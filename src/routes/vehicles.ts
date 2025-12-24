import { Router, Request, Response } from "express";
import { db, vehicles, vehiclePricing } from "../lib/db/index.js";
import { eq, asc, desc, sql, and, ilike, or, gte, lte } from "drizzle-orm";
import { asyncHandler } from "../middleware/error.js";

const router = Router();

/**
 * GET /api/vehicles
 * Get vehicles with pricing and filters
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    // Pagination
    const page = parseInt((req.query.page as string) || "1");
    const limit = parseInt((req.query.limit as string) || "24");
    const offset = (page - 1) * limit;

    // Filters
    const search = req.query.search as string | undefined;
    const manufacturer = req.query.manufacturer as string | undefined;
    const fuelType = req.query.fuelType as string | undefined;
    const bodyType = req.query.bodyType as string | undefined;
    const transmission = req.query.transmission as string | undefined;
    const minPrice = req.query.minPrice as string | undefined;
    const maxPrice = req.query.maxPrice as string | undefined;

    // Sort
    const sortBy = (req.query.sortBy as string) || "price-asc";

    // Build base query to get vehicles with their lowest price
    const vehiclesWithPricing = await db
      .select({
        id: vehicles.id,
        capCode: vehicles.capCode,
        manufacturer: vehicles.manufacturer,
        model: vehicles.model,
        variant: vehicles.variant,
        modelYear: vehicles.modelYear,
        p11d: vehicles.p11d,
        otr: vehicles.otr,
        engineSize: vehicles.engineSize,
        transmission: vehicles.transmission,
        doors: vehicles.doors,
        fuelType: vehicles.fuelType,
        co2: vehicles.co2,
        mpg: vehicles.mpg,
        bodyStyle: vehicles.bodyStyle,
        insuranceGroup: vehicles.insuranceGroup,
        euroClass: vehicles.euroClass,
        imageFolder: vehicles.imageFolder,
        createdAt: vehicles.createdAt,
        minMonthlyRental: sql<number>`MIN(CASE WHEN ${vehiclePricing.term} = 36 AND ${vehiclePricing.annualMileage} = 10000 THEN ${vehiclePricing.monthlyRental} END)`.as(
          "min_monthly_rental"
        ),
      })
      .from(vehicles)
      .leftJoin(vehiclePricing, eq(vehicles.id, vehiclePricing.vehicleId))
      .where(
        and(
          search
            ? or(
                ilike(vehicles.manufacturer, `%${search}%`),
                ilike(vehicles.model, `%${search}%`),
                ilike(vehicles.variant, `%${search}%`)
              )
            : undefined,
          manufacturer
            ? ilike(vehicles.manufacturer, `%${manufacturer}%`)
            : undefined,
          fuelType ? ilike(vehicles.fuelType, `%${fuelType}%`) : undefined,
          bodyType ? ilike(vehicles.bodyStyle, `%${bodyType}%`) : undefined,
          transmission
            ? ilike(vehicles.transmission, `%${transmission}%`)
            : undefined
        )
      )
      .groupBy(vehicles.id)
      .having(
        and(
          sql`MIN(${vehiclePricing.monthlyRental}) IS NOT NULL`,
          minPrice
            ? gte(
                sql`MIN(${vehiclePricing.monthlyRental})`,
                parseInt(minPrice) * 100
              )
            : undefined,
          maxPrice
            ? lte(
                sql`MIN(${vehiclePricing.monthlyRental})`,
                parseInt(maxPrice) * 100
              )
            : undefined
        )
      )
      .orderBy(
        sortBy === "price-desc"
          ? desc(sql`MIN(${vehiclePricing.monthlyRental})`)
          : sortBy === "name"
          ? asc(vehicles.manufacturer)
          : asc(sql`MIN(${vehiclePricing.monthlyRental})`)
      )
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const countResult = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${vehicles.id})` })
      .from(vehicles)
      .leftJoin(vehiclePricing, eq(vehicles.id, vehiclePricing.vehicleId))
      .where(
        and(
          search
            ? or(
                ilike(vehicles.manufacturer, `%${search}%`),
                ilike(vehicles.model, `%${search}%`),
                ilike(vehicles.variant, `%${search}%`)
              )
            : undefined,
          manufacturer
            ? ilike(vehicles.manufacturer, `%${manufacturer}%`)
            : undefined,
          fuelType ? ilike(vehicles.fuelType, `%${fuelType}%`) : undefined,
          bodyType ? ilike(vehicles.bodyStyle, `%${bodyType}%`) : undefined,
          transmission
            ? ilike(vehicles.transmission, `%${transmission}%`)
            : undefined
        )
      );

    const totalCount = countResult[0]?.count || 0;

    // Transform data for frontend
    const transformedVehicles = vehiclesWithPricing.map((v) => ({
      id: v.id,
      manufacturer: v.manufacturer,
      model: v.model,
      derivative: v.variant || "",
      fuelType: v.fuelType || "Unknown",
      bodyType: v.bodyStyle || "Unknown",
      transmission: v.transmission || "Unknown",
      engineSize: v.engineSize ? `${v.engineSize}cc` : undefined,
      co2: v.co2 || undefined,
      mpg: v.mpg ? parseFloat(v.mpg) : undefined,
      doors: v.doors || undefined,
      imageFolder: v.imageFolder || undefined,
      isNew: v.modelYear === "26" || v.modelYear === "25",
      isSpecialOffer: false,
      quickDelivery: false,
      baseMonthlyPrice: v.minMonthlyRental
        ? Math.round(v.minMonthlyRental / 100)
        : 0,
    }));

    res.json({
      vehicles: transformedVehicles,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(Number(totalCount) / limit),
      },
    });
  })
);

export default router;
