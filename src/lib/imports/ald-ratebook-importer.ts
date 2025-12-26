import { db } from "../db/index.js";
import { ratebookImports, providerRates, financeProviders, vehicles } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

export type ALDImportResult = {
  success: boolean;
  importId: string;
  batchId: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  uniqueCapCodes: number;
  errors: string[];
};

export type ALDImportOptions = {
  fileName: string;
  contractType: string; // CH, CHNM, PCH, PCHNM, BSSNL
  fileContent: string | Buffer; // Can be CSV string or XLSX buffer (base64 encoded)
  userId?: string;
  // Legacy options - now read from file data
  term?: number;
  annualMileage?: number;
};

/**
 * Convert a decimal value (pounds.pence) to pence integer
 */
function toPence(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "" || value === "0") {
    return null;
  }
  const num = typeof value === "string" ? parseFloat(value.replace(/[,£\s]/g, "")) : value;
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

/**
 * Parse an integer value
 */
function parseInt2(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Math.round(value);
  if (value.trim() === "") return null;
  const num = parseInt(value.replace(/,/g, ""), 10);
  return isNaN(num) ? null : num;
}

/**
 * Generate SHA-256 hash of file content
 */
function generateFileHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Generate a unique batch ID
 */
function generateBatchId(contractType: string): string {
  const timestamp = Date.now();
  return `ald_${contractType.toLowerCase()}_${timestamp}`;
}

/**
 * Parse XLSX file content into records
 */
function parseXLSX(buffer: Buffer): Record<string, string | number>[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Skip first row (title) and parse from row 2 (headers)
  const allData = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { range: 1 });
  // Skip the count row (first data row after headers)
  return allData.slice(1);
}

/**
 * Parse CSV content into records
 */
