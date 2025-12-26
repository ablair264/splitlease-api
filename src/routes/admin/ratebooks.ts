import { Router, Request, Response } from "express";
import { db } from "../../lib/db/index.js";
import { ratebookImports, financeProviders, providerRates } from "../../lib/db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { asyncHandler, ApiError } from "../../middleware/error.js";
import { importLexRatebook } from "../../lib/imports/lex-ratebook-importer.js";
import { importALDRatebook } from "../../lib/imports/ald-ratebook-importer.js";
import { importGenericRatebook } from "../../lib/imports/generic-ratebook-importer.js";

// Built-in providers with dedicated importers
const BUILTIN_PROVIDERS = ["lex", "ald"];

// All supported providers (built-in + any custom providers in database)
const SUPPORTED_PROVIDERS = ["lex", "ald"];

const router = Router();

/**
 * GET /api/admin/ratebooks
 * List all ratebook imports
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { provider, contractType, latest } = req.query as Record<string, string | undefined>;

    const conditions = [];
    if (provider) {
      conditions.push(eq(ratebookImports.providerCode, provider));
    }
    if (contractType) {
      conditions.push(eq(ratebookImports.contractType, contractType));
    }
    if (latest === "true") {
      conditions.push(eq(ratebookImports.isLatest, true));
    }

    const imports = await db
      .select({
        id: ratebookImports.id,
        providerCode: ratebookImports.providerCode,
        contractType: ratebookImports.contractType,
        batchId: ratebookImports.batchId,
        fileName: ratebookImports.fileName,
        status: ratebookImports.status,
        totalRows: ratebookImports.totalRows,
        successRows: ratebookImports.successRows,
        errorRows: ratebookImports.errorRows,
        uniqueCapCodes: ratebookImports.uniqueCapCodes,
        isLatest: ratebookImports.isLatest,
        completedAt: ratebookImports.completedAt,
        createdAt: ratebookImports.createdAt,
      })
      .from(ratebookImports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(ratebookImports.createdAt))
      .limit(50);

    const providers = await db.select().from(financeProviders);

    const [stats] = await db
      .select({
        totalRates: sql<number>`count(*)`,
        uniqueVehicles: sql<number>`count(distinct ${providerRates.capCode})`,
      })
      .from(providerRates);

    res.json({
      imports,
      providers,
      stats: {
        totalRates: Number(stats?.totalRates || 0),
        uniqueVehicles: Number(stats?.uniqueVehicles || 0),
      },
    });
  })
);

/**
 * POST /api/admin/ratebooks/import
 * Import a ratebook CSV file
 */
router.post(
  "/import",
  asyncHandler(async (req: Request, res: Response) => {
    const { fileName, contractType, csvContent, fileContent, providerCode } = req.body;

    if (!fileName || !contractType || (!csvContent && !fileContent)) {
      throw new ApiError("Missing required fields: fileName, contractType, csvContent or fileContent", 400);
    }

    const provider = providerCode || "lex";
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new ApiError(`Provider '${provider}' is not supported. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`, 400);
    }

    let result;
    if (provider === "ald") {
      result = await importALDRatebook({
        fileName,
        contractType,
        fileContent: fileContent || csvContent, // ALD can be XLSX (base64) or CSV
      });
    } else {
      result = await importLexRatebook({
        fileName,
        contractType,
        csvContent: csvContent || fileContent,
      });
    }

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  })
);

/**
 * POST /api/admin/ratebooks/import-stream
 * Import a large ratebook CSV file via streaming (for files > 10MB)
 * Send CSV as text/plain or text/csv body with query params
 */
router.post(
  "/import-stream",
  asyncHandler(async (req: Request, res: Response) => {
    const { fileName, contractType, providerCode } = req.query as Record<string, string>;

    if (!fileName || !contractType) {
      throw new ApiError("Missing required query params: fileName, contractType", 400);
    }

    const provider = providerCode || "lex";
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new ApiError(`Provider '${provider}' is not supported. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`, 400);
    }

    // Get content from body
    let fileContent: string | Buffer;
    if (typeof req.body === "string") {
      fileContent = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      fileContent = req.body;
    } else {
      throw new ApiError("Request body must be file content", 400);
    }

    const contentLength = typeof fileContent === "string" ? fileContent.length : fileContent.length;
    if (!fileContent || contentLength < 10) {
      throw new ApiError("No file content in request body", 400);
    }

    console.log(`[import-stream] Received ${contentLength} bytes for ${fileName} (provider: ${provider})`);

    let result;
    if (provider === "ald") {
      result = await importALDRatebook({
        fileName,
        contractType,
        fileContent,
      });
    } else {
      const csvContent = typeof fileContent === "string" ? fileContent : fileContent.toString("utf8");
      result = await importLexRatebook({
        fileName,
        contractType,
        csvContent,
      });
    }

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  })
);

