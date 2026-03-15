# hn-jobs-data

Data pipeline that fetches job postings from Hacker News, analyzes them with an LLM, and publishes structured JSON via GitHub Pages.

Runs automatically on the 3rd and 28th of each month via GitHub Actions.

## How it works

```
HN APIs → fetch.ts → raw.json → analyze.ts → analysis.json → index.ts → index files
                                      ↓
                              OpenRouter (Gemini Flash Lite)
```

1. **Fetch** — pulls jobs from two HN sources:
   - The monthly "Who is Hiring?" thread (via Algolia search)
   - Direct job posts (`/v0/jobstories`)
2. **Analyze** — sends all job texts to Gemini Flash Lite via OpenRouter in batched parallel calls (10 jobs per batch). Extracts technologies, roles, compensation, remote policy, and experience levels into a fixed taxonomy. Validates output with Zod.
3. **Index** — updates `latest.json`, `manifest.json`, `history.json`, `tech-trends.json`, and `role-trends.json` for consumption by [hn-jobs-site](https://github.com/gantryops/hn-jobs-site).

## Output

JSON files are served via GitHub Pages at:

```
https://data.hn-job-trends.gantryops.dev/indexes/latest.json
https://data.hn-job-trends.gantryops.dev/indexes/manifest.json
https://data.hn-job-trends.gantryops.dev/indexes/history.json
https://data.hn-job-trends.gantryops.dev/indexes/tech-trends.json
https://data.hn-job-trends.gantryops.dev/indexes/role-trends.json
```

## Run manually

```bash
pnpm install
OPENROUTER_API_KEY=your_key pnpm pipeline
```

## Cost

~$0.01 per run (~100k input tokens at $0.10/M). Two runs per month = ~$0.26/year.

## Stack

- **Node.js 22** + **TypeScript** + **tsx**
- **Zod** for schema validation
- **pnpm** for package management
- **GitHub Actions** for scheduling
- **GitHub Pages** for serving JSON

## License

MIT

---

Built by [GantryOps](https://gantryops.dev). Need help with your infrastructure? [Start with an audit.](https://gantryops.dev/#pricing)
