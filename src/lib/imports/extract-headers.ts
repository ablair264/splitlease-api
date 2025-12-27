import * as XLSX from "xlsx";
import { detectMatrixRatebook, parseMatrixToFlat } from "./matrix-ratebook";

export interface ExtractHeadersResult {
  headers: string[];
  sampleRows: Record<string, string>[];
  headerRowIndex: number;
  isMatrix: boolean;
}

const HEADER_KEYWORDS = [
  "MANUFACTURER",
  "CAP CODE",
  "CAP_CODE",
  "CAPCODE",
  "MILEAGE",
  "RENTAL",
  "MODEL",
  "MAKE",
  "VARIANT",
  "DERIVATIVE",
];

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function countFilledCells(row: unknown[]): number {
  return row.filter((cell) => normalizeCell(cell) !== "").length;
}

function findHeaderRowIndex(rawData: unknown[][]): number {
  let maxColumns = 0;
  let headerRowIndex = 0;

  for (let i = 0; i < Math.min(15, rawData.length); i++) {
    const row = rawData[i] || [];
    const filledCells = countFilledCells(row);
    if (filledCells > maxColumns) {
      maxColumns = filledCells;
      headerRowIndex = i;
    }
  }

  if (maxColumns >= 5) {
    return headerRowIndex;
  }

  for (let i = 0; i < Math.min(10, rawData.length); i++) {
    const row = rawData[i] || [];
    const rowStr = row.map((cell) => normalizeCell(cell)).join(" ").toUpperCase();
    if (HEADER_KEYWORDS.some((keyword) => rowStr.includes(keyword))) {
      return i;
    }
  }

  return headerRowIndex;
}

export function extractHeadersFromXlsx(buffer: Buffer, fileName: string): ExtractHeadersResult {
  const matrixDetection = detectMatrixRatebook({ buffer, fileName });
  if (matrixDetection.isMatrix) {
    const matrix = parseMatrixToFlat({ buffer, fileName });
    return {
      headers: matrix.headers,
      sampleRows: matrix.sampleRows,
      headerRowIndex: matrixDetection.termRowIndex ?? 0,
      isMatrix: true,
    };
  }

  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawData = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

  if (rawData.length === 0) {
    return { headers: [], sampleRows: [], headerRowIndex: 0, isMatrix: false };
  }

  const headerRowIndex = findHeaderRowIndex(rawData);
  const headerRow = rawData[headerRowIndex] || [];
  const headers = headerRow.map((cell, index) => {
    const value = normalizeCell(cell);
    return value || `Column ${index + 1}`;
  });

  const dataStartRow = headerRowIndex + 1;
  const allData = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, {
    range: dataStartRow,
    header: headers,
    defval: "",
  });

  const isValidDataRow = (row: Record<string, string | number>): boolean => {
    const values = Object.values(row);
    const filledValues = values.filter((v) => v !== null && v !== undefined && v !== "");

    if (filledValues.length < 3) return false;

    const firstVal = values[0];
    if (typeof firstVal === "number" && firstVal > 30000 && firstVal < 100000) {
      const stringValues = values.filter((v) => typeof v === "string" && v.length > 2);
      if (stringValues.length < 2) return false;
    }

    const hasTextContent = values.some(
      (v) => typeof v === "string" && v.length > 2 && !/^\d+$/.test(v)
    );

    return hasTextContent;
  };

  const validRows = allData.filter(isValidDataRow);
  const sampleRows = validRows.slice(0, 5).map((row) => {
    const strRow: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      strRow[key] = String(value ?? "");
    }
    return strRow;
  });

  return { headers, sampleRows, headerRowIndex, isMatrix: false };
}
