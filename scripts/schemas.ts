import * as z from "zod/v4"

// ==============================================================================
// Shared primitives
// ==============================================================================

const dateStringSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/)
const isoTimestampSchema = z.string().trim().datetime()
const pctSchema = z.number().min(0).max(100)
const countPctSchema = z.object({ count: z.int().min(0), pct: pctSchema })

// ==============================================================================
// raw.json — fetched job data before LLM analysis
// ==============================================================================

export const RawJobSchema = z.object({
  id: z.int(),
  source: z.enum(["who_is_hiring", "direct"]),
  by: z.string().trim(),
  time: z.int(),
  text: z.string().trim(),
})

export const RawDataSchema = z.object({
  schema_version: z.literal("1.0"),
  date: dateStringSchema,
  run_id: z.string().trim(),
  sources: z.object({
    who_is_hiring_thread_id: z.int().nullable(),
    who_is_hiring_thread_title: z.string().trim().nullable(),
    direct_jobstories_count: z.int(),
  }),
  jobs: z.array(RawJobSchema),
  fetched_at: isoTimestampSchema,
  total_jobs: z.int(),
})

// ==============================================================================
// analysis.json — LLM-generated structured summary
// ==============================================================================

const NamedCountSchema = z.object({
  name: z.string().trim(),
  count: z.int().min(0),
  pct: pctSchema,
})

const SalaryBandSchema = z.object({
  band: z.string().trim(),
  count: z.int().min(0),
})

const ExperienceLevelSchema = z.object({
  level: z.enum(["Senior", "Mid", "Junior", "Not specified"]),
  count: z.int().min(0),
  pct: pctSchema,
})

// Per-batch LLM response — counts only, no percentages. We compute pct ourselves
// after aggregating across all batches. This keeps the LLM task simple (classify
// and count) and avoids trusting LLM math.
const BatchNamedCountSchema = z.object({
  name: z.string().trim(),
  count: z.int().min(0),
})

const BatchExperienceLevelSchema = z.object({
  level: z.enum(["Senior", "Mid", "Junior", "Not specified"]),
  count: z.int().min(0),
})

// Per-job classification returned by the LLM inside each batch response.
// These sit alongside the aggregate counts so we get both summary stats AND
// granular per-job data in a single API call.
const BatchClassifiedJobSchema = z.object({
  id: z.int(),
  technologies: z.array(z.string().trim()),
  role: z.string().trim(),
  experience_level: z.enum(["Senior", "Mid", "Junior", "Not specified"]),
  remote: z.enum(["fully_remote", "hybrid", "onsite_only", "not_mentioned"]),
  salary_mentioned: z.boolean(),
  salary_band: z.string().trim().nullable(),
  equity_mentioned: z.boolean(),
  ai_ml_mentioned: z.boolean(),
})

export const BatchResponseSchema = z.object({
  technologies: z.array(BatchNamedCountSchema),
  roles: z.array(BatchNamedCountSchema),
  compensation: z.object({
    salary_mentioned_count: z.int().min(0),
    ranges: z.array(SalaryBandSchema),
    equity_mentioned_count: z.int().min(0),
  }),
  remote: z.object({
    fully_remote: z.int().min(0),
    hybrid: z.int().min(0),
    onsite_only: z.int().min(0),
    not_mentioned: z.int().min(0),
  }),
  experience_levels: z.array(BatchExperienceLevelSchema),
  ai_ml_mentioned_count: z.int().min(0),
  jobs: z.array(BatchClassifiedJobSchema),
})

// The full analysis shape written to disk (with metadata and computed percentages)
export const AnalysisSchema = z.object({
  schema_version: z.literal("1.0"),
  date: dateStringSchema,
  run_id: z.string().trim(),
  job_count: z.int(),
  technologies: z.array(NamedCountSchema),
  roles: z.array(NamedCountSchema),
  compensation: z.object({
    salary_mentioned_count: z.int().min(0),
    salary_mentioned_pct: pctSchema,
    ranges: z.array(SalaryBandSchema),
    equity_mentioned_count: z.int().min(0),
    equity_mentioned_pct: pctSchema,
  }),
  remote: z.object({
    fully_remote: countPctSchema,
    hybrid: countPctSchema,
    onsite_only: countPctSchema,
    not_mentioned: countPctSchema,
  }),
  experience_levels: z.array(ExperienceLevelSchema),
  ai_ml_mentioned_pct: pctSchema,
  generated_at: isoTimestampSchema,
})

// ==============================================================================
// classified.json — per-job LLM classifications
// ==============================================================================

export const ClassifiedJobSchema = z.object({
  id: z.int(),
  technologies: z.array(z.string().trim()),
  role: z.string().trim(),
  experience_level: z.enum(["Senior", "Mid", "Junior", "Not specified"]),
  remote: z.enum(["fully_remote", "hybrid", "onsite_only", "not_mentioned"]),
  salary_mentioned: z.boolean(),
  salary_band: z.string().trim().nullable(),
  equity_mentioned: z.boolean(),
  ai_ml_mentioned: z.boolean(),
})

export const ClassifiedDataSchema = z.object({
  schema_version: z.literal("1.0"),
  date: z.string().trim(),
  run_id: z.string().trim(),
  jobs: z.array(ClassifiedJobSchema),
  classified_at: z.string().trim().datetime(),
})

// ==============================================================================
// Index files — manifest, history, tech/role trends
// ==============================================================================

export const ManifestRunSchema = z.object({
  run_id: z.string().trim(),
  date: dateStringSchema,
  type: z.enum(["main", "refresh"]),
  job_count: z.int(),
  thread_title: z.string().trim().nullable(),
})

export const ManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  runs: z.array(ManifestRunSchema),
  latest_run_id: z.string().trim(),
  updated_at: isoTimestampSchema,
})

export const HistoryRunSchema = z.object({
  date: dateStringSchema,
  job_count: z.int(),
  top_techs: z.array(z.string().trim()),
  top_roles: z.array(z.string().trim()),
  remote_pct: pctSchema,
  salary_mentioned_pct: pctSchema,
  ai_ml_mentioned_pct: pctSchema,
})

export const HistorySchema = z.object({
  schema_version: z.literal("1.0"),
  runs: z.array(HistoryRunSchema),
})

const TrendDataPointSchema = z.object({
  date: dateStringSchema,
  count: z.int().min(0),
  pct: pctSchema,
})

export const TrendSeriesSchema = z.object({
  schema_version: z.literal("1.0"),
  updated_at: isoTimestampSchema,
  series: z.record(z.string().trim(), z.array(TrendDataPointSchema)),
})

// ==============================================================================
// Inferred types
// ==============================================================================

export type RawJob = z.infer<typeof RawJobSchema>
export type RawData = z.infer<typeof RawDataSchema>
export type BatchResponse = z.infer<typeof BatchResponseSchema>
export type Analysis = z.infer<typeof AnalysisSchema>
export type ClassifiedJob = z.infer<typeof ClassifiedJobSchema>
export type ClassifiedData = z.infer<typeof ClassifiedDataSchema>
export type ManifestRun = z.infer<typeof ManifestRunSchema>
export type Manifest = z.infer<typeof ManifestSchema>
export type HistoryRun = z.infer<typeof HistoryRunSchema>
export type History = z.infer<typeof HistorySchema>
export type TrendSeries = z.infer<typeof TrendSeriesSchema>
