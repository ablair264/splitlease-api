// Ogilvie Fleet scraper for Express.js backend

import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { db } from "../db/index.js";
import { ogilvieExports, ogilvieRatebook, ogilvieSessions, ratebookImports, providerRates } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import type { OgilvieExportConfig } from "../db/schema.js";
import { lookupOgilvieCapMapping, getCapCodeForVehicle, findCapCodeMatch, saveMatchResult, generateSourceKey } from "../matching/vehicle-matcher.js";

const BASE_URL = "https://www.ogilviefleet.co.uk";

// Map Ogilvie product names to contract types
const PRODUCT_TO_CONTRACT_TYPE: Record<string, string> = {
  "Contract Hire": "CH",
  "Contract Hire (Maintenance + Tyres)": "CH",
  "Contract Hire (No Maintenance - No Tyres)": "CHNM",
  "Contract Hire (No Maintenance)": "CHNM",
  "Personal Contract Hire": "PCH",
  "Personal Contract Hire (No Maintenance)": "PCHNM",
  "Salary Sacrifice": "BSSNL",
};

// Ogilvie Product IDs
export const OGILVIE_PRODUCTS = {
  CONTRACT_HIRE_MAINTENANCE: "3",      // Contract Hire (Maintenance + Tyres) → CH
  CONTRACT_HIRE_NO_MAINTENANCE: "1",   // Contract Hire (No Maintenance - No Tyres) → CHNM
} as const;

// Ogilvie Payment Plan IDs - Standard broker payment plans
export const OGILVIE_PAYMENT_PLANS = {
  MONTHLY_IN_ADVANCE: "263",     // 1 in Advance → monthly_in_advance
  SPREAD_3_DOWN: "265",          // 3 In Advance Spread → spread_3_down
  SPREAD_6_DOWN: "268",          // 6 In Advance Spread → spread_6_down
  SPREAD_9_DOWN: "269",          // 9 In Advance Spread → spread_9_down
} as const;

// Payment plan ID to our enum mapping
const PAYMENT_PLAN_ID_MAP: Record<string, string> = {
  "263": "monthly_in_advance",
  "265": "spread_3_down",
  "268": "spread_6_down",
  "269": "spread_9_down",
};

// Map Ogilvie payment plans to our enum (by name)
const PAYMENT_PLAN_MAP: Record<string, string> = {
  "Ogilvie Quotes 1 In Advance": "monthly_in_advance",
  "1 in Advance": "monthly_in_advance",
  "1 In Advance": "monthly_in_advance",
  "3 In Advance Spread": "spread_3_down",
  "6 In Advance Spread": "spread_6_down",
  "9 In Advance Spread": "spread_9_down",
  "Spread with 3 up front": "spread_3_down",
  "Spread with 6 up front": "spread_6_down",
  "Spread with 9 up front": "spread_9_down",
};

// Standard terms in months
export const OGILVIE_TERMS = [24, 36, 48, 60] as const;

// Annual mileages we support
export const OGILVIE_ANNUAL_MILEAGES = [10000, 12000, 15000, 20000] as const;

/**
 * Calculate life distance (total contract miles) from term and annual mileage
 */
export function calculateLifeDistance(termMonths: number, annualMileage: number): number {
  return Math.round((termMonths / 12) * annualMileage);
}

/**
 * Generate all export configurations for comprehensive rate fetching
 * Returns configs for all combinations of: products × terms × mileages × payment plans
 */
export function generateAllOgilvieConfigs(): OgilvieExportConfig[] {
  const configs: OgilvieExportConfig[] = [];

  const products = Object.values(OGILVIE_PRODUCTS);
  const paymentPlans = Object.values(OGILVIE_PAYMENT_PLANS);

  for (const productId of products) {
    for (const term of OGILVIE_TERMS) {
      for (const annualMileage of OGILVIE_ANNUAL_MILEAGES) {
        for (const paymentPlanId of paymentPlans) {
          const lifeDistance = calculateLifeDistance(term, annualMileage);

          configs.push({
            contractTerm: term,
            contractMileage: lifeDistance,
            productId,
            paymentPlanId,
          });
        }
      }
    }
  }

  console.log(`Generated ${configs.length} Ogilvie export configurations`);
  console.log(`  Products: ${products.length} (CH, CHNM)`);
  console.log(`  Terms: ${OGILVIE_TERMS.length} (${OGILVIE_TERMS.join(", ")} months)`);
  console.log(`  Mileages: ${OGILVIE_ANNUAL_MILEAGES.length} (${OGILVIE_ANNUAL_MILEAGES.join(", ")} per annum)`);
  console.log(`  Payment Plans: ${paymentPlans.length} (1+, 3+, 6+, 9+)`);

  return configs;
}

