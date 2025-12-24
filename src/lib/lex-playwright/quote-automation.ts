/**
 * Lex Quote Automation
 *
 * Core automation logic for running quotes via Playwright.
 * Follows the recorded user flow for creating and completing quotes.
 */

import { Page } from "playwright";
import { getBrowserManager } from "./browser-manager.js";
import {
  PlaywrightQuoteRequest,
  PlaywrightQuoteResult,
  LexPlaywrightBatchConfig,
  LexPlaywrightBatchResult,
  LexPlaywrightProgress,
  VehicleForQuote,
  ProgressCallback,
  CONTRACT_TYPES,
} from "./types.js";
import { db } from "../db/index.js";
import { vehicles } from "../db/schema.js";
import { eq, inArray, and, isNotNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

/**
 * Run a single quote on an already-navigated page
 */
async function runSingleQuote(
  page: Page,
  request: PlaywrightQuoteRequest
): Promise<PlaywrightQuoteResult> {
  const startTime = Date.now();

  try {
    console.log(
      `[Quote] Starting quote for ${request.manufacturer} ${request.model} - ${request.term}m / ${request.annualMileage}mi`
    );

    // Select manufacturer
    await page.locator("#selManufacturers").selectOption(request.lexMakeCode);
    await page.waitForTimeout(500); // Wait for model dropdown to populate

    // Select model
    await page.locator("#selModels").selectOption(request.lexModelCode);
    await page.waitForTimeout(500); // Wait for variant dropdown to populate

    // Select variant
    await page.locator("#selVariants").selectOption(request.lexVariantCode);
    await page.waitForTimeout(300);

    // Select contract type (2=CH, 5=CHNM)
    const contractCode = CONTRACT_TYPES[request.contractType].code;
    await page.locator("#selContracts").selectOption(contractCode);
    await page.waitForTimeout(300);

    // Select payment plan
    await page.locator("#selPaymentPlan").selectOption(request.paymentPlan);

    // Enter term
    await page.locator("#txtTerm").fill(request.term.toString());
    await page.locator("#txtTerm").press("Tab");

    // Enter annual mileage (MPA = Miles Per Annum / 1000)
    // Lex uses MPA which is annual mileage in thousands
    const mpaValue = Math.round(request.annualMileage / 1000);
    await page.locator("#txtMPA").fill(mpaValue.toString());
    await page.locator("#txtMPA").press("Tab");

    // Calculate total mileage and wait for it to populate
    await page.waitForTimeout(200);

    // Enter CO2 if provided
    if (request.co2 !== undefined && request.co2 !== null) {
      await page.getByRole("textbox", { name: "Co2 Emission" }).fill(request.co2.toString());
      await page.getByRole("textbox", { name: "Co2 Emission" }).press("Tab");
    }

    // Handle OTRP
    if (!request.useDefaultOtr && request.customOtrp) {
      // Check "Bonus excluded" and enter custom OTR
      await page.getByRole("checkbox", { name: "Bonus excluded" }).check();
      // Convert from pence to pounds for the form
      const otrpPounds = (request.customOtrp / 100).toFixed(2);
      await page.locator("#txtEnteredOTRP").fill(otrpPounds);
      await page.locator("#txtEnteredOTRP").press("Tab");
    }

    // Click Calculate
    console.log("[Quote] Clicking Calculate...");
    await page.getByRole("link", { name: "Calculate" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Check Commission Disclosure
    const commissionCheckbox = page.getByRole("checkbox", { name: "Commission Disclosure Check" });
    try {
      await commissionCheckbox.waitFor({ timeout: 5000 });
      await commissionCheckbox.check();
    } catch {
      console.log("[Quote] Commission checkbox not found, continuing...");
    }

    // Click Complete
    console.log("[Quote] Clicking Complete...");
    await page.getByRole("link", { name: "Complete" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    // Extract quote number from the page
    // The quote number appears in a table cell after completion
    const quoteNumber = await extractQuoteNumber(page);

    // Extract rental amounts
    const { monthlyRental, initialRental, otrpUsed } = await extractRentalAmounts(page);

    const duration = Date.now() - startTime;
    console.log(`[Quote] Completed in ${duration}ms - Quote: ${quoteNumber}`);

    return {
      vehicleId: request.vehicleId,
      term: request.term,
      annualMileage: request.annualMileage,
      contractType: request.contractType,
      paymentPlan: request.paymentPlan,
      success: true,
      quoteNumber,
      monthlyRental,
      initialRental,
      otrpUsed,
      usedCustomOtr: !request.useDefaultOtr,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Quote] Error: ${errorMessage}`);

    return {
      vehicleId: request.vehicleId,
      term: request.term,
      annualMileage: request.annualMileage,
      contractType: request.contractType,
      paymentPlan: request.paymentPlan,
      success: false,
      error: errorMessage,
      usedCustomOtr: !request.useDefaultOtr,
    };
  }
}

/**
 * Extract the quote number from the completed quote page
 */
async function extractQuoteNumber(page: Page): Promise<string | undefined> {
  try {
    // Look for a cell containing a quote number pattern (numeric, usually 9 digits)
    // The quote number is typically displayed prominently after completion
    const cells = await page.locator("td").allTextContents();

    for (const cell of cells) {
      const trimmed = cell.trim();
      // Quote numbers are typically 9 digits
      if (/^\d{9}$/.test(trimmed)) {
        return trimmed;
      }
    }

    // Alternative: look for specific elements that might contain the quote number
    const quoteElement = await page.locator('[id*="Quote"]').first();
    const text = await quoteElement.textContent();
    if (text) {
      const match = text.match(/\d{9}/);
      if (match) return match[0];
    }

    console.log("[Quote] Could not find quote number on page");
    return undefined;
  } catch (error) {
    console.log("[Quote] Error extracting quote number:", error);
    return undefined;
  }
}

/**
 * Extract rental amounts from the completed quote page
 */
async function extractRentalAmounts(
  page: Page
): Promise<{ monthlyRental?: number; initialRental?: number; otrpUsed?: number }> {
  try {
    // These values are typically displayed in a summary table
    // The exact selectors may need adjustment based on the actual page structure

    let monthlyRental: number | undefined;
    let initialRental: number | undefined;
    let otrpUsed: number | undefined;

    // Look for rental values in the page
    const pageContent = await page.content();

    // Try to find monthly rental (look for patterns like "£XXX.XX" near "Monthly" or "Rental")
    const monthlyMatch = pageContent.match(/Monthly[^£]*£([\d,]+\.?\d*)/i);
    if (monthlyMatch) {
      const value = parseFloat(monthlyMatch[1].replace(/,/g, ""));
      monthlyRental = Math.round(value * 100); // Convert to pence
    }

    // Try to find initial rental
    const initialMatch = pageContent.match(/Initial[^£]*£([\d,]+\.?\d*)/i);
    if (initialMatch) {
      const value = parseFloat(initialMatch[1].replace(/,/g, ""));
      initialRental = Math.round(value * 100);
    }

    // Try to find OTR/OTRP
    const otrMatch = pageContent.match(/OTR[P]?[^£]*£([\d,]+\.?\d*)/i);
    if (otrMatch) {
      const value = parseFloat(otrMatch[1].replace(/,/g, ""));
      otrpUsed = Math.round(value * 100);
    }

    return { monthlyRental, initialRental, otrpUsed };
  } catch (error) {
    console.log("[Quote] Error extracting rental amounts:", error);
    return {};
  }
}

/**
 * Get vehicles from database by IDs
 */
async function getVehiclesForQuotes(vehicleIds: string[]): Promise<VehicleForQuote[]> {
  const results = await db
    .select({
      id: vehicles.id,
      manufacturer: vehicles.manufacturer,
      model: vehicles.model,
      variant: vehicles.variant,
      lexMakeCode: vehicles.lexMakeCode,
      lexModelCode: vehicles.lexModelCode,
      lexVariantCode: vehicles.lexVariantCode,
      co2: vehicles.co2,
      p11d: vehicles.p11d,
    })
    .from(vehicles)
    .where(
      and(
        inArray(vehicles.id, vehicleIds),
        isNotNull(vehicles.lexMakeCode),
        isNotNull(vehicles.lexModelCode),
        isNotNull(vehicles.lexVariantCode)
      )
    );

  return results.map((v) => ({
    id: v.id,
    manufacturer: v.manufacturer,
    model: v.model,
    variant: v.variant,
    lexMakeCode: v.lexMakeCode!,
    lexModelCode: v.lexModelCode!,
    lexVariantCode: v.lexVariantCode!,
    co2: v.co2,
    p11d: v.p11d,
  }));
}

/**
 * Run batch quotes with progress callback
 */
export async function runBatchQuotes(
  config: LexPlaywrightBatchConfig,
  onProgress?: ProgressCallback
): Promise<LexPlaywrightBatchResult> {
  const batchId = uuidv4();
  const quotes: PlaywrightQuoteResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  const manager = getBrowserManager();

  try {
    // Report starting
    onProgress?.({
      status: "starting",
      currentVehicle: 0,
      totalVehicles: config.vehicleIds.length,
      currentCombination: 0,
      totalCombinations: 0,
    });

    // Get vehicles from database
    const vehiclesData = await getVehiclesForQuotes(config.vehicleIds);

    if (vehiclesData.length === 0) {
      throw new Error("No valid vehicles found with Lex codes");
    }

    // Calculate total combinations
    const combinationsPerVehicle =
      config.terms.length *
      config.mileages.length *
      config.contractTypes.length *
      config.paymentPlans.length;
    const totalCombinations = vehiclesData.length * combinationsPerVehicle;

    // Login
    onProgress?.({
      status: "logging_in",
      currentVehicle: 0,
      totalVehicles: vehiclesData.length,
      currentCombination: 0,
      totalCombinations,
    });

    const page = await manager.getPage();

    let currentCombination = 0;

    // Process each vehicle
    for (let vehicleIndex = 0; vehicleIndex < vehiclesData.length; vehicleIndex++) {
      const vehicle = vehiclesData[vehicleIndex];
      const vehicleInfo = `${vehicle.manufacturer} ${vehicle.model}`;

      // Navigate to new quote page for first quote or after errors
      await manager.navigateToNewQuote();

      // Process each combination for this vehicle
      for (const term of config.terms) {
        for (const mileage of config.mileages) {
          for (const contractType of config.contractTypes) {
            for (const paymentPlan of config.paymentPlans) {
              currentCombination++;

              // Report progress
              onProgress?.({
                status: "running",
                currentVehicle: vehicleIndex + 1,
                totalVehicles: vehiclesData.length,
                currentCombination,
                totalCombinations,
                currentVehicleInfo: vehicleInfo,
              });

              // Build request
              const request: PlaywrightQuoteRequest = {
                vehicleId: vehicle.id,
                lexMakeCode: vehicle.lexMakeCode,
                lexModelCode: vehicle.lexModelCode,
                lexVariantCode: vehicle.lexVariantCode,
                manufacturer: vehicle.manufacturer,
                model: vehicle.model,
                variant: vehicle.variant ?? undefined,
                co2: vehicle.co2 ?? undefined,
                term,
                annualMileage: mileage,
                contractType,
                paymentPlan,
                useDefaultOtr: config.useDefaultOtr,
                customOtrp: config.customOtrp,
              };

              // Run quote
              const result = await runSingleQuote(page, request);
              quotes.push(result);

              if (result.success) {
                successCount++;
                onProgress?.({
                  status: "running",
                  currentVehicle: vehicleIndex + 1,
                  totalVehicles: vehiclesData.length,
                  currentCombination,
                  totalCombinations,
                  currentVehicleInfo: vehicleInfo,
                  lastQuoteNumber: result.quoteNumber,
                });
              } else {
                errorCount++;
              }

              // Use "Copy Quote" for subsequent quotes of same vehicle
              // This is more efficient than starting fresh each time
              if (currentCombination < totalCombinations) {
                try {
                  // Try to use Copy Quote for next iteration
                  const copyButton = page.getByRole("link", { name: "Copy Quote" });
                  if (await copyButton.isVisible({ timeout: 2000 })) {
                    // Handle dialog that appears when copying
                    page.once("dialog", (dialog) => {
                      dialog.dismiss().catch(() => {});
                    });
                    await copyButton.click();
                    await page.waitForLoadState("networkidle");
                  } else {
                    // Navigate back to new quote if Copy not available
                    await manager.navigateToNewQuote();
                  }
                } catch {
                  // If copy fails, navigate to new quote
                  await manager.navigateToNewQuote();
                }
              }

              // Small delay between quotes to avoid overwhelming the system
              await page.waitForTimeout(500);
            }
          }
        }
      }
    }

    // Report completion
    onProgress?.({
      status: "completed",
      currentVehicle: vehiclesData.length,
      totalVehicles: vehiclesData.length,
      currentCombination: totalCombinations,
      totalCombinations,
    });

    return {
      batchId,
      totalQuotes: quotes.length,
      successCount,
      errorCount,
      quotes,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    onProgress?.({
      status: "error",
      currentVehicle: 0,
      totalVehicles: config.vehicleIds.length,
      currentCombination: 0,
      totalCombinations: 0,
      error: errorMessage,
    });

    throw error;
  } finally {
    // Clean up browser after batch completes
    await manager.cleanup();
  }
}

/**
 * Test login credentials
 */
export async function testLogin(): Promise<{ success: boolean; error?: string }> {
  const manager = getBrowserManager();

  try {
    const success = await manager.login();
    return { success };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: errorMessage };
  } finally {
    await manager.cleanup();
  }
}
