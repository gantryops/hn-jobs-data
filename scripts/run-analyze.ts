import path from "node:path"
import { analyzeJobs } from "./analyze.js"
import { updateIndexes } from "./index.js"
import { getRunMetadata, readJSON, writeJSON } from "./utils.js"
import type { ClassifiedData, RawData } from "./schemas.js"

// ==============================================================================
// Analyze only — reads existing raw.json and runs LLM analysis + indexing.
//
// Usage: pnpm analyze
//
// Requires raw.json to exist (run `pnpm fetch` first). This lets you iterate
// on the prompt/model without re-fetching from HN every time.
// ==============================================================================

async function main(): Promise<void> {
  const { runId, date, runDir } = getRunMetadata()
  const rawPath = path.join(runDir, "raw.json")

  let raw: RawData
  try {
    raw = await readJSON<RawData>(rawPath)
  } catch {
    console.error(`\n❌ No raw data found at runs/${date}/raw.json`)
    console.error(`   Run \`pnpm fetch\` first.\n`)
    process.exit(1)
  }

  // JOBS_LIMIT caps how many jobs get analyzed — useful for testing the prompt
  // without burning through all 363 jobs. e.g. JOBS_LIMIT=20 pnpm analyze
  const limit = parseInt(process.env.JOBS_LIMIT ?? "0", 10)
  if (limit > 0 && limit < raw.jobs.length) {
    console.log(`\n⚠ JOBS_LIMIT=${limit} — analyzing ${limit} of ${raw.total_jobs} jobs\n`)
    raw = { ...raw, jobs: raw.jobs.slice(0, limit), total_jobs: limit }
  }

  console.log(`\n🔬 Analyzing ${raw.total_jobs} jobs for ${runId}...\n`)

  const { analysis, classifiedJobs } = await analyzeJobs(raw)
  await writeJSON(path.join(runDir, "analysis.json"), analysis)
  console.log(`  Wrote analysis to runs/${date}/analysis.json`)

  const classifiedData: ClassifiedData = {
    schema_version: "1.0",
    date: raw.date,
    run_id: raw.run_id,
    jobs: classifiedJobs,
    classified_at: new Date().toISOString(),
  }
  await writeJSON(path.join(runDir, "classified.json"), classifiedData)
  console.log(`  Wrote ${classifiedJobs.length} classified jobs to runs/${date}/classified.json\n`)

  await updateIndexes(analysis, raw.sources.who_is_hiring_thread_title)

  console.log(`\n✅ Analysis complete: ${runId}\n`)
}

main().catch((err) => {
  console.error("\n❌ Analysis failed:", err)
  process.exit(1)
})