// CSV column mapping - maps Ogilvie CSV headers to our database fields
const CSV_COLUMN_MAP: Record<string, string> = {
  "Derivative Name": "derivativeName",
  "Manufacturer Name": "manufacturerName",
  "Range Name": "rangeName",
  "Model Name": "modelName",
  "Year Introduced": "yearIntroduced",
  "Body Styles": "bodyStyles",
  "Is It 4WD": "is4wd",
  "Transmission": "transmission",
  "CC": "cc",
  "Fuel Type": "fuelType",
  "EC Combined mpg": "ecCombinedMpg",
  "Max EV Range": "maxEvRange",
  "BatteryCapacityInkWh": "batteryCapacityKwh",
  "EnginePowerKW": "enginePowerKw",
  "List Price": "listPrice",
  "P11D Value": "p11dValue",
  "CO2 gkm": "co2Gkm",
  "CarbonFootprint": "carbonFootprint",
  "InsuranceGroup50": "insuranceGroup",
  "NCAP": "ncap",
  "NCAP Pedestrian": "ncapPedestrian",
  "Product": "product",
  "Payment Plan": "paymentPlan",
  "Contract Term": "contractTerm",
  "Contract Mileage": "contractMileage",
  "England BIK At 20%": "bik20Percent",
  "England BIK At 40%": "bik40Percent",
  "Finance Rental Exc. VAT": "financeRentalExcVat",
  "Non Finance Rental": "nonFinanceRental",
  "Regular Rental": "regularRental",
  "Monthly Effective Rental": "monthlyEffectiveRental",
  "Period Whole Life Costs": "periodWholeLifeCosts",
  "Ogilvie True Cost": "ogilvieTrueCost",
  "Driver Rebate": "driverRebate",
  "Min Driver Contribution": "minDriverContribution",
  "Max Loading Weight": "maxLoadingWeight",
  "Max Towing Weight Braked": "maxTowingWeightBraked",
  "Max Towing Weight Unbraked": "maxTowingWeightUnbraked",
  "Luggage Capacity Seats Up": "luggageCapacitySeatsUp",
  "Luggage Capacity Seats Down": "luggageCapacitySeatsDown",
  "Minimum Kerbweight": "minimumKerbweight",
};

// Default search filter template based on recorded requests
const DEFAULT_SEARCH_FILTER = {
  SearchSequence: 0,
  CurrentStartID: 0,
  CurrentEndID: 0,
  CurrentSortColumn: "DerivativeFullName",
  CurrentSortDirection: "ASC",
  CurrentPageSize: "50",
  RowsDisplayed: 50,
  RowsLeft: false,
  NewSortColumn: "DerivativeFullName",
  NewSortDirection: "ASC",
  NewPageSize: "50",
  NewPageAction: 0,
  ContractTerm: 24,
  ContractAnnualDistance: null,
  ContractLifeDistance: 20000,
  ProductID: "1",
  PaymentPlanID: "263",
  Deposit: 0,
  QualifyingFlag: "1",
  RFLFundingFlag: "1",
  BrokerID: 699,
  CustomerID: 14483,
  CustomerStructureID: 0,
  CustomerPayrollCycle: 3,
  BrokerProspectID: 0,
  DriverID: 0,
  EstimatedDriverAge: 0,
  DriverGradeID: 0,
  VehicleAssetTypeID: 1,
  ManufacturerIDList: [] as number[],
  RangeIDList: [] as number[],
  ModelIDList: [] as number[],
  TextSearch: "",
  FuelTypeList: [] as string[],
  RDELevelList: [] as string[],
  TransmissionTypesList: [] as string[],
  BodyStyleList: [] as string[],
  DoorsList: [] as string[],
  DerivativeStatusList: [] as string[],
  MinCo2: null,
  MaxCo2: null,
  MinEngineSize: null,
  MaxEngineSize: null,
  MinMPG: null,
  MaxMPG: null,
  MaxLtrPer100Km: null,
  MinMaxEVRange: null,
  NCAPRating: "0",
  MaxInsuranceGroup: "0",
  MinLuggageCapacity: null,
  MinMaxLoadingWeight: null,
  MaxMaxLoadingWeight: null,
  MinEnginePowerKW: null,
  MaxEnginePowerKW: null,
  MinEnginePowerBHP: null,
  MaxEnginePowerBHP: null,
  MinNoOfSeats: null,
  MaxNoOfSeats: null,
  FourWheelDrive: "1",
  RangeType: "1",
  RangeFrom: 0,
  RangeTo: null,
  ListPriceTo: null,
  ListPriceFrom: null,
  P11DPriceFrom: null,
  P11DPriceTo: null,
  MaxBIKTaxablePercent: null,
  MaxBIKMonthly: null,
  BIKPercentage: 20,
  MaxBIKMonthlyWithFuel: null,
  BIKPercentageWithFuel: 20,
  BIKRatesApplicable: [
    { Id: 1, Name: "UK Rates", IsDefault: true },
    { Id: 2, Name: "Scottish Rates", IsDefault: false },
  ],
  UKTaxCountry: "1",
  MinLifeCostsPPM: null,
  MaxLifeCostsPPM: null,
  DealerCode: 0,
  DealerCode2: 0,
  DiscountPercent: 0,
  AllowZeroDiscountPercent: false,
  DriverContribution: null,
  DriverContributionMethodID: null,
  DriverAnnualSalary: null,
  SalarySacrificeFrom: null,
  SalarySacrificeTo: null,
  UseDriverSalarySacrifice: false,
  ShowCashAllowanceCalculation: false,
  UseCashAllowanceCalculation: false,
  CashAllowanceCalculationID: 0,
  NetCostToDriverFrom: null,
  NetCostToDriverTo: null,
  CashAllowanceNetCostFrom: null,
  CashAllowanceNetCostTo: null,
  CashAllowanceCalculations: [
    { Id: 0, Name: "No", IsDefault: false },
    { Id: 1, Name: "Yes", IsDefault: true },
  ],
  ProductServices: [] as string[],
  CashAllowanceCalculation: "",
  ShowDriverSalarySacrifice: false,
};

/**
 * Convert a decimal value (pounds) to pence integer
 */
function toPence(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "" || value === "0") {
    return null;
  }
  const num = typeof value === "string" ? parseFloat(value.replace(/[,£\s]/g, "")) : value;
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

