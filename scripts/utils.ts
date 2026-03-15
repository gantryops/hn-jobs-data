import fs from "node:fs/promises"
import path from "node:path"

export function getRunMetadata(): { runId: string; date: string; runDir: string } {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const dayOfMonth = now.getUTCDate()

  // The 3rd-of-month run is "main", the 28th is "refresh", manual runs use "manual"
  let type: string
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    type = "manual"
  } else if (dayOfMonth <= 14) {
    type = "main"
  } else {
    type = "refresh"
  }

  return {
    runId: `${date}-${type}`,
    date,
    runDir: path.resolve("runs", date),
  }
}

export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n")
}

export async function readJSON<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf-8")
  return JSON.parse(content) as T
}
