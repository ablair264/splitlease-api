/**
 * CLI script to import a Lex Autolease ratebook CSV directly
 * Usage: npx tsx scripts/import-lex-ratebook.ts <csv-file-path> <contract-type>
 *
 * Example:
 *   npx tsx scripts/import-lex-ratebook.ts "/path/to/ratebook.csv" CHNM
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { importLexRatebook } from "../src/lib/imports/lex-ratebook-importer.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npx tsx scripts/import-lex-ratebook.ts <csv-file-path> <contract-type>");
    console.error("Contract types: CH, CHNM, PCH, PCHNM, BSSNL");
    process.exit(1);
  }

  const [csvPath, contractType] = args;

  // Validate contract type
  const validTypes = ["CH", "CHNM", "PCH", "PCHNM", "BSSNL"];
  if (!validTypes.includes(contractType.toUpperCase())) {
    console.error(`Invalid contract type: ${contractType}`);
    console.error(`Valid types: ${validTypes.join(", ")}`);
    process.exit(1);
  }

  console.log(`\n📁 Reading CSV file: ${csvPath}`);

  let csvContent: string;
  try {
    csvContent = readFileSync(csvPath, "utf-8");
  } catch (e) {
    console.error(`Failed to read file: ${e}`);
    process.exit(1);
  }

  const lineCount = csvContent.split("\n").length;
  console.log(`📊 File contains ~${lineCount.toLocaleString()} lines`);
  console.log(`📋 Contract type: ${contractType.toUpperCase()}`);
  console.log(`\n🚀 Starting import...`);

  const startTime = Date.now();

  try {
    const result = await importLexRatebook({
      fileName: basename(csvPath),
      contractType: contractType.toUpperCase(),
      csvContent,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ Import completed in ${duration}s`);
    console.log(`   Batch ID: ${result.batchId}`);
    console.log(`   Import ID: ${result.importId}`);
    console.log(`   Total rows: ${result.totalRows.toLocaleString()}`);
    console.log(`   Success: ${result.successRows.toLocaleString()}`);
    console.log(`   Errors: ${result.errorRows.toLocaleString()}`);
    console.log(`   Unique CAP codes: ${result.uniqueCapCodes.toLocaleString()}`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️  First few errors:`);
      result.errors.slice(0, 5).forEach(e => console.log(`   - ${e}`));
    }

    if (!result.success) {
      console.log(`\n❌ Import marked as failed (too many errors)`);
      process.exit(1);
    }

  } catch (e) {
    console.error(`\n❌ Import failed: ${e}`);
    process.exit(1);
  }

  process.exit(0);
}

main();
