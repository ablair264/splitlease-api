import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Database fields that ratebooks can map to
export const DATABASE_FIELDS = {
  // Required identifiers
  capCode: { label: "CAP Code", description: "Vehicle CAP identification code", required: true },

  // Vehicle info
  manufacturer: { label: "Manufacturer", description: "Vehicle manufacturer/make (e.g., BMW, AUDI)", required: true },
  model: { label: "Model", description: "Vehicle model name", required: true },
  variant: { label: "Variant", description: "Vehicle variant/derivative/trim level", required: false },
  modelYear: { label: "Model Year", description: "Year of the model", required: false },

  // Contract terms
  term: { label: "Term", description: "Contract term in months (e.g., 24, 36, 48)", required: true },
  annualMileage: { label: "Annual Mileage", description: "Annual mileage allowance", required: true },

  // Pricing (all should be in GBP)
  totalRental: { label: "Total Rental", description: "Monthly rental amount (main price)", required: true },
  leaseRental: { label: "Lease Rental", description: "Finance/lease portion of rental", required: false },
  serviceRental: { label: "Service Rental", description: "Maintenance/service portion of rental", required: false },

  // Vehicle specs
  p11d: { label: "P11D", description: "P11D value (list price for tax purposes)", required: false },
  co2Gkm: { label: "CO2 g/km", description: "CO2 emissions in grams per kilometer", required: false },
  fuelType: { label: "Fuel Type", description: "Fuel type (Petrol, Diesel, Electric, Hybrid)", required: false },
  transmission: { label: "Transmission", description: "Transmission type (Manual, Automatic)", required: false },
  bodyStyle: { label: "Body Style", description: "Body style (Hatchback, Saloon, SUV, etc.)", required: false },

  // Additional pricing
  excessMileagePpm: { label: "Excess Mileage PPM", description: "Excess mileage charge per mile in pence", required: false },
  wholeLifeCost: { label: "Whole Life Cost", description: "Total cost over contract period", required: false },
  otrPrice: { label: "OTR Price", description: "On The Road price (full vehicle price including taxes)", required: false },
  basicListPrice: { label: "Basic List Price", description: "Basic list price before options/taxes", required: false },

  // Other specs
  insuranceGroup: { label: "Insurance Group", description: "Insurance group number", required: false },
  mpgCombined: { label: "MPG Combined", description: "Combined fuel economy in MPG", required: false },
  wltpEvRange: { label: "EV Range", description: "Electric vehicle range in miles", required: false },
  euroRating: { label: "Euro Rating", description: "Euro emissions classification", required: false },
} as const;

export type DatabaseFieldKey = keyof typeof DATABASE_FIELDS;

export interface ColumnMapping {
  sourceColumn: string;
  targetField: DatabaseFieldKey | null;
  confidence: number; // 0-100
  reasoning: string;
}

export interface AnalysisResult {
  mappings: ColumnMapping[];
  unmappedColumns: string[];
  missingRequiredFields: string[];
  suggestedProviderName: string;
}

/**
 * Analyze CSV/XLSX column headers and suggest mappings to database fields
 */
