import { Router, Request, Response } from "express";
import { db } from "../../lib/db/index.js";
import { providerRates } from "../../lib/db/schema.js";
import { eq, and, gte, lte, ilike, sql, desc, asc } from "drizzle-orm";
import { asyncHandler } from "../../middleware/error.js";

const router = Router();

/**
 * GET /api/admin/rates
 * Admin rate explorer with comprehensive filtering
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      capCode,
      manufacturer,
      model,
      fuelType,
      contractType,
      term,
      mileage,
      minPrice,
      maxPrice,
      bodyStyle,
      provider,
      sort = "price",
      order = "asc",
      limit: limitParam = "50",
      offset: offsetParam = "0",
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitParam || "50"), 200);
    const offset = parseInt(offsetParam || "0");

    const conditions = [];

    // Only get rates from latest imports
    conditions.push(
      sql`${providerRates.importId} IN (
        SELECT id FROM ratebook_imports WHERE is_latest = true
      )`
    );

    if (capCode) conditions.push(eq(providerRates.capCode, capCode));
    if (manufacturer) conditions.push(ilike(providerRates.manufacturer, manufacturer));
    if (model) conditions.push(ilike(providerRates.model, `%${model}%`));
    if (fuelType) conditions.push(eq(providerRates.fuelType, fuelType));
    if (contractType) conditions.push(eq(providerRates.contractType, contractType));
    if (term) conditions.push(eq(providerRates.term, parseInt(term)));
    if (mileage) conditions.push(eq(providerRates.annualMileage, parseInt(mileage)));
    if (minPrice) conditions.push(gte(providerRates.totalRental, Math.round(parseFloat(minPrice) * 100)));
    if (maxPrice) conditions.push(lte(providerRates.totalRental, Math.round(parseFloat(maxPrice) * 100)));
    if (bodyStyle) conditions.push(ilike(providerRates.bodyStyle, `%${bodyStyle}%`));
    if (provider) conditions.push(eq(providerRates.providerCode, provider));

    const sortColumn = {
      price: providerRates.totalRental,
      manufacturer: providerRates.manufacturer,
      co2: providerRates.co2Gkm,
      term: providerRates.term,
    }[sort || "price"] || providerRates.totalRental;

    const orderBy = order === "desc" ? desc(sortColumn) : asc(sortColumn);

    const rates = await db
      .select({
        id: providerRates.id,
        capCode: providerRates.capCode,
        providerCode: providerRates.providerCode,
        contractType: providerRates.contractType,
        manufacturer: providerRates.manufacturer,
        model: providerRates.model,
        variant: providerRates.variant,
        term: providerRates.term,
        annualMileage: providerRates.annualMileage,
        totalRental: providerRates.totalRental,
        leaseRental: providerRates.leaseRental,
        serviceRental: providerRates.serviceRental,
        co2Gkm: providerRates.co2Gkm,
        p11d: providerRates.p11d,
        fuelType: providerRates.fuelType,
        transmission: providerRates.transmission,
        bodyStyle: providerRates.bodyStyle,
        excessMileagePpm: providerRates.excessMileagePpm,
        bikTaxLowerRate: providerRates.bikTaxLowerRate,
        bikTaxHigherRate: providerRates.bikTaxHigherRate,
        insuranceGroup: providerRates.insuranceGroup,
        score: providerRates.score,
      })
      .from(providerRates)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(providerRates)
      .where(and(...conditions));

    const transformedRates = rates.map((r) => ({
      ...r,
      totalRentalGbp: r.totalRental / 100,
      leaseRentalGbp: r.leaseRental ? r.leaseRental / 100 : null,
      serviceRentalGbp: r.serviceRental ? r.serviceRental / 100 : null,
      p11dGbp: r.p11d ? r.p11d / 100 : null,
      excessMileagePence: r.excessMileagePpm,
      bikTaxLowerRateGbp: r.bikTaxLowerRate ? r.bikTaxLowerRate / 100 : null,
      bikTaxHigherRateGbp: r.bikTaxHigherRate ? r.bikTaxHigherRate / 100 : null,
    }));

    res.json({
      rates: transformedRates,
      pagination: {
        total: Number(countResult?.count || 0),
        limit,
        offset,
        hasMore: offset + rates.length < Number(countResult?.count || 0),
      },
    });
  })
);

/**
 * GET /api/admin/rates/filters
 * Get available filter options
 */
router.get(
  "/filters",
  asyncHandler(async (req: Request, res: Response) => {
    const manufacturers = await db
      .selectDistinct({ value: providerRates.manufacturer })
      .from(providerRates)
      .where(sql`${providerRates.importId} IN (SELECT id FROM ratebook_imports WHERE is_latest = true)`)
      .orderBy(providerRates.manufacturer);

    const fuelTypes = await db
      .selectDistinct({ value: providerRates.fuelType })
      .from(providerRates)
      .where(
        and(
          sql`${providerRates.importId} IN (SELECT id FROM ratebook_imports WHERE is_latest = true)`,
          sql`${providerRates.fuelType} IS NOT NULL`
        )
      )
      .orderBy(providerRates.fuelType);

    const bodyStyles = await db
      .selectDistinct({ value: providerRates.bodyStyle })
      .from(providerRates)
      .where(
        and(
          sql`${providerRates.importId} IN (SELECT id FROM ratebook_imports WHERE is_latest = true)`,
          sql`${providerRates.bodyStyle} IS NOT NULL`
        )
      )
      .orderBy(providerRates.bodyStyle);

    const providers = await db
      .selectDistinct({ value: providerRates.providerCode })
      .from(providerRates)
      .where(sql`${providerRates.importId} IN (SELECT id FROM ratebook_imports WHERE is_latest = true)`)
      .orderBy(providerRates.providerCode);

    res.json({
      manufacturers: manufacturers.map((m) => m.value).filter(Boolean),
      fuelTypes: fuelTypes.map((f) => f.value).filter(Boolean),
      bodyStyles: bodyStyles.map((b) => b.value).filter(Boolean),
      providers: providers.map((p) => p.value).filter(Boolean),
      contractTypes: ["CH", "CHNM", "PCH", "PCHNM", "BSSNL"],
      terms: [24, 36, 48, 60],
      mileages: [5000, 8000, 10000, 15000, 20000],
    });
  })
);

/**
 * GET /api/admin/rates/manufacturers
 * Get manufacturers with rate counts
 */
router.get(
  "/manufacturers",
  asyncHandler(async (req: Request, res: Response) => {
    const result = await db.execute(sql`
      SELECT
        pr.manufacturer,
        COUNT(*) AS rate_count,
        COUNT(DISTINCT pr.cap_code) AS vehicle_count,
        MIN(pr.total_rental) AS min_rental,
        MAX(pr.total_rental) AS max_rental
      FROM provider_rates pr
      JOIN ratebook_imports ri ON ri.id = pr.import_id AND ri.is_latest = true
      GROUP BY pr.manufacturer
      ORDER BY vehicle_count DESC
    `);

    const manufacturers = (result.rows as Array<{
      manufacturer: string;
      rate_count: string;
      vehicle_count: string;
      min_rental: string;
      max_rental: string;
    }>).map((row) => ({
      manufacturer: row.manufacturer,
      rateCount: Number(row.rate_count),
      vehicleCount: Number(row.vehicle_count),
      minRentalGbp: Math.round(Number(row.min_rental) / 100),
      maxRentalGbp: Math.round(Number(row.max_rental) / 100),
    }));

    res.json({ manufacturers });
  })
);

export default router;
