// Fleet Marque scraper for Express.js backend

import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { db } from "../db/index.js";
import { fleetMarqueTerms, vehicles } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import type { FleetMarqueScrapeResult } from "../db/schema.js";
import { FLEET_MARQUE_MAKES, type ScraperConfig, type ScrapeProgress } from "./fleet-marque-constants.js";

// Re-export for convenience in API routes
export { FLEET_MARQUE_MAKES, type ScraperConfig, type ScrapeProgress } from "./fleet-marque-constants.js";

// Parse derivatives HTML into structured data using cheerio
function parseDerivatives(html: string, make: string, model: string): FleetMarqueScrapeResult[] {
  const $ = cheerio.load(html);
  const results: FleetMarqueScrapeResult[] = [];

  $(".tablealternate").each((_, row) => {
    // Get direct div children - they have classes like 'col-md-1 border-right-grey'
    const cols = $(row).children("div");

    if (cols.length >= 7) {
      const capid = $(cols[0]).text().trim();
      const modelName = $(cols[1]).text().trim();
      const derivative = $(cols[2]).text().trim();
      const priceText = $(cols[3]).text().trim();
      const co2Text = $(cols[4]).text().trim();
      const discountText = $(cols[5]).text().trim();

      // Skip header rows or invalid data
      if (!capid || capid === "CAPID" || isNaN(parseInt(capid))) {
        return;
      }

      // Parse price - handle £ symbol and commas, convert to pence
      const price = Math.round((parseFloat(priceText.replace(/[£,\s]/g, "")) || 0) * 100);

      // Parse CO2
      const co2 = parseInt(co2Text.replace(/[^\d]/g, "")) || 0;

      // Parse discount percentage
      const discount = parseFloat(discountText.replace("%", "")) || 0;

      // Calculate discounted price in pence
      const discountedPrice = Math.round(price * (1 - discount / 100));

      // Get build link
      const buildLink = $(row).find('a[href*="emsdealpage"]').attr("href");

      results.push({
        capid,
        make,
        model: modelName || model,
        derivative,
        capPrice: price,
        co2,
        discountPercent: discount,
        discountedPrice,
        savings: price - discountedPrice,
        buildUrl: buildLink ? `https://www.fleetportal.co.uk${buildLink}` : null,
      });
    }
  });

  return results;
}

// Create axios client with cookie jar
function createClient(phpsessid?: string): { client: AxiosInstance; jar: CookieJar } {
  const jar = new CookieJar();
  const baseUrl = "https://www.fleetportal.co.uk";

  // If PHPSESSID provided, add it to the jar
  if (phpsessid) {
    jar.setCookieSync(`PHPSESSID=${phpsessid}`, baseUrl);
  }

  const client = wrapper(
    axios.create({
      baseURL: baseUrl,
      jar,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.5",
        "X-Requested-With": "XMLHttpRequest",
      },
      withCredentials: true,
      maxRedirects: 5,
    } as Parameters<typeof axios.create>[0] & { jar: CookieJar })
  );

  return { client, jar };
}

