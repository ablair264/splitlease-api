import { Router, Request, Response } from "express";
import { db } from "../lib/db/index.js";
import {
  lexSessions,
  lexQuotes,
  lexQuoteRequests,
  vehicles,
  fleetMarqueTerms,
} from "../lib/db/schema.js";
import { eq, desc, and, gt, isNull, sql, isNotNull } from "drizzle-orm";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { LexApiClient, type LexQuoteParams } from "../lib/lex/api-client.js";
import { z } from "zod";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// =============================================================================
// LOGIN
// =============================================================================

/**
 * POST /api/lex-autolease/login
 * Login with email/password and create session
 */
router.post(
  "/login",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new ApiError("Email and password are required", 400);
    }

    const client = await LexApiClient.login(email, password);

    res.json({
      success: true,
      message: "Login successful",
      session: await getSessionInfo(),
    });
  })
);

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

/**
 * GET /api/lex-autolease/session
 * Check if a valid session exists
 */
router.get(
  "/session",
  asyncHandler(async (req: Request, res: Response) => {
    const session = await db
      .select()
      .from(lexSessions)
      .where(
        and(eq(lexSessions.isValid, true), gt(lexSessions.expiresAt, new Date()))
      )
      .orderBy(desc(lexSessions.createdAt))
      .limit(1);

    if (session.length === 0) {
      res.json({ hasValidSession: false });
      return;
    }

    const s = session[0];
    res.json({
      hasValidSession: true,
      session: {
        id: s.id,
        username: s.profileData?.Username || "Unknown",
        expiresAt: s.expiresAt,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
      },
    });
  })
);

/**
 * POST /api/lex-autolease/session
 * Save session from browser capture
 */
router.post(
  "/session",
  asyncHandler(async (req: Request, res: Response) => {
    const { csrfToken, profile, cookies } = req.body;

    if (!csrfToken || !cookies) {
      throw new ApiError("csrfToken and cookies are required", 400);
    }

    // Invalidate existing sessions
    await db
      .update(lexSessions)
      .set({ isValid: false })
      .where(eq(lexSessions.isValid, true));

    // Calculate expiry (8 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 8);

    // Store new session
    const [newSession] = await db
      .insert(lexSessions)
      .values({
        userId: req.user?.id || null,
        sessionCookies: cookies,
        csrfToken,
        profileData: profile || {
          SalesCode: "",
          Discount: "-1",
          RVCode: "00",
          Role: "",
          Username: "",
        },
        isValid: true,
        expiresAt,
      })
      .returning();

    res.json({
      success: true,
      session: {
        id: newSession.id,
        username: newSession.profileData?.Username || "Unknown",
        expiresAt: newSession.expiresAt,
      },
    });
  })
);

/**
 * DELETE /api/lex-autolease/session
 * Invalidate current session
 */
router.delete(
  "/session",
  asyncHandler(async (req: Request, res: Response) => {
    await db
      .update(lexSessions)
      .set({ isValid: false })
      .where(eq(lexSessions.isValid, true));

    res.json({ success: true, message: "Session invalidated" });
  })
);

// =============================================================================
// QUOTE REQUESTS (Batch Jobs)
// =============================================================================

const createRequestSchema = z.object({
  term: z.number().min(12).max(60),
  annualMileage: z.number().min(1000).max(100000),
  initialRentalMonths: z.number().min(1).max(12).optional().default(1),
  maintenanceIncluded: z.boolean().optional().default(false),
  vehicleIds: z.array(z.string().uuid()).optional(),
});

/**
 * GET /api/lex-autolease/requests
 * List quote requests
 */
router.get(
  "/requests",
  asyncHandler(async (req: Request, res: Response) => {
    const requests = await db
      .select()
      .from(lexQuoteRequests)
      .orderBy(desc(lexQuoteRequests.createdAt))
      .limit(50);

    res.json({ requests });
  })
);

/**
 * POST /api/lex-autolease/requests
 * Create a new quote request
 */
