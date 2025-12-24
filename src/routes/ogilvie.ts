import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  loginToOgilvie,
  validateOgilvieSession,
  getOgilvieManufacturers,
  runOgilvieExport,
  runOgilvieMultiExport,
  getOgilvieExports,
  getOgilvieExport,
  deleteOgilvieExport,
  cacheOgilvieSession,
  getCachedOgilvieSession,
  processOgilvieToProviderRates,
} from "../lib/scraper/ogilvie.js";
import type { OgilvieExportConfig } from "../lib/db/schema.js";
import { z } from "zod";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// =============================================================================
// LOGIN
// =============================================================================

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * POST /api/ogilvie/login
 * Login to Ogilvie and cache session
 */
router.post(
  "/login",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = loginSchema.parse(req.body);

    const result = await loginToOgilvie(email, password);

    if (result.success && result.sessionCookie) {
      // Get user ID from request (set by auth middleware)
      const userId = req.user?.id;
      if (!userId) {
        throw new ApiError("User ID not available", 401);
      }

      // Cache the session
      await cacheOgilvieSession(userId, result.sessionCookie, result.verificationToken);

      res.json({
        success: true,
        message: "Login successful",
        username: email,
      });
    } else {
      throw new ApiError(result.error || "Login failed", 401);
    }
  })
);

// =============================================================================
// SESSION VALIDATION
// =============================================================================

/**
 * GET /api/ogilvie/validate
 * Validate the cached session is still active
 */
router.get(
  "/validate",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      res.json({
        valid: false,
        error: "User not authenticated",
      });
      return;
    }

    const session = await getCachedOgilvieSession(userId);

    if (!session) {
      res.json({
        valid: false,
        error: "No cached session found",
      });
      return;
    }

    const isValid = await validateOgilvieSession(session.sessionCookie);

    if (!isValid) {
      res.json({
        valid: false,
        error: "Session expired or invalid",
      });
      return;
    }

    res.json({
      valid: true,
      createdAt: session.createdAt,
    });
  })
);

// =============================================================================
// MANUFACTURERS
// =============================================================================

/**
 * GET /api/ogilvie/manufacturers
 * Get list of manufacturers available for export
 */
router.get(
  "/manufacturers",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError("User not authenticated", 401);
    }

    const session = await getCachedOgilvieSession(userId);

    if (!session) {
      throw new ApiError("No valid session. Please login first.", 401);
    }

    const isValid = await validateOgilvieSession(session.sessionCookie);
    if (!isValid) {
      throw new ApiError("Session expired. Please login again.", 401);
    }

    const manufacturers = await getOgilvieManufacturers(session.sessionCookie);

    res.json({ manufacturers });
  })
);

// =============================================================================
// EXPORTS
// =============================================================================

const exportConfigSchema = z.object({
  contractTerm: z.number().min(12).max(60).default(24),
  contractMileage: z.number().min(5000).max(100000).default(20000),
  productId: z.string().optional(),
  paymentPlanId: z.string().optional(),
  qualifyingFlag: z.string().optional(),
  rflFundingFlag: z.string().optional(),
  manufacturerIds: z.array(z.number()).optional(),
});

const exportSchema = z.object({
  config: exportConfigSchema.optional(),
  configs: z.array(exportConfigSchema).optional(),
  // If neither is provided, use default config
});

/**
 * POST /api/ogilvie/export
 * Run a single or multi-config export
 */
router.post(
  "/export",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError("User not authenticated", 401);
    }

    const session = await getCachedOgilvieSession(userId);
    if (!session) {
      throw new ApiError("No valid session. Please login first.", 401);
    }

    const isValid = await validateOgilvieSession(session.sessionCookie);
    if (!isValid) {
      throw new ApiError("Session expired. Please login again.", 401);
    }

    const data = exportSchema.parse(req.body);

    let result;

    if (data.configs && data.configs.length > 0) {
      // Multi-config export
      result = await runOgilvieMultiExport(
        session.sessionCookie,
        data.configs as OgilvieExportConfig[]
      );
    } else {
      // Single export with provided or default config
      const config: OgilvieExportConfig = data.config || {
        contractTerm: 24,
        contractMileage: 20000,
      };
      result = await runOgilvieExport(session.sessionCookie, config);
    }

    res.json(result);
  })
);

/**
 * GET /api/ogilvie/exports
 * List export batches
 */
router.get(
  "/exports",
  asyncHandler(async (req: Request, res: Response) => {
    const { limit: limitParam = "20" } = req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitParam || "20"), 100);

    const exports = await getOgilvieExports(limit);

    res.json({ exports });
  })
);

/**
 * GET /api/ogilvie/exports/:batchId
 * Get details of a specific export batch
 */
router.get(
  "/exports/:batchId",
  asyncHandler(async (req: Request, res: Response) => {
    const { batchId } = req.params;

    const exportData = await getOgilvieExport(batchId);

    if (!exportData) {
      throw new ApiError("Export not found", 404);
    }

    res.json({ export: exportData });
  })
);

/**
 * DELETE /api/ogilvie/exports/:batchId
 * Delete an export batch
 */
router.delete(
  "/exports/:batchId",
  asyncHandler(async (req: Request, res: Response) => {
    const { batchId } = req.params;

    await deleteOgilvieExport(batchId);

    res.json({ success: true, message: "Export deleted" });
  })
);

// =============================================================================
// PROCESS TO PROVIDER RATES
// =============================================================================

const processSchema = z.object({
  batchId: z.string().min(1),
});

/**
 * POST /api/ogilvie/process
 * Process Ogilvie ratebook data into provider_rates
 */
router.post(
  "/process",
  asyncHandler(async (req: Request, res: Response) => {
    const { batchId } = processSchema.parse(req.body);

    const result = await processOgilvieToProviderRates(batchId);

    res.json(result);
  })
);

export default router;
