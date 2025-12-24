/**
 * Lex Playwright Automation Routes
 *
 * API endpoints for running Playwright-based quote generation.
 */

import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { db } from "../lib/db/index.js";
import { lexPlaywrightBatches, lexPlaywrightQuotes, vehicles } from "../lib/db/schema.js";
import { eq, and, isNotNull, inArray, desc } from "drizzle-orm";
import {
  runBatchQuotes,
  testLogin,
  LexPlaywrightBatchConfig,
  LexPlaywrightProgress,
  ContractType,
  PaymentPlanId,
  PAYMENT_PLANS,
  CONTRACT_TYPES,
} from "../lib/lex-playwright/index.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Active batch jobs for SSE streaming
const activeBatches = new Map<
  string,
  {
    progress: LexPlaywrightProgress;
    clients: Response[];
  }
>();

// =============================================================================
// BATCH CONFIGURATION SCHEMA
// =============================================================================

const batchConfigSchema = z.object({
  vehicleIds: z.array(z.string().uuid()).min(1, "At least one vehicle required"),
  terms: z.array(z.number().min(12).max(60)).min(1, "At least one term required"),
  mileages: z.array(z.number().min(1000).max(100000)).min(1, "At least one mileage required"),
  contractTypes: z
    .array(z.enum(["CH", "CHNM"]))
    .min(1, "At least one contract type required"),
  paymentPlans: z
    .array(z.enum(["1", "7", "8", "9", "12", "17", "23", "26", "27", "39", "43", "106"]))
    .min(1, "At least one payment plan required"),
  useDefaultOtr: z.boolean().default(true),
  customOtrp: z.number().optional(), // In pence
});

// =============================================================================
// GET VEHICLES WITH LEX CODES
// =============================================================================

/**
 * GET /api/lex-playwright/vehicles
 * Get vehicles that have Lex codes for quoting
 */
router.get(
  "/vehicles",
  asyncHandler(async (req: Request, res: Response) => {
    const { manufacturer, search, limit = "100" } = req.query;

    let query = db
      .select({
        id: vehicles.id,
        manufacturer: vehicles.manufacturer,
        model: vehicles.model,
        variant: vehicles.variant,
        lexMakeCode: vehicles.lexMakeCode,
        lexModelCode: vehicles.lexModelCode,
        lexVariantCode: vehicles.lexVariantCode,
        co2: vehicles.co2,
        p11d: vehicles.p11d,
        fuelType: vehicles.fuelType,
      })
      .from(vehicles)
      .where(
        and(
          isNotNull(vehicles.lexMakeCode),
          isNotNull(vehicles.lexModelCode),
          isNotNull(vehicles.lexVariantCode)
        )
      )
      .orderBy(vehicles.manufacturer, vehicles.model, vehicles.variant)
      .limit(Math.min(parseInt(limit as string) || 100, 500));

    const results = await query;

    // Filter by manufacturer or search if provided
    let filtered = results;
    if (manufacturer) {
      filtered = filtered.filter(
        (v) => v.manufacturer.toLowerCase() === (manufacturer as string).toLowerCase()
      );
    }
    if (search) {
      const searchLower = (search as string).toLowerCase();
      filtered = filtered.filter(
        (v) =>
          v.manufacturer.toLowerCase().includes(searchLower) ||
          v.model.toLowerCase().includes(searchLower) ||
          (v.variant && v.variant.toLowerCase().includes(searchLower))
      );
    }

    res.json({
      success: true,
      vehicles: filtered,
      count: filtered.length,
    });
  })
);

// =============================================================================
// GET PAYMENT PLANS AND CONTRACT TYPES
// =============================================================================

/**
 * GET /api/lex-playwright/options
 * Get available payment plans and contract types
 */
router.get(
  "/options",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      paymentPlans: Object.entries(PAYMENT_PLANS).map(([id, name]) => ({ id, name })),
      contractTypes: Object.entries(CONTRACT_TYPES).map(([code, info]) => ({
        code,
        name: info.name,
        selectorValue: info.code,
      })),
    });
  })
);

// =============================================================================
// TEST LOGIN
// =============================================================================

/**
 * POST /api/lex-playwright/test-login
 * Test Lex credentials without running quotes
 */
router.post(
  "/test-login",
  asyncHandler(async (req: Request, res: Response) => {
    // Check if credentials are configured
    if (!process.env.LEX_USERNAME || !process.env.LEX_PASSWORD) {
      throw new ApiError(
        "LEX_USERNAME and LEX_PASSWORD environment variables must be set",
        500
      );
    }

    const result = await testLogin();

    if (result.success) {
      res.json({ success: true, message: "Login successful" });
    } else {
      throw new ApiError(result.error || "Login failed", 401);
    }
  })
);