function parseCSV(content: string): Record<string, string>[] {
  // Check if first line is a title line (contains date or "Broker")
  const lines = content.split("\n");
  let skipRows = 0;

  if (lines[0]?.includes("Broker") || lines[0]?.includes("Generated")) {
    skipRows = 1;
    // Also skip count row if present
    if (lines[1] && !lines[1].includes(",")) {
      skipRows = 2;
    }
  }

  const csvContent = lines.slice(skipRows).join("\n");

  return parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

/**
 * Import an ALD ratebook (CSV or XLSX) into the unified provider_rates table
 *
 * ALD files contain TERM and ANNUAL_MILEAGE per row, allowing multiple
 * mileage bands per vehicle in a single file.
 */
export async function importALDRatebook(options: ALDImportOptions): Promise<ALDImportResult> {
  const { fileName, contractType, fileContent, userId } = options;
  const batchId = generateBatchId(contractType);
  const fileHash = generateFileHash(fileContent);
  const errors: string[] = [];

  // Check for duplicate file
  const existingImport = await db
    .select()
    .from(ratebookImports)
    .where(and(eq(ratebookImports.fileHash, fileHash), eq(ratebookImports.providerCode, "ald")))
    .limit(1);

  if (existingImport.length > 0) {
    return {
      success: false,
      importId: "",
      batchId,
      totalRows: 0,
      successRows: 0,
      errorRows: 0,
      uniqueCapCodes: 0,
      errors: [`Duplicate file detected. This ratebook was already imported on ${existingImport[0].createdAt}`],
    };
  }

  // Get ALD provider ID
  const aldProvider = await db.select().from(financeProviders).where(eq(financeProviders.code, "ald")).limit(1);

  // Mark previous imports for this contract type as not latest
  await db
    .update(ratebookImports)
    .set({ isLatest: false })
    .where(
      and(
        eq(ratebookImports.providerCode, "ald"),
        eq(ratebookImports.contractType, contractType),
        eq(ratebookImports.isLatest, true)
      )
    );

  // Create import record
  const [importRecord] = await db
    .insert(ratebookImports)
    .values({
      providerId: aldProvider[0]?.id || null,
      providerCode: "ald",
      contractType,
      batchId,
      fileName,
      fileHash,
      status: "processing",
      isLatest: true,
      startedAt: new Date(),
      createdBy: userId || null,
    })
    .returning();

  const importId = importRecord.id;

  // Parse file based on type
  let records: Record<string, string | number>[];
  try {
    const isXLSX = fileName.toLowerCase().endsWith(".xlsx") || fileName.toLowerCase().endsWith(".xls");

    if (isXLSX) {
      const buffer = typeof fileContent === "string"
        ? Buffer.from(fileContent, "base64")
        : fileContent;
      records = parseXLSX(buffer);
    } else {
      const csvString = typeof fileContent === "string"
        ? fileContent
        : fileContent.toString("utf-8");
      records = parseCSV(csvString);
    }
  } catch (e) {
    await db.update(ratebookImports).set({ status: "failed", errorLog: [`Parse error: ${e}`] }).where(eq(ratebookImports.id, importId));

    return {
      success: false,
      importId,
      batchId,
      totalRows: 0,
      successRows: 0,
      errorRows: 1,
      uniqueCapCodes: 0,
      errors: [`File parse error: ${e}`],
    };
  }

  const totalRows = records.length;
  let successRows = 0;
  let errorRows = 0;
  const capCodes = new Set<string>();
  const BATCH_SIZE = 100;

  // Process in batches
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const ratesToInsert: (typeof providerRates.$inferInsert)[] = [];

    for (const row of batch) {
      try {
        // Get CAP CODE
        const capCode = String(row["CAP CODE"] || "").trim();

        if (!capCode) {
          errorRows++;
          errors.push(`Row ${i + batch.indexOf(row) + 2}: Missing CAP CODE`);
          continue;
        }

        capCodes.add(capCode);

        // Read TERM and ANNUAL_MILEAGE from the row
        const term = parseInt2(row["TERM"]) || options.term || 36;
        const annualMileage = parseInt2(row["ANNUAL_MILEAGE"]) || options.annualMileage || 10000;

        // Extract vehicle info
        const manufacturer = String(row["MANUFACTURER"] || "").trim().toUpperCase();
        const vehicleDesc = String(row["VEHICLE DESCRIPTION"] || "").trim();

        // Parse model and variant from vehicle description
        // Format is typically "MAKE Model Variant Details"
        const descParts = vehicleDesc.split(" ");
        const model = descParts.slice(0, 2).join(" "); // First two words
        const variant = descParts.slice(2).join(" "); // Rest is variant

        // Parse rental values
        // NET RENTAL WM = With Maintenance (total), NET RENTAL CM = Contract/No Maintenance (base)
        const rentalWM = toPence(row["NET RENTAL WM"]); // With Maintenance
        const rentalCM = toPence(row["NET RENTAL CM"]); // Without Maintenance

        // Determine rental values based on contract type
        let totalRental: number;
        let leaseRental: number | null = null;
        let serviceRental: number | null = null;

        if (contractType === "CH" || contractType === "PCH") {
          // With maintenance contracts
          if (rentalWM !== null) {
            totalRental = rentalWM;
            leaseRental = rentalCM;
            serviceRental = rentalCM !== null ? rentalWM - rentalCM : null;
          } else {
            totalRental = rentalCM || 0;
            leaseRental = rentalCM;
          }
        } else {
          // Without maintenance contracts (CHNM, PCHNM)
          totalRental = rentalCM || rentalWM || 0;
          leaseRental = rentalCM;
        }

        const rate: typeof providerRates.$inferInsert = {
          capCode,
          importId,
          providerCode: "ald",
          contractType,
          manufacturer: manufacturer || "UNKNOWN",
          model: model || "Unknown",
          variant: variant || null,
          isCommercial: false,
          term,
          annualMileage,
          paymentPlan: "monthly_in_advance",
          totalRental,
          leaseRental,
          serviceRental,
          nonRecoverableVat: null,
          co2Gkm: parseInt2(row["CO2"]),
          p11d: toPence(row["P11D"]),
          fuelType: String(row["FUEL TYPE"] || ""),
          transmission: String(row["TRANSMISSION"] || ""),
          bodyStyle: String(row["BODY STYLE"] || ""),
          modelYear: String(row["MODELYEAR"] || ""),
          excessMileagePpm: toPence(row["Excess Mileage"]),
          financeEmcPpm: null,
          serviceEmcPpm: null,
          wltpEvRange: null,
          wltpEvRangeMin: null,
          wltpEvRangeMax: null,
          wltpEaerMiles: null,
          fuelEcoCombined: String(row["MPG COMBINED"] || ""),
          bikTaxLowerRate: null,
          bikTaxHigherRate: null,
          bikPercent: null,
          wholeLifeCost: toPence(row["WLC"]),
          estimatedSaleValue: null,
          fuelCostPpm: toPence(row["FUEL_COST"]),
          insuranceGroup: String(row["INSURANCE GROUP"] || ""),
          euroRating: String(row["EURO CLASSIFICATION"] || ""),
          rdeCertificationLevel: null,
          rawData: {
            winId: row["WIN ID"],
            capId: row["CAP ID"],
            idsCode: row["IDS CODE"],
            otr: row["OTR"],
            mrp: row["MRP"],
            basicPrice: row["BASIC PRICE"],
            vat: row["VAT"],
            additionalRfl: row["ADDITIONAL RFL"],
            engSize: row["ENGSIZE"],
            doors: row["DOORS"],
          },
        };

        ratesToInsert.push(rate);
        successRows++;
      } catch (e) {
        errorRows++;
        errors.push(`Row ${i + batch.indexOf(row) + 2}: ${e}`);
      }
    }

    // Look up vehicle_ids for CAP codes
    if (ratesToInsert.length > 0) {
      const batchCapCodes = Array.from(new Set(ratesToInsert.map(r => r.capCode).filter((c): c is string => Boolean(c))));

      if (batchCapCodes.length > 0) {
        const vehicleMatches = await db
          .select({
            capCode: vehicles.capCode,
            vehicleId: vehicles.id,
            manufacturer: vehicles.manufacturer,
            model: vehicles.model,
            variant: vehicles.variant,
          })
          .from(vehicles)
          .where(inArray(vehicles.capCode, batchCapCodes));

        const capCodeToVehicle = new Map(
          vehicleMatches.map(v => [v.capCode, v])
        );

        for (const rate of ratesToInsert) {
          if (rate.capCode) {
            const vehicle = capCodeToVehicle.get(rate.capCode);
            if (vehicle) {
              rate.vehicleId = vehicle.vehicleId;
              if (!rate.manufacturer || rate.manufacturer === "UNKNOWN") {
                rate.manufacturer = vehicle.manufacturer;
              }
              if (!rate.model || rate.model === "Unknown") {
                rate.model = vehicle.model;
              }
              if (!rate.variant && vehicle.variant) {
                rate.variant = vehicle.variant;
              }
            }
          }
        }
      }

      // Bulk insert batch
      try {
        await db.insert(providerRates).values(ratesToInsert);
      } catch (e) {
        errorRows += ratesToInsert.length;
        successRows -= ratesToInsert.length;
        errors.push(`Batch insert error at row ${i}: ${e}`);
      }
    }

    // Update progress
    await db
      .update(ratebookImports)
      .set({
        totalRows,
        successRows,
        errorRows,
        uniqueCapCodes: capCodes.size,
      })
      .where(eq(ratebookImports.id, importId));
  }

  // Calculate scores for imported rates using the database function
  try {
    await db.execute(
      `UPDATE provider_rates pr
       SET score = result.score, score_breakdown = result.breakdown
       FROM (
         SELECT pr2.id, (calculate_rate_score_with_breakdown(
           pr2.total_rental, pr2.term, pr2.p11d, pr2.basic_list_price, pr2.contract_type, pr2.cap_code,
           COALESCE(pr2.payment_plan, 'monthly_in_advance'),
           pr2.manufacturer, pr2.fuel_type, pr2.wltp_ev_range
         )).*
         FROM provider_rates pr2
         WHERE pr2.import_id = '${importId}'
       ) result
       WHERE pr.id = result.id`
    );
    console.log(`[ald-importer] Calculated scores for import ${importId}`);
  } catch (e) {
    console.error(`[ald-importer] Failed to calculate scores: ${e}`);
    errors.push(`Score calculation failed: ${e}`);
  }

  // Finalize import
  const finalStatus = errorRows > totalRows / 2 ? "failed" : "completed";
  await db
    .update(ratebookImports)
    .set({
      status: finalStatus,
      totalRows,
      successRows,
      errorRows,
      uniqueCapCodes: capCodes.size,
      errorLog: errors.length > 0 ? errors.slice(0, 100) : null,
      completedAt: new Date(),
    })
    .where(eq(ratebookImports.id, importId));

  return {
    success: finalStatus === "completed",
    importId,
    batchId,
    totalRows,
    successRows,
    errorRows,
    uniqueCapCodes: capCodes.size,
    errors: errors.slice(0, 20),
  };
}

/**
 * Get import status by batch ID
 */
export async function getALDImportStatus(batchId: string) {
  const [importRecord] = await db.select().from(ratebookImports).where(eq(ratebookImports.batchId, batchId)).limit(1);
  return importRecord || null;
}
