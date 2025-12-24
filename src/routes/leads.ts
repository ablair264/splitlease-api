import { Router, Request, Response } from "express";
import { db } from "../lib/db/index.js";
import { leads, leadMessages } from "../lib/db/schema.js";
import { eq, desc, sql, and, gte, lte } from "drizzle-orm";
import { asyncHandler, ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { z } from "zod";

const router = Router();

// Validation schema for creating a lead
const createLeadSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Valid email required").optional(),
  phone: z.string().optional(),
  source: z.string().default("website"),
  rawData: z.record(z.unknown()).optional(),
  brokerId: z.string().uuid("Valid broker ID required"),
});

/**
 * POST /api/leads
 * Create a new lead (public endpoint)
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const validated = createLeadSchema.parse(req.body);

    const [lead] = await db
      .insert(leads)
      .values({
        brokerId: validated.brokerId,
        name: validated.name || null,
        email: validated.email || null,
        phone: validated.phone || null,
        source: validated.source,
        rawData: validated.rawData || null,
        status: "new",
      })
      .returning();

    res.status(201).json({
      success: true,
      lead: {
        id: lead.id,
        name: lead.name,
        email: lead.email,
        status: lead.status,
        createdAt: lead.createdAt,
      },
    });
  })
);

/**
 * GET /api/leads
 * Get all leads (protected)
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const {
      status,
      source,
      search,
      startDate,
      endDate,
      limit: limitParam = "50",
      offset: offsetParam = "0",
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitParam || "50"), 200);
    const offset = parseInt(offsetParam || "0");

    const conditions = [];

    if (status) conditions.push(eq(leads.status, status));
    if (source) conditions.push(eq(leads.source, source));
    if (search) {
      conditions.push(
        sql`(${leads.name} ILIKE ${`%${search}%`} OR ${leads.email} ILIKE ${`%${search}%`})`
      );
    }
    if (startDate) conditions.push(gte(leads.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(leads.createdAt, new Date(endDate)));

    const allLeads = await db
      .select()
      .from(leads)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(leads.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(leads)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    res.json({
      leads: allLeads,
      pagination: {
        total: Number(countResult?.count || 0),
        limit,
        offset,
        hasMore: offset + allLeads.length < Number(countResult?.count || 0),
      },
    });
  })
);

/**
 * GET /api/leads/:id
 * Get a single lead with messages (protected)
 */
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const leadId = req.params.id;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));

    if (!lead) {
      throw new ApiError("Lead not found", 404);
    }

    const messages = await db
      .select()
      .from(leadMessages)
      .where(eq(leadMessages.leadId, leadId))
      .orderBy(desc(leadMessages.sentAt));

    res.json({
      lead,
      messages,
    });
  })
);

/**
 * PATCH /api/leads/:id
 * Update a lead (protected)
 */
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const leadId = req.params.id;
    const updates = req.body;

    const [updated] = await db
      .update(leads)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId))
      .returning();

    if (!updated) {
      throw new ApiError("Lead not found", 404);
    }

    res.json({ lead: updated });
  })
);

/**
 * POST /api/leads/:id/messages
 * Add a message to a lead (protected)
 */
router.post(
  "/:id/messages",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const leadId = req.params.id;
    const { content, channel = "email", direction = "outbound" } = req.body;

    if (!content) {
      throw new ApiError("Message content is required", 400);
    }

    const [message] = await db
      .insert(leadMessages)
      .values({
        leadId,
        content,
        channel,
        direction,
        sentBy: req.user?.id || null,
        sentAt: new Date(),
      })
      .returning();

    // Update lead's updatedAt
    await db
      .update(leads)
      .set({ updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    res.status(201).json({ message });
  })
);

export default router;