// =============================================================================
// START BATCH
// =============================================================================

/**
 * POST /api/lex-playwright/batch
 * Start a new batch quote job
 */
router.post(
  "/batch",
  asyncHandler(async (req: Request, res: Response) => {
    const config = batchConfigSchema.parse(req.body);
    const userId = req.user?.id;

    if (!userId) {
      throw new ApiError("User not authenticated", 401);
    }

    // Check if credentials are configured
    if (!process.env.LEX_USERNAME || !process.env.LEX_PASSWORD) {
      throw new ApiError(
        "LEX_USERNAME and LEX_PASSWORD environment variables must be set",
        500
      );
    }

    // Verify all vehicles exist and have Lex codes
    const vehicleCheck = await db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(
        and(
          inArray(vehicles.id, config.vehicleIds),
          isNotNull(vehicles.lexMakeCode),
          isNotNull(vehicles.lexModelCode),
          isNotNull(vehicles.lexVariantCode)
        )
      );

    if (vehicleCheck.length !== config.vehicleIds.length) {
      throw new ApiError(
        `Only ${vehicleCheck.length} of ${config.vehicleIds.length} vehicles have valid Lex codes`,
        400
      );
    }

    // Calculate total combinations
    const totalCombinations =
      config.vehicleIds.length *
      config.terms.length *
      config.mileages.length *
      config.contractTypes.length *
      config.paymentPlans.length;

    // Create batch record
    const batchId = uuidv4();
    await db.insert(lexPlaywrightBatches).values({
      batchId,
      status: "pending",
      vehicleIds: config.vehicleIds,
      terms: config.terms,
      mileages: config.mileages,
      contractTypes: config.contractTypes,
      paymentPlans: config.paymentPlans,
      useDefaultOtr: config.useDefaultOtr,
      customOtrp: config.customOtrp,
      totalCombinations,
      createdBy: userId,
    });

    // Initialize active batch for SSE
    activeBatches.set(batchId, {
      progress: {
        status: "starting",
        currentVehicle: 0,
        totalVehicles: config.vehicleIds.length,
        currentCombination: 0,
        totalCombinations,
      },
      clients: [],
    });

    // Start batch processing in background
    processBatch(batchId, config as LexPlaywrightBatchConfig, userId);

    res.json({
      success: true,
      batchId,
      totalCombinations,
      message: "Batch started. Connect to SSE endpoint for progress updates.",
    });
  })
);

/**
 * Process batch in background
 */
async function processBatch(
  batchId: string,
  config: LexPlaywrightBatchConfig,
  userId: string
): Promise<void> {
  const batch = activeBatches.get(batchId);

  try {
    // Update batch status to running
    await db
      .update(lexPlaywrightBatches)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(lexPlaywrightBatches.batchId, batchId));

    // Run batch with progress callback
    const result = await runBatchQuotes(config, (progress) => {
      if (batch) {
        batch.progress = progress;
        // Send to all connected SSE clients
        for (const client of batch.clients) {
          client.write(`event: progress\n`);
          client.write(`data: ${JSON.stringify(progress)}\n\n`);
        }
      }
    });

    // Save quotes to database
    for (const quote of result.quotes) {
      await db.insert(lexPlaywrightQuotes).values({
        batchId,
        vehicleId: quote.vehicleId,
        term: quote.term,
        annualMileage: quote.annualMileage,
        contractType: quote.contractType,
        paymentPlan: quote.paymentPlan,
        otrpUsed: quote.otrpUsed,
        usedCustomOtr: quote.usedCustomOtr,
        quoteNumber: quote.quoteNumber,
        monthlyRental: quote.monthlyRental,
        initialRental: quote.initialRental,
        status: quote.success ? "success" : "error",
        errorMessage: quote.error,
      });
    }

    // Update batch status to completed
    await db
      .update(lexPlaywrightBatches)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedCount: result.totalQuotes,
        successCount: result.successCount,
        errorCount: result.errorCount,
      })
      .where(eq(lexPlaywrightBatches.batchId, batchId));

    // Send completion to SSE clients
    if (batch) {
      for (const client of batch.clients) {
        client.write(`event: complete\n`);
        client.write(
          `data: ${JSON.stringify({
            batchId,
            totalQuotes: result.totalQuotes,
            successCount: result.successCount,
            errorCount: result.errorCount,
          })}\n\n`
        );
        client.end();
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Update batch status to failed
    await db
      .update(lexPlaywrightBatches)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(lexPlaywrightBatches.batchId, batchId));

    // Send error to SSE clients
    if (batch) {
      for (const client of batch.clients) {
        client.write(`event: error\n`);
        client.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
        client.end();
      }
    }
  } finally {
    // Clean up active batch
    activeBatches.delete(batchId);
  }
}