/**
 * Map payment plan from Ogilvie format to our enum
 * Accepts either payment plan name or payment plan ID
 */
function mapPaymentPlan(plan: string | null, paymentPlanId?: string | null): string {
  // First try to map by ID if provided
  if (paymentPlanId && PAYMENT_PLAN_ID_MAP[paymentPlanId]) {
    return PAYMENT_PLAN_ID_MAP[paymentPlanId];
  }

  if (!plan) return "monthly_in_advance";
  if (PAYMENT_PLAN_MAP[plan]) return PAYMENT_PLAN_MAP[plan];

  const lower = plan.toLowerCase();
  if (lower.includes("advance") || lower.includes("1 in")) return "monthly_in_advance";
  if (lower.includes("spread") && lower.includes("9")) return "spread_9_down";
  if (lower.includes("spread") && lower.includes("6")) return "spread_6_down";
  if (lower.includes("spread") && lower.includes("3")) return "spread_3_down";
  return "monthly_in_advance";
}

/**
 * Calculate annual mileage from life distance and term
 */
function calculateAnnualMileage(lifeDistance: number, termMonths: number): number {
  return Math.round(lifeDistance / (termMonths / 12));
}

/**
 * Get or create a CAP code match for an Ogilvie vehicle
 * Priority:
 * 1. Check Ogilvie CAP mappings table (scraped from website) - 100% confidence
 * 2. Check existing confirmed matches in vehicle_cap_matches
 * 3. Fuzzy match against Lex data
 */
async function getOrCreateCapMatch(
  manufacturer: string,
  model: string,
  variant: string | null,
  p11d: number | null,
  yearIntroduced: string | null
): Promise<string | null> {
  // Construct full derivative name as it appears on Ogilvie website
  const derivativeFullName = yearIntroduced
    ? `${manufacturer} ${model} ${variant || ""} (${yearIntroduced})`.trim()
    : `${manufacturer} ${model} ${variant || ""}`.trim();

  // Priority 1: Check Ogilvie CAP mappings table (from website scrape)
  const ogilvieMapping = await lookupOgilvieCapMapping(derivativeFullName);
  if (ogilvieMapping?.capId) {
    const sourceKey = generateSourceKey(manufacturer, model, variant);
    await saveMatchResult({
      sourceKey,
      manufacturer,
      model,
      variant,
      p11d,
      capCode: ogilvieMapping.capId,
      matchedManufacturer: manufacturer,
      matchedModel: model,
      matchedVariant: variant,
      matchedP11d: p11d,
      confidence: 100,
      method: "auto_exact",
    }, "ogilvie");
    return ogilvieMapping.capId;
  }

  // Priority 2: Try to get existing confirmed match
  const capCode = await getCapCodeForVehicle(manufacturer, model, variant, p11d, "ogilvie");
  if (capCode) {
    return capCode;
  }

  // Priority 3: Fuzzy match against Lex data
  const result = await findCapCodeMatch({ manufacturer, model, variant, p11d });
  await saveMatchResult(result, "ogilvie");

  // Return the CAP code if confidence is high enough (auto-confirmed)
  if (result.confidence >= 90) {
    return result.capCode;
  }

  return null;
}

export type ProcessOgilvieResult = {
  importId: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  uniqueCapCodes: number;
};

/**
 * Process ogilvie_ratebook data from a batch and insert into provider_rates with CAP matching
 */
