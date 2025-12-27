import { db } from "../db/index.js";
import { ratebookImports, providerRates, financeProviders, vehicles, providerMappings } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import type { DatabaseFieldKey } from "../ai/column-analyzer.js";

export type GenericImportResult = {
  success: boolean;
  importId: string;
  batchId: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  uniqueCapCodes: number;
  errors: string[];
};

export type GenericImportOptions = {
  fileName: string;
  contractType: string;
  fileContent: string | Buffer;
  providerCode: string;
  // Column mappings: sourceColumn -> targetField
  columnMappings: Record<string, DatabaseFieldKey | null>;
  userId?: string;
};

// Type for provider_mappings columnMappings field (column index based)
export type IndexBasedColumnMappings = {
  cap_code?: number;
  manufacturer?: number;
  model?: number;
  variant?: number;
  monthly_rental?: number;
  p11d?: number;
  otr_price?: number;
  basic_list_price?: number;
  term?: number;
  mileage?: number;
  mpg?: number;
  co2?: number;
  fuel_type?: number;
  electric_range?: number;
  insurance_group?: number;
  body_style?: number;
  transmission?: number;
  euro_rating?: number;
  upfront?: number;
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
  if (typeof value === "string" && value.trim() === "") return null;
  const num = parseInt(String(value).replace(/,/g, ""), 10);
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
function generateBatchId(providerCode: string, contractType: string): string {
  const timestamp = Date.now();
  return `${providerCode}_${contractType.toLowerCase()}_${timestamp}`;
}

/**
 * Parse XLSX file content into records
 */
function parseXLSX(buffer: Buffer): Record<string, string | number>[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Try to detect header row (skip title rows)
  const allData = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { range: 0 });

  // Check if first row looks like a title (no commas, or contains "Broker", "Generated", etc.)
  if (allData.length > 0) {
    const firstRowKeys = Object.keys(allData[0] || {});
    const firstRowValues = Object.values(allData[0] || {});

    // If first row values contain typical header-like content, use range: 1
    const looksLikeTitle = firstRowValues.some(
      (v) =>
        String(v).includes("Broker") ||
        String(v).includes("Generated") ||
        String(v).includes("Date:")
    );

    if (looksLikeTitle) {
      // Re-parse with range: 1 to skip title row
      const dataWithSkip = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { range: 1 });
      // Also skip count row if present (just a number)
      if (dataWithSkip.length > 0) {
        const firstDataRow = dataWithSkip[0];
        const values = Object.values(firstDataRow || {});
        const looksLikeCount = values.length === 1 && typeof values[0] === "number";
        return looksLikeCount ? dataWithSkip.slice(1) : dataWithSkip;
      }
    }
  }

  return allData;
}

/**
 * Parse CSV content into records
 */