// Login and get session credentials
async function login(
  email: string,
  password: string
): Promise<{ sid: string; phpsessid: string; client: AxiosInstance }> {
  console.log("Attempting Fleet Marque login as:", email);

  const { client, jar } = createClient();

  // POST login credentials
  const response = await client.post(
    "/login.php",
    new URLSearchParams({
      submitted: "1",
      duser: email,
      pword: password,
      remember: "1",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      maxRedirects: 5,
    }
  );

  // Extract SID from redirect URL or response body
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalUrl = (response.request as any)?.res?.responseUrl || "";
  const sidMatch = finalUrl.match(/sid=([a-z0-9]+)/i) || response.data?.match(/sid=([a-z0-9]+)/i);

  if (sidMatch) {
    const sid = sidMatch[1];
    console.log("Logged in successfully, SID:", sid.substring(0, 8) + "...");

    // Get PHPSESSID from cookie jar
    const cookies = await jar.getCookies("https://www.fleetportal.co.uk");
    const phpsessidCookie = cookies.find((c) => c.key === "PHPSESSID");
    const phpsessid = phpsessidCookie?.value || "";

    return { sid, phpsessid, client };
  }

  // Check if still on login page (bad credentials)
  if (response.data.includes("name='duser'") || response.data.includes("Login</b>")) {
    throw new Error("Login failed - check your email and password");
  }

  throw new Error("Could not extract session ID from login response");
}

// Fetch models for a make
async function fetchModels(
  client: AxiosInstance,
  sid: string,
  make: string
): Promise<{ name: string; slug: string }[]> {
  const url = `/ems/findmakemodel.php?sid=${sid}&vehicletype=&make=${make}`;

  const response = await client.get(url);

  // Check if session expired
  if (response.data.includes("name='duser'") || response.data.includes("Login</b>")) {
    throw new Error("Session expired - please login again");
  }

  const $ = cheerio.load(response.data);

  const models: { name: string; slug: string }[] = [];
  $('select[name="model"] option').each((_, el) => {
    const value = $(el).attr("value");
    const name = $(el).text().trim();
    // Skip the "Select Model" placeholder
    if (value && value !== "0" && value !== "") {
      models.push({ name, slug: value });
    }
  });

  return models;
}

// Fetch derivatives for a make/model
async function fetchDerivatives(
  client: AxiosInstance,
  sid: string,
  make: string,
  model: string
): Promise<FleetMarqueScrapeResult[]> {
  const params = new URLSearchParams({
    sid,
    ajaxcall: "1",
    vehicletype: "0",
    make,
    model,
  });

  const response = await client.get(`/ems/findderivative_inc.php?${params}`);

  // Check if session expired
  if (response.data.includes("name='duser'") || response.data.includes("Login</b>")) {
    throw new Error("Session expired - please login again");
  }

  return parseDerivatives(response.data, make, model);
}

// Delay helper
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random delay between min and max
function randomDelay(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Main scraper function
export async function runFleetMarqueScraper(
  config: ScraperConfig,
  selectedMakes?: string[],
  onProgress?: (progress: ScrapeProgress) => void
): Promise<{ batchId: string; vehiclesScraped: number; vehiclesLinked: number; vehiclesCreated: number }> {
  let { sid, phpsessid, email, password, minDelay = 1000, maxDelay = 3000, betweenMakes = 5000 } = config;

  let client: AxiosInstance;

  // If email/password provided, login to get session
  if (email && password && (!sid || !phpsessid)) {
    console.log("Logging in with email/password...");
    const credentials = await login(email, password);
    sid = credentials.sid;
    phpsessid = credentials.phpsessid;
    client = credentials.client;
    console.log("Login successful, SID:", sid?.substring(0, 8) + "...");
  } else if (sid && phpsessid) {
    // Use provided session
    console.log("Using provided session credentials");
    const created = createClient(phpsessid);
    client = created.client;
  } else {
    throw new Error("Session credentials required. Provide either email/password or sid/phpsessid");
  }

  if (!sid) {
    throw new Error("No session ID available");
  }

  const batchId = `fm_${Date.now()}`;
  const makes = selectedMakes
    ? FLEET_MARQUE_MAKES.filter((m) => selectedMakes.includes(m.slug))
    : FLEET_MARQUE_MAKES;

  let vehiclesScraped = 0;
  let vehiclesLinked = 0;
  let vehiclesCreated = 0;

  const progress: ScrapeProgress = {
    currentMake: "",
    currentModel: "",
    makesCompleted: 0,
    totalMakes: makes.length,
    vehiclesFound: 0,
    status: "running",
  };

  try {
    for (let i = 0; i < makes.length; i++) {
      const make = makes[i];
      progress.currentMake = make.name;
      progress.makesCompleted = i;
      onProgress?.(progress);

      console.log(`[${i + 1}/${makes.length}] Processing ${make.name}...`);

      try {
        // Fetch models for this make
        const models = await fetchModels(client, sid, make.slug);
        console.log(`  Found ${models.length} models for ${make.name}`);

        for (const model of models) {
          progress.currentModel = model.name;
          onProgress?.(progress);

          try {
            console.log(`    Fetching ${make.name} ${model.name}...`);
            const derivatives = await fetchDerivatives(client, sid, make.slug, model.slug);
            console.log(`      Found ${derivatives.length} derivatives`);

            for (const vehicle of derivatives) {
              // Try to find existing vehicle by cap_code
              const existingVehicle = await db.query.vehicles.findFirst({
                where: eq(vehicles.capCode, vehicle.capid),
              });

              let vehicleId: string | null = null;

              if (existingVehicle) {
                vehicleId = existingVehicle.id;
                vehiclesLinked++;
              } else {
                // Create new vehicle
                const [newVehicle] = await db
                  .insert(vehicles)
                  .values({
                    capCode: vehicle.capid,
                    manufacturer: vehicle.make.toUpperCase(),
                    model: vehicle.model,
                    variant: vehicle.derivative,
                    co2: vehicle.co2,
                    otr: vehicle.capPrice, // CAP price as OTR
                  })
                  .returning({ id: vehicles.id });

                vehicleId = newVehicle.id;
                vehiclesCreated++;
              }

              // Insert fleet marque term
              await db.insert(fleetMarqueTerms).values({
                capCode: vehicle.capid,
                vehicleId,
                make: vehicle.make.toUpperCase(),
                model: vehicle.model,
                derivative: vehicle.derivative,
                capPrice: vehicle.capPrice,
                co2: vehicle.co2,
                discountPercent: vehicle.discountPercent.toString(),
                discountedPrice: vehicle.discountedPrice,
                savings: vehicle.savings,
                buildUrl: vehicle.buildUrl,
                scrapeBatchId: batchId,
              });

              vehiclesScraped++;
              progress.vehiclesFound = vehiclesScraped;
            }

            // Random delay between model requests
            const delayMs = randomDelay(minDelay, maxDelay);
            console.log(`      (waiting ${Math.round(delayMs / 1000)}s...)`);
            await delay(delayMs);
          } catch (err) {
            console.error(`Error fetching ${make.name} ${model.name}:`, err);
            // Continue with next model
          }
        }
      } catch (err) {
        // Catch errors at the make level (e.g., fetchModels fails)
        console.error(`Error processing make ${make.name}:`, err);
        // Check if session expired
        if (err instanceof Error && err.message.includes("Session expired")) {
          throw err; // Re-throw session errors to stop the scraper
        }
        // Continue with next make for other errors
      }

      // Longer delay between makes
      if (i < makes.length - 1) {
        console.log(`  Waiting ${betweenMakes / 1000}s before next make...\n`);
        await delay(betweenMakes);
      }
    }

    progress.status = "completed";
    progress.makesCompleted = makes.length;
    onProgress?.(progress);
  } catch (err) {
    progress.status = "error";
    progress.error = err instanceof Error ? err.message : "Unknown error";
    onProgress?.(progress);
    throw err;
  }

  return { batchId, vehiclesScraped, vehiclesLinked, vehiclesCreated };
}

// Get scrape history/batches
export async function getScrapeBatches() {
  const result = await db.execute(sql`
    SELECT
      scrape_batch_id,
      MIN(scraped_at) as scraped_at,
      COUNT(*) as vehicle_count,
      COUNT(DISTINCT make) as make_count,
      AVG(CAST(discount_percent AS NUMERIC))::NUMERIC(5,2) as avg_discount
    FROM fleet_marque_terms
    WHERE scrape_batch_id IS NOT NULL
    GROUP BY scrape_batch_id
    ORDER BY MIN(scraped_at) DESC
    LIMIT 20
  `);

  return result.rows;
}

// Get terms for a specific batch or all terms
export async function getFleetMarqueTerms(filters?: {
  batchId?: string;
  make?: string;
  minDiscount?: number;
  limit?: number;
  offset?: number;
}) {
  const { batchId, make, minDiscount, limit = 50, offset = 0 } = filters || {};

  let whereClause = sql`1=1`;

  if (batchId) {
    whereClause = sql`${whereClause} AND scrape_batch_id = ${batchId}`;
  }
  if (make) {
    whereClause = sql`${whereClause} AND make = ${make}`;
  }
  if (minDiscount) {
    whereClause = sql`${whereClause} AND CAST(discount_percent AS NUMERIC) >= ${minDiscount}`;
  }

  const result = await db.execute(sql`
    SELECT
      fmt.*,
      v.variant as vehicle_variant,
      v.fuel_type,
      v.transmission
    FROM fleet_marque_terms fmt
    LEFT JOIN vehicles v ON fmt.vehicle_id = v.id
    WHERE ${whereClause}
    ORDER BY CAST(discount_percent AS NUMERIC) DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute(sql`
    SELECT COUNT(*) as total
    FROM fleet_marque_terms
    WHERE ${whereClause}
  `);

  return {
    terms: result.rows,
    total: Number(countResult.rows[0]?.total || 0),
  };
}

// Delete old batches
export async function deleteScrapeBatch(batchId: string) {
  await db.delete(fleetMarqueTerms).where(eq(fleetMarqueTerms.scrapeBatchId, batchId));
}
