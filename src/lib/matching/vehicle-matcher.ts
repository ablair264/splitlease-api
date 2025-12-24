import { db } from "../db/index.js";
import { vehicleCapMatches, providerRates, ogilvieCapMappings } from "../db/schema.js";
import { eq, and, sql, ilike } from "drizzle-orm";
import { createHash } from "crypto";

// Manufacturer name normalization map
const MANUFACTURER_ALIASES: Record<string, string> = {
  "MERCEDES-BENZ": "MERCEDES",
  "MERCEDES BENZ": "MERCEDES",
  "VW": "VOLKSWAGEN",
  "LAND ROVER": "LANDROVER",
  "ALFA ROMEO": "ALFAROMEO",
  "ROLLS-ROYCE": "ROLLSROYCE",
  "ROLLS ROYCE": "ROLLSROYCE",
  "ASTON MARTIN": "ASTONMARTIN",
  "BMW ALPINA": "ALPINA",
};

// P11D tolerance in pence (£500 = 50000 pence) - STRICT for better matching
const P11D_TOLERANCE_PENCE = 50000;
// Hard rejection threshold - if P11D differs by more than this, reject match entirely
const P11D_HARD_REJECTION_PENCE = 100000; // £1000

// Minimum confidence thresholds
const HIGH_CONFIDENCE_THRESHOLD = 90;
const MEDIUM_CONFIDENCE_THRESHOLD = 70;

export type MatchResult = {
  sourceKey: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  p11d: number | null;
  capCode: string | null;
  matchedManufacturer: string | null;
  matchedModel: string | null;
  matchedVariant: string | null;
  matchedP11d: number | null;
  confidence: number;
  method: "auto_exact" | "auto_fuzzy" | "manual" | "none";
};

export type VehicleToMatch = {
  manufacturer: string;
  model: string;
  variant: string | null;
  p11d: number | null;
};

/**
 * Normalize manufacturer name for comparison
 */
export function normalizeManufacturer(name: string): string {
  const upper = name.toUpperCase().trim();
  return MANUFACTURER_ALIASES[upper] || upper.replace(/[^A-Z0-9]/g, "");
}

/**
 * Normalize model/variant name for comparison
 */
export function normalizeModelName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, "") // Remove special chars except spaces
    .replace(/\s+/g, " ") // Normalize spaces
    .trim();
}

/**
 * Generate unique source key for a vehicle
 */
export function generateSourceKey(manufacturer: string, model: string, variant: string | null): string {
  const normalized = `${normalizeManufacturer(manufacturer)}_${normalizeModelName(model)}_${normalizeModelName(variant || "")}`;
  return createHash("md5").update(normalized).digest("hex");
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate string similarity as a percentage (0-100)
 * Uses Levenshtein distance normalized by max string length
 */
export function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;

  const normA = normalizeModelName(a);
  const normB = normalizeModelName(b);

  if (normA === normB) return 100;

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 100;

  const distance = levenshteinDistance(normA, normB);
  return Math.round((1 - distance / maxLen) * 100);
}

/**
 * Body type keywords for matching
 */
const BODY_TYPE_KEYWORDS = [
  "HATCHBACK", "HATCH", "SALOON", "SEDAN", "ESTATE", "TOURING", "WAGON",
  "SUV", "CROSSOVER", "COUPE", "CONVERTIBLE", "CABRIO", "CABRIOLET", "ROADSTER",
  "MPV", "VAN", "PICKUP", "TRUCK"
];

/**
 * Extract body type from model or variant name
 */
export function extractBodyType(text: string): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  for (const bodyType of BODY_TYPE_KEYWORDS) {
    if (upper.includes(bodyType)) {
      // Normalize similar types
      if (bodyType === "CABRIO" || bodyType === "CABRIOLET") return "CONVERTIBLE";
      if (bodyType === "HATCH") return "HATCHBACK";
      if (bodyType === "SEDAN") return "SALOON";
      if (bodyType === "WAGON" || bodyType === "TOURING") return "ESTATE";
      return bodyType;
    }
  }
  return null;
}

/**
 * Extract base model name by removing body type keywords and common suffixes
 * e.g., "DUSTER ESTATE" → "DUSTER", "500 ELECTRIC HATCHBACK" → "500 ELECTRIC"
 */
