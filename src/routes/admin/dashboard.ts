import { Router, Request, Response } from "express";
import { db } from "../../lib/db/index.js";
import { sql } from "drizzle-orm";
import { asyncHandler } from "../../middleware/error.js";

const router = Router();

const PROVIDER_LABELS: Record<string, string> = {
  lex: "Lex Autolease",
  ogilvie: "Ogilvie Fleet",
  venus: "Venus Fleet",
  drivalia: "Drivalia",
};

/**
 * GET /api/admin/dashboard/stats
 * Dashboard statistics for the admin pricing dashboard
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const contractType = (req.query.contractType as string) || "CHNM";
    const term = parseInt((req.query.term as string) || "36");
    const mileage = parseInt((req.query.mileage as string) || "10000");

    // Value score SQL
    const valueScoreSQL = `
      CASE
        WHEN pr.p11d IS NULL OR pr.p11d <= 0 THEN 50
        ELSE
          CASE
            WHEN (pr.total_rental::float * 36) / pr.p11d < 0.20 THEN 95
            WHEN (pr.total_rental::float * 36) / pr.p11d < 0.28 THEN
              95 - (((pr.total_rental::float * 36) / pr.p11d - 0.20) / 0.08 * 15)::int
            WHEN (pr.total_rental::float * 36) / pr.p11d < 0.38 THEN
              80 - (((pr.total_rental::float * 36) / pr.p11d - 0.28) / 0.10 * 15)::int
            WHEN (pr.total_rental::float * 36) / pr.p11d < 0.48 THEN
              65 - (((pr.total_rental::float * 36) / pr.p11d - 0.38) / 0.10 * 15)::int
            WHEN (pr.total_rental::float * 36) / pr.p11d < 0.58 THEN
              50 - (((pr.total_rental::float * 36) / pr.p11d - 0.48) / 0.10 * 10)::int
            WHEN (pr.total_rental::float * 36) / pr.p11d < 0.70 THEN
              40 - (((pr.total_rental::float * 36) / pr.p11d - 0.58) / 0.12 * 15)::int
            ELSE
              GREATEST(10, 25 - (((pr.total_rental::float * 36) / pr.p11d - 0.70) / 0.30 * 15)::int)
          END
      END
    `;

    // 1. KPIs
    const kpisResult = await db.execute(sql.raw(`
      SELECT
        COUNT(DISTINCT pr.cap_code) AS unique_vehicles,
        COUNT(*) AS total_rates,
        COUNT(DISTINCT pr.provider_code) AS provider_count
      FROM provider_rates pr
      JOIN ratebook_imports ri ON ri.id = pr.import_id
      WHERE ri.is_latest = true
        AND pr.contract_type = '${contractType}'
    `));

    const kpis = kpisResult.rows[0] as {
      unique_vehicles: string;
      total_rates: string;
      provider_count: string;
    };

    // Hot deals count (score 80+)
    const hotDealsResult = await db.execute(sql.raw(`
      SELECT COUNT(DISTINCT pr.cap_code) AS hot_count
      FROM provider_rates pr
      JOIN ratebook_imports ri ON ri.id = pr.import_id
      WHERE ri.is_latest = true
        AND pr.contract_type = '${contractType}'
        AND pr.term = ${term}
        AND pr.annual_mileage = ${mileage}
        AND pr.p11d IS NOT NULL
        AND pr.p11d > 0
        AND (${valueScoreSQL}) >= 80
    `));

    const hotDealsCount = Number((hotDealsResult.rows[0] as { hot_count: string })?.hot_count || 0);

    // Rate freshness
    const freshnessResult = await db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE ri.is_latest = true) AS latest_count,
        COUNT(*) AS total_count
      FROM provider_rates pr
      JOIN ratebook_imports ri ON ri.id = pr.import_id
      WHERE pr.contract_type = '${contractType}'
    `));

    const freshness = freshnessResult.rows[0] as { latest_count: string; total_count: string };
    const rateFreshness = Number(freshness.total_count) > 0
      ? Math.round((Number(freshness.latest_count) / Number(freshness.total_count)) * 100)
      : 0;

    // 2. Alerts
    const alertsResult = await db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE ri.is_latest = false) AS stale_imports,
        COUNT(*) FILTER (WHERE ri.error_rows > 0) AS imports_with_errors,
        COUNT(*) FILTER (WHERE ri.status = 'failed') AS failed_imports
      FROM ratebook_imports ri
    `));

    const alertData = alertsResult.rows[0] as {
      stale_imports: string;
      imports_with_errors: string;
      failed_imports: string;
    };

    const alerts: Array<{ type: string; message: string; count: number }> = [];
    if (Number(alertData.stale_imports) > 0) {
      alerts.push({ type: "warning", message: "stale imports need cleanup", count: Number(alertData.stale_imports) });
    }
    if (Number(alertData.imports_with_errors) > 0) {
      alerts.push({ type: "error", message: "imports have errors", count: Number(alertData.imports_with_errors) });
    }
    if (Number(alertData.failed_imports) > 0) {
      alerts.push({ type: "error", message: "failed imports", count: Number(alertData.failed_imports) });
    }

    // 3. Best Deals
    const bestDealsResult = await db.execute(sql.raw(`
      WITH ranked AS (
        SELECT
          pr.cap_code,
          pr.manufacturer,
          pr.model,
          pr.variant,
          pr.fuel_type,
          pr.total_rental,
          pr.p11d,
          pr.provider_code,
          pr.term,
          pr.annual_mileage,
          (${valueScoreSQL}) AS score,
          v.image_folder,
          ROW_NUMBER() OVER (
            PARTITION BY pr.cap_code
            ORDER BY pr.total_rental ASC
          ) AS rn
        FROM provider_rates pr
        JOIN ratebook_imports ri ON ri.id = pr.import_id
        LEFT JOIN vehicles v ON v.cap_code = pr.cap_code
        WHERE ri.is_latest = true
          AND pr.contract_type = '${contractType}'
          AND pr.term = ${term}
          AND pr.annual_mileage = ${mileage}
          AND pr.p11d IS NOT NULL
          AND pr.p11d > 0
      )
      SELECT *
      FROM ranked
      WHERE rn = 1
      ORDER BY score DESC, total_rental ASC
      LIMIT 10
    `));

    const bestDeals = (bestDealsResult.rows as Array<{
      cap_code: string;
      manufacturer: string;
      model: string;
      variant: string | null;
      fuel_type: string | null;
      total_rental: string;
      p11d: string;
      provider_code: string;
      term: number;
      annual_mileage: number;
      score: string;
      image_folder: string | null;
    }>).map((row, index) => {
      const score = Number(row.score);
      let scoreLabel = "Average";
      if (score >= 80) scoreLabel = "Hot";
      else if (score >= 65) scoreLabel = "Great";
      else if (score >= 50) scoreLabel = "Good";
      else if (score >= 40) scoreLabel = "Fair";

      return {
        rank: index + 1,
        capCode: row.cap_code,
        manufacturer: row.manufacturer,
        model: row.model,
        variant: row.variant,
        displayName: row.variant ? `${row.model} ${row.variant}` : row.model,
        fuelType: row.fuel_type,
        monthlyPriceGbp: Math.round(Number(row.total_rental) / 100),
        p11dGbp: Math.round(Number(row.p11d) / 100),
        providerCode: row.provider_code,
        providerName: PROVIDER_LABELS[row.provider_code] || row.provider_code.toUpperCase(),
        term: row.term,
        mileage: row.annual_mileage,
        score,
        scoreLabel,
        imageUrl: row.image_folder ? `/images/vehicles/${row.image_folder}/front_view.webp` : null,
      };
    });

    // 4. Import Health
    const importHealthResult = await db.execute(sql.raw(`
      SELECT
        ri.provider_code,
        COUNT(*) FILTER (WHERE ri.is_latest = true) AS latest_count,
        SUM(ri.success_rows) FILTER (WHERE ri.is_latest = true) AS latest_rates,
        COUNT(*) FILTER (WHERE ri.is_latest = false) AS stale_count,
        COUNT(*) FILTER (WHERE ri.error_rows > 0) AS error_count,
        MAX(ri.created_at) AS last_import
      FROM ratebook_imports ri
      WHERE ri.contract_type = '${contractType}'
      GROUP BY ri.provider_code
      ORDER BY latest_rates DESC NULLS LAST
    `));

    const importHealth = (importHealthResult.rows as Array<{
      provider_code: string;
      latest_count: string;
      latest_rates: string;
      stale_count: string;
      error_count: string;
      last_import: string;
    }>).map((row) => ({
      providerCode: row.provider_code,
      providerName: PROVIDER_LABELS[row.provider_code] || row.provider_code.toUpperCase(),
      latestImports: Number(row.latest_count),
      latestRates: Number(row.latest_rates || 0),
      staleImports: Number(row.stale_count),
      hasIssues: Number(row.error_count) > 0,
      lastImport: row.last_import,
    }));

    // 5. Rate Distribution
    const rateDistributionResult = await db.execute(sql.raw(`
      SELECT
        pr.provider_code,
        COUNT(*) AS rate_count,
        COUNT(DISTINCT pr.cap_code) AS vehicle_count
      FROM provider_rates pr
      JOIN ratebook_imports ri ON ri.id = pr.import_id
      WHERE ri.is_latest = true
        AND pr.contract_type = '${contractType}'
      GROUP BY pr.provider_code
      ORDER BY rate_count DESC
    `));

    const rateDistribution = (rateDistributionResult.rows as Array<{
      provider_code: string;
      rate_count: string;
      vehicle_count: string;
    }>).map((row) => ({
      providerCode: row.provider_code,
      providerName: PROVIDER_LABELS[row.provider_code] || row.provider_code.toUpperCase(),
      rateCount: Number(row.rate_count),
      vehicleCount: Number(row.vehicle_count),
    }));

    // 6. Contract Type Breakdown
    const contractBreakdownResult = await db.execute(sql.raw(`
      SELECT
        pr.contract_type,
        COUNT(*) AS rate_count
      FROM provider_rates pr
      JOIN ratebook_imports ri ON ri.id = pr.import_id
      WHERE ri.is_latest = true
      GROUP BY pr.contract_type
      ORDER BY rate_count DESC
    `));

    const contractBreakdown = (contractBreakdownResult.rows as Array<{
      contract_type: string;
      rate_count: string;
    }>).map((row) => ({
      contractType: row.contract_type,
      count: Number(row.rate_count),
    }));

    res.json({
      alerts,
      hasAlerts: alerts.length > 0,
      kpis: {
        vehiclesWithRates: Number(kpis.unique_vehicles),
        hotDeals: hotDealsCount,
        rateFreshness,
        providerCount: Number(kpis.provider_count),
      },
      bestDeals,
      importHealth,
      rateDistribution,
      contractBreakdown,
      appliedFilters: { contractType, term, mileage },
    });
  })
);

export default router;
