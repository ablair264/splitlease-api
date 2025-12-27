import { pgTable, text, timestamp, uuid, integer, jsonb, boolean, numeric, index } from "drizzle-orm/pg-core";

// Auth.js tables
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  password: text("password"),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionToken: text("session_token").notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull().unique(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

// Broker-specific tables
export const brokers = pgTable("brokers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  domain: text("domain"),
  webhookSecret: text("webhook_secret"),
  settings: jsonb("settings").$type<BrokerSettings>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: uuid("broker_id").notNull().references(() => brokers.id, { onDelete: "cascade" }),
  
  // Contact info
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  
  // Raw submission
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
  source: text("source"), // website, carwow, leasing.com, etc.
  
  // AI-extracted data
  intent: text("intent"), // browsing, ready_to_order, just_asking
  customerType: text("customer_type"), // personal, business
  vehiclePreferences: jsonb("vehicle_preferences").$type<VehiclePreferences>(),
  budget: jsonb("budget").$type<BudgetInfo>(),
  timeline: text("timeline"),
  
  // Scoring
  score: integer("score"), // 1-100
  scoreReasons: jsonb("score_reasons").$type<string[]>(),
  
  // AI draft response
  draftResponse: text("draft_response"),
  draftGeneratedAt: timestamp("draft_generated_at"),

  // Matched deals (grouped format with alternatives)
  matchedDeals: jsonb("matched_deals").$type<GroupedMatchedDeals>(),
  
  // Status
  status: text("status").notNull().default("new"), // new, contacted, quoted, won, lost
  assignedTo: uuid("assigned_to").references(() => users.id),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  contactedAt: timestamp("contacted_at"),
});

export const leadMessages = pgTable("lead_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(), // inbound, outbound
  channel: text("channel").notNull(), // email, sms, phone
  content: text("content").notNull(),
  sentBy: uuid("sent_by").references(() => users.id),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  aiGenerated: boolean("ai_generated").default(false),
});

