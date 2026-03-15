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
  url?: string
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
// Most only have a title + URL, so we fetch the linked page and extract
// text content to give the LLM something meaningful to classify.
// ==============================================================================

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "hn-jobs-data/1.0 (https://github.com/gantryops/hn-jobs-data)" },
    })
    if (!res.ok) return ""
    const html = await res.text()

    // Extract text from HTML — strip tags, scripts, styles. Simple regex
    // approach is good enough for job pages. We don't need perfect parsing,
    // just enough text for the LLM to identify technologies and roles.
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()

    // Cap at ~2000 chars — enough for classification, avoids huge payloads
    return cleaned.slice(0, 2000)
  } catch {
    return ""
  }
}

async function fetchDirectJobs(): Promise<RawJob[]> {
  const ids = await fetchJSON<number[]>(`${HN_API}/jobstories.json`)
  console.log(`  Found ${ids.length} direct job stories`)

  const BATCH_SIZE = 10
  const jobs: RawJob[] = []

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const items = await Promise.all(
      batch.map((id) => fetchJSON<HNItem>(`${HN_API}/item/${id}.json`)),
    )

    // Fetch linked pages in parallel for items that only have a title
    const enriched = await Promise.all(
      items.map(async (item) => {
        if (item.deleted || item.dead) return null

        let text = item.text || ""

        // If no text body but has a URL, fetch the page for context
        if (!text && item.url) {
          const pageText = await fetchPageText(item.url)
          // Combine title + extracted page text
          text = `${item.title || ""}\n\n${pageText}`.trim()
        }

        if (!text) text = item.title || ""
        if (!text) return null

        return {
          id: item.id,
          source: "direct" as const,
          by: item.by ?? "unknown",
          time: item.time ?? 0,
          text,
        }
      }),
    )

    for (const job of enriched) {
      if (job) jobs.push(job)
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

  // Parse the target month for filtering direct jobs by timestamp
  const targetYear = parseInt(date.slice(0, 4), 10)
  const targetMonth = parseInt(date.slice(5, 7), 10)
  const monthStart = new Date(targetYear, targetMonth - 1, 1).getTime() / 1000
  const monthEnd = new Date(targetYear, targetMonth, 1).getTime() / 1000

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

  // Filter direct jobs to only include ones posted within the target month
  const filteredDirect = directJobs.filter((j) => j.time >= monthStart && j.time < monthEnd)
  if (filteredDirect.length < directJobs.length) {
    console.log(`  Filtered direct jobs: ${filteredDirect.length} in target month (${directJobs.length - filteredDirect.length} outside range)`)
  }

  // Deduplicate by ID — thread posts take priority since they have richer text
  const seen = new Set<number>()
  const allJobs: RawJob[] = []

  for (const job of thread.jobs) {
    seen.add(job.id)
    allJobs.push(job)
  }
  for (const job of filteredDirect) {
    if (!seen.has(job.id)) {
      allJobs.push(job)
    }
  }

  console.log(`  Total: ${allJobs.length} unique jobs (${thread.jobs.length} thread + ${filteredDirect.length} direct, ${thread.jobs.length + filteredDirect.length - allJobs.length} dupes removed)`)

  const raw: RawData = {
    schema_version: "1.0",
    date,
    run_id: runId,
    sources: {
      who_is_hiring_thread_id: thread.info?.id ?? null,
      who_is_hiring_thread_title: thread.info?.title ?? null,
      direct_jobstories_count: filteredDirect.length,
    },
    jobs: allJobs,
    fetched_at: new Date().toISOString(),
    total_jobs: allJobs.length,
  }

  return raw
}
