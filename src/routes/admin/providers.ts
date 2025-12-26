import { Router, Request, Response } from "express";
import { db } from "../../lib/db/index.js";
import { providerMappings, financeProviders } from "../../lib/db/schema.js";
import { eq } from "drizzle-orm";
import { asyncHandler, ApiError } from "../../middleware/error.js";
import { analyzeColumnHeaders, getDatabaseFields, DatabaseFieldKey } from "../../lib/ai/column-analyzer.js";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

const router = Router();

/**
 * POST /api/admin/providers/analyze-columns
 * Analyze file headers and suggest column mappings using AI
 */
router.post(
  "/analyze-columns",
  asyncHandler(async (req: Request, res: Response) => {
    const { headers, sampleRows, fileName } = req.body;

    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      throw new ApiError("Missing or invalid headers array", 400);
    }

    console.log(`[analyze-columns] Analyzing ${headers.length} columns from ${fileName || "unknown file"}`);

    const analysis = await analyzeColumnHeaders(headers, sampleRows || []);

    res.json({
      success: true,
      analysis,
      availableFields: getDatabaseFields(),
    });
  })
);

/**
 * POST /api/admin/providers/extract-headers
 * Extract headers and sample rows from uploaded file (CSV or XLSX)
 */
router.post(
  "/extract-headers",
  asyncHandler(async (req: Request, res: Response) => {
    const { fileContent, fileName, isBase64 } = req.body;

    if (!fileContent || !fileName) {
      throw new ApiError("Missing fileContent or fileName", 400);
    }

    const isXLSX = fileName.toLowerCase().endsWith(".xlsx") || fileName.toLowerCase().endsWith(".xls");
    let headers: string[] = [];
    let sampleRows: Record<string, string>[] = [];

    try {
      if (isXLSX) {
        // Parse XLSX
        const buffer = isBase64
          ? Buffer.from(fileContent, "base64")
          : Buffer.from(fileContent);
        const wb = XLSX.read(buffer, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];

        // Detect how many title rows to skip by checking first few rows
        // ALD files have "Broker - CHcmXX" in row 0 and a count row in row 1
        const rawData = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });

        // STEP 1: Find the row with the most columns - this is almost always the header row
        let maxColumns = 0;
        let headerRowIndex = 0;
        for (let i = 0; i < Math.min(15, rawData.length); i++) {
          const row = rawData[i];
          const filledCells = row ? row.filter(Boolean).length : 0;
          if (filledCells > maxColumns) {
            maxColumns = filledCells;
            headerRowIndex = i;
          }
        }

        console.log(`[extract-headers] Max columns row: index ${headerRowIndex} with ${maxColumns} columns`);

        // STEP 2: Verify the max-columns row looks like headers (has text, not just numbers)
        // If it has at least 5 columns, use it as the header row
        let skipRows = headerRowIndex;

        // STEP 3: Double-check by looking for keyword matches (optional validation)
        if (maxColumns >= 5) {
          const headerRow = rawData[headerRowIndex];
          const rowStr = headerRow ? headerRow.join(" ").toUpperCase() : "";

          // Check for common header keywords to confirm
          const hasHeaderKeywords =
            rowStr.includes("MANUFACTURER") ||
            rowStr.includes("CAP CODE") ||
            rowStr.includes("CAP_CODE") ||
            rowStr.includes("CAPCODE") ||
            rowStr.includes("MILEAGE") ||
            rowStr.includes("RENTAL") ||
            rowStr.includes("MODEL") ||
            rowStr.includes("MAKE") ||
            rowStr.includes("VARIANT") ||
            rowStr.includes("DERIVATIVE");

          if (hasHeaderKeywords) {
            console.log(`[extract-headers] Confirmed header row ${headerRowIndex} with keywords`);
          } else {
            console.log(`[extract-headers] Using row ${headerRowIndex} based on column count (${maxColumns}), no keyword match`);
          }
        } else {
          // Very few columns - might be a malformed file, try to find any row with headers
          console.log(`[extract-headers] Warning: Max columns is only ${maxColumns}, searching for header keywords...`);

          for (let i = 0; i < Math.min(10, rawData.length); i++) {
            const row = rawData[i];
            if (!row) continue;

            const rowStr = row.join(" ").toUpperCase();
            if (
              rowStr.includes("MANUFACTURER") ||
              rowStr.includes("CAP CODE") ||
              rowStr.includes("RENTAL") ||
              rowStr.includes("MODEL")
            ) {
              skipRows = i;
              console.log(`[extract-headers] Found header keywords at row ${i}`);
              break;
            }
          }
        }

        console.log(`[extract-headers] XLSX: Using row ${skipRows} as header for ${fileName}`);

        // Get all data starting from header row
        const allData = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { range: skipRows });

        if (allData.length > 0) {
          headers = Object.keys(allData[0] || {});
          // Convert values to strings for sample rows
          sampleRows = allData.slice(0, 5).map((row) => {
            const strRow: Record<string, string> = {};
            for (const [key, value] of Object.entries(row)) {
              strRow[key] = String(value ?? "");
            }
            return strRow;
          });
        }

        console.log(`[extract-headers] XLSX: Found ${headers.length} headers: ${headers.slice(0, 5).join(", ")}...`);
      } else {
        // Parse CSV
        const csvContent = isBase64
          ? Buffer.from(fileContent, "base64").toString("utf-8")
          : fileContent;

        // Check for title rows and skip them
        const lines = csvContent.split("\n");
        let skipRows = 0;
        if (lines[0]?.includes("Broker") || lines[0]?.includes("Generated") || !lines[0]?.includes(",")) {
          skipRows = 1;
          if (lines[1] && !lines[1].includes(",")) {
            skipRows = 2;
          }
        }

        const cleanContent = lines.slice(skipRows).join("\n");

        const records = parse(cleanContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }) as Record<string, string>[];

        if (records.length > 0) {
          headers = Object.keys(records[0] || {});
          sampleRows = records.slice(0, 5);
        }
      }

      res.json({
        success: true,
        headers,
        sampleRows,
        totalColumns: headers.length,
      });
    } catch (error) {
      console.error("[extract-headers] Parse error:", error);
      throw new ApiError(`Failed to parse file: ${error}`, 400);
    }
  })
);