export function extractBaseModel(modelName: string): string {
  if (!modelName) return "";
  let upper = modelName.toUpperCase().trim();

  // Remove body type keywords from the end
  for (const bodyType of BODY_TYPE_KEYWORDS) {
    const pattern = new RegExp(`\\s*${bodyType}\\s*$`, "i");
    upper = upper.replace(pattern, "").trim();
  }

  return upper;
}

/**
 * Check if base model names are compatible (at least 60% similar or one contains the other)
 */
export function baseModelsCompatible(modelA: string, modelB: string): boolean {
  const baseA = extractBaseModel(modelA);
  const baseB = extractBaseModel(modelB);

  if (!baseA || !baseB) return true; // Can't compare, allow

  // Exact match after normalization
  const normA = normalizeModelName(baseA);
  const normB = normalizeModelName(baseB);

  if (normA === normB) return true;

  // One contains the other (e.g., "LEON" in "LEON")
  if (normA.includes(normB) || normB.includes(normA)) return true;

  // Require at least 60% similarity for base model
  const similarity = stringSimilarity(baseA, baseB);
  return similarity >= 60;
}

/**
 * Check if body types are compatible
 */
export function bodyTypesCompatible(textA: string | null, textB: string | null): boolean {
  const bodyA = extractBodyType(textA || "");
  const bodyB = extractBodyType(textB || "");

  // If we can't detect body type, allow the match
  if (!bodyA || !bodyB) return true;

  // Body types must match
  return bodyA === bodyB;
}

/**
 * Check if P11D values are within tolerance
 */
export function p11dWithinTolerance(p11dA: number | null, p11dB: number | null): boolean {
  if (p11dA === null || p11dB === null) return true; // Can't compare, assume OK
  return Math.abs(p11dA - p11dB) <= P11D_TOLERANCE_PENCE;
}

/**
 * Check if P11D difference is so large it should hard-reject the match
 */
export function p11dHardReject(p11dA: number | null, p11dB: number | null): boolean {
  if (p11dA === null || p11dB === null) return false; // Can't compare, don't reject
  return Math.abs(p11dA - p11dB) > P11D_HARD_REJECTION_PENCE;
}

/**
 * Calculate P11D similarity bonus (0-15 points)
 */
export function p11dSimilarityBonus(p11dA: number | null, p11dB: number | null): number {
  if (p11dA === null || p11dB === null) return 0;

  const diff = Math.abs(p11dA - p11dB);

  if (diff === 0) return 15;
  if (diff <= 5000) return 12; // Within £50
  if (diff <= 10000) return 8; // Within £100
  if (diff <= 20000) return 4; // Within £200
  return 0;
}

/**
 * Calculate overall match confidence score
 * Uses combined model+variant similarity to handle providers putting data in different fields
 */
export function calculateConfidence(
  manufacturerMatch: boolean,
  combinedSimilarity: number,
  p11dBonus: number
): number {
  if (!manufacturerMatch) return 0;

  // Combined model+variant similarity (0-70)
  // This handles cases where providers put body type in different fields
  const combinedScore = (combinedSimilarity / 100) * 70;

  // P11D bonus (0-15)
  // Manufacturer exact match bonus (15)
  const mfrBonus = manufacturerMatch ? 15 : 0;

  return Math.min(100, Math.round(combinedScore + p11dBonus + mfrBonus));
}

/**
 * Look up CAP code from Ogilvie CAP mappings table (scraped from their website)
 * Returns CAP ID if found, null otherwise
 */
export async function lookupOgilvieCapMapping(derivativeName: string): Promise<{
  capId: string | null;
  capCode: string | null;
} | null> {
  if (!derivativeName) return null;

  // Exact match on derivative full name
  const mapping = await db
    .select({
      capId: ogilvieCapMappings.capId,
      capCode: ogilvieCapMappings.capCode,
    })
    .from(ogilvieCapMappings)
    .where(eq(ogilvieCapMappings.derivativeFullName, derivativeName))
    .limit(1);

  if (mapping.length > 0 && mapping[0].capId) {
    return mapping[0];
  }

  return null;
}

/**
 * Find the best CAP code match for a vehicle from Lex data
 */