function parseCSV(content: string): Record<string, string>[] {
  // Check for title rows and skip them
  const lines = content.split("\n");
  let skipRows = 0;

  if (lines[0]?.includes("Broker") || lines[0]?.includes("Generated") || !lines[0]?.includes(",")) {
    skipRows = 1;
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
 * Extract a value from a row using column mappings
 */
function extractValue(
  row: Record<string, string | number>,
  targetField: DatabaseFieldKey,
  columnMappings: Record<string, DatabaseFieldKey | null>
): string | number | null {
  // Find the source column that maps to this target field
  for (const [sourceColumn, mappedField] of Object.entries(columnMappings)) {
    if (mappedField === targetField) {
      const value = row[sourceColumn];
      return value !== undefined ? value : null;
    }
  }
  return null;
}

/**
 * Import a ratebook using dynamic column mappings
 */
export async function importGenericRatebook(options: GenericImportOptions): Promise<GenericImportResult> {
  const { fileName, contractType, fileContent, providerCode, columnMappings, userId } = options;
  const batchId = generateBatchId(providerCode, contractType);
  const fileHash = generateFileHash(fileContent);
  const errors: string[] = [];

  // Check for duplicate file
  const existingImport = await db
    .select()
    .from(ratebookImports)
    .where(and(eq(ratebookImports.fileHash, fileHash), eq(ratebookImports.providerCode, providerCode)))
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

  // Get or create provider
  let [provider] = await db.select().from(financeProviders).where(eq(financeProviders.code, providerCode)).limit(1);

  if (!provider) {
    // Create provider entry
    [provider] = await db
      .insert(financeProviders)
      .values({
        code: providerCode,
        name: providerCode.charAt(0).toUpperCase() + providerCode.slice(1),
        isActive: true,
        supportedContractTypes: ["CH", "CHNM", "PCH", "PCHNM"],
      })
      .returning();
  }

  // Mark previous imports for this contract type as not latest
  await db
    .update(ratebookImports)
    .set({ isLatest: false })
    .where(
      and(
        eq(ratebookImports.providerCode, providerCode),
        eq(ratebookImports.contractType, contractType),
        eq(ratebookImports.isLatest, true)
      )
    );

  // Create import record
  const [importRecord] = await db
    .insert(ratebookImports)
    .values({
      providerId: provider?.id || null,
      providerCode,
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
      const buffer =
        typeof fileContent === "string" ? Buffer.from(fileContent, "base64") : fileContent;
      records = parseXLSX(buffer);
    } else {
      const csvString =
        typeof fileContent === "string" ? fileContent : fileContent.toString("utf-8");
      records = parseCSV(csvString);
    }
  } catch (e) {
    await db
      .update(ratebookImports)
      .set({ status: "failed", errorLog: [`Parse error: ${e}`] })
      .where(eq(ratebookImports.id, importId));

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
        // Extract values using column mappings
        const capCode = String(extractValue(row, "capCode", columnMappings) || "").trim();

        if (!capCode) {
          errorRows++;
          errors.push(`Row ${i + batch.indexOf(row) + 2}: Missing CAP Code`);
          continue;
        }

        capCodes.add(capCode);

        // Extract required fields
        const manufacturer = String(extractValue(row, "manufacturer", columnMappings) || "UNKNOWN").trim().toUpperCase();
        const model = String(extractValue(row, "model", columnMappings) || "Unknown").trim();
        const variant = extractValue(row, "variant", columnMappings);
        const term = parseInt2(extractValue(row, "term", columnMappings)) || 36;
        const annualMileage = parseInt2(extractValue(row, "annualMileage", columnMappings)) || 10000;
        const totalRental = toPence(extractValue(row, "totalRental", columnMappings)) || 0;

        // Extract optional fields
        const leaseRental = toPence(extractValue(row, "leaseRental", columnMappings));
        const serviceRental = toPence(extractValue(row, "serviceRental", columnMappings));
        const p11d = toPence(extractValue(row, "p11d", columnMappings));
        const co2Gkm = parseInt2(extractValue(row, "co2Gkm", columnMappings));
        const fuelType = extractValue(row, "fuelType", columnMappings);
        const transmission = extractValue(row, "transmission", columnMappings);
        const bodyStyle = extractValue(row, "bodyStyle", columnMappings);
        const modelYear = extractValue(row, "modelYear", columnMappings);
        const excessMileagePpm = toPence(extractValue(row, "excessMileagePpm", columnMappings));
        const wholeLifeCost = toPence(extractValue(row, "wholeLifeCost", columnMappings));
        const otrPrice = toPence(extractValue(row, "otrPrice", columnMappings));
        const basicListPrice = toPence(extractValue(row, "basicListPrice", columnMappings));
        const insuranceGroup = extractValue(row, "insuranceGroup", columnMappings);
        const mpgCombined = extractValue(row, "mpgCombined", columnMappings);
        const wltpEvRange = parseInt2(extractValue(row, "wltpEvRange", columnMappings));
        const euroRating = extractValue(row, "euroRating", columnMappings);

        const rate: typeof providerRates.$inferInsert = {
          capCode,
          importId,
          providerCode,
          contractType,
          manufacturer,
          model,
          variant: variant ? String(variant) : null,
          isCommercial: false,
          term,
          annualMileage,
          paymentPlan: "monthly_in_advance",
          totalRental,
          leaseRental,
          serviceRental,
          nonRecoverableVat: null,
          co2Gkm,
          p11d,
          otrPrice,
          basicListPrice,
          fuelType: fuelType ? String(fuelType) : null,
          transmission: transmission ? String(transmission) : null,
          bodyStyle: bodyStyle ? String(bodyStyle) : null,
          modelYear: modelYear ? String(modelYear) : null,
          excessMileagePpm,
          financeEmcPpm: null,
          serviceEmcPpm: null,
          wltpEvRange,
          wltpEvRangeMin: null,
          wltpEvRangeMax: null,
          wltpEaerMiles: null,
          fuelEcoCombined: mpgCombined ? String(mpgCombined) : null,
          bikTaxLowerRate: null,
          bikTaxHigherRate: null,
          bikPercent: null,
          wholeLifeCost,
          estimatedSaleValue: null,
          fuelCostPpm: null,
          insuranceGroup: insuranceGroup ? String(insuranceGroup) : null,
          euroRating: euroRating ? String(euroRating) : null,
          rdeCertificationLevel: null,
          rawData: null, // Skip rawData to reduce storage
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
      const batchCapCodes = Array.from(
        new Set(ratesToInsert.map((r) => r.capCode).filter((c): c is string => Boolean(c)))
      );

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

        const capCodeToVehicle = new Map(vehicleMatches.map((v) => [v.capCode, v]));

        for (const rate of ratesToInsert) {
          if (rate.capCode) {
            const vehicle = capCodeToVehicle.get(rate.capCode);
            if (vehicle) {
              rate.vehicleId = vehicle.vehicleId;
              // Use vehicle data if rate data is missing
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
    console.log(`[generic-importer] Calculated scores for import ${importId}`);
  } catch (e) {
    console.error(`[generic-importer] Failed to calculate scores: ${e}`);
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
 * Get stored column mappings for a provider
 */
export async function getProviderMappings(providerName: string): Promise<Record<string, DatabaseFieldKey | null> | null> {
  const [mapping] = await db
    .select()
    .from(providerMappings)
    .where(eq(providerMappings.providerName, providerName))
    .limit(1);

  if (!mapping) return null;

  // Convert index-based mappings to column name mappings (legacy support)
  // For new-style mappings, the columnMappings is already { sourceColumn: targetField }
  return mapping.columnMappings as Record<string, DatabaseFieldKey | null>;
}
