import fs from "node:fs/promises"
import path from "node:path"
import type { Analysis, History, Manifest, TrendSeries } from "./schemas.js"

// ==============================================================================
// Index builder
//
// After each pipeline run, we update four index files that the site consumes:
//   - latest.json    — copy of the most recent analysis (default view)
//   - manifest.json  — list of all runs with metadata
//   - history.json   — lightweight summaries for sparkline charts
//   - tech-trends.json / role-trends.json — per-item counts over time
// ==============================================================================

const INDEXES_DIR = path.resolve("indexes")

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n")
}

// ==============================================================================
// latest.json — just a copy of the current analysis
// ==============================================================================

async function updateLatest(analysis: Analysis): Promise<void> {
  await writeJSON(path.join(INDEXES_DIR, "latest.json"), analysis)
  console.log("  Updated latest.json")
}

// ==============================================================================
// manifest.json — append-only list of all runs
// ==============================================================================

async function updateManifest(analysis: Analysis, threadTitle: string | null): Promise<void> {
  const filePath = path.join(INDEXES_DIR, "manifest.json")
  const existing = await readJSON<Manifest>(filePath)

  // Determine run type from run_id suffix (e.g. "2026-03-01-main" → "main")
  const typeSuffix = analysis.run_id.split("-").pop()
  const runType = typeSuffix === "refresh" ? "refresh" : "main"

  const newRun = {
    run_id: analysis.run_id,
    date: analysis.date,
    type: runType as "main" | "refresh",
    job_count: analysis.job_count,
    thread_title: threadTitle,
  }

  const runs = existing?.runs ?? []

  // Replace if this run_id already exists (re-run), otherwise append
  const existingIndex = runs.findIndex((r) => r.run_id === analysis.run_id)
  if (existingIndex >= 0) {
    runs[existingIndex] = newRun
  } else {
    runs.push(newRun)
  }

  // Sort by date descending so latest is first
  runs.sort((a, b) => b.date.localeCompare(a.date))

  const manifest: Manifest = {
    schema_version: "1.0",
    runs,
    latest_run_id: analysis.run_id,
    updated_at: new Date().toISOString(),
  }

  await writeJSON(filePath, manifest)
  console.log("  Updated manifest.json")
}

// ==============================================================================
// history.json — lightweight summaries for trend sparklines
// ==============================================================================

async function updateHistory(analysis: Analysis): Promise<void> {
  const filePath = path.join(INDEXES_DIR, "history.json")
  const existing = await readJSON<History>(filePath)
  const runs = existing?.runs ?? []

  const topN = (items: Array<{ name: string; count: number }>, n: number) =>
    items
      .slice(0, n)
      .map((t) => t.name)

  const newRun = {
    date: analysis.date,
    job_count: analysis.job_count,
    top_techs: topN(analysis.technologies, 5),
    top_roles: topN(analysis.roles, 5),
    remote_pct: analysis.remote.fully_remote.pct,
    salary_mentioned_pct: analysis.compensation.salary_mentioned_pct,
    ai_ml_mentioned_pct: analysis.ai_ml_mentioned_pct,
  }

  // Replace if this date already exists (refresh run updates the same month)
  const existingIndex = runs.findIndex((r) => r.date === analysis.date)
  if (existingIndex >= 0) {
    runs[existingIndex] = newRun
  } else {
    runs.push(newRun)
  }

  runs.sort((a, b) => a.date.localeCompare(b.date))

  const history: History = {
    schema_version: "1.0",
    runs,
  }

  await writeJSON(filePath, history)
  console.log("  Updated history.json")
}

// ==============================================================================
// tech-trends.json / role-trends.json — per-item time series
// ==============================================================================

async function updateTrendSeries(
  fileName: string,
  items: Array<{ name: string; count: number; pct: number }>,
  date: string,
): Promise<void> {
  const filePath = path.join(INDEXES_DIR, fileName)
  const existing = await readJSON<TrendSeries>(filePath)
  const series = existing?.series ?? {}

  for (const item of items) {
    if (!series[item.name]) {
      series[item.name] = []
    }

    const points = series[item.name]
    const dataPoint = { date, count: item.count, pct: item.pct }

    // Replace if this date already exists, otherwise append
    const existingIndex = points.findIndex((p) => p.date === date)
    if (existingIndex >= 0) {
      points[existingIndex] = dataPoint
    } else {
      points.push(dataPoint)
    }

    // Keep sorted chronologically
    points.sort((a, b) => a.date.localeCompare(b.date))
  }

  const trendSeries: TrendSeries = {
    schema_version: "1.0",
    updated_at: new Date().toISOString(),
    series,
  }

  await writeJSON(filePath, trendSeries)
  console.log(`  Updated ${fileName}`)
}

// ==============================================================================
// Public API — called by the orchestrator after analysis completes
// ==============================================================================

export async function updateIndexes(
  analysis: Analysis,
  threadTitle: string | null,
): Promise<void> {
  console.log("Updating indexes...")

  await Promise.all([
    updateLatest(analysis),
    updateManifest(analysis, threadTitle),
    updateHistory(analysis),
    updateTrendSeries("tech-trends.json", analysis.technologies, analysis.date),
    updateTrendSeries("role-trends.json", analysis.roles, analysis.date),
  ])

  console.log("Indexes updated successfully")
}
