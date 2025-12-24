/**
 * Lex Autolease API Client
 *
 * Server-side client for making authenticated API calls to Lex Autolease
 * using stored session credentials.
 */

import { db } from "../db/index.js";
import { lexSessions } from "../db/schema.js";
import { eq, and, gt } from "drizzle-orm";
import type { LexProfile } from "../db/schema.js";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";

const LEX_BASE_URL = "https://associate.lexautolease.co.uk";

// Lex Payment Plan IDs - verified from captured API data
const LEX_PAYMENT_PLAN_IDS: Record<string, number> = {
  annual_in_advance: 1,
  monthly_in_advance: 7,
  quarterly_in_advance: 8,
  three_down_terminal_pause: 9,
  six_down_terminal_pause: 12,
  nine_down_terminal_pause: 17,
  spread_3_down: 23,
  spread_6_down: 26,
  spread_12_down: 27,
  no_deposit_benefit_car: 39,
  spread_9_down: 43,
};

// Payment plan initial rental multipliers (how many months upfront)
const LEX_PAYMENT_PLAN_MULTIPLIERS: Record<string, number> = {
  annual_in_advance: 12,
  monthly_in_advance: 1,
  quarterly_in_advance: 3,
  three_down_terminal_pause: 3,
  six_down_terminal_pause: 6,
  nine_down_terminal_pause: 9,
  spread_3_down: 3,
  spread_6_down: 6,
  spread_12_down: 12,
  spread_9_down: 9,
  no_deposit_benefit_car: 0,
};

// Contract Type IDs - verified from captured API data
const LEX_CONTRACT_TYPE_IDS = {
  contract_hire_with_maintenance: 2,        // CHM
  contract_hire_without_maintenance: 5,     // CHNM
  personal_contract_hire: 87,               // PCH
  personal_contract_hire_without_maint: 88, // PCHNM
  salary_sacrifice: 110,                    // SSC
  flexible_lease_with_maintenance: 121,     // FXWM
};

export type LexQuoteParams = {
  makeId: string;
  modelId: string;
  variantId: string;
  term: number;         // e.g., 24, 36, 48
  mileage: number;      // annual mileage e.g., 5000, 10000
  contractType?: keyof typeof LEX_CONTRACT_TYPE_IDS;
  paymentPlan?: keyof typeof LEX_PAYMENT_PLAN_IDS;
  brokerOtrp?: number;  // Custom OTR price in pounds (for fleet discounts)
};

export type LexQuoteResult = {
  success: boolean;
  quoteId?: string;
  monthlyRental?: number;       // ex VAT
  monthlyRentalIncVat?: number; // inc VAT
  initialRental?: number;
  otrp?: number;                // On The Road Price (Lex standard)
  brokerOtrp?: number;          // Custom broker OTR price used (if any)
  co2?: number;
  p11d?: number;
  term?: number;
  mileage?: number;
  contractType?: string;
  usedFleetDiscount?: boolean;  // Whether fleet discount was applied
  error?: string;
};

export type LexContractType = {
  Key: number;
  Value: string;
};

export class LexApiClient {
  private sessionCookies: string;
  private csrfToken: string;
  private profile: LexProfile;

  constructor(sessionCookies: string, csrfToken: string, profile: LexProfile) {
    this.sessionCookies = sessionCookies;
    this.csrfToken = csrfToken;
    this.profile = profile;
  }

  /**
   * Login with email and password
   * Returns a new LexApiClient and saves the session to the database
   */
  static async login(email: string, password: string): Promise<LexApiClient> {
    console.log("Attempting Lex Autolease login as:", email);

    const jar = new CookieJar();
    const client = wrapper(
      axios.create({
        baseURL: LEX_BASE_URL,
        jar,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.5",
        },
        withCredentials: true,
        maxRedirects: 5,
      } as Parameters<typeof axios.create>[0] & { jar: CookieJar })
    );

    // Step 1: Get the login page to get any CSRF tokens
    const loginPageResponse = await client.get("/");
    const $loginPage = cheerio.load(loginPageResponse.data);

    // Look for hidden form fields
    const hiddenFields: Record<string, string> = {};
    $loginPage('input[type="hidden"]').each((_, el) => {
      const name = $loginPage(el).attr("name");
      const value = $loginPage(el).attr("value") || "";
      if (name) {
        hiddenFields[name] = value;
      }
    });

    // Step 2: Submit the login form
    const loginData = new URLSearchParams({
      ...hiddenFields,
      txtUsername: email,
      txtPassword: password,
    });