/**
 * GET /api/admin/providers
 * List all provider configurations
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const mappings = await db.select().from(providerMappings);
    const providers = await db.select().from(financeProviders);

    res.json({
      mappings,
      providers,
    });
  })
);

/**
 * GET /api/admin/providers/:providerName
 * Get a specific provider's column mapping configuration
 */
router.get(
  "/:providerName",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerName } = req.params;

    const [mapping] = await db
      .select()
      .from(providerMappings)
      .where(eq(providerMappings.providerName, providerName))
      .limit(1);

    if (!mapping) {
      throw new ApiError(`Provider mapping not found: ${providerName}`, 404);
    }

    res.json(mapping);
  })
);

/**
 * POST /api/admin/providers
 * Create or update a provider column mapping configuration
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerName, columnMappings, fileFormat } = req.body;

    if (!providerName || !columnMappings) {
      throw new ApiError("Missing providerName or columnMappings", 400);
    }

    // Validate columnMappings structure
    if (typeof columnMappings !== "object") {
      throw new ApiError("columnMappings must be an object", 400);
    }

    // Check if provider exists
    const [existing] = await db
      .select()
      .from(providerMappings)
      .where(eq(providerMappings.providerName, providerName))
      .limit(1);

    if (existing) {
      // Update existing
      const [updated] = await db
        .update(providerMappings)
        .set({
          columnMappings,
          fileFormat: fileFormat || existing.fileFormat,
          updatedAt: new Date(),
        })
        .where(eq(providerMappings.providerName, providerName))
        .returning();

      res.json({
        success: true,
        message: "Provider mapping updated",
        mapping: updated,
      });
    } else {
      // Create new
      const [created] = await db
        .insert(providerMappings)
        .values({
          providerName,
          columnMappings,
          fileFormat: fileFormat || "csv",
        })
        .returning();

      // Also create finance_providers entry if it doesn't exist
      const providerCode = providerName.toLowerCase().replace(/[^a-z0-9]/g, "_");
      const [existingProvider] = await db
        .select()
        .from(financeProviders)
        .where(eq(financeProviders.code, providerCode))
        .limit(1);

      if (!existingProvider) {
        await db.insert(financeProviders).values({
          code: providerCode,
          name: providerName,
          isActive: true,
          supportedContractTypes: ["CH", "CHNM", "PCH", "PCHNM"],
        });
      }

      res.json({
        success: true,
        message: "Provider mapping created",
        mapping: created,
        providerCode,
      });
    }
  })
);

/**
 * DELETE /api/admin/providers/:providerName
 * Delete a provider mapping configuration
 */
router.delete(
  "/:providerName",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerName } = req.params;

    const [deleted] = await db
      .delete(providerMappings)
      .where(eq(providerMappings.providerName, providerName))
      .returning();

    if (!deleted) {
      throw new ApiError(`Provider mapping not found: ${providerName}`, 404);
    }

    res.json({
      success: true,
      message: "Provider mapping deleted",
    });
  })
);

/**
 * GET /api/admin/providers/fields/list
 * Get list of available database fields for mapping UI
 */
router.get(
  "/fields/list",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      fields: getDatabaseFields(),
    });
  })
);

export default router;