router.post(
  "/requests",
  asyncHandler(async (req: Request, res: Response) => {
    const data = createRequestSchema.parse(req.body);

    // Count vehicles that have Lex codes
    let vehicleCount: number;

    if (data.vehicleIds && data.vehicleIds.length > 0) {
      vehicleCount = data.vehicleIds.length;
    } else {
      const [result] = await db
        .select({ count: sql<number>`count(*)` })
        .from(vehicles)
        .where(
          and(
            isNotNull(vehicles.lexMakeCode),
            isNotNull(vehicles.lexModelCode),
            isNotNull(vehicles.lexVariantCode)
          )
        );
      vehicleCount = Number(result?.count || 0);
    }

    if (vehicleCount === 0) {
      throw new ApiError("No vehicles with Lex codes found", 400);
    }

    const batchId = `lex_${Date.now()}`;

    const [request] = await db
      .insert(lexQuoteRequests)
      .values({
        batchId,
        status: "pending",
        totalVehicles: vehicleCount,
        term: data.term,
        annualMileage: data.annualMileage,
        initialRentalMonths: data.initialRentalMonths,
        maintenanceIncluded: data.maintenanceIncluded,
      })
      .returning();

    res.status(201).json({ request });
  })
);

/**
 * PATCH /api/lex-autolease/requests/:id
 * Update request status
 */
router.patch(
  "/requests/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;

    const [updated] = await db
      .update(lexQuoteRequests)
      .set(updates)
      .where(eq(lexQuoteRequests.id, id))
      .returning();

    if (!updated) {
      throw new ApiError("Request not found", 404);
    }

    res.json({ request: updated });
  })
);

/**
 * DELETE /api/lex-autolease/requests/:id
 * Delete a quote request
 */
router.delete(
  "/requests/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    await db.delete(lexQuoteRequests).where(eq(lexQuoteRequests.id, id));

    res.json({ success: true });
  })
);

// =============================================================================
// RUN QUOTES
// =============================================================================

const runQuotesSchema = z.object({
  requestId: z.string().uuid().optional(),
  term: z.number().min(12).max(60),
  annualMileage: z.number().min(1000).max(100000),
  contractType: z.string().optional().default("contract_hire_without_maintenance"),
  paymentPlan: z.string().optional().default("spread_3_down"),
  vehicleIds: z.array(z.string().uuid()).optional(),
  useFleetDiscounts: z.boolean().optional().default(true),
});

/**
 * POST /api/lex-autolease/run-quotes
 * Run quotes for vehicles with Lex codes
 */