export async function findCapCodeMatch(vehicle: VehicleToMatch): Promise<MatchResult> {
  const sourceKey = generateSourceKey(vehicle.manufacturer, vehicle.model, vehicle.variant);
  const normalizedMfr = normalizeManufacturer(vehicle.manufacturer);

  // First, check if we have an existing match
  const existingMatch = await db
    .select()
    .from(vehicleCapMatches)
    .where(eq(vehicleCapMatches.sourceKey, sourceKey))
    .limit(1);

  if (existingMatch.length > 0 && existingMatch[0].matchStatus !== "pending") {
    return {
      sourceKey,
      manufacturer: vehicle.manufacturer,
      model: vehicle.model,
      variant: vehicle.variant,
      p11d: vehicle.p11d,
      capCode: existingMatch[0].capCode,
      matchedManufacturer: existingMatch[0].matchedManufacturer,
      matchedModel: existingMatch[0].matchedModel,
      matchedVariant: existingMatch[0].matchedVariant,
      matchedP11d: existingMatch[0].matchedP11d,
      confidence: parseFloat(existingMatch[0].matchConfidence || "0"),
      method: existingMatch[0].matchMethod as "auto_exact" | "auto_fuzzy" | "manual" || "none",
    };
  }

  // Search Lex rates for potential matches (only from latest imports)
  // Get unique vehicles by CAP code with their details
  const candidates = await db
    .selectDistinctOn([providerRates.capCode], {
      capCode: providerRates.capCode,
      manufacturer: providerRates.manufacturer,
      model: providerRates.model,
      variant: providerRates.variant,
      p11d: providerRates.p11d,
    })
    .from(providerRates)
    .where(
      and(
        eq(providerRates.providerCode, "lex"),
        sql`${providerRates.importId} IN (SELECT id FROM ratebook_imports WHERE is_latest = true)`,
        ilike(providerRates.manufacturer, `%${normalizedMfr.substring(0, 4)}%`)
      )
    )
    .limit(500);

  let bestMatch: MatchResult = {
    sourceKey,
    manufacturer: vehicle.manufacturer,
    model: vehicle.model,
    variant: vehicle.variant,
    p11d: vehicle.p11d,
    capCode: null,
    matchedManufacturer: null,
    matchedModel: null,
    matchedVariant: null,
    matchedP11d: null,
    confidence: 0,
    method: "none",
  };

  for (const candidate of candidates) {
    const mfrMatch = normalizeManufacturer(candidate.manufacturer) === normalizedMfr;
    if (!mfrMatch) continue;

    // STRICT CHECK 1: Hard reject if P11D differs by more than £1000
    if (p11dHardReject(vehicle.p11d, candidate.p11d)) {
      continue; // P11D way off, definitely wrong vehicle
    }

    // STRICT CHECK 2: Body type must be compatible (HATCHBACK != CONVERTIBLE)
    const sourceFullText = `${vehicle.model} ${vehicle.variant || ""}`;
    const candidateFullText = `${candidate.model} ${candidate.variant || ""}`;
    if (!bodyTypesCompatible(sourceFullText, candidateFullText)) {
      continue; // Body type mismatch, skip
    }

    // STRICT CHECK 3: Base model name must be similar (DUSTER != JOGGER, 500 != DUCATO)
    if (!baseModelsCompatible(vehicle.model, candidate.model)) {
      continue; // Base model mismatch, skip
    }

    // Compare combined model+variant strings to handle providers putting data in different fields
    // e.g., Ogilvie "iX ESTATE" + "400kW..." vs Lex "iX" + "iX ESTATE 400kW..."
    const sourceFullName = `${vehicle.model} ${vehicle.variant || ""}`.trim();
    const candidateFullName = `${candidate.model} ${candidate.variant || ""}`.trim();
    const combinedSim = stringSimilarity(sourceFullName, candidateFullName);
    const p11dBonus = p11dSimilarityBonus(vehicle.p11d, candidate.p11d);

    const confidence = calculateConfidence(mfrMatch, combinedSim, p11dBonus);

    // STRICT CHECK 4: P11D must be within £500 tolerance for any match above 50%
    if (confidence >= 50) {
      if (!p11dWithinTolerance(vehicle.p11d, candidate.p11d)) {
        continue; // P11D mismatch, skip this candidate
      }
    }

    if (confidence > bestMatch.confidence) {
      bestMatch = {
        sourceKey,
        manufacturer: vehicle.manufacturer,
        model: vehicle.model,
        variant: vehicle.variant,
        p11d: vehicle.p11d,
        capCode: candidate.capCode,
        matchedManufacturer: candidate.manufacturer,
        matchedModel: candidate.model,
        matchedVariant: candidate.variant,
        matchedP11d: candidate.p11d,
        confidence,
        method: confidence >= HIGH_CONFIDENCE_THRESHOLD ? "auto_exact" : "auto_fuzzy",
      };

      // If we found an exact match (100%), no need to continue
      if (confidence === 100) break;
    }
  }

  return bestMatch;
}

