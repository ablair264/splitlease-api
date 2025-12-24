import { Router, Request, Response } from "express";
import { db } from "../../lib/db/index.js";
import { ratebookImports, financeProviders, providerRates } from "../../lib/db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { asyncHandler, ApiError } from "../../middleware/error.js";

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
