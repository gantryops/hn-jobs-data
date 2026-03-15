import type { RawData, RawJob } from "./schemas.js"

// ==============================================================================
// HN API clients
// ==============================================================================

const HN_API = "https://hacker-news.firebaseio.com/v0"
const ALGOLIA_API = "https://hn.algolia.com/api/v1"

// Generous timeout — HN's Firebase API can be slow under load
const FETCH_TIMEOUT = 15_000

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json() as Promise<T>
}

// ==============================================================================
// HN item types — just enough structure to extract what we need
// ==============================================================================

interface HNItem {
  id: number
  type?: string
  by?: string
  time?: number
  text?: string
  title?: string
  kids?: number[]
  parent?: number
  deleted?: boolean
  dead?: boolean
}

interface AlgoliaHit {
  objectID: string
  title: string
}

interface AlgoliaResult {
  hits: AlgoliaHit[]
}

// ==============================================================================
// Source 1: "Who is Hiring?" monthly thread
//
// The thread is posted on the first weekday of each month by the "whoishiring"
// account. We find it via Algolia search, then fetch all top-level comments
// (each comment = one job posting).
// ==============================================================================

interface ThreadInfo {
  id: number
  title: string
}

async function findWhoIsHiringThread(): Promise<ThreadInfo | null> {
  // BACKFILL_MONTH/BACKFILL_YEAR are set by the backfill script to search
  // for a specific past month's thread instead of the current one.
  const monthName = process.env.BACKFILL_MONTH ?? new Date().toLocaleString("en-US", { month: "long" })
  const year = process.env.BACKFILL_YEAR ?? String(new Date().getFullYear())
  const query = `Ask HN Who is hiring ${monthName} ${year}`

  const result = await fetchJSON<AlgoliaResult>(
    `${ALGOLIA_API}/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=3`,
  )

  // Match the exact "Who is hiring?" thread — Algolia sometimes returns
  // "Who wants to be hired?" or "Freelancer?" threads too
  const hit = result.hits.find((h) => /who is hiring/i.test(h.title))
  if (!hit) return null

  return { id: parseInt(hit.objectID, 10), title: hit.title }
}

async function fetchThreadJobs(threadId: number): Promise<RawJob[]> {
  const thread = await fetchJSON<HNItem>(`${HN_API}/item/${threadId}.json`)
  const commentIds = thread.kids ?? []

  console.log(`  Found ${commentIds.length} top-level comments in thread`)

  // Fetch comments in parallel, batched to avoid overwhelming the API
  const BATCH_SIZE = 20
  const jobs: RawJob[] = []

  for (let i = 0; i < commentIds.length; i += BATCH_SIZE) {
    const batch = commentIds.slice(i, i + BATCH_SIZE)
    const comments = await Promise.all(
      batch.map((id) => fetchJSON<HNItem>(`${HN_API}/item/${id}.json`)),
    )

    for (const comment of comments) {
      // Skip deleted/dead comments and replies (we only want top-level job posts)
      if (comment.deleted || comment.dead || !comment.text) continue

      jobs.push({
        id: comment.id,
        source: "who_is_hiring",
        by: comment.by ?? "unknown",
        time: comment.time ?? 0,
        text: comment.text,
      })
    }
  }

  return jobs
}

// ==============================================================================
// Source 2: Direct job posts (/v0/jobstories)
//
// Companies (mostly YC-backed) post jobs directly to HN. These appear
// in the "jobs" section and are separate from the monthly thread.
// ==============================================================================

async function fetchDirectJobs(): Promise<RawJob[]> {
  const ids = await fetchJSON<number[]>(`${HN_API}/jobstories.json`)
  console.log(`  Found ${ids.length} direct job stories`)

  const BATCH_SIZE = 20
  const jobs: RawJob[] = []

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const items = await Promise.all(
      batch.map((id) => fetchJSON<HNItem>(`${HN_API}/item/${id}.json`)),
    )

    for (const item of items) {
      if (item.deleted || item.dead) continue

      // Direct job posts use `title` instead of `text` — some have both
      const text = item.text || item.title || ""
      if (!text) continue

      jobs.push({
        id: item.id,
        source: "direct",
        by: item.by ?? "unknown",
        time: item.time ?? 0,
        text,
      })
    }
  }

  return jobs
}

// ==============================================================================
// Main fetch orchestrator
//
// Fetches from both sources, deduplicates by ID (in case a company posts in
// both the thread and as a direct job story), and returns the combined result.
// ==============================================================================

export async function fetchAllJobs(runId: string, date: string): Promise<RawData> {
  console.log("Fetching HN jobs...")

  // Fetch both sources concurrently
  const [thread, directJobs] = await Promise.all([
    findWhoIsHiringThread().then(async (info) => {
      if (!info) {
        console.warn("  ⚠ 'Who is Hiring?' thread not found — using direct jobs only")
        return { info: null, jobs: [] as RawJob[] }
      }
      console.log(`  Found thread: "${info.title}" (id: ${info.id})`)
      const jobs = await fetchThreadJobs(info.id)
      return { info, jobs }
    }),
    fetchDirectJobs(),
  ])

  // Deduplicate by ID — thread posts take priority since they have richer text
  const seen = new Set<number>()
  const allJobs: RawJob[] = []

  for (const job of thread.jobs) {
    seen.add(job.id)
    allJobs.push(job)
  }
  for (const job of directJobs) {
    if (!seen.has(job.id)) {
      allJobs.push(job)
    }
  }

  console.log(`  Total: ${allJobs.length} unique jobs (${thread.jobs.length} thread + ${directJobs.length} direct, ${thread.jobs.length + directJobs.length - allJobs.length} dupes removed)`)

  const raw: RawData = {
    schema_version: "1.0",
    date,
    run_id: runId,
    sources: {
      who_is_hiring_thread_id: thread.info?.id ?? null,
      who_is_hiring_thread_title: thread.info?.title ?? null,
      direct_jobstories_count: directJobs.length,
    },
    jobs: allJobs,
    fetched_at: new Date().toISOString(),
    total_jobs: allJobs.length,
  }

  return raw
}
