import { Router, Request, Response } from "express";
import { db } from "../lib/db/index.js";
import { providerRates } from "../lib/db/schema.js";
import { eq, and, gte, lte, ilike, sql, desc, asc } from "drizzle-orm";
import { asyncHandler } from "../middleware/error.js";

const router = Router();

/**
 * GET /api/rates
 * Search and filter rates across all providers
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

    // Build conditions
    const conditions = [];

    // Only get rates from latest imports
    conditions.push(
      sql`${providerRates.importId} IN (
        SELECT id FROM ratebook_imports WHERE is_latest = true
      )`
    );

    if (capCode) conditions.push(eq(providerRates.capCode, capCode));
    if (manufacturer)
      conditions.push(ilike(providerRates.manufacturer, manufacturer));
    if (model) conditions.push(ilike(providerRates.model, `%${model}%`));
    if (fuelType) conditions.push(eq(providerRates.fuelType, fuelType));
    if (contractType)
      conditions.push(eq(providerRates.contractType, contractType));
    if (term) conditions.push(eq(providerRates.term, parseInt(term)));
    if (mileage)
      conditions.push(eq(providerRates.annualMileage, parseInt(mileage)));
    if (minPrice)
      conditions.push(
        gte(providerRates.totalRental, Math.round(parseFloat(minPrice) * 100))
      );
    if (maxPrice)
      conditions.push(
        lte(providerRates.totalRental, Math.round(parseFloat(maxPrice) * 100))
      );
    if (bodyStyle)
      conditions.push(ilike(providerRates.bodyStyle, `%${bodyStyle}%`));
    if (provider) conditions.push(eq(providerRates.providerCode, provider));

    // Determine sort column and order
    const sortColumn =
      {
        price: providerRates.totalRental,
        manufacturer: providerRates.manufacturer,
        co2: providerRates.co2Gkm,
        term: providerRates.term,
      }[sort || "price"] || providerRates.totalRental;

    const orderBy = order === "desc" ? desc(sortColumn) : asc(sortColumn);

    // Execute query
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
      })
      .from(providerRates)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(providerRates)
      .where(and(...conditions));

    // Transform prices to GBP
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
 * GET /api/rates/best
 * Get the best (cheapest) rate per vehicle
 */
router.get(
  "/best",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      contractType,
      term,
      mileage,
      fuelType,
      manufacturer,
      bodyStyle,
      minPrice,
      maxPrice,
      limit: limitParam = "50",
      offset: offsetParam = "0",
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitParam || "50"), 200);
    const offset = parseInt(offsetParam || "0");

    // Build WHERE conditions for raw SQL query
    const innerConditions: string[] = [
      "import_id IN (SELECT id FROM ratebook_imports WHERE is_latest = true)",
    ];

    if (contractType) innerConditions.push(`contract_type = '${contractType}'`);
    if (term) innerConditions.push(`term = ${parseInt(term)}`);
    if (mileage) innerConditions.push(`annual_mileage = ${parseInt(mileage)}`);
    if (fuelType) innerConditions.push(`fuel_type ILIKE '${fuelType}'`);
    if (manufacturer)
      innerConditions.push(`manufacturer ILIKE '${manufacturer}'`);
    if (bodyStyle) innerConditions.push(`body_style ILIKE '%${bodyStyle}%'`);
    if (minPrice)
      innerConditions.push(
        `total_rental >= ${Math.round(parseFloat(minPrice) * 100)}`
      );
    if (maxPrice)
      innerConditions.push(
        `total_rental <= ${Math.round(parseFloat(maxPrice) * 100)}`
      );

    const whereClause = innerConditions.join(" AND ");

    // Use raw SQL for DISTINCT ON query
    const bestDealsQuery = sql`
      SELECT DISTINCT ON (cap_code)
        id,
        cap_code,
        provider_code,
        contract_type,
        manufacturer,
        model,
        variant,
        term,
        annual_mileage,
        payment_plan,
        total_rental,
        lease_rental,
        service_rental,
        co2_gkm,
        p11d,
        fuel_type,
        transmission,
        body_style,
        excess_mileage_ppm,
        bik_tax_lower_rate,
        bik_tax_higher_rate,
        insurance_group,
        wltp_ev_range
      FROM provider_rates
      WHERE ${sql.raw(whereClause)}
      ORDER BY cap_code, total_rental ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const bestDeals = await db.execute(bestDealsQuery);

    // Get total unique vehicles count
    const countQuery = sql`
      SELECT COUNT(DISTINCT cap_code) as count
      FROM provider_rates
      WHERE ${sql.raw(whereClause)}
    `;

    const countResult = await db.execute(countQuery);
    const totalCount = Number(
      (countResult.rows[0] as { count: string })?.count || 0
    );

    // Transform results
    const transformedDeals = (
      bestDeals.rows as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id,
      capCode: r.cap_code,
      providerCode: r.provider_code,
      contractType: r.contract_type,
      manufacturer: r.manufacturer,
      model: r.model,
      variant: r.variant,
      term: r.term,
      annualMileage: r.annual_mileage,
      paymentPlan: r.payment_plan,
      totalRentalGbp: Number(r.total_rental) / 100,
      leaseRentalGbp: r.lease_rental ? Number(r.lease_rental) / 100 : null,
      serviceRentalGbp: r.service_rental ? Number(r.service_rental) / 100 : null,
      co2Gkm: r.co2_gkm,
      p11dGbp: r.p11d ? Number(r.p11d) / 100 : null,
      fuelType: r.fuel_type,
      transmission: r.transmission,
      bodyStyle: r.body_style,
      excessMileagePence: r.excess_mileage_ppm,
      bikTaxLowerRateGbp: r.bik_tax_lower_rate
        ? Number(r.bik_tax_lower_rate) / 100
        : null,
      bikTaxHigherRateGbp: r.bik_tax_higher_rate
        ? Number(r.bik_tax_higher_rate) / 100
        : null,
      insuranceGroup: r.insurance_group,
      evRangeMiles: r.wltp_ev_range,
    }));

    res.json({
      deals: transformedDeals,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + transformedDeals.length < totalCount,
      },
      filters: {
        contractType,
        term: term ? parseInt(term) : null,
        mileage: mileage ? parseInt(mileage) : null,
        fuelType,
        manufacturer,
        bodyStyle,
        priceRangeGbp: {
          min: minPrice ? parseFloat(minPrice) : null,
          max: maxPrice ? parseFloat(maxPrice) : null,
        },
      },
    });
  })
);

export default router;