/**
 * POST /api/admin/ratebooks/import-chunked
 * Import a large ratebook CSV file in chunks
 * Each chunk is processed independently and results aggregated
 */
router.post(
  "/import-chunked",
  asyncHandler(async (req: Request, res: Response) => {
    const { fileName, contractType, providerCode, chunkIndex, totalChunks, headerRow } = req.query as Record<string, string>;

    if (!fileName || !contractType) {
      throw new ApiError("Missing required query params: fileName, contractType", 400);
    }

    const provider = providerCode || "lex";
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new ApiError(`Provider '${provider}' is not supported. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`, 400);
    }

    // Get content from body
    let fileContent: string | Buffer;
    if (typeof req.body === "string") {
      fileContent = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      fileContent = req.body;
    } else {
      throw new ApiError("Request body must be file content", 400);
    }

    // If this is not the first chunk and we have a header row, prepend it
    if (parseInt(chunkIndex || "0") > 0 && headerRow) {
      const contentStr = typeof fileContent === "string" ? fileContent : fileContent.toString("utf8");
      fileContent = decodeURIComponent(headerRow) + "\n" + contentStr;
    }

    const chunkNum = parseInt(chunkIndex || "0") + 1;
    const total = parseInt(totalChunks || "1");
    const contentLength = typeof fileContent === "string" ? fileContent.length : fileContent.length;
    console.log(`[import-chunked] Processing chunk ${chunkNum}/${total} for ${fileName} (${contentLength} bytes, provider: ${provider})`);

    let result;
    if (provider === "ald") {
      result = await importALDRatebook({
        fileName: `${fileName} (chunk ${chunkNum}/${total})`,
        contractType,
        fileContent,
      });
    } else {
      const csvContent = typeof fileContent === "string" ? fileContent : fileContent.toString("utf8");
      result = await importLexRatebook({
        fileName: `${fileName} (chunk ${chunkNum}/${total})`,
        contractType,
        csvContent,
      });
    }

    res.json({
      ...result,
      chunkIndex: parseInt(chunkIndex || "0"),
      totalChunks: total,
    });
  })
);

/**
 * POST /api/admin/ratebooks/import-with-mappings
 * Import a ratebook using custom column mappings (for any provider)
 * This endpoint supports dynamic column configuration from the UI
 */
router.post(
  "/import-with-mappings",
  asyncHandler(async (req: Request, res: Response) => {
    const { fileName, contractType, fileContent, providerCode, columnMappings } = req.body;

    if (!fileName || !contractType || !fileContent || !providerCode || !columnMappings) {
      throw new ApiError(
        "Missing required fields: fileName, contractType, fileContent, providerCode, columnMappings",
        400
      );
    }

    // Validate columnMappings has required fields
    const requiredFields = ["capCode", "manufacturer", "model", "term", "annualMileage", "totalRental"];
    const mappedFields = Object.values(columnMappings).filter(Boolean);
    const missingRequired = requiredFields.filter((f) => !mappedFields.includes(f));

    if (missingRequired.length > 0) {
      throw new ApiError(
        `Missing required field mappings: ${missingRequired.join(", ")}. Please map columns for these fields.`,
        400
      );
    }

    console.log(
      `[import-with-mappings] Importing ${fileName} for provider ${providerCode} with ${Object.keys(columnMappings).length} column mappings`
    );

    const result = await importGenericRatebook({
      fileName,
      contractType,
      fileContent,
      providerCode,
      columnMappings,
    });

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  })
);

/**
 * GET /api/admin/ratebooks/:importId
 * Get a specific ratebook import
 */
router.get(
  "/:importId",
  asyncHandler(async (req: Request, res: Response) => {
    const importId = req.params.importId;

    const [importRecord] = await db
      .select()
      .from(ratebookImports)
      .where(eq(ratebookImports.id, importId));

    if (!importRecord) {
      throw new ApiError("Import not found", 404);
    }

    // Get sample rates from this import
    const sampleRates = await db
      .select()
      .from(providerRates)
      .where(eq(providerRates.importId, importId))
      .limit(20);

    res.json({
      import: importRecord,
      sampleRates,
    });
  })
);

/**
 * DELETE /api/admin/ratebooks/:importId
 * Delete a ratebook import and its rates
 */
router.delete(
  "/:importId",
  asyncHandler(async (req: Request, res: Response) => {
    const importId = req.params.importId;

    // Delete rates first
    await db.delete(providerRates).where(eq(providerRates.importId, importId));

    // Delete import
    const [deleted] = await db
      .delete(ratebookImports)
      .where(eq(ratebookImports.id, importId))
      .returning();

    if (!deleted) {
      throw new ApiError("Import not found", 404);
    }

    res.json({ success: true, deleted: importId });
  })
);

export default router;