router.post(
  "/run-quotes",
  asyncHandler(async (req: Request, res: Response) => {
    const data = runQuotesSchema.parse(req.body);

    // Get or validate session
    const client = await LexApiClient.getValidSession();
    if (!client) {
      throw new ApiError("No valid Lex session. Please login first.", 401);
    }

    // Get vehicles with Lex codes
    let vehicleList;
    if (data.vehicleIds && data.vehicleIds.length > 0) {
      vehicleList = await db
        .select()
        .from(vehicles)
        .where(
          and(
            sql`${vehicles.id} = ANY(${data.vehicleIds})`,
            isNotNull(vehicles.lexMakeCode),
            isNotNull(vehicles.lexModelCode),
            isNotNull(vehicles.lexVariantCode)
          )
        );
    } else {
      vehicleList = await db
        .select()
        .from(vehicles)
        .where(
          and(
            isNotNull(vehicles.lexMakeCode),
            isNotNull(vehicles.lexModelCode),
            isNotNull(vehicles.lexVariantCode)
          )
        )
        .limit(100); // Limit batch size
    }

    if (vehicleList.length === 0) {
      throw new ApiError("No vehicles with Lex codes found", 400);
    }

    // Update request if provided
    if (data.requestId) {
      await db
        .update(lexQuoteRequests)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(lexQuoteRequests.id, data.requestId));
    }

    // Get fleet discounts if enabled
    const fleetDiscounts = new Map<string, number>();
    if (data.useFleetDiscounts) {
      const discounts = await db
        .select({
          capCode: fleetMarqueTerms.capCode,
          discountedPrice: fleetMarqueTerms.discountedPrice,
        })
        .from(fleetMarqueTerms)
        .where(isNotNull(fleetMarqueTerms.discountedPrice));

      for (const d of discounts) {
        if (d.capCode && d.discountedPrice) {
          fleetDiscounts.set(d.capCode, d.discountedPrice);
        }
      }
    }

    const results: Array<{
      vehicleId: string;
      success: boolean;
      quote?: unknown;
      error?: string;
    }> = [];
    let successCount = 0;
    let errorCount = 0;

    for (const vehicle of vehicleList) {
      try {
        // Check for fleet discount
        const fleetDiscount = vehicle.capCode
          ? fleetDiscounts.get(vehicle.capCode)
          : undefined;

        const quoteParams: LexQuoteParams = {
          makeId: vehicle.lexMakeCode!,
          modelId: vehicle.lexModelCode!,
          variantId: vehicle.lexVariantCode!,
          term: data.term,
          mileage: data.annualMileage,
          contractType: data.contractType as LexQuoteParams["contractType"],
          paymentPlan: data.paymentPlan as LexQuoteParams["paymentPlan"],
          brokerOtrp: fleetDiscount ? fleetDiscount / 100 : undefined, // Convert pence to pounds
        };

        const result = await client.runQuote(quoteParams);

        if (result.success) {
          // Save quote to database
          await db.insert(lexQuotes).values({
            vehicleId: vehicle.id,
            capCode: vehicle.capCode,
            makeCode: vehicle.lexMakeCode!,
            modelCode: vehicle.lexModelCode!,
            variantCode: vehicle.lexVariantCode!,
            make: vehicle.manufacturer,
            model: vehicle.model,
            variant: vehicle.variant,
            term: data.term,
            annualMileage: data.annualMileage,
            paymentPlan: data.paymentPlan,
            monthlyRental: Math.round((result.monthlyRental || 0) * 100),
            initialRental: Math.round((result.initialRental || 0) * 100),
            otrp: Math.round((result.otrp || 0) * 100),
            brokerOtrp: fleetDiscount || null,
            contractType: result.contractType || data.contractType,
            usedFleetDiscount: Boolean(fleetDiscount),
            status: "success",
            quotedAt: new Date(),
          });

          successCount++;
          results.push({
            vehicleId: vehicle.id,
            success: true,
            quote: result,
          });
        } else {
          errorCount++;
          results.push({
            vehicleId: vehicle.id,
            success: false,
            error: result.error,
          });
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        errorCount++;
        results.push({
          vehicleId: vehicle.id,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    // Update request if provided
    if (data.requestId) {
      await db
        .update(lexQuoteRequests)
        .set({
          status: "completed",
          completedAt: new Date(),
          processedCount: vehicleList.length,
          successCount,
          errorCount,
        })
        .where(eq(lexQuoteRequests.id, data.requestId));
    }

    res.json({
      success: true,
      totalProcessed: vehicleList.length,
      successCount,
      errorCount,
      results,
    });
  })
);

// =============================================================================
// VEHICLES (Lex Code Management)
// =============================================================================

/**
 * GET /api/lex-autolease/vehicles
 * List vehicles with optional Lex code filter
 */
router.get(
  "/vehicles",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      hasLexCodes,
      manufacturer,
      limit: limitParam = "50",
      offset: offsetParam = "0",
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitParam || "50"), 200);
    const offset = parseInt(offsetParam || "0");

    const conditions = [];

    if (hasLexCodes === "true") {
      conditions.push(isNotNull(vehicles.lexMakeCode));
      conditions.push(isNotNull(vehicles.lexModelCode));
      conditions.push(isNotNull(vehicles.lexVariantCode));
    } else if (hasLexCodes === "false") {
      conditions.push(
        sql`(${vehicles.lexMakeCode} IS NULL OR ${vehicles.lexModelCode} IS NULL OR ${vehicles.lexVariantCode} IS NULL)`
      );
    }

    if (manufacturer) {
      conditions.push(eq(vehicles.manufacturer, manufacturer.toUpperCase()));
    }

    const vehicleList = await db
      .select()
      .from(vehicles)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(vehicles.manufacturer, vehicles.model)
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(vehicles)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    res.json({
      vehicles: vehicleList,
      pagination: {
        total: Number(countResult?.count || 0),
        limit,
        offset,
        hasMore: offset + vehicleList.length < Number(countResult?.count || 0),
      },
    });
  })
);

