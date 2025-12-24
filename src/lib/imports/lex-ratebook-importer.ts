import { db } from "../db/index.js";
import { ratebookImports, providerRates, financeProviders, vehicles } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import { parse } from "csv-parse/sync";

// CSV column to database field mapping for Lex Autolease ratebooks
const LEX_COLUMN_MAP: Record<string, string> = {
  CAP_CODE: "capCode",
  Manufacturer: "manufacturer",
  Model_Name: "model",
  Variant: "variant",
  Commercial: "isCommercial",
  CO2_g_per_km: "co2Gkm",
  P11D: "p11d",
  Basic_List_Price: "basicListPrice",
  Term: "term",
  Mileage: "annualMileage",
  Rental: "totalRental",
  Payment_Plan: "paymentPlan",
  Contract_Type: "contractType",
  Fuel_Type: "fuelType",
  Model_Year: "modelYear",
  Lease_Rental: "leaseRental",
  Service_Rental: "serviceRental",
  Non_Recoverable_VAT: "nonRecoverableVat",
  Excess_Mileage: "excessMileagePpm",
  Finance_Emc_Ppm: "financeEmcPpm",
  Service_Emc_Ppm: "serviceEmcPpm",
  Fuel_Eco_Combined: "fuelEcoCombined",
  WLTP_EAER__miles: "wltpEaerMiles",
  "WLTP_Pure_EV_Range__miles_": "wltpEvRange",
  "WLTP_Pure_EV_Range__miles____Min": "wltpEvRangeMin",
  "WLTP_Pure_EV_Range__miles____Max": "wltpEvRangeMax",
  Body_Style: "bodyStyle",
  Whole_Life_Cost: "wholeLifeCost",
  Estimated_Sale_Value: "estimatedSaleValue",
  TRANSMISSION: "transmission",
  EURO_RATING: "euroRating",
  RDE_Certification_Level: "rdeCertificationLevel",
  FUEL_COST_PPM: "fuelCostPpm",
  BIK_TAX_AT_LOWER_RATE: "bikTaxLowerRate",
  BIK_TAX_AT_HIGHER_RATE: "bikTaxHigherRate",
  INSURANCE_GROUP: "insuranceGroup",
};

// Payment plan mapping from Lex CSV format to our enum
const PAYMENT_PLAN_MAP: Record<string, string> = {
  "Monthly in advance": "monthly_in_advance",
  "Spread Rentals with 3 down": "spread_3_down",
  "Spread Rentals with 6 down": "spread_6_down",
  "Spread Rentals with 9 down": "spread_9_down",
};

export type LexImportResult = {
  success: boolean;
  importId: string;
  batchId: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  uniqueCapCodes: number;
  errors: string[];
};

export type LexImportOptions = {
  fileName: string;
  contractType: string;
  csvContent: string;
  userId?: string;
};

/**
 * Convert a decimal value (pounds.pence) to pence integer
 */
function toPence(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "" || value === ".00") {
    return null;
  }
  const num = typeof value === "string" ? parseFloat(value.replace(/,/g, "")) : value;
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

/**
 * Parse an integer value
 */
function parseInt2(value: string | null | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const num = parseInt(value.replace(/,/g, ""), 10);
  return isNaN(num) ? null : num;
}

/**
 * Generate SHA-256 hash of file content
 */
function generateFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Generate a unique batch ID
 */
function generateBatchId(contractType: string): string {
  const timestamp = Date.now();
  return `lex_${contractType.toLowerCase()}_${timestamp}`;
}

/**
 * Map payment plan from CSV format to our enum
 */
function mapPaymentPlan(csvValue: string): string {
  return PAYMENT_PLAN_MAP[csvValue] || "spread_6_down";
}

/**
 * Import a Lex Autolease ratebook CSV into the database
 */
