import * as z from "zod/v4"
import { BatchResponseSchema, type Analysis, type BatchResponse, type ClassifiedJob, type RawData, type RawJob } from "./schemas.js"

// ==============================================================================
// OpenRouter API
// ==============================================================================

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
const DEFAULT_MODEL = "google/gemini-3.1-flash-lite-preview"
const MODEL = process.env.MODEL ?? DEFAULT_MODEL
const MAX_CONCURRENT = 5

// Configurable batch size — smaller batches = better accuracy + lower latency,
// but more API calls. 10 is a good default for ~200 job postings.
const JOBS_PER_BATCH = parseInt(process.env.JOBS_PER_BATCH ?? "10", 10)

// The prompt focuses on classification rules only — output format is enforced
// via structured output (response_format), not prompt instructions.
const SYSTEM_PROMPT = `You are a data analyst specializing in tech job market trends.

You will be given a batch of job postings from Hacker News. Each job has a numeric ID.
Your task is to:
1. Classify each individual job and return a "jobs" array with per-job data.
2. Return aggregate counts summarising the batch.

Both are required in every response.

## Technology Taxonomy

Only use the following technology names. Map all variants to the canonical name.
Do not invent new entries. If a technology is not in this list, skip it.

Languages:     TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Swift, C++, C#, Ruby, PHP, Scala, Elixir
Frontend:      React, Next.js, Vue, Angular, Svelte
Backend:       Node.js, Django, FastAPI, Rails, Spring, Laravel, GraphQL, gRPC
Databases:     PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch, Cassandra, SQLite
Cloud:         AWS, GCP, Azure, Cloudflare
Infra/DevOps:  Kubernetes, Docker, Terraform, GitHub Actions
Messaging:     Kafka, RabbitMQ, Pub/Sub, SQS
AI/ML:         PyTorch, TensorFlow, LangChain, OpenAI API, Hugging Face
Mobile:        iOS, Android, React Native, Flutter

## Role Taxonomy

Only use the following role names. Normalize all variants to the closest match.

Senior Software Engineer, Staff Engineer, Principal Engineer, Engineering Manager,
Full Stack Engineer, Backend Engineer, Frontend Engineer, Mobile Engineer,
ML Engineer, AI Engineer, Data Scientist, Data Engineer, DevOps / SRE,
Product Manager, Designer, Other

## Experience Level Rules

- "Senior"        = mentions "senior", "sr.", "5+ years", "7+ years", or similar
- "Mid"           = mentions "mid-level", "3+ years", "3-5 years"
- "Junior"        = mentions "junior", "jr.", "new grad", "0-2 years", "entry level"
- "Not specified" = no clear indication

## Compensation Rules

- Count a job as "salary mentioned" only if a dollar figure or range appears
- Use these salary bands: <$100k, $100k-$150k, $150k-$200k, $200k+
- salary_band should be null when salary_mentioned is false
- Count equity as mentioned only if "equity", "options", "RSUs", or "stock" appears

## Remote Rules

- "fully_remote"   = explicitly states remote with no location requirement
- "hybrid"         = mentions hybrid, partial remote, or specific days in-office
- "onsite_only"    = requires specific location with no remote option stated
- "not_mentioned"  = no work arrangement information

## Per-job classification ("jobs" array)

For each job posting, return an object with:
- id: the numeric HN item ID provided in the input
- technologies: array of canonical technology names found in this job
- role: single closest role from the taxonomy
- experience_level: one of "Senior", "Mid", "Junior", "Not specified"
- remote: one of "fully_remote", "hybrid", "onsite_only", "not_mentioned"
- salary_mentioned: boolean
- salary_band: salary band string if salary_mentioned is true, null otherwise
- equity_mentioned: boolean
- ai_ml_mentioned: boolean (any mention of AI, ML, LLM, or related terms)

## Important

- Only return counts in the aggregate section — do NOT compute percentages
- Sort arrays by count descending
- Only include items with count > 0 in the aggregate section
- The "jobs" array must contain one entry per input job, using the provided ID`

// Convert the Zod schema to JSON Schema once — passed to OpenRouter as structured
// output so the model is constrained to return valid JSON matching our schema.
const batchJsonSchema = z.toJSONSchema(BatchResponseSchema)

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

// ==============================================================================
// Single batch API call with retry
// ==============================================================================