    const loginResponse = await client.post("/", loginData.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      maxRedirects: 5,
    });

    // Check if login was successful by looking for error messages
    const $response = cheerio.load(loginResponse.data);
    const errorMessage = $response(".error-message, .login-error, .alert-danger").text().trim();

    if (errorMessage) {
      throw new Error(`Login failed: ${errorMessage}`);
    }

    // Check if we're still on the login page
    if (loginResponse.data.includes('txtPassword') && loginResponse.data.includes('txtUsername')) {
      throw new Error("Login failed - check your email and password");
    }

    // Step 3: Extract session data from the authenticated page
    // Look for csrf_token and profile in the JavaScript
    const csrfMatch = loginResponse.data.match(/csrf_token\s*[=:]\s*["']([^"']+)["']/);
    const profileMatch = loginResponse.data.match(/profile\s*[=:]\s*(\{[^}]+\})/);

    if (!csrfMatch) {
      // Try alternative pattern
      const altCsrfMatch = loginResponse.data.match(/window\.csrf_token\s*=\s*["']([^"']+)["']/);
      if (!altCsrfMatch) {
        throw new Error("Could not extract CSRF token from authenticated page");
      }
    }

    const csrfToken = csrfMatch?.[1] || loginResponse.data.match(/window\.csrf_token\s*=\s*["']([^"']+)["']/)?.[1] || "";

    // Parse profile or use defaults
    let profile: LexProfile = {
      SalesCode: "",
      Discount: "-1",
      RVCode: "00",
      Role: "",
      Username: email,
    };

    if (profileMatch) {
      try {
        const profileData = JSON.parse(profileMatch[1].replace(/'/g, '"'));
        profile = {
          SalesCode: profileData.SalesCode || "",
          Discount: profileData.Discount || "-1",
          RVCode: profileData.RVCode || "00",
          Role: profileData.Role || "",
          Username: profileData.Username || email,
        };
      } catch {
        // Use defaults if parsing fails
      }
    }

    // Get cookies as a string
    const cookies = await jar.getCookies(LEX_BASE_URL);
    const sessionCookies = cookies.map(c => `${c.key}=${c.value}`).join("; ");

    console.log("Login successful for:", profile.Username || email);

    // Invalidate any existing sessions
    await db
      .update(lexSessions)
      .set({ isValid: false })
      .where(eq(lexSessions.isValid, true));

    // Calculate expiry (sessions typically last 8 hours)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 8);

    // Store new session
    await db
      .insert(lexSessions)
      .values({
        sessionCookies,
        csrfToken,
        profileData: profile,
        isValid: true,
        expiresAt,
      });

    return new LexApiClient(sessionCookies, csrfToken, profile);
  }

  /**
   * Get valid session from database
   */
  static async getValidSession(): Promise<LexApiClient | null> {
    const sessions = await db
      .select()
      .from(lexSessions)
      .where(
        and(
          eq(lexSessions.isValid, true),
          gt(lexSessions.expiresAt, new Date())
        )
      )
      .orderBy(lexSessions.createdAt)
      .limit(1);

    if (sessions.length === 0) {
      return null;
    }

    const session = sessions[0];
    return new LexApiClient(
      session.sessionCookies,
      session.csrfToken,
      session.profileData
    );
  }

  /**
   * Get valid session or login with credentials
   */
  static async getOrCreateSession(email?: string, password?: string): Promise<LexApiClient | null> {
    // First try to get existing valid session
    const existing = await LexApiClient.getValidSession();
    if (existing) {
      return existing;
    }

    // If credentials provided, login
    if (email && password) {
      return await LexApiClient.login(email, password);
    }

    return null;
  }

  /**
   * Make authenticated API call to Lex service
   */
  private async callService<T>(serviceName: string, functionName: string, data: Record<string, unknown>): Promise<T> {
    const url = `${LEX_BASE_URL}/services/${serviceName}.svc/${functionName}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-csrf-check": this.csrfToken,
        "Cookie": this.sessionCookies,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Lex API Error (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }

  /**
   * Get available contract types
   */
  async getContractTypes(paymentPlanId = "", specialOfferId = 0): Promise<LexContractType[]> {
    return await this.callService<LexContractType[]>("Quote", "GetContractTypes", {
      paymentPlanId,
      specialOfferId,
    });
  }

  /**
   * Get variant details including WLTP CO2 value
   */
  async getVariantDetails(makeId: string, modelId: string, variantId: string): Promise<{
    WLTPCO2: number;
    CO2: number;
    ListPrice: number;
    Description: string;
    FuelType: string;
    Transmission: string;
    BodyStyle: string;
    EngineSize: number;
  }> {
    return await this.callService("Quote", "GetVariant", {
      manufacturerId: parseInt(makeId),
      modelId: parseInt(modelId),
      variantId: parseInt(variantId),
    });
  }

  /**
   * Build quote line request object - matches captured API format exactly
   */
  private buildQuoteLine(params: LexQuoteParams & { contractTypeId: number }) {
    // Total mileage = (term in months / 12) * annual mileage
    const totalMileage = Math.round((params.term / 12) * params.mileage);

    // If custom broker OTRP is provided, use it and set BonusExcluded to true
    const hasCustomOtrp = params.brokerOtrp && params.brokerOtrp > 0;

    return {
      LineNo: 0,
      Term: params.term.toString(),
      Mileage: params.mileage.toString(),
      TotalMileage: totalMileage.toString(),
      BrokerOTRP: hasCustomOtrp ? params.brokerOtrp!.toString() : "0",
      Commission: this.profile.SalesCode || "000000000",
      ContractTypeId: params.contractTypeId.toString(),
      BonusExcluded: hasCustomOtrp, // Must be true when using custom OTRP
      OffInvSupport: 0,
      DealerDiscount: -1,
      ModelId: params.modelId,
      VariantId: params.variantId,
      ManufacturerId: params.makeId,
      SpecialOfferDetail: { OfferId: 0, SpecialOfferTypeId: 0, TrimColourId: 0 },
      OptionalExtras: [],
      Deposit: "-1",
      EstimatedSaleValue: "-2",
      InitialPayment: "-1",
      FRFExcluded: false,
      RegulatedAgreementOnly: false,
      VATInclusive: false,
      IsZeroCommission: false,
    };
  }

  /**
   * Calculate quote - matches captured API format exactly
   */
  private async calculateQuote(
    quoteLine: ReturnType<typeof this.buildQuoteLine>,
    paymentPlanId: number,
    wltpCo2: number
  ) {
    const calcRequest = {
      RVCode: this.profile.RVCode || "00",
      PaymentPlanId: paymentPlanId.toString(),
      CustomerRef: "",
      IsRentalRollback: false,
      TargetRental: 0,
      RollbackField: "",
      ActiveLine: quoteLine,
      IsSpecialOfferVehicle: false,
      AnticipatedDeliveryDate: null,
      WLTPCo2: wltpCo2.toString(),
      SelectedLineNo: 0,
      IsWLTPCo2: true,
      PartnerId: "0",
      GenerateQuoteNumber: false,
    };

    return await this.callService<{
      Success: boolean;
      QuoteId: string;
      Message: string;
      LineNumbers: string[];
    }>("Quote", "CalculateQuote", { calcrequest: calcRequest });
  }

  /**
   * Get quote details after calculation - returns full quote with variants
   */
  private async getQuoteDetails() {
    return await this.callService<{
      QuoteId: number;
      Status: string;
      IsCalculated: boolean;
      Variants: Array<{
        MonthlyRental: number;
        MonthlyRentalIncVAT: number;
        InitialPayment: number;
        OTRP: number;
        TaxableListPrice: number;
        Term: number;
        Mileage: number;
        ContractTypeId: number;
        ContractTypeDescription: string;
        Description: string;
        Manufacturer: string;
        Model: string;
        CalcStatus: number;
        CalcStatusDescription: string;
      }>;
    }>("Quote", "GetQuote", {});
  }

  /**
   * Get specific quote line details - returns data for a specific vehicle in the quote
   */
  private async getQuoteLine(lineNo: number) {
    return await this.callService<{
      LineNo: string;
      Description: string;
      ManufacturerId: number;
      ModelId: number;
      VariantId: number;
      Term: number;
      Mileage: number;
      TotalMileage: number;
      MonthlyRental: number;
      MonthlyRentalIncVAT: number;
      InitialPayment: number;
      OTRP: number;
      BrokerOTRP: number;
      TaxableListPrice: number;
      ContractTypeId: number;
      ContractType: string;
      PaymentPlanId: number;
      BonusExcluded: boolean;
      CalcStatus: number;
      CalcStatusDescription: string;
      CalcErrorMessage: string;
    }>("Quote", "GetQuoteLine", { lineNo });
  }

  /**
   * Run a complete quote for a vehicle
   * Flow: GetVariant (for CO2) → CalculateQuote → GetQuote
   */
  async runQuote(params: LexQuoteParams): Promise<LexQuoteResult> {
    try {
      // Get contract type ID
      const contractTypeId =
        LEX_CONTRACT_TYPE_IDS[params.contractType || "contract_hire_without_maintenance"];

      // Get payment plan ID
      const paymentPlanId =
        LEX_PAYMENT_PLAN_IDS[params.paymentPlan || "spread_3_down"];

      // Step 1: Get variant details to get WLTP CO2 value
      const variantDetails = await this.getVariantDetails(
        params.makeId,
        params.modelId,
        params.variantId
      );

      const wltpCo2 = variantDetails.WLTPCO2 || variantDetails.CO2 || 0;

      // Step 2: Build quote line and calculate
      const quoteLine = this.buildQuoteLine({
        ...params,
        contractTypeId,
      });

      const calcResult = await this.calculateQuote(quoteLine, paymentPlanId, wltpCo2);

      if (!calcResult.Success) {
        return {
          success: false,
          error: calcResult.Message || "Quote calculation failed",
        };
      }

      // Step 3: Get the specific quote line using the line number from CalculateQuote
      // This is critical - CalculateQuote adds a line to the session and returns the line number
      // We must use GetQuoteLine with that specific line number to get the correct vehicle's price
      const lineNo = calcResult.LineNumbers?.[0] ? parseInt(calcResult.LineNumbers[0]) : 0;
      const quoteLine2 = await this.getQuoteLine(lineNo);

      console.log("GetQuoteLine FULL response:", JSON.stringify(quoteLine2, null, 2));
      console.log("Payment plan used:", params.paymentPlan, "-> ID:", paymentPlanId);

      if (quoteLine2.CalcStatus !== 0 || quoteLine2.CalcErrorMessage) {
        return {
          success: false,
          error: quoteLine2.CalcErrorMessage || "Quote calculation returned error status"
        };
      }

      // Check if this is a Personal Contract Hire (PCH) - consumers pay VAT
      const isPCH = params.contractType?.includes("personal_contract_hire") ||
                    quoteLine2.ContractType?.toLowerCase().includes("personal");

      // For PCH, use inc-VAT prices. Calculate if Lex returns 0.
      const VAT_RATE = 1.2;
      let monthlyRental = quoteLine2.MonthlyRental;
      let monthlyRentalIncVat = quoteLine2.MonthlyRentalIncVAT;

      if (isPCH) {
        // Use inc-VAT price for PCH customers
        if (monthlyRentalIncVat > 0) {
          monthlyRental = monthlyRentalIncVat;
        } else {
          // Calculate VAT if Lex didn't return it
          monthlyRental = quoteLine2.MonthlyRental * VAT_RATE;
          monthlyRentalIncVat = monthlyRental;
        }
        console.log(`PCH contract - using inc-VAT price: ${quoteLine2.MonthlyRental} * ${VAT_RATE} = ${monthlyRental}`);
      }

      // Calculate initial rental based on payment plan if Lex returns -1 or invalid value
      let initialRental = quoteLine2.InitialPayment;
      if (initialRental <= 0 && monthlyRental > 0) {
        const multiplier = LEX_PAYMENT_PLAN_MULTIPLIERS[params.paymentPlan || "spread_3_down"] || 1;
        initialRental = monthlyRental * multiplier;
        console.log(`Calculated initial rental: ${monthlyRental} x ${multiplier} = ${initialRental}`);
      } else if (isPCH && initialRental > 0) {
        // Apply VAT to initial rental for PCH
        initialRental = initialRental * VAT_RATE;
      }

      return {
        success: true,
        quoteId: calcResult.QuoteId,
        monthlyRental,
        monthlyRentalIncVat,
        initialRental,
        otrp: quoteLine2.OTRP,
        brokerOtrp: params.brokerOtrp || quoteLine2.BrokerOTRP,
        p11d: quoteLine2.TaxableListPrice,
        co2: wltpCo2,
        term: quoteLine2.Term,
        mileage: quoteLine2.Mileage,
        contractType: quoteLine2.ContractType,
        usedFleetDiscount: Boolean(params.brokerOtrp && params.brokerOtrp > 0),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Run quotes for multiple vehicles in batch
   */
  async runBatchQuotes(
    vehicles: LexQuoteParams[],
    onProgress?: (completed: number, total: number, result: LexQuoteResult) => void
  ): Promise<{ results: LexQuoteResult[]; successCount: number; errorCount: number }> {
    const results: LexQuoteResult[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < vehicles.length; i++) {
      const result = await this.runQuote(vehicles[i]);
      results.push(result);

      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }

      if (onProgress) {
        onProgress(i + 1, vehicles.length, result);
      }

      // Small delay between requests to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return { results, successCount, errorCount };
  }
}