/**
 * PATCH /api/lex-autolease/vehicles/:id
 * Update Lex codes for a vehicle
 */
router.patch(
  "/vehicles/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { lexMakeCode, lexModelCode, lexVariantCode } = req.body;

    const [updated] = await db
      .update(vehicles)
      .set({
        lexMakeCode: lexMakeCode || null,
        lexModelCode: lexModelCode || null,
        lexVariantCode: lexVariantCode || null,
      })
      .where(eq(vehicles.id, id))
      .returning();

    if (!updated) {
      throw new ApiError("Vehicle not found", 404);
    }

    res.json({ vehicle: updated });
  })
);

// =============================================================================
// QUOTES
// =============================================================================

/**
 * GET /api/lex-autolease/quotes
 * List saved quotes
 */
router.get(
  "/quotes",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      vehicleId,
      term,
      limit: limitParam = "50",
      offset: offsetParam = "0",
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitParam || "50"), 200);
    const offset = parseInt(offsetParam || "0");

    const conditions = [];

    if (vehicleId) {
      conditions.push(eq(lexQuotes.vehicleId, vehicleId));
    }
    if (term) {
      conditions.push(eq(lexQuotes.term, parseInt(term)));
    }

    const quotes = await db
      .select()
      .from(lexQuotes)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(lexQuotes.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lexQuotes)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    res.json({
      quotes,
      pagination: {
        total: Number(countResult?.count || 0),
        limit,
        offset,
        hasMore: offset + quotes.length < Number(countResult?.count || 0),
      },
    });
  })
);

/**
 * POST /api/lex-autolease/quotes
 * Manually add a quote
 */
router.post(
  "/quotes",
  asyncHandler(async (req: Request, res: Response) => {
    const data = req.body;

    const [quote] = await db
      .insert(lexQuotes)
      .values({
        vehicleId: data.vehicleId || null,
        capCode: data.capCode || null,
        makeCode: data.makeCode,
        modelCode: data.modelCode,
        variantCode: data.variantCode,
        make: data.make,
        model: data.model,
        variant: data.variant,
        term: data.term,
        annualMileage: data.annualMileage,
        paymentPlan: data.paymentPlan || "monthly_in_advance",
        monthlyRental: data.monthlyRental,
        initialRental: data.initialRental,
        otrp: data.otrp,
        brokerOtrp: data.brokerOtrp,
        contractType: data.contractType,
        status: data.status || "pending",
      })
      .returning();

    res.status(201).json({ quote });
  })
);

/**
 * DELETE /api/lex-autolease/quotes/:id
 * Delete a quote
 */
router.delete(
  "/quotes/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    await db.delete(lexQuotes).where(eq(lexQuotes.id, id));

    res.json({ success: true });
  })
);

// Helper function to get session info
async function getSessionInfo() {
  const session = await db
    .select()
    .from(lexSessions)
    .where(
      and(eq(lexSessions.isValid, true), gt(lexSessions.expiresAt, new Date()))
    )
    .orderBy(desc(lexSessions.createdAt))
    .limit(1);

  if (session.length === 0) return null;

  const s = session[0];
  return {
    id: s.id,
    username: s.profileData?.Username || "Unknown",
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
  };
}

export default router;
