import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  runFleetMarqueScraper,
  getScrapeBatches,
  getFleetMarqueTerms,
  deleteScrapeBatch,
  FLEET_MARQUE_MAKES,
} from "../lib/scraper/fleet-marque.js";
import { z } from "zod";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// =============================================================================
// MAKES (Reference Data)
// =============================================================================

/**
 * GET /api/fleet-marque/makes
 * Get list of available makes for scraping
 */
router.get(
  "/makes",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ makes: FLEET_MARQUE_MAKES });
  })
);

// =============================================================================
// SCRAPE
// =============================================================================

const scrapeSchema = z.object({
  // Auth options - either email/password or sid/phpsessid
  email: z.string().email().optional(),
  password: z.string().optional(),
  sid: z.string().optional(),
  phpsessid: z.string().optional(),

  // Optional filters
  makes: z.array(z.string()).optional(),

  // Rate limiting
  minDelay: z.number().min(500).max(10000).optional().default(1000),
  maxDelay: z.number().min(1000).max(30000).optional().default(3000),
  betweenMakes: z.number().min(1000).max(60000).optional().default(5000),
});

/**
 * POST /api/fleet-marque/scrape
 * Run Fleet Marque scraper
 */
router.post(
  "/scrape",
  asyncHandler(async (req: Request, res: Response) => {
    const data = scrapeSchema.parse(req.body);

    // Validate auth is provided
    const hasCredentials = data.email && data.password;
    const hasSession = data.sid && data.phpsessid;

    if (!hasCredentials && !hasSession) {
      throw new ApiError(
        "Authentication required. Provide either email/password or sid/phpsessid",
        400
      );
    }

    const result = await runFleetMarqueScraper(
      {
        email: data.email,
        password: data.password,
        sid: data.sid,
        phpsessid: data.phpsessid,
        minDelay: data.minDelay,
        maxDelay: data.maxDelay,
        betweenMakes: data.betweenMakes,
      },
      data.makes
    );

    res.json({
      success: true,
      ...result,
    });
  })
);

// =============================================================================
// BATCHES
// =============================================================================

/**
 * GET /api/fleet-marque/batches
 * Get scrape batch history
 */
router.get(
  "/batches",
  asyncHandler(async (req: Request, res: Response) => {
    const batches = await getScrapeBatches();

    res.json({ batches });
  })
);

/**
 * DELETE /api/fleet-marque/batches/:batchId
 * Delete a scrape batch
 */
router.delete(
  "/batches/:batchId",
  asyncHandler(async (req: Request, res: Response) => {
    const { batchId } = req.params;

    await deleteScrapeBatch(batchId);

    res.json({ success: true, message: "Batch deleted" });
  })
);

// =============================================================================
// TERMS
// =============================================================================

const termsQuerySchema = z.object({
  batchId: z.string().optional(),
  make: z.string().optional(),
  minDiscount: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(500).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

/**
 * GET /api/fleet-marque/terms
 * Get Fleet Marque terms with optional filters
 */
router.get(
  "/terms",
  asyncHandler(async (req: Request, res: Response) => {
    const query = termsQuerySchema.parse(req.query);

    const result = await getFleetMarqueTerms({
      batchId: query.batchId,
      make: query.make,
      minDiscount: query.minDiscount,
      limit: query.limit,
      offset: query.offset,
    });

    res.json({
      terms: result.terms,
      pagination: {
        total: result.total,
        limit: query.limit,
        offset: query.offset,
        hasMore: (query.offset || 0) + result.terms.length < result.total,
      },
    });
  })
);

export default router;
