import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  loginToOgilvie,
  validateOgilvieSession,
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

// =============================================================================
// BACKGROUND JOB TRACKING
// =============================================================================

type ExportJobStatus = {
  jobId: string;
  status: "running" | "completed" | "failed";
  configs: OgilvieExportConfig[];
  currentConfigIndex: number;
  totalConfigs: number;
  currentProgress: {
    status: string;
    currentPage: number;
    totalPages: number;
    vehiclesProcessed: number;
  } | null;
  results: Array<{
    config: { contractTerm: number; contractMileage: number };
    success: boolean;
    batchId?: string;
    error?: string;
  }>;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
};

// In-memory job tracker (for production, use Redis or DB)
const exportJobs = new Map<string, ExportJobStatus>();

// Clean up old jobs (older than 1 hour)
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [jobId, job] of exportJobs.entries()) {
    if (job.startedAt.getTime() < oneHourAgo) {
      exportJobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000); // Run every 10 minutes

const router = Router();

// All routes require authentication
router.use(requireAuth);

// =============================================================================
// LOGIN
// =============================================================================

const loginSchema = z.object({
  email: z.string().min(1), // Ogilvie uses username, not email
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

/**
 * POST /api/ogilvie/export/start
 * Start a background export job, returns job ID immediately
 */
router.post(
  "/export/start",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError("User not authenticated", 401);
    }

    const { configs } = req.body as { configs?: OgilvieExportConfig[] };
    if (!configs || configs.length === 0) {
      throw new ApiError("configs array is required", 400);
    }

    const session = await getCachedOgilvieSession(userId);
    if (!session) {
      throw new ApiError("No Ogilvie session. Please login first.", 401);
    }

    const isValid = await validateOgilvieSession(session.sessionCookie);
    if (!isValid) {
      throw new ApiError("Ogilvie session expired. Please login again.", 401);
    }

    // Create job ID
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Initialize job status
    const jobStatus: ExportJobStatus = {
      jobId,
      status: "running",
      configs,
      currentConfigIndex: 0,
      totalConfigs: configs.length,
      currentProgress: null,
      results: [],
      startedAt: new Date(),
    };
    exportJobs.set(jobId, jobStatus);

    // Run export in background (don't await)
    runExportJob(jobId, session.sessionCookie, configs).catch((error) => {
      console.error(`Export job ${jobId} failed:`, error);
      const job = exportJobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "Unknown error";
        job.completedAt = new Date();
      }
    });

    // Return job ID immediately
    res.json({
      success: true,
      jobId,
      message: "Export started in background",
    });
  })
);

/**
 * GET /api/ogilvie/export/status/:jobId
 * Poll for export job status
 */
router.get(
  "/export/status/:jobId",
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;

    const job = exportJobs.get(jobId);
    if (!job) {
      throw new ApiError("Job not found", 404);
    }

    res.json({
      jobId: job.jobId,
      status: job.status,
      currentConfigIndex: job.currentConfigIndex,
      totalConfigs: job.totalConfigs,
      currentProgress: job.currentProgress,
      results: job.results,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    });
  })
);

/**
 * Run export job in background
 */
async function runExportJob(
  jobId: string,
  sessionCookie: string,
  configs: OgilvieExportConfig[]
): Promise<void> {
  const job = exportJobs.get(jobId);
  if (!job) return;

  try {
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      job.currentConfigIndex = i;
      job.currentProgress = {
        status: "preparing",
        currentPage: 0,
        totalPages: 0,
        vehiclesProcessed: 0,
      };

      const result = await runOgilvieExport(
        sessionCookie,
        config,
        (progress) => {
          job.currentProgress = {
            status: progress.status,
            currentPage: progress.currentPage,
            totalPages: progress.totalPages,
            vehiclesProcessed: progress.vehiclesProcessed,
          };
        }
      );

      job.results.push({
        config: { contractTerm: config.contractTerm, contractMileage: config.contractMileage },
        success: result.success,
        batchId: result.batchId,
        error: result.error,
      });

      // Small delay between configs
      if (i < configs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    job.status = "completed";
    job.completedAt = new Date();
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Unknown error";
    job.completedAt = new Date();
    throw error;
  }
}

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