export async function analyzeColumnHeaders(
  headers: string[],
  sampleRows: Record<string, string>[] = []
): Promise<AnalysisResult> {
  const fieldDescriptions = Object.entries(DATABASE_FIELDS)
    .map(([key, info]) => `- ${key}: ${info.label} - ${info.description}${info.required ? " (REQUIRED)" : ""}`)
    .join("\n");

  const sampleDataDescription = sampleRows.length > 0
    ? `\n\nSample data from first few rows:\n${JSON.stringify(sampleRows.slice(0, 3), null, 2)}`
    : "";

  const prompt = `You are an expert at analyzing vehicle leasing ratebook files. Analyze these column headers and map them to our database fields.

SOURCE COLUMNS FROM FILE:
${headers.map((h, i) => `${i + 1}. "${h}"`).join("\n")}
${sampleDataDescription}

TARGET DATABASE FIELDS:
${fieldDescriptions}

For each source column, determine:
1. Which database field it maps to (or null if no match)
2. Confidence score 0-100 (100 = exact match, 70+ = confident, 50-69 = likely, <50 = uncertain)
3. Brief reasoning

Also suggest a provider name based on the file format and column names:
- ALD Automotive: Has NET RENTAL WM/CM, ANNUAL_MILEAGE (underscore), WIN ID columns
- Lex Autolease: Has Vehicle Rental, Service Rental, Non Recoverable VAT columns
- Ogilvie Fleet: Has MonthlyRental, FinanceElement, MaintenanceElement columns
- Zenith Fleet: Has specific Zenith columns
- Arval: Has specific Arval columns

Common column name patterns:
- CAP CODE, CAP_CODE, CapCode, Cap Id -> capCode
- MANUFACTURER, Make, Mfr -> manufacturer
- MODEL, Model_Name -> model
- VARIANT, Derivative, Trim -> variant
- TERM, Contract Term, Months -> term
- MILEAGE, Annual_Mileage, Miles -> annualMileage
- RENTAL, Monthly Rental, NET RENTAL, Net_Rental -> totalRental
- NET RENTAL WM (with maintenance) -> totalRental (for maintenance contracts)
- NET RENTAL CM (contract only) -> leaseRental
- P11D, P11D Value -> p11d
- CO2, CO2 g/km, CO2_g_per_km -> co2Gkm
- FUEL TYPE, Fuel -> fuelType
- TRANSMISSION, Trans -> transmission
- OTR, OTRP, On The Road, OTR Price -> otrPrice
- BASIC PRICE, Basic List Price, List Price, Base Price -> basicListPrice

Respond in JSON format:
{
  "mappings": [
    {
      "sourceColumn": "COLUMN_NAME",
      "targetField": "fieldKey or null",
      "confidence": 85,
      "reasoning": "Brief explanation"
    }
  ],
  "suggestedProviderName": "Provider Name"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a data mapping expert specializing in vehicle leasing ratebooks. Always respond with valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from OpenAI");
    }

    const parsed = JSON.parse(content) as {
      mappings: ColumnMapping[];
      suggestedProviderName: string;
    };

    // Validate and clean up mappings
    const validMappings = parsed.mappings.map((m) => ({
      sourceColumn: m.sourceColumn,
      targetField: m.targetField && m.targetField in DATABASE_FIELDS ? m.targetField : null,
      confidence: Math.min(100, Math.max(0, m.confidence || 0)),
      reasoning: m.reasoning || "",
    }));

    // Find unmapped columns
    const mappedColumns = validMappings
      .filter((m) => m.targetField !== null)
      .map((m) => m.sourceColumn);
    const unmappedColumns = headers.filter((h) => !mappedColumns.includes(h));

    // Find missing required fields
    const mappedFields = validMappings
      .filter((m) => m.targetField !== null)
      .map((m) => m.targetField);
    const missingRequiredFields = Object.entries(DATABASE_FIELDS)
      .filter(([key, info]) => info.required && !mappedFields.includes(key as DatabaseFieldKey))
      .map(([key]) => key);

    return {
      mappings: validMappings,
      unmappedColumns,
      missingRequiredFields,
      suggestedProviderName: parsed.suggestedProviderName || "Unknown Provider",
    };
  } catch (error) {
    console.error("[column-analyzer] OpenAI error:", error);

    // Fallback: attempt basic pattern matching
    return fallbackAnalysis(headers);
  }
}

/**
 * Fallback analysis using pattern matching (no AI)
 */
function fallbackAnalysis(headers: string[]): AnalysisResult {
  const patterns: Record<DatabaseFieldKey, RegExp[]> = {
    capCode: [/cap.?code/i, /cap.?id/i, /capcode/i],
    manufacturer: [/manufacturer/i, /^make$/i, /^mfr$/i],
    model: [/^model$/i, /model.?name/i],
    variant: [/variant/i, /derivative/i, /^trim$/i],
    modelYear: [/model.?year/i, /^year$/i],
    term: [/^term$/i, /contract.?term/i, /months/i],
    annualMileage: [/mileage/i, /annual.?miles/i],
    totalRental: [/^rental$/i, /monthly.?rental/i, /net.?rental.?wm/i, /net.?rental$/i, /total.?rental/i],
    leaseRental: [/lease.?rental/i, /finance.?rental/i, /net.?rental.?cm/i, /contract.?rental/i],
    serviceRental: [/service.?rental/i, /maintenance/i],
    p11d: [/p11d/i],
    co2Gkm: [/co2/i, /co2.?g/i],
    fuelType: [/fuel.?type/i, /^fuel$/i],
    transmission: [/transmission/i, /^trans$/i],
    bodyStyle: [/body.?style/i, /^body$/i],
    excessMileagePpm: [/excess.?mileage/i, /emc/i],
    wholeLifeCost: [/whole.?life/i, /wlc/i],
    otrPrice: [/^otr$/i, /^otrp$/i, /on.?the.?road/i, /otr.?price/i],
    basicListPrice: [/basic.?price/i, /basic.?list/i, /list.?price/i, /base.?price/i],
    insuranceGroup: [/insurance.?group/i],
    mpgCombined: [/mpg/i, /fuel.?eco/i],
    wltpEvRange: [/ev.?range/i, /electric.?range/i, /wltp/i],
    euroRating: [/euro/i],
  };

  const mappings: ColumnMapping[] = headers.map((header) => {
    for (const [field, regexes] of Object.entries(patterns)) {
      for (const regex of regexes) {
        if (regex.test(header)) {
          return {
            sourceColumn: header,
            targetField: field as DatabaseFieldKey,
            confidence: 60,
            reasoning: "Pattern match (fallback)",
          };
        }
      }
    }
    return {
      sourceColumn: header,
      targetField: null,
      confidence: 0,
      reasoning: "No pattern match found",
    };
  });

  const mappedColumns = mappings
    .filter((m) => m.targetField !== null)
    .map((m) => m.sourceColumn);
  const unmappedColumns = headers.filter((h) => !mappedColumns.includes(h));

  const mappedFields = mappings
    .filter((m) => m.targetField !== null)
    .map((m) => m.targetField);
  const missingRequiredFields = Object.entries(DATABASE_FIELDS)
    .filter(([key, info]) => info.required && !mappedFields.includes(key as DatabaseFieldKey))
    .map(([key]) => key);

  return {
    mappings,
    unmappedColumns,
    missingRequiredFields,
    suggestedProviderName: "Unknown Provider",
  };
}

/**
 * Get the list of available database fields for the UI
 */
export function getDatabaseFields() {
  return Object.entries(DATABASE_FIELDS).map(([key, info]) => ({
    key,
    ...info,
  }));
}