export async function processOgilvieToProviderRates(batchId: string): Promise<ProcessOgilvieResult> {
  console.log(`Processing ogilvie_ratebook batch ${batchId} to provider_rates...`);

  // Get all rows from ogilvie_ratebook for this batch
  const ratebookRows = await db
    .select()
    .from(ogilvieRatebook)
    .where(eq(ogilvieRatebook.exportBatchId, batchId));

  if (ratebookRows.length === 0) {
    console.log("No rows found in ogilvie_ratebook for batch");
    return { importId: "", totalRows: 0, successRows: 0, errorRows: 0, uniqueCapCodes: 0 };
  }

  console.log(`Found ${ratebookRows.length} rows in ogilvie_ratebook`);

  // Group by contract type to create separate imports
  const byContractType = new Map<string, typeof ratebookRows>();
  for (const row of ratebookRows) {
    const product = row.product || "Contract Hire (No Maintenance - No Tyres)";
    const contractType = PRODUCT_TO_CONTRACT_TYPE[product] || "CHNM";
    if (!byContractType.has(contractType)) {
      byContractType.set(contractType, []);
    }
    byContractType.get(contractType)!.push(row);
  }

  let totalSuccessRows = 0;
  let totalErrorRows = 0;
  const allCapCodes = new Set<string>();
  let lastImportId = "";

  for (const [contractType, rows] of Array.from(byContractType.entries())) {
    console.log(`\nProcessing ${contractType}: ${rows.length} rows`);

    // Mark previous Ogilvie imports as not latest
    await db
      .update(ratebookImports)
      .set({ isLatest: false })
      .where(and(eq(ratebookImports.providerCode, "ogilvie"), eq(ratebookImports.isLatest, true)));

    // Create import record
    const importBatchId = `ogilvie_${contractType.toLowerCase()}_${Date.now()}`;
    const [importRecord] = await db
      .insert(ratebookImports)
      .values({
        providerCode: "ogilvie",
        contractType,
        batchId: importBatchId,
        fileName: `ogilvie_export_${batchId}`,
        status: "processing",
        isLatest: true,
        startedAt: new Date(),
        totalRows: rows.length,
      })
      .returning();

    lastImportId = importRecord.id;
    let successRows = 0;
    let errorRows = 0;
    const errors: string[] = [];
    const capCodes = new Set<string>();
    const BATCH_SIZE = 50;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const ratesToInsert: (typeof providerRates.$inferInsert)[] = [];

      for (const row of batch) {
        try {
          const manufacturer = row.manufacturerName?.trim();
          const model = row.modelName?.trim();
          const variant = row.derivativeName?.trim() || null;

          if (!manufacturer || !model) {
            errorRows++;
            errors.push(`Row missing manufacturer or model`);
            continue;
          }

          const p11dValue = toPence(row.p11dValue);

          // Get CAP code via matching system
          const capCode = await getOrCreateCapMatch(
            manufacturer,
            model,
            variant,
            p11dValue,
            row.yearIntroduced
          );

          if (!capCode) {
            errorRows++;
            errors.push(`No CAP code match for ${manufacturer} ${model}`);
            continue;
          }

          capCodes.add(capCode);
          allCapCodes.add(capCode);

          // Calculate annual mileage from life distance and term
          // Ogilvie uses life distance (total contract miles), not annual mileage
          const lifeDistance = row.contractMileage || 30000;
          const termMonths = row.contractTerm || 36;
          const annualMileage = calculateAnnualMileage(lifeDistance, termMonths);

          const rate: typeof providerRates.$inferInsert = {
            capCode,
            importId: importRecord.id,
            providerCode: "ogilvie",
            contractType,
            manufacturer: manufacturer.toUpperCase(),
            model,
            variant,
            isCommercial: false,
            term: termMonths,
            annualMileage,
            paymentPlan: mapPaymentPlan(row.paymentPlan),
            totalRental: toPence(row.regularRental) || toPence(row.monthlyEffectiveRental) || 0,
            leaseRental: toPence(row.financeRentalExcVat),
            serviceRental: toPence(row.nonFinanceRental),
            co2Gkm: row.co2Gkm,
            p11d: p11dValue,
            fuelType: row.fuelType || null,
            transmission: row.transmission || null,
            bodyStyle: row.bodyStyles || null,
            modelYear: row.yearIntroduced || null,
            wltpEvRange: row.maxEvRange ? parseInt(String(row.maxEvRange)) : null,
            fuelEcoCombined: row.ecCombinedMpg ? String(row.ecCombinedMpg) : null,
            bikTaxLowerRate: toPence(row.bik20Percent),
            bikTaxHigherRate: toPence(row.bik40Percent),
            wholeLifeCost: toPence(row.periodWholeLifeCosts),
            insuranceGroup: row.insuranceGroup || null,
          };

          ratesToInsert.push(rate);
          successRows++;
        } catch (e) {
          errorRows++;
          errors.push(`Error processing row: ${e}`);
        }
      }

      // Bulk insert batch
      if (ratesToInsert.length > 0) {
        try {
          await db.insert(providerRates).values(ratesToInsert);
        } catch (e) {
          errorRows += ratesToInsert.length;
          successRows -= ratesToInsert.length;
          errors.push(`Batch insert error: ${e}`);
        }
      }

      console.log(`  Processed ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} rows`);
    }

    // Update import record
    await db
      .update(ratebookImports)
      .set({
        status: errorRows > rows.length / 2 ? "failed" : "completed",
        successRows,
        errorRows,
        uniqueCapCodes: capCodes.size,
        errorLog: errors.length > 0 ? errors.slice(0, 50) : null,
        completedAt: new Date(),
      })
      .where(eq(ratebookImports.id, importRecord.id));

    console.log(`  Completed: ${successRows} success, ${errorRows} errors, ${capCodes.size} unique CAP codes`);

    totalSuccessRows += successRows;
    totalErrorRows += errorRows;
  }

  return {
    importId: lastImportId,
    totalRows: ratebookRows.length,
    successRows: totalSuccessRows,
    errorRows: totalErrorRows,
    uniqueCapCodes: allCapCodes.size,
  };
}

export type OgilvieLoginResult = {
  success: boolean;
  sessionCookie?: string;
  verificationToken?: string;
  error?: string;
};

export type OgilvieExportProgress = {
  status: "preparing" | "exporting" | "downloading" | "completed" | "error";
  currentPage: number;
  totalPages: number;
  vehiclesProcessed: number;
  error?: string;
};

// Create axios client with cookie jar
function createClient(cookies?: string): { client: AxiosInstance; jar: CookieJar } {
  const jar = new CookieJar();

  // If cookies provided, add them to the jar
  if (cookies) {
    const cookieParts = cookies.split(";").map((c) => c.trim());
    for (const cookie of cookieParts) {
      try {
        jar.setCookieSync(cookie, BASE_URL);
      } catch (e) {
        // Ignore cookie parsing errors
      }
    }
  }

  const client = wrapper(
    axios.create({
      baseURL: BASE_URL,
      jar,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
      withCredentials: true,
      maxRedirects: 5,
    } as Parameters<typeof axios.create>[0] & { jar: CookieJar })
  );

  return { client, jar };
}