async function callOpenRouter(jobs: RawJob[]): Promise<BatchResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY environment variable is not set")

  const jobTexts = jobs.map((job) => `--- Job ID: ${job.id} ---\n${job.text}`).join("\n\n")
  const userMessage = `Here are ${jobs.length} job postings. Classify each one individually (using the provided ID) and return both per-job classifications and aggregate counts.\n\n${jobTexts}`

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) console.log(`    Retrying batch...`)

      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          // Structured output — model is constrained to return valid JSON
          // matching our BatchResponseSchema. No code fence stripping needed.
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "batch_response",
              schema: batchJsonSchema,
            },
          },
          temperature: 0,
          max_tokens: 8192,
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter API error ${res.status}: ${body}`)
      }

      const data = (await res.json()) as OpenRouterResponse
      const content = data.choices[0]?.message?.content
      if (!content) throw new Error("OpenRouter returned empty response")

      // Structured output guarantees valid JSON, but we still validate with
      // Zod as a defence-in-depth measure
      return BatchResponseSchema.parse(JSON.parse(content))
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw new Error(`Batch failed after 2 attempts: ${lastError?.message}`)
}

// ==============================================================================
// Aggregation — merge batch results and compute percentages
// ==============================================================================

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function toPct(count: number, total: number): number {
  return total === 0 ? 0 : round1((count / total) * 100)
}

function aggregateBatches(batches: BatchResponse[], totalJobs: number): Omit<Analysis, "schema_version" | "date" | "run_id" | "job_count" | "generated_at"> {
  // Merge named counts (technologies, roles) by summing counts for each name
  const techMap = new Map<string, number>()
  const roleMap = new Map<string, number>()
  const bandMap = new Map<string, number>()
  const levelMap = new Map<string, number>()

  let salaryCount = 0
  let equityCount = 0
  let remoteFullyRemote = 0
  let remoteHybrid = 0
  let remoteOnsite = 0
  let remoteNotMentioned = 0
  let aiMlCount = 0

  for (const batch of batches) {
    for (const t of batch.technologies) {
      techMap.set(t.name, (techMap.get(t.name) ?? 0) + t.count)
    }
    for (const r of batch.roles) {
      roleMap.set(r.name, (roleMap.get(r.name) ?? 0) + r.count)
    }
    for (const b of batch.compensation.ranges) {
      bandMap.set(b.band, (bandMap.get(b.band) ?? 0) + b.count)
    }
    for (const e of batch.experience_levels) {
      levelMap.set(e.level, (levelMap.get(e.level) ?? 0) + e.count)
    }

    salaryCount += batch.compensation.salary_mentioned_count
    equityCount += batch.compensation.equity_mentioned_count
    remoteFullyRemote += batch.remote.fully_remote
    remoteHybrid += batch.remote.hybrid
    remoteOnsite += batch.remote.onsite_only
    remoteNotMentioned += batch.remote.not_mentioned
    aiMlCount += batch.ai_ml_mentioned_count
  }

  // Convert maps to sorted arrays with percentages
  const mapToSorted = (map: Map<string, number>) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count, pct: toPct(count, totalJobs) }))
      .sort((a, b) => b.count - a.count)

  const levels = (["Senior", "Mid", "Junior", "Not specified"] as const)
    .map((level) => ({
      level,
      count: levelMap.get(level) ?? 0,
      pct: toPct(levelMap.get(level) ?? 0, totalJobs),
    }))
    .sort((a, b) => b.count - a.count)

  const ranges = [...bandMap.entries()]
    .map(([band, count]) => ({ band, count }))
    .sort((a, b) => b.count - a.count)

  return {
    technologies: mapToSorted(techMap),
    roles: mapToSorted(roleMap),
    compensation: {
      salary_mentioned_count: salaryCount,
      salary_mentioned_pct: toPct(salaryCount, totalJobs),
      ranges,
      equity_mentioned_count: equityCount,
      equity_mentioned_pct: toPct(equityCount, totalJobs),
    },
    remote: {
      fully_remote: { count: remoteFullyRemote, pct: toPct(remoteFullyRemote, totalJobs) },
      hybrid: { count: remoteHybrid, pct: toPct(remoteHybrid, totalJobs) },
      onsite_only: { count: remoteOnsite, pct: toPct(remoteOnsite, totalJobs) },
      not_mentioned: { count: remoteNotMentioned, pct: toPct(remoteNotMentioned, totalJobs) },
    },
    experience_levels: levels,
    ai_ml_mentioned_pct: toPct(aiMlCount, totalJobs),
  }
}

// ==============================================================================
// Main entry point — batch jobs, run in parallel, aggregate
// ==============================================================================

export interface AnalyzeResult {
  analysis: Analysis
  classifiedJobs: ClassifiedJob[]
}

export async function analyzeJobs(raw: RawData): Promise<AnalyzeResult> {
  // Split jobs into batches of JOBS_PER_BATCH
  const batches: RawJob[][] = []
  for (let i = 0; i < raw.jobs.length; i += JOBS_PER_BATCH) {
    batches.push(raw.jobs.slice(i, i + JOBS_PER_BATCH))
  }

  console.log(`Analyzing ${raw.total_jobs} jobs via OpenRouter (${MODEL})...`)
  console.log(`  ${batches.length} batches of up to ${JOBS_PER_BATCH} jobs, ${MAX_CONCURRENT} concurrent`)

  // Process batches with bounded concurrency
  const results: BatchResponse[] = []
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const chunk = batches.slice(i, i + MAX_CONCURRENT)
    const chunkResults = await Promise.all(
      chunk.map((batch, j) => {
        const batchNum = i + j + 1
        console.log(`  Batch ${batchNum}/${batches.length} (${batch.length} jobs)`)
        return callOpenRouter(batch)
      }),
    )
    results.push(...chunkResults)
  }

  // Aggregate all batch results and compute percentages
  const aggregated = aggregateBatches(results, raw.total_jobs)

  // Collect per-job classifications from all batches
  const classifiedJobs: ClassifiedJob[] = results.flatMap((batch) => batch.jobs)

  console.log(`  Analysis complete: ${aggregated.technologies.length} technologies, ${aggregated.roles.length} roles, ${classifiedJobs.length} jobs classified`)

  const analysis: Analysis = {
    schema_version: "1.0",
    date: raw.date,
    run_id: raw.run_id,
    job_count: raw.total_jobs,
    ...aggregated,
    generated_at: new Date().toISOString(),
  }

  return { analysis, classifiedJobs }
}
