import path from "node:path"
import { fetchAllJobs } from "./fetch.js"
import { analyzeJobs } from "./analyze.js"
import { updateIndexes } from "./index.js"
import { readJSON, writeJSON } from "./utils.js"
import type { ClassifiedData, RawData } from "./schemas.js"

// ==============================================================================
// Backfill — fetch and analyze a specific past month's data.
//
// Usage: pnpm backfill 2026-01
//        pnpm backfill 2026-02
//
// Fetches the "Who is Hiring?" thread for that month via Algolia, runs the
// LLM analysis, and updates indexes. The date is set to the 1st of the month.
// ==============================================================================

async function main(): Promise<void> {
  const monthArg = process.argv[2]
  if (!monthArg || !/^\d{4}-\d{2}$/.test(monthArg)) {
    console.error("Usage: pnpm backfill YYYY-MM  (e.g. pnpm backfill 2026-01)")
    process.exit(1)
  }

  const [yearStr, monthStr] = monthArg.split("-")
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

  if (month < 1 || month > 12) {
    console.error(`Invalid month: ${month}. Must be between 1 and 12.`)
    process.exit(1)
  }

  const date = `${monthArg}-01`
  const runId = `${date}-backfill`
  const runDir = path.resolve("runs", date)

  // Override the date used by fetchAllJobs — we need to search for the
  // specific month's thread, not the current month. We do this by temporarily
  // setting the system date context via environment variable.
  process.env.BACKFILL_MONTH = new Date(year, month - 1, 2).toLocaleString("en-US", { month: "long" })
  process.env.BACKFILL_YEAR = String(year)

  console.log(`\n📦 Backfilling ${monthArg} (${process.env.BACKFILL_MONTH} ${year})...\n`)

  // Reuse existing raw.json if available (avoids re-fetching from HN)
  let raw: RawData
  const rawPath = path.join(runDir, "raw.json")
  try {
    raw = await readJSON<RawData>(rawPath)
    console.log(`  Reusing existing runs/${date}/raw.json (${raw.total_jobs} jobs)\n`)
  } catch {
    raw = await fetchAllJobs(runId, date)
    await writeJSON(rawPath, raw)
    console.log(`  Wrote ${raw.total_jobs} jobs to runs/${date}/raw.json\n`)
  }

  if (raw.total_jobs === 0) {
    console.warn("⚠ No jobs found for this month — skipping analysis.")
    process.exit(0)
  }

  const { analysis, classifiedJobs } = await analyzeJobs(raw)
  await writeJSON(path.join(runDir, "analysis.json"), analysis)
  console.log(`  Wrote analysis to runs/${date}/analysis.json`)

  const classifiedData: ClassifiedData = {
    schema_version: "1.0",
    date,
    run_id: runId,
    jobs: classifiedJobs,
    classified_at: new Date().toISOString(),
  }
  await writeJSON(path.join(runDir, "classified.json"), classifiedData)
  console.log(`  Wrote ${classifiedJobs.length} classified jobs to runs/${date}/classified.json\n`)

  await updateIndexes(analysis, raw.sources.who_is_hiring_thread_title)

  console.log(`\n✅ Backfill complete: ${runId}\n`)
}

main().catch((err) => {
  console.error("\n❌ Backfill failed:", err)
  process.exit(1)
})
