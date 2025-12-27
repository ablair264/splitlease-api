import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  detectMatrixRatebook,
  parseMatrixToFlat,
} from "../src/lib/imports/matrix-ratebook";

function buildMatrixWorkbookBuffer() {
  const rows = [
    ["CAP ID", "", "", "", "", "", "", "", "108321", "", "", "OTR", "25000"],
    [
      "Hyundai",
      "Tucson",
      "(2024) 1.6T 150 N Line S Manual 26ym",
      "",
      "BCH RATES ADD VAT FOR PCH",
      "",
      "",
      "",
      "BASE RENTALS",
    ],
    ["", "1+23", "1+35", "1+47", "3+23", "3+35"],
    ["5k - Non Maintained", "£344.90", "£292.07", "£292.71", "£316.56", "£275.03"],
    ["8k - Non Maintained", "£357.25", "£302.50", "£300.22", "£327.89", "£284.85"],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const buffer = buildMatrixWorkbookBuffer();
const detection = detectMatrixRatebook({ buffer, fileName: "matrix.xlsx" });
assert.equal(detection.isMatrix, true);

const parsed = parseMatrixToFlat({ buffer, fileName: "matrix.xlsx" });
assert.ok(parsed.headers.includes("1+23"));
assert.ok(parsed.headers.includes("1+35"));
assert.ok(parsed.headers.includes("Mileage"));
assert.equal(parsed.sampleRows[0]?.Mileage, "5k - Non Maintained");

console.log("matrix-ratebook.test.ts passed");