/**
 * Save or update a match result in the database
 */
export async function saveMatchResult(result: MatchResult, sourceProvider: string): Promise<void> {
  const matchStatus =
    result.confidence >= HIGH_CONFIDENCE_THRESHOLD
      ? "confirmed"
      : result.confidence >= MEDIUM_CONFIDENCE_THRESHOLD
        ? "pending"
        : "pending";

  await db
    .insert(vehicleCapMatches)
    .values({
      sourceKey: result.sourceKey,
      sourceProvider,
      manufacturer: result.manufacturer,
      model: result.model,
      variant: result.variant,
      p11d: result.p11d,
      capCode: result.capCode,
      matchedManufacturer: result.matchedManufacturer,
      matchedModel: result.matchedModel,
      matchedVariant: result.matchedVariant,
      matchedP11d: result.matchedP11d,
      matchConfidence: result.confidence.toString(),
      matchStatus,
      matchMethod: result.method,
      matchedAt: result.capCode ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: vehicleCapMatches.sourceKey,
      set: {
        capCode: result.capCode,
        matchedManufacturer: result.matchedManufacturer,
        matchedModel: result.matchedModel,
        matchedVariant: result.matchedVariant,
        matchedP11d: result.matchedP11d,
        matchConfidence: result.confidence.toString(),
        matchStatus,
        matchMethod: result.method,
        matchedAt: result.capCode ? new Date() : null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Batch match multiple vehicles
 */
export async function batchMatchVehicles(
  vehicles: VehicleToMatch[],
  sourceProvider: string,
  onProgress?: (processed: number, total: number) => void
): Promise<{
  total: number;
  matched: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  unmatched: number;
}> {
  const stats = {
    total: vehicles.length,
    matched: 0,
    highConfidence: 0,
    mediumConfidence: 0,
    lowConfidence: 0,
    unmatched: 0,
  };

  for (let i = 0; i < vehicles.length; i++) {
    const vehicle = vehicles[i];
    const result = await findCapCodeMatch(vehicle);

    if (result.capCode) {
      stats.matched++;
      if (result.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
        stats.highConfidence++;
      } else if (result.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
        stats.mediumConfidence++;
      } else {
        stats.lowConfidence++;
      }
    } else {
      stats.unmatched++;
    }

    await saveMatchResult(result, sourceProvider);

    if (onProgress) {
      onProgress(i + 1, vehicles.length);
    }
  }

  return stats;
}

/**
 * Get CAP code for a vehicle (with caching via vehicle_cap_matches)
 */
export async function getCapCodeForVehicle(
  manufacturer: string,
  model: string,
  variant: string | null,
  p11d: number | null,
  sourceProvider: string
): Promise<string | null> {
  const sourceKey = generateSourceKey(manufacturer, model, variant);

  // Check cache first
  const cached = await db
    .select({ capCode: vehicleCapMatches.capCode, matchStatus: vehicleCapMatches.matchStatus })
    .from(vehicleCapMatches)
    .where(eq(vehicleCapMatches.sourceKey, sourceKey))
    .limit(1);

  if (cached.length > 0) {
    // Only return confirmed or manual matches
    if (cached[0].matchStatus === "confirmed" || cached[0].matchStatus === "manual") {
      return cached[0].capCode;
    }
    return null; // Pending or rejected
  }

  // No cache, perform matching
  const result = await findCapCodeMatch({ manufacturer, model, variant, p11d });
  await saveMatchResult(result, sourceProvider);

  // Only return high confidence matches automatically
  if (result.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return result.capCode;
  }

  return null;
}

/**
 * Get match statistics for a provider
 */
export async function getMatchStats(sourceProvider: string) {
  const stats = await db
    .select({
      status: vehicleCapMatches.matchStatus,
      count: sql<number>`count(*)`,
    })
    .from(vehicleCapMatches)
    .where(eq(vehicleCapMatches.sourceProvider, sourceProvider))
    .groupBy(vehicleCapMatches.matchStatus);

  return stats.reduce(
    (acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    },
    {} as Record<string, number>
  );
}
