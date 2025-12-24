/**
 * Lex Playwright Automation Types
 */

// Payment plan options from Lex
export const PAYMENT_PLANS = {
  "1": "Annual in advance",
  "7": "Monthly in advance",
  "8": "Quarterly in advance",
  "9": "Three down terminal pause",
  "12": "Six down terminal pause",
  "17": "Nine down terminal pause",
  "23": "Spread Rentals with 3 down",
  "26": "Spread Rentals with 6 down",
  "27": "Spread Rentals with 12 down",
  "39": "No deposit benefit car plan",
  "43": "Spread Rentals with 9 down",
  "106": "Spread Rentals Initial Payment",
} as const;

// Contract types
export const CONTRACT_TYPES = {
  CH: { code: "2", name: "Contract Hire with Maintenance" },
  CHNM: { code: "5", name: "Contract Hire without Maintenance" },
} as const;

export type ContractType = keyof typeof CONTRACT_TYPES;
export type PaymentPlanId = keyof typeof PAYMENT_PLANS;

/**
 * Single quote request parameters
 */
export interface PlaywrightQuoteRequest {
  vehicleId: string;
  lexMakeCode: string;
  lexModelCode: string;
  lexVariantCode: string;
  manufacturer?: string;
  model?: string;
  variant?: string;
  co2?: number;
  term: number;
  annualMileage: number;
  contractType: ContractType;
  paymentPlan: PaymentPlanId;
  useDefaultOtr: boolean;
  customOtrp?: number; // In pence, only if useDefaultOtr=false
}

/**
 * Result from a single quote execution
 */
export interface PlaywrightQuoteResult {
  vehicleId: string;
  term: number;
  annualMileage: number;
  contractType: ContractType;
  paymentPlan: PaymentPlanId;
  success: boolean;
  quoteNumber?: string;
  monthlyRental?: number; // In pence
  initialRental?: number; // In pence
  otrpUsed?: number; // In pence
  usedCustomOtr: boolean;
  error?: string;
}

/**
 * Batch configuration for running multiple quotes
 */
export interface LexPlaywrightBatchConfig {
  vehicleIds: string[];
  terms: number[];
  mileages: number[];
  contractTypes: ContractType[];
  paymentPlans: PaymentPlanId[];
  useDefaultOtr: boolean;
  customOtrp?: number; // In pence, only if useDefaultOtr=false
}

/**
 * Progress callback data
 */
export interface LexPlaywrightProgress {
  status: "starting" | "logging_in" | "running" | "completed" | "error";
  currentVehicle: number;
  totalVehicles: number;
  currentCombination: number;
  totalCombinations: number;
  currentVehicleInfo?: string; // e.g., "BMW 320i"
  lastQuoteNumber?: string;
  error?: string;
}

/**
 * Batch execution result
 */
export interface LexPlaywrightBatchResult {
  batchId: string;
  totalQuotes: number;
  successCount: number;
  errorCount: number;
  quotes: PlaywrightQuoteResult[];
}

/**
 * Vehicle data from database for quote execution
 */
export interface VehicleForQuote {
  id: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  lexMakeCode: string;
  lexModelCode: string;
  lexVariantCode: string;
  co2: number | null;
  p11d: number | null;
}

/**
 * Progress callback function type
 */
export type ProgressCallback = (progress: LexPlaywrightProgress) => void;
