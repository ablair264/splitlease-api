import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { extractHeadersFromXlsx } from "../src/lib/imports/extract-headers";

function buildWorkbookBuffer() {
  const rows = [
    ["Broker - CHcm5k", 45993.071],
    [
      "TERM",
      "ANNUAL_MILEAGE",
      "MANUFACTURER",
      "VEHICLE DESCRIPTION",
      "MODELYEAR",
      "P11D",
      "ENGSIZE",
      "TRANSMISSION",
      "DOORS",
      "FUEL TYPE",
      "CO2",
      "NET RENTAL WM",
      "NET RENTAL CM",
      "WLC",
      "FUEL_COST",
      "BASIC PRICE",
      "VAT",
      "OTR",
      "MRP",
      "INSURANCE GROUP",
      "ADDITIONAL RFL",
      "EURO CLASSIFICATION",
      "WIN ID",
      "CAP CODE",
      "CAP ID",
      "MPG COMBINED",
      "BODY STYLE",
      "IDS CODE",
      "Excess Mileage",
    ],
    ["40667"],
    [
      24,
      5000,
      "Alfa Romeo",
      "AL Giulia 2.0 Turbo 280hp Tributo Italiano Auto",
      "24",
      49510.01,
      1995,
      "Automatic",
      4,
      "Petrol",
      167,
      "",
      924.09,
      "",
      304.6213,
      1630.5236,
      40653.73,
      7386.36,
      45733.18,
      48784.48,
      50,
      671.6667,
      "Euro 6d-ISC",
      201234,
      "ALGU20TIL4SPTA  1",
      "C104378",
      38.2,
      "Saloon",
      "AL001439",
      11.2847,
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const buffer = buildWorkbookBuffer();
const result = extractHeadersFromXlsx(buffer, "Broker – CHcm5k - Generated 02122025.xlsx");

assert.equal(result.headers[0], "TERM");
assert.equal(result.headers[1], "ANNUAL_MILEAGE");
assert.ok(result.headers.includes("CAP CODE"));
assert.equal(result.sampleRows[0]?.MANUFACTURER, "Alfa Romeo");

console.log("extract-headers.test.ts passed");
