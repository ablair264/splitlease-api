import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { extractHeadersFromXlsx } from "../src/lib/imports/extract-headers";

function buildMatrixWorkbookBuffer() {
  const rows = [
    ["CAP ID", "", "", "", "", "", "", "", "108321", "", "", "OTR", "25000"],
    ["Hyundai", "Tucson", "(2024)", "", "BCH RATES ADD VAT FOR PCH", "", "", "", "BASE RENTALS"],
    ["", "1+23", "1+35", "1+47"],
    ["5k - Non Maintained", "£344.90", "£292.07", "£292.71"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const buffer = buildMatrixWorkbookBuffer();
const result = extractHeadersFromXlsx(buffer, "matrix.xlsx");
assert.ok(result.headers.includes("1+23"));
assert.ok(result.headers.includes("Mileage"));

console.log("extract-headers-matrix.test.ts passed");