// Login to Ogilvie Fleet
export async function loginToOgilvie(email: string, password: string): Promise<OgilvieLoginResult> {
  console.log("Attempting Ogilvie login as:", email);

  const { client, jar } = createClient();

  try {
    // First, get the login page to capture the CSRF token
    const loginPageResponse = await client.get("/BrokerQuotes/Account/Login");
    const $ = cheerio.load(loginPageResponse.data);

    // Extract verification token - this is required
    const verificationToken =
      $('input[name="__RequestVerificationToken"]').val() as string | undefined;

    if (!verificationToken) {
      console.error("Could not find __RequestVerificationToken on login page");
      return {
        success: false,
        error: "Could not retrieve login page token",
      };
    }

    // Prepare login form data exactly as the browser does
    const formData = new URLSearchParams();
    formData.append("__RequestVerificationToken", verificationToken);
    formData.append("Email", email);
    formData.append("Password", password);

    // Submit login to the Account/Login endpoint
    const loginResponse = await client.post(
      "/BrokerQuotes/Account/Login?ReturnUrl=%2FBrokerQuotes%2F",
      formData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `${BASE_URL}/BrokerQuotes/Account/Login`,
          Origin: BASE_URL,
        },
        maxRedirects: 5,
      }
    );

    // Check if login was successful by looking at the response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalUrl = (loginResponse.request as any)?.res?.responseUrl || "";

    // If we're redirected to the dashboard or derivative search, login was successful
    if (
      finalUrl.includes("DerivativeSearch") ||
      finalUrl.includes("Dashboard") ||
      !finalUrl.includes("Login")
    ) {
      // Get all cookies from the jar
      const cookies = await jar.getCookies(BASE_URL);
      const cookieString = cookies.map((c) => `${c.key}=${c.value}`).join("; ");

      console.log("Ogilvie login successful");

      return {
        success: true,
        sessionCookie: cookieString,
        verificationToken,
      };
    }

    // Check for error messages in the response
    const $response = cheerio.load(loginResponse.data);
    const errorMsg =
      $response(".validation-summary-errors").text().trim() ||
      $response(".alert-danger").text().trim() ||
      "Login failed - check your credentials";

    return {
      success: false,
      error: errorMsg,
    };
  } catch (error) {
    console.error("Ogilvie login error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown login error",
    };
  }
}

// Validate if a session is still active
export async function validateOgilvieSession(sessionCookie: string): Promise<boolean> {
  const { client } = createClient(sessionCookie);

  try {
    const response = await client.get("/BrokerQuotes/DerivativeSearch?ShortListID=0", {
      maxRedirects: 0,
      validateStatus: (status) => status < 400,
    });

    // If we get a 200 and not redirected to login, session is valid
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalUrl = (response.request as any)?.res?.responseUrl || "";
    return !finalUrl.includes("Login") && response.status === 200;
  } catch (error) {
    return false;
  }
}

// Get available manufacturers from Ogilvie
export async function getOgilvieManufacturers(
  sessionCookie: string
): Promise<{ id: number; name: string }[]> {
  const { client } = createClient(sessionCookie);

  try {
    // Navigate to derivative search to initialize session
    const response = await client.get("/BrokerQuotes/DerivativeSearch?ShortListID=0");
    const $ = cheerio.load(response.data);

    // Look for manufacturer dropdown/list in the page
    const manufacturers: { id: number; name: string }[] = [];

    // Try to find manufacturer select element
    $('select[name="ManufacturerID"] option, #ManufacturerID option, [data-manufacturer] option').each((_, el) => {
      const $el = $(el);
      const id = parseInt($el.attr("value") || "0", 10);
      const name = $el.text().trim();
      if (id > 0 && name) {
        manufacturers.push({ id, name });
      }
    });

    // If not found in select, try the API
    if (manufacturers.length === 0) {
      const apiResponse = await client.get("/BrokerQuotes/api/DerivativeSearch/GetManufacturers", {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      if (Array.isArray(apiResponse.data)) {
        for (const item of apiResponse.data) {
          const id = item.ID || item.Id || item.id || item.ManufacturerID;
          const name = item.Name || item.name || item.ManufacturerName;
          if (id && name) {
            manufacturers.push({ id: parseInt(id, 10), name });
          }
        }
      }
    }

    return manufacturers.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("Error fetching manufacturers:", error);
    return [];
  }
}

// Get total vehicle count for current filters
async function getTotalVehicleCount(
  client: AxiosInstance,
  searchFilter: typeof DEFAULT_SEARCH_FILTER
): Promise<number> {
  try {
    const response = await client.post(
      "/BrokerQuotes/api/DerivativeSearch/GetDerivatives",
      {
        PageNo: 1,
        PageSize: 1,
        SearchFilter: searchFilter,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );

    // The response should contain total count info
    return response.data?.TotalRecords || response.data?.totalRecords || 0;
  } catch (error) {
    console.error("Error getting vehicle count:", error);
    return 0;
  }
}

// Prepare export by calling PrepareExport for each page
async function prepareExportPages(
  client: AxiosInstance,
  searchFilter: typeof DEFAULT_SEARCH_FILTER,
  totalVehicles: number,
  onProgress?: (progress: OgilvieExportProgress) => void
): Promise<boolean> {
  const pageSize = 10; // Ogilvie uses page size of 10 for export
  const totalPages = Math.ceil(totalVehicles / pageSize);

  console.log(`Preparing export: ${totalVehicles} vehicles across ${totalPages} pages`);

  for (let page = 1; page <= totalPages; page++) {
    onProgress?.({
      status: "preparing",
      currentPage: page,
      totalPages,
      vehiclesProcessed: (page - 1) * pageSize,
    });

    try {
      const response = await client.post(
        "/BrokerQuotes/DerivativeSearch/PrepareExport",
        {
          PageNo: page,
          PageSize: pageSize,
          SearchFilter: searchFilter,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
        }
      );

      if (!response.data?.result) {
        console.error(`PrepareExport failed for page ${page}`);
        return false;
      }

      // Small delay between requests to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error preparing export page ${page}:`, error);
      return false;
    }
  }

  return true;
}

// Download the CSV export
async function downloadExportCsv(client: AxiosInstance): Promise<string | null> {
  try {
    const response = await client.get("/BrokerQuotes/DerivativeSearch/Export?Format=CSV", {
      headers: {
        Accept: "text/csv,application/octet-stream,*/*",
      },
      responseType: "text",
    });

    return response.data;
  } catch (error) {
    console.error("Error downloading CSV:", error);
    return null;
  }
}

// Parse CSV string into array of objects
function parseCsv(csvData: string): Record<string, string>[] {
  const lines = csvData.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return [];

  // Parse header row - handle quoted values
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header.trim()] = values[index]?.trim() || "";
    });

    rows.push(row);
  }

  return rows;
}