// Vehicle catalog
export const vehicles = pgTable("vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  capCode: text("cap_code"),
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  modelYear: text("model_year"),
  p11d: integer("p11d"),
  otr: integer("otr"),
  engineSize: integer("engine_size"),
  transmission: text("transmission"),
  doors: integer("doors"),
  fuelType: text("fuel_type"),
  co2: integer("co2"),
  mpg: text("mpg"),
  bodyStyle: text("body_style"),
  insuranceGroup: integer("insurance_group"),
  euroClass: text("euro_class"),
  imageFolder: text("image_folder"),
  imageUrl: text("image_url"), // Imagin Studio CDN URL
  // Lex Autolease codes
  lexMakeCode: text("lex_make_code"),
  lexModelCode: text("lex_model_code"),
  lexVariantCode: text("lex_variant_code"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Pricing from funders
export const vehiclePricing = pgTable("vehicle_pricing", {
  id: uuid("id").primaryKey().defaultRandom(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),
  providerName: text("provider_name").notNull(),
  term: integer("term").notNull(),
  annualMileage: integer("annual_mileage").notNull(),
  monthlyRental: integer("monthly_rental").notNull(), // in pence
  excessMileage: text("excess_mileage"),
  uploadBatchId: text("upload_batch_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Fleet Marque discount terms
export const fleetMarqueTerms = pgTable("fleet_marque_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  capCode: text("cap_code").notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
  make: text("make").notNull(),
  model: text("model").notNull(),
  derivative: text("derivative"),
  capPrice: integer("cap_price"), // in pence
  co2: integer("co2"),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }),
  discountedPrice: integer("discounted_price"), // in pence
  savings: integer("savings"), // in pence
  buildUrl: text("build_url"),
  scrapeBatchId: text("scrape_batch_id"),
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Types
export type BrokerSettings = {
  autoRespond?: boolean;
  autoRespondDelay?: number; // minutes
  emailSignature?: string;
  defaultAssignee?: string;
};

export type VehiclePreferences = {
  makes?: string[];
  models?: string[];
  bodyTypes?: string[];
  fuelTypes?: string[];
  transmission?: string;
  features?: string[];
};

export type BudgetInfo = {
  maxMonthly?: number;
  maxInitial?: number;
  preferredTerm?: number;
  preferredMileage?: number;
};

export type MatchedDealSummary = {
  vehicleId: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  monthlyRental: number;
  term: number;
  annualMileage: number;
  score: number;
  matchReason: string[];
};

// Grouped vehicle type for quote page
export type VehicleGroupSummary = {
  groupKey: string;
  manufacturer: string;
  model: string;
  fuelType: string | null;
  transmission: string | null;
  bodyStyle: string | null;
  avgP11d: number | null;
  avgCo2: number | null;
  bestScore: number;
  deals: MatchedDealSummary[];
  isAlternative: boolean;
};

export type GroupedMatchedDeals = {
  primaryMatches: VehicleGroupSummary[];
  alternatives: VehicleGroupSummary[];
};

// Lex Autolease quotes
export const lexQuotes = pgTable("lex_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
  capCode: text("cap_code"),
  makeCode: text("make_code").notNull(),
  modelCode: text("model_code").notNull(),
  variantCode: text("variant_code").notNull(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  term: integer("term").notNull(),
  annualMileage: integer("annual_mileage").notNull(),
  paymentPlan: text("payment_plan").notNull().default("monthly_in_advance"), // monthly_in_advance, spread_6_down
  initialRental: integer("initial_rental"), // in pence
  monthlyRental: integer("monthly_rental"), // in pence
  otrp: integer("otrp"), // On The Road Price in pence (original Lex OTR)
  brokerOtrp: integer("broker_otrp"), // Broker OTR Price in pence (fleet discounted)
  usedFleetDiscount: boolean("used_fleet_discount").default(false),
  fleetSavingsPercent: numeric("fleet_savings_percent", { precision: 5, scale: 2 }),
  excessMileageCharge: numeric("excess_mileage_charge", { precision: 10, scale: 2 }),
  maintenanceIncluded: boolean("maintenance_included").default(false),
  contractType: text("contract_type"), // CH, CHNM, PCH, PCHNM
  quoteReference: text("quote_reference"),
  rawResponse: jsonb("raw_response").$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"), // pending, success, error
  errorMessage: text("error_message"),
  requestBatchId: text("request_batch_id"),
  quotedAt: timestamp("quoted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Lex quote request batches
export const lexQuoteRequests = pgTable("lex_quote_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: text("batch_id").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed
  totalVehicles: integer("total_vehicles").notNull(),
  processedCount: integer("processed_count").default(0),
  successCount: integer("success_count").default(0),
  errorCount: integer("error_count").default(0),
  term: integer("term").notNull(),
  annualMileage: integer("annual_mileage").notNull(),
  initialRentalMonths: integer("initial_rental_months").default(1),
  maintenanceIncluded: boolean("maintenance_included").default(false),
  errorLog: jsonb("error_log").$type<string[]>(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Fleet Marque types
export type FleetMarqueTerm = {
  id: string;
  capCode: string;
  vehicleId: string | null;
  make: string;
  model: string;
  derivative: string | null;
  capPrice: number | null;
  co2: number | null;
  discountPercent: string | null;
  discountedPrice: number | null;
  savings: number | null;
  buildUrl: string | null;
  scrapeBatchId: string | null;
  scrapedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type FleetMarqueScrapeResult = {
  capid: string;
  make: string;
  model: string;
  derivative: string;
  capPrice: number;
  co2: number;
  discountPercent: number;
  discountedPrice: number;
  savings: number;
  buildUrl: string | null;
};

// Lex Autolease types
export type LexQuote = {
  id: string;
  vehicleId: string | null;
  capCode: string | null;
  makeCode: string;
  modelCode: string;
  variantCode: string;
  make: string;
  model: string;
  variant: string | null;
  term: number;
  annualMileage: number;
  initialRental: number | null;
  monthlyRental: number | null;
  excessMileageCharge: string | null;
  maintenanceIncluded: boolean;
  quoteReference: string | null;
  rawResponse: Record<string, unknown> | null;
  status: "pending" | "success" | "error";
  errorMessage: string | null;
  requestBatchId: string | null;
  quotedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LexQuoteRequest = {
  id: string;
  batchId: string;
  status: "pending" | "running" | "completed" | "failed";
  totalVehicles: number;
  processedCount: number;
  successCount: number;
  errorCount: number;
  term: number;
  annualMileage: number;
  initialRentalMonths: number;
  maintenanceIncluded: boolean;
  errorLog: string[] | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type LexVehicleSelection = {
  makeCode: string;
  modelCode: string;
  variantCode: string;
  make: string;
  model: string;
  variant: string;
  capCode?: string;
  vehicleId?: string;
};

// Provider column mappings for flexible uploads
export const providerMappings = pgTable("provider_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerName: text("provider_name").notNull().unique(),
  columnMappings: jsonb("column_mappings").$type<ColumnMappings>().notNull(),
  fileFormat: text("file_format").default("csv"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Ratebook upload batches
export const ratebookUploads = pgTable("ratebook_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerName: text("provider_name").notNull(),
  fileName: text("file_name").notNull(),
  totalRows: integer("total_rows").notNull(),
  processedRows: integer("processed_rows").default(0),
  successRows: integer("success_rows").default(0),
  errorRows: integer("error_rows").default(0),
  status: text("status").default("pending"), // pending, processing, completed, failed
  errorLog: jsonb("error_log").$type<string[]>(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Column mapping types
export type ColumnMappings = {
  cap_code?: number;
  manufacturer?: number;
  model?: number;
  variant?: number;
  monthly_rental?: number;
  p11d?: number;
  otr_price?: number;
  basic_list_price?: number;
  term?: number;
  mileage?: number;
  mpg?: number;
  co2?: number;
  fuel_type?: number;
  electric_range?: number;
  insurance_group?: number;
  body_style?: number;
  transmission?: number;
  euro_rating?: number;
  upfront?: number;
};

export type ProviderMapping = {
  id: string;
  providerName: string;
  columnMappings: ColumnMappings;
  fileFormat: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type RatebookUpload = {
  id: string;
  providerName: string;
  fileName: string;
  totalRows: number;
  processedRows: number | null;
  successRows: number | null;
  errorRows: number | null;
  status: string | null;
  errorLog: string[] | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
};

// Ogilvie Fleet ratebook exports
export const ogilvieExports = pgTable("ogilvie_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: text("batch_id").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed
  contractTerm: integer("contract_term").notNull(), // 24, 36, 48
  contractMileage: integer("contract_mileage").notNull(), // 20000, 30000, 40000
  productId: text("product_id").notNull().default("1"), // Contract Hire type
  paymentPlanId: text("payment_plan_id").notNull().default("263"), // 1 in Advance
  totalVehicles: integer("total_vehicles").default(0),
  exportedRows: integer("exported_rows").default(0),
  errorMessage: text("error_message"),
  csvData: text("csv_data"), // Store the raw CSV for download
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ogilvieRatebook = pgTable("ogilvie_ratebook", {
  id: uuid("id").primaryKey().defaultRandom(),
  exportBatchId: text("export_batch_id").notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),

  // Vehicle details from Ogilvie CSV
  derivativeName: text("derivative_name"),
  manufacturerName: text("manufacturer_name"),
  rangeName: text("range_name"),
  modelName: text("model_name"),
  yearIntroduced: text("year_introduced"),
  bodyStyles: text("body_styles"),
  is4wd: text("is_4wd"),
  transmission: text("transmission"),
  cc: integer("cc"),
  fuelType: text("fuel_type"),
  ecCombinedMpg: numeric("ec_combined_mpg"),
  maxEvRange: numeric("max_ev_range"),
  batteryCapacityKwh: numeric("battery_capacity_kwh"),
  enginePowerKw: integer("engine_power_kw"),
  listPrice: numeric("list_price"),
  p11dValue: numeric("p11d_value"),
  co2Gkm: integer("co2_gkm"),
  carbonFootprint: numeric("carbon_footprint"),
  insuranceGroup: text("insurance_group"),
  ncap: integer("ncap"),
  ncapPedestrian: integer("ncap_pedestrian"),
  product: text("product"),
  paymentPlan: text("payment_plan"),
  contractTerm: integer("contract_term"),
  contractMileage: integer("contract_mileage"),
  bik20Percent: numeric("bik_20_percent"),
  bik40Percent: numeric("bik_40_percent"),
  financeRentalExcVat: numeric("finance_rental_exc_vat"),
  nonFinanceRental: numeric("non_finance_rental"),
  regularRental: numeric("regular_rental"),
  monthlyEffectiveRental: numeric("monthly_effective_rental"),
  periodWholeLifeCosts: numeric("period_whole_life_costs"),
  ogilvieTrueCost: numeric("ogilvie_true_cost"),
  driverRebate: numeric("driver_rebate"),
  minDriverContribution: numeric("min_driver_contribution"),
  maxLoadingWeight: integer("max_loading_weight"),
  maxTowingWeightBraked: integer("max_towing_weight_braked"),
  maxTowingWeightUnbraked: integer("max_towing_weight_unbraked"),
  luggageCapacitySeatsUp: integer("luggage_capacity_seats_up"),
  luggageCapacitySeatsDown: integer("luggage_capacity_seats_down"),
  minimumKerbweight: integer("minimum_kerbweight"),

  createdAt: timestamp("created_at").defaultNow(),
});

// Ogilvie session storage (for caching login sessions)
export const ogilvieSessions = pgTable("ogilvie_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionCookie: text("session_cookie").notNull(),
  verificationToken: text("verification_token"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Lex Autolease session storage (for server-side API calls)
export const lexSessions = pgTable("lex_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),

  // Session authentication
  sessionCookies: text("session_cookies").notNull(), // JSON string of all cookies
  csrfToken: text("csrf_token").notNull(),

  // Profile data from window.profile
  profileData: jsonb("profile_data").$type<LexProfile>().notNull(),

  // Session validity
  isValid: boolean("is_valid").default(true),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type LexProfile = {
  SalesCode: string;
  Discount: string;
  RVCode: string;
  Role: string;
  Username?: string;
};

export type LexSession = {
  id: string;
  userId: string | null;
  sessionCookies: string;
  csrfToken: string;
  profileData: LexProfile;
  isValid: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
};

// Ogilvie types
export type OgilvieExport = {
  id: string;
  batchId: string;
  status: "pending" | "running" | "completed" | "failed";
  contractTerm: number;
  contractMileage: number;
  productId: string;
  paymentPlanId: string;
  totalVehicles: number | null;
  exportedRows: number | null;
  errorMessage: string | null;
  csvData: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type OgilvieRatebookEntry = {
  id: string;
  exportBatchId: string;
  vehicleId: string | null;
  derivativeName: string | null;
  manufacturerName: string | null;
  rangeName: string | null;
  modelName: string | null;
  yearIntroduced: string | null;
  bodyStyles: string | null;
  is4wd: string | null;
  transmission: string | null;
  cc: number | null;
  fuelType: string | null;
  ecCombinedMpg: string | null;
  maxEvRange: string | null;
  batteryCapacityKwh: string | null;
  enginePowerKw: number | null;
  listPrice: string | null;
  p11dValue: string | null;
  co2Gkm: number | null;
  carbonFootprint: string | null;
  insuranceGroup: string | null;
  ncap: number | null;
  ncapPedestrian: number | null;
  product: string | null;
  paymentPlan: string | null;
  contractTerm: number | null;
  contractMileage: number | null;
  bik20Percent: string | null;
  bik40Percent: string | null;
  financeRentalExcVat: string | null;
  nonFinanceRental: string | null;
  regularRental: string | null;
  monthlyEffectiveRental: string | null;
  periodWholeLifeCosts: string | null;
  ogilvieTrueCost: string | null;
  driverRebate: string | null;
  minDriverContribution: string | null;
  maxLoadingWeight: number | null;
  maxTowingWeightBraked: number | null;
  maxTowingWeightUnbraked: number | null;
  luggageCapacitySeatsUp: number | null;
  luggageCapacitySeatsDown: number | null;
  minimumKerbweight: number | null;
  createdAt: Date | null;
};

export type OgilvieExportConfig = {
  contractTerm: number;
  contractMileage: number;
  productId?: string;
  paymentPlanId?: string;
  qualifyingFlag?: string;
  rflFundingFlag?: string;
  manufacturerIds?: number[]; // Filter to specific manufacturers
};

// ============================================
// UNIFIED FINANCE PROVIDER RATES ARCHITECTURE
// ============================================

// Finance providers reference table
export const financeProviders = pgTable("finance_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(), // lex, ogilvie, drivalia
  name: text("name").notNull(),
  isActive: boolean("is_active").default(true),
  supportedContractTypes: text("supported_contract_types").array(), // ['CH', 'CHNM', 'PCH', 'PCHNM', 'BSSNL']
  credentials: jsonb("credentials").$type<ProviderCredentials>(), // Encrypted API keys, etc.
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Ratebook import tracking with versioning
export const ratebookImports = pgTable("ratebook_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id").references(() => financeProviders.id, { onDelete: "cascade" }),
  providerCode: text("provider_code").notNull(), // lex, ogilvie, drivalia
  contractType: text("contract_type").notNull(), // CH, CHNM, PCH, PCHNM, BSSNL
  batchId: text("batch_id").notNull().unique(),

  // File info
  fileName: text("file_name"),
  fileHash: text("file_hash"), // SHA-256 to detect duplicates
  ratebookDate: timestamp("ratebook_date"), // Date the ratebook was generated

  // Processing status
  status: text("status").notNull().default("pending"), // pending, validating, processing, completed, failed, superseded
  totalRows: integer("total_rows").default(0),
  successRows: integer("success_rows").default(0),
  errorRows: integer("error_rows").default(0),
  uniqueCapCodes: integer("unique_cap_codes").default(0),
  errorLog: jsonb("error_log").$type<string[]>(),

  // Version tracking
  supersededImportId: uuid("superseded_import_id"), // Previous import this one replaces
  isLatest: boolean("is_latest").default(true), // Quick flag for "current rates" queries

  // Timestamps
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Unified provider rates table (THE MAIN TABLE)
export const providerRates = pgTable("provider_rates", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Identifiers
  capCode: text("cap_code"), // Nullable for providers without CAP codes (e.g., Ogilvie)
  vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }), // Link to vehicles table
  importId: uuid("import_id").notNull().references(() => ratebookImports.id, { onDelete: "cascade" }),
  providerCode: text("provider_code").notNull(), // lex, ogilvie, drivalia (denormalized for speed)
  contractType: text("contract_type").notNull(), // CH, CHNM, PCH, PCHNM, BSSNL

  // Vehicle info (denormalized for query speed)
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  isCommercial: boolean("is_commercial").default(false),

  // Contract terms
  term: integer("term").notNull(), // 24, 36, 48, 60
  annualMileage: integer("annual_mileage").notNull(), // 5000, 8000, 10000, 15000, 20000, 30000
  paymentPlan: text("payment_plan").notNull(), // monthly_in_advance, spread_6_down

  // Pricing (all in PENCE for precision)
  totalRental: integer("total_rental").notNull(), // Main monthly rental (Rental column)
  leaseRental: integer("lease_rental"), // Finance portion
  serviceRental: integer("service_rental"), // Maintenance portion
  nonRecoverableVat: integer("non_recoverable_vat"),

  // Vehicle specs
  co2Gkm: integer("co2_gkm"),
  p11d: integer("p11d"), // in pence
  otrPrice: integer("otr_price"), // On The Road price in pence
  fuelType: text("fuel_type"),
  transmission: text("transmission"),
  bodyStyle: text("body_style"),
  modelYear: text("model_year"),

  // Excess mileage charges (pence per mile)
  excessMileagePpm: integer("excess_mileage_ppm"),
  financeEmcPpm: integer("finance_emc_ppm"),
  serviceEmcPpm: integer("service_emc_ppm"),

  // EV/Hybrid range data
  wltpEvRange: integer("wltp_ev_range"), // Pure EV range miles
  wltpEvRangeMin: integer("wltp_ev_range_min"),
  wltpEvRangeMax: integer("wltp_ev_range_max"),
  wltpEaerMiles: integer("wltp_eaer_miles"), // Electric Assist Extended Range
  fuelEcoCombined: numeric("fuel_eco_combined", { precision: 6, scale: 2 }), // MPG

  // Salary Sacrifice / BIK fields
  bikTaxLowerRate: integer("bik_tax_lower_rate"), // Monthly BIK cost at 20% tax
  bikTaxHigherRate: integer("bik_tax_higher_rate"), // Monthly BIK cost at 40% tax
  bikPercent: numeric("bik_percent", { precision: 5, scale: 2 }), // BIK percentage

  // Cost analysis
  wholeLifeCost: integer("whole_life_cost"),
  estimatedSaleValue: integer("estimated_sale_value"),
  fuelCostPpm: integer("fuel_cost_ppm"),
  insuranceGroup: text("insurance_group"),

  // Euro rating
  euroRating: text("euro_rating"),
  rdeCertificationLevel: text("rde_certification_level"),

  // Raw data backup
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),

  // Deal value score (0-100, calculated from cost ratio)
  score: integer("score"),
  basicListPrice: integer("basic_list_price"),
  scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Score breakdown type
export type ScoreBreakdown = {
  valueScore: number;
  efficiencyBonus: number;
  affordabilityMod: number;
  brandBonus: number;
  costRatio: number;
  totalPayments: number;
};

// Salary Sacrifice rates - separate table for BSSNL contract type
// Includes BIK-specific fields and employer/employee cost breakdowns
export const salarySacrificeRates = pgTable(
  "salary_sacrifice_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    capCode: text("cap_code"),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    importId: uuid("import_id").notNull().references(() => ratebookImports.id, { onDelete: "cascade" }),
    providerCode: text("provider_code").notNull(),

    // Vehicle info (denormalized for query performance)
    manufacturer: text("manufacturer").notNull(),
    model: text("model").notNull(),
    variant: text("variant"),
    fuelType: text("fuel_type"),
    transmission: text("transmission"),
    bodyStyle: text("body_style"),
    modelYear: text("model_year"),

    // Contract terms
    term: integer("term").notNull(), // 24, 36, 48, 60
    annualMileage: integer("annual_mileage").notNull(),
    paymentPlan: text("payment_plan").notNull(), // "6+23", "3+23", etc.

    // Pricing (all in pence)
    grossSalaryDeduction: integer("gross_salary_deduction").notNull(), // Monthly deduction
    employerNiSaving: integer("employer_ni_saving"), // Monthly NI saving
    netCostToEmployer: integer("net_cost_to_employer"), // After NI offset
    employeeSaving: integer("employee_saving"), // vs retail/PCP

    // BIK fields (critical for SS)
    p11d: integer("p11d"),
    co2Gkm: integer("co2_gkm"),
    bikPercent: numeric("bik_percent", { precision: 5, scale: 2 }),
    bikTaxLowerRate: integer("bik_tax_lower_rate"), // 20% taxpayer monthly
    bikTaxHigherRate: integer("bik_tax_higher_rate"), // 40% taxpayer monthly

    // EV-specific (0% BIK benefits)
    wltpEvRange: integer("wltp_ev_range"),
    isZeroEmission: boolean("is_zero_emission").default(false),

    // Maintenance
    includesMaintenance: boolean("includes_maintenance").default(true),
    maintenanceCost: integer("maintenance_cost"), // Monthly if separate

    // Insurance (often included in SS)
    includesInsurance: boolean("includes_insurance").default(false),
    insuranceCost: integer("insurance_cost"),

    // Scoring
    valueScore: integer("value_score"), // 0-100 score for this term

    // Metadata
    rawData: jsonb("raw_data"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    capCodeIdx: index("idx_ss_rates_cap_code").on(table.capCode),
    vehicleIdx: index("idx_ss_rates_vehicle_id").on(table.vehicleId),
    termIdx: index("idx_ss_rates_term").on(table.term),
    providerIdx: index("idx_ss_rates_provider").on(table.providerCode),
    bikIdx: index("idx_ss_rates_bik").on(table.bikPercent, table.bikTaxLowerRate),
    scoreIdx: index("idx_ss_rates_score").on(table.valueScore),
    lookupIdx: index("idx_ss_rates_lookup").on(
      table.capCode,
      table.term,
      table.annualMileage,
      table.providerCode
    ),
  })
);

// TypeScript types
export type SalarySacrificeRate = typeof salarySacrificeRates.$inferSelect;
export type NewSalarySacrificeRate = typeof salarySacrificeRates.$inferInsert;

// Types for unified provider rates
export type ProviderCredentials = {
  apiKey?: string;
  username?: string;
  password?: string;
  baseUrl?: string;
  encryptedData?: string;
};

export type FinanceProvider = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  supportedContractTypes: string[] | null;
  credentials: ProviderCredentials | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RatebookImport = {
  id: string;
  providerId: string | null;
  providerCode: string;
  contractType: string;
  batchId: string;
  fileName: string | null;
  fileHash: string | null;
  ratebookDate: Date | null;
  status: "pending" | "validating" | "processing" | "completed" | "failed" | "superseded";
  totalRows: number;
  successRows: number;
  errorRows: number;
  uniqueCapCodes: number;
  errorLog: string[] | null;
  supersededImportId: string | null;
  isLatest: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
};

export type ProviderRate = {
  id: string;
  capCode: string | null;
  vehicleId: string | null;
  importId: string;
  providerCode: string;
  contractType: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  isCommercial: boolean;
  term: number;
  annualMileage: number;
  paymentPlan: string;
  totalRental: number;
  leaseRental: number | null;
  serviceRental: number | null;
  nonRecoverableVat: number | null;
  co2Gkm: number | null;
  p11d: number | null;
  otrPrice: number | null;
  fuelType: string | null;
  transmission: string | null;
  bodyStyle: string | null;
  modelYear: string | null;
  excessMileagePpm: number | null;
  financeEmcPpm: number | null;
  serviceEmcPpm: number | null;
  wltpEvRange: number | null;
  wltpEvRangeMin: number | null;
  wltpEvRangeMax: number | null;
  wltpEaerMiles: number | null;
  fuelEcoCombined: string | null;
  bikTaxLowerRate: number | null;
  bikTaxHigherRate: number | null;
  bikPercent: string | null;
  wholeLifeCost: number | null;
  estimatedSaleValue: number | null;
  fuelCostPpm: number | null;
  insuranceGroup: string | null;
  euroRating: string | null;
  rdeCertificationLevel: string | null;
  rawData: Record<string, unknown> | null;
  score: number | null;
  createdAt: Date;
};

// Contract type constants
export const CONTRACT_TYPES = {
  CH: "CH", // Contract Hire with Maintenance (Business)
  CHNM: "CHNM", // Contract Hire without Maintenance (Business)
  PCH: "PCH", // Personal Contract Hire with Maintenance
  PCHNM: "PCHNM", // Personal Contract Hire without Maintenance
  BSSNL: "BSSNL", // Salary Sacrifice
} as const;

export type ContractType = (typeof CONTRACT_TYPES)[keyof typeof CONTRACT_TYPES];

// Payment plan constants
export const PAYMENT_PLANS = {
  MONTHLY_IN_ADVANCE: "monthly_in_advance",
  SPREAD_3_DOWN: "spread_3_down",
  SPREAD_6_DOWN: "spread_6_down",
  SPREAD_9_DOWN: "spread_9_down",
} as const;

export type PaymentPlan = (typeof PAYMENT_PLANS)[keyof typeof PAYMENT_PLANS];

// Customer type for contract type grouping
export const CUSTOMER_TYPES = {
  BUSINESS: "business",
  PERSONAL: "personal",
  SALARY_SACRIFICE: "salary_sacrifice",
} as const;

export type CustomerType = (typeof CUSTOMER_TYPES)[keyof typeof CUSTOMER_TYPES];

// Helper to determine customer type from contract type
export function getCustomerType(contractType: ContractType): CustomerType {
  switch (contractType) {
    case "CH":
    case "CHNM":
      return CUSTOMER_TYPES.BUSINESS;
    case "PCH":
    case "PCHNM":
      return CUSTOMER_TYPES.PERSONAL;
    case "BSSNL":
      return CUSTOMER_TYPES.SALARY_SACRIFICE;
    default:
      return CUSTOMER_TYPES.BUSINESS;
  }
}

// Helper to check if contract includes maintenance
export function includesMaintenance(contractType: ContractType): boolean {
  return contractType === "CH" || contractType === "PCH" || contractType === "BSSNL";
}

// ============================================
// VEHICLE CAP CODE MATCHING
// ============================================

// Vehicle CAP code matches (for providers without CAP codes like Ogilvie)
export const vehicleCapMatches = pgTable("vehicle_cap_matches", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Unique key for the source vehicle (hash of manufacturer_model_variant)
  sourceKey: text("source_key").notNull().unique(),
  sourceProvider: text("source_provider").notNull(), // ogilvie, drivalia, etc.

  // Source vehicle details
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  p11d: integer("p11d"), // P11D in pence for verification

  // Matched CAP code from reference provider (Lex)
  capCode: text("cap_code"), // NULL if unmatched
  matchedManufacturer: text("matched_manufacturer"),
  matchedModel: text("matched_model"),
  matchedVariant: text("matched_variant"),
  matchedP11d: integer("matched_p11d"),

  // Match quality
  matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }), // 0-100
  matchStatus: text("match_status").notNull().default("pending"), // pending, confirmed, rejected, manual
  matchMethod: text("match_method"), // auto_exact, auto_fuzzy, manual

  // Audit
  matchedAt: timestamp("matched_at"),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
  confirmedAt: timestamp("confirmed_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Types for vehicle matching
export type VehicleCapMatch = {
  id: string;
  sourceKey: string;
  sourceProvider: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  p11d: number | null;
  capCode: string | null;
  matchedManufacturer: string | null;
  matchedModel: string | null;
  matchedVariant: string | null;
  matchedP11d: number | null;
  matchConfidence: string | null;
  matchStatus: "pending" | "confirmed" | "rejected" | "manual";
  matchMethod: string | null;
  matchedAt: Date | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const MATCH_STATUS = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  MANUAL: "manual",
} as const;

export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

// ============================================
// OGILVIE CAP CODE MAPPINGS (from website scrape)
// ============================================

// Ogilvie derivative name → CAP code mappings scraped from their website
export const ogilvieCapMappings = pgTable("ogilvie_cap_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Ogilvie derivative full name (exact match from their website)
  derivativeFullName: text("derivative_full_name").notNull().unique(),

  // CAP codes from Ogilvie website
  capId: text("cap_id"), // e.g., "103010" (DataOriginatorCode)
  capCode: text("cap_code"), // e.g., "ABA500   2VE A" (LookupCode)

  // Normalized manufacturer/model for faster lookups
  manufacturer: text("manufacturer"),
  model: text("model"),

  // Import tracking
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
  importBatchId: text("import_batch_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Types for Ogilvie CAP mappings
export type OgilvieCapMapping = {
  id: string;
  derivativeFullName: string;
  capId: string | null;
  capCode: string | null;
  manufacturer: string | null;
  model: string | null;
  scrapedAt: Date;
  importBatchId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ============================================
// FEATURED DEALS & ALERT RULES
// ============================================

// Featured deals - vehicles showcased on website
export const featuredDeals = pgTable("featured_deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  capCode: text("cap_code").notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),

  // Vehicle info (denormalized for display)
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  fuelType: text("fuel_type"),

  // Best deal at time of featuring
  bestProviderCode: text("best_provider_code"),
  bestMonthlyPrice: integer("best_monthly_price"), // in pence
  bestTerm: integer("best_term"),
  bestMileage: integer("best_mileage"),
  contractType: text("contract_type"),
  scoreAtFeaturing: integer("score_at_featuring"),

  // Status
  isActive: boolean("is_active").default(true),
  featuredAt: timestamp("featured_at").defaultNow().notNull(),
  unfeaturedAt: timestamp("unfeatured_at"),
  featuredBy: uuid("featured_by").references(() => users.id),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Alert rules for deal notifications
export const dealAlertRules = pgTable("deal_alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),

  // Conditions (JSON structure for flexibility)
  conditions: jsonb("conditions").$type<DealAlertConditions>().notNull(),

  // Notification settings
  notifyMethod: text("notify_method").notNull(), // email, slack, webhook
  notifyTarget: text("notify_target"), // email address, slack channel, webhook URL

  // Status
  isActive: boolean("is_active").default(true),
  lastTriggeredAt: timestamp("last_triggered_at"),
  triggerCount: integer("trigger_count").default(0),

  // Ownership
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Types for Deal Alert Conditions
export type DealAlertConditions = {
  scoreMin?: number; // Minimum score threshold (e.g., 80, 90, 95)
  scoreMax?: number;
  priceMax?: number; // Maximum monthly price in GBP
  priceMin?: number;
  manufacturers?: string[]; // Filter to specific manufacturers
  fuelTypes?: string[]; // Electric, Hybrid, Petrol, Diesel
  contractTypes?: string[]; // CH, CHNM, PCH, PCHNM, BSSNL
  providers?: string[]; // lex, ogilvie, venus
};

// Ratio band for score calculation
export type RatioBand = {
  maxRatio: number;
  score: number;
};

// Scoring configuration
export const scoringConfig = pgTable("scoring_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("default"),
  isActive: boolean("is_active").default(true),

  // Weight configuration (must sum to 100)
  weights: jsonb("weights").$type<ScoringWeights>().notNull(),

  // Threshold labels
  thresholds: jsonb("thresholds").$type<ScoreThresholds>(),

  // Ratio bands for score calculation
  ratioBands: jsonb("ratio_bands").$type<RatioBand[]>(),

  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Types for Scoring Configuration
export type ScoringWeights = {
  valueScore: number; // Weight for rental/P11D ratio (default 70)
  providerCompetition: number; // Weight for multi-provider coverage (default 20)
  rateFreshness: number; // Weight for how recent the rate is (default 10)
};

export type ScoreThresholds = {
  hot: { min: number; label: string }; // e.g., { min: 80, label: "Hot Deal" }
  great: { min: number; label: string }; // e.g., { min: 65, label: "Great" }
  good: { min: number; label: string }; // e.g., { min: 50, label: "Good" }
  fair: { min: number; label: string }; // e.g., { min: 40, label: "Fair" }
  average: { min: number; label: string }; // e.g., { min: 0, label: "Average" }
};

// ============================================
// VEHICLE STATUS (Special Offers, Enable/Disable)
// ============================================

export const vehicleStatus = pgTable("vehicle_status", {
  id: uuid("id").primaryKey().defaultRandom(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),

  // Special offer tracking
  isSpecialOffer: boolean("is_special_offer").default(false),
  specialOfferAt: timestamp("special_offer_at"),
  specialOfferNotes: text("special_offer_notes"),

  // Website visibility
  isEnabled: boolean("is_enabled").default(true),
  disabledAt: timestamp("disabled_at"),
  disabledReason: text("disabled_reason"),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  vehicleIdIdx: index("idx_vehicle_status_vehicle_id").on(table.vehicleId),
  specialOfferIdx: index("idx_vehicle_status_special_offer").on(table.isSpecialOffer),
  enabledIdx: index("idx_vehicle_status_enabled").on(table.isEnabled),
}));

export type VehicleStatus = {
  id: string;
  vehicleId: string;
  isSpecialOffer: boolean;
  specialOfferAt: Date | null;
  specialOfferNotes: string | null;
  isEnabled: boolean;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ============================================
// MARKET INTELLIGENCE (SplitIntelligence)
// ============================================

// Market data snapshots for trend analysis
export const marketIntelligenceSnapshots = pgTable("market_intelligence_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotDate: timestamp("snapshot_date").notNull().defaultNow(),
  source: text("source").notNull(), // 'leasing_com' | 'leaseloco'

  // Aggregate stats
  totalDealsCount: integer("total_deals_count").default(0),
  avgMonthlyPrice: integer("avg_monthly_price"), // in pence
  priceRange: jsonb("price_range").$type<{ min: number; max: number }>(),
  vehicleTypeBreakdown: jsonb("vehicle_type_breakdown").$type<Record<string, number>>(),

  // Raw response backup
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sourceIdx: index("idx_mi_snapshots_source").on(table.source),
  dateIdx: index("idx_mi_snapshots_date").on(table.snapshotDate),
}));

// Individual competitor deals
export const marketIntelligenceDeals = pgTable("market_intelligence_deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => marketIntelligenceSnapshots.id, { onDelete: "cascade" }),
  source: text("source").notNull(), // 'leasing_com' | 'leaseloco'
  externalId: text("external_id"), // ID from the source

  // Vehicle info
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  bodyType: text("body_type"),
  fuelType: text("fuel_type"),

  // Deal terms
  monthlyPrice: integer("monthly_price").notNull(), // in pence
  initialPayment: integer("initial_payment"), // in pence
  term: integer("term"), // months
  annualMileage: integer("annual_mileage"),

  // Source-specific scores
  valueScore: integer("value_score"), // leaseloco score
  dealCount: integer("deal_count"), // number of deals for this vehicle
  stockStatus: text("stock_status"), // in_stock, order, etc.
  imageUrl: text("image_url"),
  leaseType: text("lease_type"), // personal | business
  vatIncluded: boolean("vat_included"),

  // Matching to our inventory
  matchedCapCode: text("matched_cap_code"),
  matchedVehicleId: uuid("matched_vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
  matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }), // 0-100

  // Trend tracking (compared to previous snapshot)
  previousPrice: integer("previous_price"), // in pence
  priceChange: integer("price_change"), // in pence (positive = increase)
  priceChangePercent: numeric("price_change_percent", { precision: 6, scale: 2 }),

  // Raw data backup
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  snapshotIdx: index("idx_mi_deals_snapshot").on(table.snapshotId),
  sourceIdx: index("idx_mi_deals_source").on(table.source),
  manufacturerIdx: index("idx_mi_deals_manufacturer").on(table.manufacturer),
  priceIdx: index("idx_mi_deals_price").on(table.monthlyPrice),
  matchedIdx: index("idx_mi_deals_matched").on(table.matchedVehicleId),
  leaseTypeIdx: index("idx_mi_deals_lease_type").on(table.leaseType),
  vatIncludedIdx: index("idx_mi_deals_vat_included").on(table.vatIncluded),
}));

// AI chat sessions for market intelligence
export const intelligenceChatSessions = pgTable("intelligence_chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

  // Session state
  isActive: boolean("is_active").default(true),
  lastSnapshotId: uuid("last_snapshot_id").references(() => marketIntelligenceSnapshots.id, { onDelete: "set null" }),

  // Context tracking
  contextSummary: text("context_summary"), // AI-generated summary of conversation

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("idx_chat_sessions_user").on(table.userId),
  activeIdx: index("idx_chat_sessions_active").on(table.isActive),
}));

// Chat messages
export const intelligenceChatMessages = pgTable("intelligence_chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => intelligenceChatSessions.id, { onDelete: "cascade" }),

  role: text("role").notNull(), // 'user' | 'assistant' | 'system'
  content: text("content").notNull(),

  // Referenced data in this message
  referencedDeals: jsonb("referenced_deals").$type<string[]>(), // Deal IDs mentioned
  referencedVehicles: jsonb("referenced_vehicles").$type<string[]>(), // Vehicle IDs mentioned

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sessionIdx: index("idx_chat_messages_session").on(table.sessionId),
  roleIdx: index("idx_chat_messages_role").on(table.role),
}));

// Types for Market Intelligence
export type MarketIntelligenceSnapshot = {
  id: string;
  snapshotDate: Date;
  source: 'leasing_com' | 'leaseloco' | 'appliedleasing' | 'selectcarleasing' | 'vipgateway';
  totalDealsCount: number;
  avgMonthlyPrice: number | null;
  priceRange: { min: number; max: number } | null;
  vehicleTypeBreakdown: Record<string, number> | null;
  rawData: Record<string, unknown> | null;
  createdAt: Date;
};

export type MarketIntelligenceDeal = {
  id: string;
  snapshotId: string;
  source: 'leasing_com' | 'leaseloco' | 'appliedleasing' | 'selectcarleasing' | 'vipgateway';
  externalId: string | null;
  manufacturer: string;
  model: string;
  variant: string | null;
  bodyType: string | null;
  fuelType: string | null;
  monthlyPrice: number;
  initialPayment: number | null;
  term: number | null;
  annualMileage: number | null;
  valueScore: number | null;
  dealCount: number | null;
  stockStatus: string | null;
  imageUrl: string | null;
  leaseType: string | null;
  vatIncluded: boolean | null;
  matchedCapCode: string | null;
  matchedVehicleId: string | null;
  matchConfidence: string | null;
  previousPrice: number | null;
  priceChange: number | null;
  priceChangePercent: string | null;
  rawData: Record<string, unknown> | null;
  createdAt: Date;
};

export type IntelligenceChatSession = {
  id: string;
  userId: string | null;
  isActive: boolean;
  lastSnapshotId: string | null;
  contextSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IntelligenceChatMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  referencedDeals: string[] | null;
  referencedVehicles: string[] | null;
  createdAt: Date;
};

// ============================================
// USER TABLE VIEWS (Saved column layouts & filters)
// ============================================

export const userTableViews = pgTable("user_table_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

  // View identification
  viewName: text("view_name").notNull(),
  tableId: text("table_id").notNull(), // "rate-explorer", "deal-finder", etc.

  // Column configuration
  columnOrder: jsonb("column_order").$type<string[]>(),
  columnVisibility: jsonb("column_visibility").$type<Record<string, boolean>>(),
  columnWidths: jsonb("column_widths").$type<Record<string, number>>(),

  // Filter/sort state
  filters: jsonb("filters").$type<Record<string, unknown>>(),
  sortBy: text("sort_by"),
  sortOrder: text("sort_order"), // "asc" | "desc"

  // Default view flag
  isDefault: boolean("is_default").default(false),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  userTableIdx: index("idx_user_table_views_user_table").on(table.userId, table.tableId),
  defaultIdx: index("idx_user_table_views_default").on(table.userId, table.tableId, table.isDefault),
}));

export type UserTableView = {
  id: string;
  userId: string;
  viewName: string;
  tableId: string;
  columnOrder: string[] | null;
  columnVisibility: Record<string, boolean> | null;
  columnWidths: Record<string, number> | null;
  filters: Record<string, unknown> | null;
  sortBy: string | null;
  sortOrder: "asc" | "desc" | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// ============================================
// LEX PLAYWRIGHT AUTOMATION
// ============================================

export const lexPlaywrightBatches = pgTable("lex_playwright_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: text("batch_id").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed

  // Configuration
  vehicleIds: jsonb("vehicle_ids").$type<string[]>().notNull(),
  terms: jsonb("terms").$type<number[]>().notNull(),
  mileages: jsonb("mileages").$type<number[]>().notNull(),
  contractTypes: jsonb("contract_types").$type<string[]>().notNull(),
  paymentPlans: jsonb("payment_plans").$type<string[]>().notNull(),
  useDefaultOtr: boolean("use_default_otr").default(true),
  customOtrp: integer("custom_otrp"), // In pence, if use_default_otr=false

  // Progress
  totalCombinations: integer("total_combinations").default(0),
  processedCount: integer("processed_count").default(0),
  successCount: integer("success_count").default(0),
  errorCount: integer("error_count").default(0),

  // Results
  errorMessage: text("error_message"),

  // Timestamps
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("idx_lex_playwright_batches_status").on(table.status),
  createdAtIdx: index("idx_lex_playwright_batches_created").on(table.createdAt),
}));

export const lexPlaywrightQuotes = pgTable("lex_playwright_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: text("batch_id").notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id),

  // Quote parameters
  term: integer("term").notNull(),
  annualMileage: integer("annual_mileage").notNull(),
  contractType: text("contract_type").notNull(), // 'CH' or 'CHNM'
  paymentPlan: text("payment_plan").notNull(),
  otrpUsed: integer("otrp_used"), // In pence
  usedCustomOtr: boolean("used_custom_otr").default(false),

  // Results
  quoteNumber: text("quote_number"), // Lex quote reference
  monthlyRental: integer("monthly_rental"), // In pence
  initialRental: integer("initial_rental"), // In pence
  status: text("status").notNull(), // 'success' or 'error'
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  batchIdx: index("idx_lex_playwright_quotes_batch").on(table.batchId),
  vehicleIdx: index("idx_lex_playwright_quotes_vehicle").on(table.vehicleId),
}));

export type LexPlaywrightBatch = {
  id: string;
  batchId: string;
  status: string;
  vehicleIds: string[];
  terms: number[];
  mileages: number[];
  contractTypes: string[];
  paymentPlans: string[];
  useDefaultOtr: boolean;
  customOtrp: number | null;
  totalCombinations: number;
  processedCount: number;
  successCount: number;
  errorCount: number;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
};

export type LexPlaywrightQuote = {
  id: string;
  batchId: string;
  vehicleId: string | null;
  term: number;
  annualMileage: number;
  contractType: string;
  paymentPlan: string;
  otrpUsed: number | null;
  usedCustomOtr: boolean;
  quoteNumber: string | null;
  monthlyRental: number | null;
  initialRental: number | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
};
