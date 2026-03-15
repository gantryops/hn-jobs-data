import fs from "node:fs/promises"
import path from "node:path"
import { updateIndexes } from "./index.js"
import { readJSON } from "./utils.js"
import type { Analysis, RawData } from "./schemas.js"

// ==============================================================================
// Index only — rebuilds all index files from existing run data.
//
// Usage: pnpm index
//
// Scans runs/ for all analysis.json files, rebuilds manifest, history,
// tech-trends, role-trends, and latest.json from scratch. No API calls.
// Useful after backfills or when indexes get out of sync.
// ==============================================================================

async function main(): Promise<void> {
  const runsDir = path.resolve("runs")
  const entries = await fs.readdir(runsDir)

  // Find all runs that have an analysis.json
  const runs: Array<{ date: string; analysis: Analysis; threadTitle: string | null }> = []

  for (const entry of entries.sort()) {
    const analysisPath = path.join(runsDir, entry, "analysis.json")
    const rawPath = path.join(runsDir, entry, "raw.json")

    try {
      const analysis = await readJSON<Analysis>(analysisPath)
      let threadTitle: string | null = null
      try {
        const raw = await readJSON<RawData>(rawPath)
        threadTitle = raw.sources.who_is_hiring_thread_title
      } catch {
        // raw.json might not exist for old runs
      }
      runs.push({ date: entry, analysis, threadTitle })
    } catch {
      // No analysis.json for this run — skip
      continue
    }
  }

  if (runs.length === 0) {
    console.error("No analysis files found in runs/")
    process.exit(1)
  }

  console.log(`\nRebuilding indexes from ${runs.length} runs...\n`)

  // Clear indexes and rebuild from each run in chronological order
  const indexesDir = path.resolve("indexes")
  await fs.rm(indexesDir, { recursive: true, force: true })

  for (const run of runs) {
    console.log(`  Processing ${run.date}...`)
    await updateIndexes(run.analysis, run.threadTitle)
  }

  console.log(`\n✅ Indexes rebuilt from ${runs.length} runs\n`)
}

main().catch((err) => {
  console.error("\n❌ Index rebuild failed:", err)
  process.exit(1)
})