export async function importLexRatebook(options: LexImportOptions): Promise<LexImportResult> {
  const { fileName, contractType, csvContent, userId } = options;
  const batchId = generateBatchId(contractType);
  const fileHash = generateFileHash(csvContent);
  const errors: string[] = [];

  // Check for duplicate file
  const existingImport = await db
    .select()
    .from(ratebookImports)
    .where(and(eq(ratebookImports.fileHash, fileHash), eq(ratebookImports.providerCode, "lex")))
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

  // Get Lex provider ID
  const lexProvider = await db.select().from(financeProviders).where(eq(financeProviders.code, "lex")).limit(1);

  // Mark previous imports for this contract type as not latest
  await db
    .update(ratebookImports)
    .set({ isLatest: false })
    .where(and(eq(ratebookImports.providerCode, "lex"), eq(ratebookImports.contractType, contractType), eq(ratebookImports.isLatest, true)));

  // Create import record
  const [importRecord] = await db
    .insert(ratebookImports)
    .values({
      providerId: lexProvider[0]?.id || null,
      providerCode: "lex",
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

  // Parse CSV
  let records: Record<string, string>[];
  try {
    records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
      escape: "\\",
      quote: '"',
    });
  } catch (e) {
    await db.update(ratebookImports).set({ status: "failed", errorLog: [`CSV parse error: ${e}`] }).where(eq(ratebookImports.id, importId));

    return {
      success: false,
      importId,
      batchId,
      totalRows: 0,
      successRows: 0,
      errorRows: 1,
      uniqueCapCodes: 0,
      errors: [`CSV parse error: ${e}`],
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
        const capCode = row.CAP_CODE?.trim();
        if (!capCode) {
          errorRows++;
          errors.push(`Row ${i + batch.indexOf(row) + 2}: Missing CAP_CODE`);
          continue;
        }

        capCodes.add(capCode);

        // Map CSV columns to database fields
        const rate: typeof providerRates.$inferInsert = {
          capCode,
          importId,
          providerCode: "lex",
          contractType: row.Contract_Type || contractType,
          manufacturer: row.Manufacturer || "Unknown",
          model: row.Model_Name || "Unknown",
          variant: row.Variant || null,
          isCommercial: row.Commercial === "Y",
          term: parseInt2(row.Term) || 36,
          annualMileage: parseInt2(row.Mileage) || 10000,
          paymentPlan: mapPaymentPlan(row.Payment_Plan),
          totalRental: toPence(row.Rental) || 0,
          leaseRental: toPence(row.Lease_Rental),
          serviceRental: toPence(row.Service_Rental),
          nonRecoverableVat: toPence(row.Non_Recoverable_VAT),
          co2Gkm: parseInt2(row.CO2_g_per_km),
          p11d: toPence(row.P11D),
          basicListPrice: toPence(row.Basic_List_Price),
          fuelType: row.Fuel_Type || null,
          transmission: row.TRANSMISSION || null,
          bodyStyle: row.Body_Style || null,
          modelYear: row.Model_Year || null,
          excessMileagePpm: toPence(row.Excess_Mileage),
          financeEmcPpm: toPence(row.Finance_Emc_Ppm),
          serviceEmcPpm: toPence(row.Service_Emc_Ppm),
          wltpEvRange: parseInt2(row["WLTP_Pure_EV_Range__miles_"]),
          wltpEvRangeMin: parseInt2(row["WLTP_Pure_EV_Range__miles____Min"]),
          wltpEvRangeMax: parseInt2(row["WLTP_Pure_EV_Range__miles____Max"]),
          wltpEaerMiles: parseInt2(row["WLTP_EAER__miles"]),
          fuelEcoCombined: row.Fuel_Eco_Combined && row.Fuel_Eco_Combined !== ".0" ? row.Fuel_Eco_Combined : null,
          bikTaxLowerRate: toPence(row.BIK_TAX_AT_LOWER_RATE),
          bikTaxHigherRate: toPence(row.BIK_TAX_AT_HIGHER_RATE),
          wholeLifeCost: toPence(row.Whole_Life_Cost),
          estimatedSaleValue: toPence(row.Estimated_Sale_Value),
          fuelCostPpm: toPence(row.FUEL_COST_PPM),
          insuranceGroup: row.INSURANCE_GROUP || null,
          euroRating: row.EURO_RATING || null,
          rdeCertificationLevel: row.RDE_Certification_Level || null,
          rawData: null, // Skip rawData to reduce payload size
        };

        ratesToInsert.push(rate);
        successRows++;
      } catch (e) {
        errorRows++;
        errors.push(`Row ${i + batch.indexOf(row) + 2}: ${e}`);
      }
    }

    // Look up vehicle_ids for all cap_codes in this batch
    if (ratesToInsert.length > 0) {
      const batchCapCodes = Array.from(new Set(ratesToInsert.map(r => r.capCode).filter((c): c is string => Boolean(c))));

      if (batchCapCodes.length > 0) {
        const vehicleMatches = await db
          .select({ id: vehicles.id, capCode: vehicles.capCode })
          .from(vehicles)
          .where(inArray(vehicles.capCode, batchCapCodes));

        const capCodeToVehicleId = new Map(
          vehicleMatches.map(v => [v.capCode, v.id])
        );

        // Set vehicle_id on each rate
        for (const rate of ratesToInsert) {
          if (rate.capCode) {
            rate.vehicleId = capCodeToVehicleId.get(rate.capCode) || null;
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
export async function getImportStatus(batchId: string) {
  const [importRecord] = await db.select().from(ratebookImports).where(eq(ratebookImports.batchId, batchId)).limit(1);
  return importRecord || null;
}

/**
 * Get all imports for a provider/contract type
 */
export async function getImportHistory(providerCode: string, contractType?: string, limit = 10) {
  let query = db
    .select()
    .from(ratebookImports)
    .where(contractType ? and(eq(ratebookImports.providerCode, providerCode), eq(ratebookImports.contractType, contractType)) : eq(ratebookImports.providerCode, providerCode))
    .orderBy(ratebookImports.createdAt)
    .limit(limit);

  return await query;
}

/**
 * Get the latest import for each contract type
 */
export async function getLatestImports(providerCode: string) {
  return await db.select().from(ratebookImports).where(and(eq(ratebookImports.providerCode, providerCode), eq(ratebookImports.isLatest, true)));
}
