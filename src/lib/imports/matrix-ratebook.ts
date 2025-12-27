import * as XLSX from "xlsx";

const TERM_PATTERN = /\b\d{1,2}\+\d{2}\b/;
const MATRIX_LABELS = ["BASE RENTALS", "BCH RATES", "ADD VAT FOR PCH", "PCH", "BCH"];

export interface MatrixDetectionResult {
  isMatrix: boolean;
  termRowIndex: number | null;
  labelRowIndex: number | null;
}

export interface MatrixParseResult {
  headers: string[];
  sampleRows: Record<string, string>[];
  meta: Record<string, string>;
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function sheetToRows(buffer: Buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
}

export function detectMatrixRatebook({
  buffer,
  fileName,
  rows,
}: {
  buffer?: Buffer;
  fileName?: string;
  rows?: string[][];
}): MatrixDetectionResult {
  const rawRows = rows ?? sheetToRows(buffer as Buffer);
  const scanRows = rawRows.slice(0, 30);

  let termRowIndex: number | null = null;
  let labelRowIndex: number | null = null;

  for (let i = 0; i < scanRows.length; i++) {
    const row = scanRows[i] || [];
    const cellText = row.map((c) => normalize(c));

    const termMatches = cellText.filter((c) => TERM_PATTERN.test(c));
    if (termMatches.length >= 3) {
      termRowIndex = i;
    }

    const rowUpper = cellText.join(" ").toUpperCase();
    if (MATRIX_LABELS.some((label) => rowUpper.includes(label))) {
      labelRowIndex = i;
    }
  }

  return {
    isMatrix: termRowIndex !== null && labelRowIndex !== null,
    termRowIndex,
    labelRowIndex,
  };
}

function extractTermHeaders(row: string[]) {
  return row.filter((cell) => TERM_PATTERN.test(cell));
}

function findMileageRows(rows: string[][], termRowIndex: number) {
  return rows.slice(termRowIndex + 1).filter((row) => normalize(row[0]) !== "");
}

export function parseMatrixToFlat({
  buffer,
  fileName,
  rows,
}: {
  buffer?: Buffer;
  fileName?: string;
  rows?: string[][];
}): MatrixParseResult {
  const rawRows = rows ?? sheetToRows(buffer as Buffer);
  const detection = detectMatrixRatebook({ rows: rawRows });
  const termRow = rawRows[detection.termRowIndex ?? 0] || [];
  const termHeaders = extractTermHeaders(termRow.map((c) => normalize(c)));

  const headers = [
    "Make",
    "Model",
    "Variant",
    "CAP Code",
    "CAP ID",
    "BLP",
    "OTR",
    "Vehicle Description",
    "Mileage",
    ...termHeaders,
  ];

  const mileageRows = findMileageRows(rawRows, detection.termRowIndex ?? 0);
  const sampleRows = mileageRows.slice(0, 5).map((row) => {
    const rowObj: Record<string, string> = {};
    rowObj.Mileage = normalize(row[0]);

    termHeaders.forEach((term) => {
      const cellIndex = termRow.findIndex((c) => normalize(c) === term);
      const value = normalize(row[cellIndex]);
      rowObj[term] = value;
    });

    return rowObj;
  });

  return { headers, sampleRows, meta: {} };
}
