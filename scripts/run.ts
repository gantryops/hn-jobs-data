import fs from "node:fs/promises"
import path from "node:path"
import { fetchAllJobs } from "./fetch.js"
import { analyzeJobs } from "./analyze.js"
import { updateIndexes } from "./index.js"
import { getRunMetadata, readJSON, writeJSON } from "./utils.js"
import type { Analysis, ClassifiedData, RawData } from "./schemas.js"

// ==============================================================================
// Pipeline orchestrator
//
// Runs the full pipeline: fetch → analyze → index.
//
// Skips steps that have already completed for this run:
//   - raw.json exists    → skip fetch
//   - analysis.json exists → skip analysis
//
// Use `pnpm analyze` to force re-analysis, or delete analysis.json manually.
// ==============================================================================

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const { runId, date, runDir } = getRunMetadata()
  const rawPath = path.join(runDir, "raw.json")
  const analysisPath = path.join(runDir, "analysis.json")
  const classifiedPath = path.join(runDir, "classified.json")

  console.log(`\n🚀 Pipeline run: ${runId}\n`)

  // ── Step 1: Fetch (or reuse existing raw.json) ─────────────────────────────
  let raw: RawData
  try {
    raw = await readJSON<RawData>(rawPath)
    console.log(`  Reusing existing runs/${date}/raw.json (${raw.total_jobs} jobs)\n`)
  } catch {
    raw = await fetchAllJobs(runId, date)

    if (raw.total_jobs === 0) {
      console.warn("⚠ No jobs fetched — skipping analysis. Previous data remains intact.")
      process.exit(0)
    }

    await writeJSON(rawPath, raw)
    console.log(`  Wrote ${raw.total_jobs} jobs to runs/${date}/raw.json\n`)
  }

  // ── Step 2: Analyze (skip if analysis.json already exists) ─────────────────
  let analysis: Analysis
  if (await fileExists(analysisPath)) {
    console.log(`  Analysis already exists at runs/${date}/analysis.json — skipping.`)
    console.log(`  To re-run: delete analysis.json or use \`pnpm analyze\`\n`)
    analysis = await readJSON<Analysis>(analysisPath)
  } else {
    const result = await analyzeJobs(raw)
    analysis = result.analysis
    await writeJSON(analysisPath, analysis)
    console.log(`  Wrote analysis to runs/${date}/analysis.json`)

    const classifiedData: ClassifiedData = {
      schema_version: "1.0",
      date: raw.date,
      run_id: raw.run_id,
      jobs: result.classifiedJobs,
      classified_at: new Date().toISOString(),
    }
    await writeJSON(classifiedPath, classifiedData)
    console.log(`  Wrote ${result.classifiedJobs.length} classified jobs to runs/${date}/classified.json\n`)
  }

  // ── Step 3: Update indexes ─────────────────────────────────────────────────
  await updateIndexes(analysis, raw.sources.who_is_hiring_thread_title)

  console.log(`\n✅ Pipeline complete: ${runId}\n`)
}

main().catch((err) => {
  console.error("\n❌ Pipeline failed:", err)
  process.exit(1)
})