// =============================================================================
// SSE STREAM
// =============================================================================

/**
 * GET /api/lex-playwright/batch/:batchId/stream
 * SSE endpoint for progress updates
 */
router.get(
  "/batch/:batchId/stream",
  asyncHandler(async (req: Request, res: Response) => {
    const { batchId } = req.params;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    // Check if batch exists
    const batchRecord = await db
      .select()
      .from(lexPlaywrightBatches)
      .where(eq(lexPlaywrightBatches.batchId, batchId))
      .limit(1);

    if (batchRecord.length === 0) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: "Batch not found" })}\n\n`);
      res.end();
      return;
    }

    const batch = batchRecord[0];

    // If batch is already completed or failed, send final status
    if (batch.status === "completed" || batch.status === "failed") {
      res.write(`event: ${batch.status === "completed" ? "complete" : "error"}\n`);
      res.write(
        `data: ${JSON.stringify({
          batchId,
          status: batch.status,
          successCount: batch.successCount,
          errorCount: batch.errorCount,
          error: batch.errorMessage,
        })}\n\n`
      );
      res.end();
      return;
    }

    // Add client to active batch
    const activeBatch = activeBatches.get(batchId);
    if (activeBatch) {
      activeBatch.clients.push(res);

      // Send current progress immediately
      res.write(`event: progress\n`);
      res.write(`data: ${JSON.stringify(activeBatch.progress)}\n\n`);

      // Handle client disconnect
      req.on("close", () => {
        const index = activeBatch.clients.indexOf(res);
        if (index > -1) {
          activeBatch.clients.splice(index, 1);
        }
      });
    } else {
      // Batch is pending but not yet in active list
      res.write(`event: progress\n`);
      res.write(
        `data: ${JSON.stringify({
          status: "pending",
          currentVehicle: 0,
          totalVehicles: batch.vehicleIds?.length || 0,
          currentCombination: 0,
          totalCombinations: batch.totalCombinations || 0,
        })}\n\n`
      );
    }
  })
);

// =============================================================================
// GET BATCH STATUS
// =============================================================================

/**
 * GET /api/lex-playwright/batch/:batchId
 * Get batch status and results
 */
router.get(
  "/batch/:batchId",
  asyncHandler(async (req: Request, res: Response) => {
    const { batchId } = req.params;

    const batchRecord = await db
      .select()
      .from(lexPlaywrightBatches)
      .where(eq(lexPlaywrightBatches.batchId, batchId))
      .limit(1);

    if (batchRecord.length === 0) {
      throw new ApiError("Batch not found", 404);
    }

    const batch = batchRecord[0];

    // Get quotes for this batch
    const quotes = await db
      .select()
      .from(lexPlaywrightQuotes)
      .where(eq(lexPlaywrightQuotes.batchId, batchId));

    res.json({
      success: true,
      batch: {
        batchId: batch.batchId,
        status: batch.status,
        totalCombinations: batch.totalCombinations,
        processedCount: batch.processedCount,
        successCount: batch.successCount,
        errorCount: batch.errorCount,
        errorMessage: batch.errorMessage,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
        createdAt: batch.createdAt,
      },
      quotes,
    });
  })
);

// =============================================================================
// LIST BATCHES
// =============================================================================

/**
 * GET /api/lex-playwright/batches
 * List recent batch jobs
 */
router.get(
  "/batches",
  asyncHandler(async (req: Request, res: Response) => {
    const { limit = "20" } = req.query;

    const batches = await db
      .select()
      .from(lexPlaywrightBatches)
      .orderBy(desc(lexPlaywrightBatches.createdAt))
      .limit(Math.min(parseInt(limit as string) || 20, 100));

    res.json({
      success: true,
      batches: batches.map((b) => ({
        batchId: b.batchId,
        status: b.status,
        totalCombinations: b.totalCombinations,
        processedCount: b.processedCount,
        successCount: b.successCount,
        errorCount: b.errorCount,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
        createdAt: b.createdAt,
      })),
    });
  })
);

export default router;
