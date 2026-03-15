import path from "node:path"
import { fetchAllJobs } from "./fetch.js"
import { getRunMetadata, writeJSON } from "./utils.js"

// ==============================================================================
// Fetch only — download raw job data from HN without running analysis.
//
// Usage: pnpm fetch
//
// Writes to runs/{date}/raw.json. Inspect the output, then run `pnpm analyze`
// when ready to send it through the LLM.
// ==============================================================================

async function main(): Promise<void> {
  const { runId, date, runDir } = getRunMetadata()

  console.log(`\n📥 Fetching jobs for ${runId}...\n`)

  const raw = await fetchAllJobs(runId, date)
  await writeJSON(path.join(runDir, "raw.json"), raw)

  console.log(`\n✅ Wrote ${raw.total_jobs} jobs to runs/${date}/raw.json`)
  console.log(`   Inspect the data, then run: pnpm analyze\n`)
}

main().catch((err) => {
  console.error("\n❌ Fetch failed:", err)
  process.exit(1)
})