// Parse a single CSV line handling quoted values
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

// Parse currency string to pence (integer)
function parseCurrencyToPence(value: string): number | null {
  if (!value) return null;
  // Remove currency symbols, commas, spaces
  const cleaned = value.replace(/[£$,\s]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return Math.round(num * 100); // Convert to pence
}

// Parse percentage string
function parsePercent(value: string): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[%\s]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return num.toString();
}

// Parse integer
function parseInteger(value: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[,\s]/g, "");
  const num = parseInt(cleaned, 10);
  if (isNaN(num)) return null;
  return num;
}

// Helper to parse numeric value
function parseNumeric(value: string): string | null {
  if (!value || value.trim() === "") return null;
  const cleaned = value.replace(/[,\s]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return num.toString();
}

// Insert CSV data into ogilvie_ratebook table
async function insertRatebookData(
  csvData: string,
  batchId: string,
  contractTerm: number,
  contractMileage: number
): Promise<number> {
  const rows = parseCsv(csvData);
  console.log(`Parsing ${rows.length} rows from CSV for batch ${batchId}`);

  if (rows.length === 0) return 0;

  // Log first row headers to help debug column mapping
  const firstRow = rows[0];
  console.log("CSV Headers found:", Object.keys(firstRow));

  let insertedCount = 0;
  const batchSize = 100;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    const insertValues = batch.map((row) => {
      return {
        exportBatchId: batchId,
        derivativeName: row["Derivative Name"] || null,
        manufacturerName: row["Manufacturer Name"] || null,
        rangeName: row["Range Name"] || null,
        modelName: row["Model Name"] || null,
        yearIntroduced: row["Year Introduced"] || null,
        bodyStyles: row["Body Styles"] || null,
        is4wd: row["Is It 4WD"] || null,
        transmission: row["Transmission"] || null,
        cc: parseInteger(row["CC"] || ""),
        fuelType: row["Fuel Type"] || null,
        ecCombinedMpg: parseNumeric(row["EC Combined mpg"] || ""),
        maxEvRange: parseNumeric(row["Max EV Range"] || ""),
        batteryCapacityKwh: parseNumeric(row["BatteryCapacityInkWh"] || ""),
        enginePowerKw: parseInteger(row["EnginePowerKW"] || ""),
        listPrice: parseNumeric(row["List Price"] || ""),
        p11dValue: parseNumeric(row["P11D Value"] || ""),
        co2Gkm: parseInteger(row["CO2 gkm"] || ""),
        carbonFootprint: parseNumeric(row["CarbonFootprint"] || ""),
        insuranceGroup: row["InsuranceGroup50"] || null,
        ncap: parseInteger(row["NCAP"] || ""),
        ncapPedestrian: parseInteger(row["NCAP Pedestrian"] || ""),
        product: row["Product"] || null,
        paymentPlan: row["Payment Plan"] || null,
        contractTerm: parseInteger(row["Contract Term"] || "") || contractTerm,
        contractMileage: parseInteger(row["Contract Mileage"] || "") || contractMileage,
        bik20Percent: parseNumeric(row["England BIK At 20%"] || ""),
        bik40Percent: parseNumeric(row["England BIK At 40%"] || ""),
        financeRentalExcVat: parseNumeric(row["Finance Rental Exc. VAT"] || ""),
        nonFinanceRental: parseNumeric(row["Non Finance Rental"] || ""),
        regularRental: parseNumeric(row["Regular Rental"] || ""),
        monthlyEffectiveRental: parseNumeric(row["Monthly Effective Rental"] || ""),
        periodWholeLifeCosts: parseNumeric(row["Period Whole Life Costs"] || ""),
        ogilvieTrueCost: parseNumeric(row["Ogilvie True Cost"] || ""),
        driverRebate: parseNumeric(row["Driver Rebate"] || ""),
        minDriverContribution: parseNumeric(row["Min Driver Contribution"] || ""),
        maxLoadingWeight: parseInteger(row["Max Loading Weight"] || ""),
        maxTowingWeightBraked: parseInteger(row["Max Towing Weight Braked"] || ""),
        maxTowingWeightUnbraked: parseInteger(row["Max Towing Weight Unbraked"] || ""),
        luggageCapacitySeatsUp: parseInteger(row["Luggage Capacity Seats Up"] || ""),
        luggageCapacitySeatsDown: parseInteger(row["Luggage Capacity Seats Down"] || ""),
        minimumKerbweight: parseInteger(row["Minimum Kerbweight"] || ""),
      };
    }).filter((v) => v.manufacturerName && v.modelName); // Only insert rows with manufacturer and model

    if (insertValues.length > 0) {
      try {
        await db.insert(ogilvieRatebook).values(insertValues);
        insertedCount += insertValues.length;
      } catch (error) {
        console.error(`Error inserting batch at index ${i}:`, error);
      }
    }
  }

  console.log(`Inserted ${insertedCount} rows into ogilvie_ratebook`);
  return insertedCount;
}

// Main export function
export async function runOgilvieExport(
  sessionCookie: string,
  config: OgilvieExportConfig,
  onProgress?: (progress: OgilvieExportProgress) => void
): Promise<{ success: boolean; batchId?: string; csvData?: string; insertedRows?: number; providerRatesResult?: ProcessOgilvieResult; error?: string }> {
  const batchId = `ogilvie_${Date.now()}`;
  const { client } = createClient(sessionCookie);

  // Create the search filter with the specified config
  const searchFilter = {
    ...DEFAULT_SEARCH_FILTER,
    ContractTerm: config.contractTerm,
    ContractLifeDistance: config.contractMileage,
    ProductID: config.productId || "1",
    PaymentPlanID: config.paymentPlanId || "263",
    QualifyingFlag: config.qualifyingFlag || "1",
    RFLFundingFlag: config.rflFundingFlag || "1",
    ManufacturerIDList: config.manufacturerIds || [],
  };

  try {
    // Create export record
    await db.insert(ogilvieExports).values({
      batchId,
      status: "running",
      contractTerm: config.contractTerm,
      contractMileage: config.contractMileage,
      productId: searchFilter.ProductID,
      paymentPlanId: searchFilter.PaymentPlanID,
      startedAt: new Date(),
    });

    // First, navigate to the derivative search page to initialize the session
    onProgress?.({
      status: "preparing",
      currentPage: 0,
      totalPages: 0,
      vehiclesProcessed: 0,
    });

    await client.get("/BrokerQuotes/DerivativeSearch?ShortListID=0");

    // Save the filters to set up the export
    await client.post("/BrokerQuotes/DerivativeSearch/SaveFilters", searchFilter, {
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    // Get total vehicle count
    const totalVehicles = await getTotalVehicleCount(client, searchFilter);
    console.log(`Total vehicles to export: ${totalVehicles}`);

    if (totalVehicles === 0) {
      // Try to get vehicles anyway - the count might not be returned
      // We'll proceed with a reasonable estimate
      console.log("Could not determine vehicle count, proceeding with export...");
    }

    // Update export record with vehicle count
    await db
      .update(ogilvieExports)
      .set({ totalVehicles })
      .where(eq(ogilvieExports.batchId, batchId));

    // Prepare export pages
    const estimatedVehicles = totalVehicles || 5000; // Use estimate if count not available
    const prepared = await prepareExportPages(client, searchFilter, estimatedVehicles, onProgress);

    if (!prepared) {
      throw new Error("Failed to prepare export pages");
    }

    // Download the CSV
    onProgress?.({
      status: "downloading",
      currentPage: 0,
      totalPages: 0,
      vehiclesProcessed: estimatedVehicles,
    });

    const csvData = await downloadExportCsv(client);

    if (!csvData) {
      throw new Error("Failed to download CSV export");
    }

    // Count rows in CSV
    const rowCount = csvData.split("\n").filter((line) => line.trim()).length - 1; // Subtract header

    // Parse and insert into ogilvie_ratebook table
    onProgress?.({
      status: "exporting",
      currentPage: 0,
      totalPages: 0,
      vehiclesProcessed: rowCount,
    });

    const insertedRows = await insertRatebookData(
      csvData,
      batchId,
      config.contractTerm,
      config.contractMileage
    );

    // Process ogilvie_ratebook data into provider_rates with CAP matching
    console.log("Processing ogilvie_ratebook data into provider_rates with CAP matching...");
    const processResult = await processOgilvieToProviderRates(batchId);
    console.log(`Provider rates processed: ${processResult.successRows} success, ${processResult.errorRows} errors, ${processResult.uniqueCapCodes} unique CAP codes`);

    // Update export record
    await db
      .update(ogilvieExports)
      .set({
        status: "completed",
        exportedRows: insertedRows,
        csvData,
        completedAt: new Date(),
      })
      .where(eq(ogilvieExports.batchId, batchId));

    onProgress?.({
      status: "completed",
      currentPage: 0,
      totalPages: 0,
      vehiclesProcessed: insertedRows,
    });

    return {
      success: true,
      batchId,
      csvData,
      insertedRows,
      providerRatesResult: processResult,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Update export record with error
    await db
      .update(ogilvieExports)
      .set({
        status: "failed",
        errorMessage,
        completedAt: new Date(),
      })
      .where(eq(ogilvieExports.batchId, batchId));

    onProgress?.({
      status: "error",
      currentPage: 0,
      totalPages: 0,
      vehiclesProcessed: 0,
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

// Run multiple exports (24/20k, 36/30k, 48/40k)
export async function runOgilvieMultiExport(
  sessionCookie: string,
  configs: OgilvieExportConfig[],
  onProgress?: (configIndex: number, progress: OgilvieExportProgress) => void
): Promise<{ results: Array<{ config: OgilvieExportConfig; success: boolean; batchId?: string; error?: string }> }> {
  const results: Array<{ config: OgilvieExportConfig; success: boolean; batchId?: string; error?: string }> = [];

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    console.log(`Running export ${i + 1}/${configs.length}: ${config.contractTerm} months / ${config.contractMileage} miles`);

    const result = await runOgilvieExport(sessionCookie, config, (progress) => {
      onProgress?.(i, progress);
    });

    results.push({
      config,
      success: result.success,
      batchId: result.batchId,
      error: result.error,
    });

    // Delay between exports
    if (i < configs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return { results };
}

export type FullExportProgress = {
  configIndex: number;
  totalConfigs: number;
  currentConfig: OgilvieExportConfig;
  exportProgress: OgilvieExportProgress;
  completedConfigs: number;
  successfulConfigs: number;
  failedConfigs: number;
};

export type FullExportResult = {
  success: boolean;
  totalConfigs: number;
  completedConfigs: number;
  successfulConfigs: number;
  failedConfigs: number;
  totalRatesImported: number;
  results: Array<{
    config: OgilvieExportConfig;
    success: boolean;
    batchId?: string;
    insertedRows?: number;
    error?: string;
  }>;
};

/**
 * Run a full export of ALL Ogilvie rate combinations
 * This fetches rates for: 2 products × 4 terms × 4 mileages × 4 payment plans = 128 configs
 *
 * @param sessionCookie - Valid Ogilvie session cookie
 * @param onProgress - Optional callback for progress updates
 * @param delayBetweenExports - Delay in ms between exports (default 3000)
 */
export async function runOgilvieFullExport(
  sessionCookie: string,
  onProgress?: (progress: FullExportProgress) => void,
  delayBetweenExports = 3000
): Promise<FullExportResult> {
  const configs = generateAllOgilvieConfigs();
  const totalConfigs = configs.length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Starting FULL Ogilvie export: ${totalConfigs} configurations`);
  console.log(`${"=".repeat(60)}\n`);

  const results: FullExportResult["results"] = [];
  let successfulConfigs = 0;
  let failedConfigs = 0;
  let totalRatesImported = 0;

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];

    // Build a readable description
    const productName = config.productId === "3" ? "CH" : "CHNM";
    const paymentPlanName = PAYMENT_PLAN_ID_MAP[config.paymentPlanId || "263"] || "monthly";
    const annualMileage = calculateAnnualMileage(config.contractMileage, config.contractTerm);

    console.log(`\n[${i + 1}/${totalConfigs}] Exporting: ${productName} | ${config.contractTerm}mo | ${annualMileage.toLocaleString()}/yr | ${paymentPlanName}`);

    const result = await runOgilvieExport(sessionCookie, config, (progress) => {
      onProgress?.({
        configIndex: i,
        totalConfigs,
        currentConfig: config,
        exportProgress: progress,
        completedConfigs: i,
        successfulConfigs,
        failedConfigs,
      });
    });

    if (result.success) {
      successfulConfigs++;
      totalRatesImported += result.insertedRows || 0;
      console.log(`  ✓ Success: ${result.insertedRows?.toLocaleString() || 0} rows`);
    } else {
      failedConfigs++;
      console.log(`  ✗ Failed: ${result.error}`);
    }

    results.push({
      config,
      success: result.success,
      batchId: result.batchId,
      insertedRows: result.insertedRows,
      error: result.error,
    });

    // Progress callback after each config
    onProgress?.({
      configIndex: i,
      totalConfigs,
      currentConfig: config,
      exportProgress: { status: "completed", currentPage: 0, totalPages: 0, vehiclesProcessed: result.insertedRows || 0 },
      completedConfigs: i + 1,
      successfulConfigs,
      failedConfigs,
    });

    // Delay between exports to avoid rate limiting
    if (i < configs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenExports));
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Full Export Complete`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Total Configs: ${totalConfigs}`);
  console.log(`Successful: ${successfulConfigs}`);
  console.log(`Failed: ${failedConfigs}`);
  console.log(`Total Rates Imported: ${totalRatesImported.toLocaleString()}`);
  console.log(`${"=".repeat(60)}\n`);

  return {
    success: failedConfigs === 0,
    totalConfigs,
    completedConfigs: successfulConfigs + failedConfigs,
    successfulConfigs,
    failedConfigs,
    totalRatesImported,
    results,
  };
}

// Get export history
export async function getOgilvieExports(limit = 20) {
  return await db.query.ogilvieExports.findMany({
    orderBy: (exports, { desc }) => [desc(exports.createdAt)],
    limit,
  });
}

// Get specific export with CSV data
export async function getOgilvieExport(batchId: string) {
  return await db.query.ogilvieExports.findFirst({
    where: eq(ogilvieExports.batchId, batchId),
  });
}

// Delete old exports
export async function deleteOgilvieExport(batchId: string) {
  await db.delete(ogilvieRatebook).where(eq(ogilvieRatebook.exportBatchId, batchId));
  await db.delete(ogilvieExports).where(eq(ogilvieExports.batchId, batchId));
}

// Store/retrieve cached sessions
export async function cacheOgilvieSession(userId: string, sessionCookie: string, verificationToken?: string) {
  // Delete any existing sessions for this user
  await db.delete(ogilvieSessions).where(eq(ogilvieSessions.userId, userId));

  // Insert new session (expires in 1 hour)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(ogilvieSessions).values({
    userId,
    sessionCookie,
    verificationToken,
    expiresAt,
  });
}

export async function getCachedOgilvieSession(userId: string) {
  const session = await db.query.ogilvieSessions.findFirst({
    where: eq(ogilvieSessions.userId, userId),
  });

  if (!session) return null;

  // Check if expired
  if (new Date(session.expiresAt) < new Date()) {
    await db.delete(ogilvieSessions).where(eq(ogilvieSessions.id, session.id));
    return null;
  }

  return session;
}
