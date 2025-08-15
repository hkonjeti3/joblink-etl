# Job Parser for Google Sheets (ATS-aware + LLM notes)

A Google Apps Script that turns a Google Sheet into a lightweight job-intake pipeline:

- **Auto-enqueue on paste:** pasting a job URL into the **Link** column queues it.
- **Robust extraction:** resolves aggregators → ATS, uses ATS APIs (Greenhouse/Lever), falls back to direct/JS-rendered HTML, then **LLM extraction** only when needed.
- **High-signal parsing:** JSON-LD → ATS slug → H1 → `og:title` → `<title>` with confidence scoring.
- **Non-destructive provenance:** writes human-readable `parse:{...}`, `extract:{...}`, `notes:{...}` tokens to **Source**.
- **Notes generation:** creates LinkedIn **Invite** and **Follow-up** messages (LLM or template), without ever overwriting the extracted **Company** and **Role**.

---

## How it works (flow)

```
Paste URL in "Link" → Queue row
   ↓
Fetch (cheap-first):
  1) ATS API (Greenhouse/Lever)
  2) Direct HTML
  3) Renderer (Playwright/Cloud Run) only if needed
  4) Aggregator → find first ATS link → re-fetch
   ↓
Extract company/role:
  - JSON-LD (JobPosting)
  - ATS slug in URL
  - H1 → og:title → <title>
  - Optional LLM extractor if empty/generic
   ↓
Write results:
  - Canonical Link, Company (auto), Role (auto)
  - Source tokens (parse/extract/notes)
  - Status = ok | error
   ↓
Notes queue:
  - Build snippet → LLM (or template) → write Invite/Follow-up
```

---

## Sheet layout (row 1 headers must match)

| Link | Canonical Link | Company (auto) | Role (auto) | Status | Source | LI Invite | LI Follow-up |
|------|-----------------|----------------|-------------|--------|--------|-----------|--------------|

> You can have additional columns (e.g., your own notes). Only these header names are required.

---

## Installation

1. **Create the Sheet** and add the headers above in row 1.
2. **Extensions → Apps Script** → paste the script from `Code.gs` (in this repo) into `Code.gs`.
3. **Save**, then **Run** ➜ `onOpen` once to grant permissions.
4. **Set Script Properties** (Project Settings → Script properties):

   | Key | Purpose | Example |
   |-----|---------|---------|
   | `RENDERER_URL` | Playwright Cloud Run endpoint | `https://<service>.run.app/render` |
   | `RENDERER_KEY` | Auth header for renderer | `abc123...` |
   | `LLM_ENDPOINT` | OpenAI-compatible chat endpoint | `https://api.your-llm.example/v1/chat/completions` |
   | `LLM_API_KEY` | Bearer token for LLM | `sk-...` |
   | `LLM_MODEL` | Notes LLM model | `llama-3.1-8b-instant` |
   | `EXTRACT_LLM_MODEL` | Extractor model (optional, else falls back to `LLM_MODEL`) | `llama-3.1-8b-instant` |
   | `USE_LLM` | 1=generate notes with LLM, 0=template only | `1` |
   | `USE_EXTRACT_LLM` | 1=allow LLM extractor for company/role, 0=off | `1` |
   | `BATCH_SIZE` | Parse batch per drain cycle | `12` |
   | `REQUESTS_PER_MINUTE` | Max fetches/min for parse | `60` |
   | `NOTES_BATCH_SIZE` | Notes batch per drain | `12` |
   | `NOTES_PER_MINUTE` | Max notes/min | `60` |

5. **Triggers**
   - A **simple trigger** `onEdit` is in the code (fires when you paste).
   - (Optional) Add an **installable** time-based trigger to run `drainAllQueues` every 1–5 minutes as a safety net.
   - (Optional) Add an **installable on edit** trigger to run `onEditHandler` (extra redundancy).

---

## Usage

- Paste a job URL into **Link** → `Status` becomes `queued` → row is processed → `Company (auto)`, `Role (auto)`, `Canonical Link`, and `Source` are filled → Notes are generated (if configured).
- To re-run a row: clear `Company (auto)` and/or `Role (auto)`, clear `Status`, paste the URL again or use **Job Parser → Enqueue selected rows**.

---

## Configuration & behavior highlights

- **No hardcoded company map.** Company names come from structured data or URL tenant slug (e.g., `boards.greenhouse.io/<tenant>/jobs/...`).
- **LLM escalation rules:**
  - Extractor LLM only runs if company is empty **or** role looks generic (e.g., “job details”, “careers”).
  - Notes LLM never overwrites Company/Role; it only writes **LI Invite** and **LI Follow-up**.
- **Readable provenance:** `Source` cell shows `parse:{...}`, `extract:{...}`, `notes:{...}` tokens for quick debugging.
- **Canonicalization:** UTM and ATS tracking params are stripped in **Canonical Link**.

---

## Troubleshooting

- **Auto-enqueue not firing on paste:** make sure you see the custom “Job Parser” menu (means script loaded). The `Link` header must exactly match. If still broken, check Triggers and execution logs.  
- **Nothing extracted:** check `Source → parse:{...}`. If `conf=0.00`, renderer escalation and/or LLM extractor will kick in next run; ensure `RENDERER_*` and `USE_EXTRACT_LLM=1`.
- **LLM 429 (rate limit):** lower `NOTES_PER_MINUTE`, `REQUESTS_PER_MINUTE`, or set `USE_LLM=0` temporarily (template notes will be used).
- **Errors in NotesQueue:** open the **NotesQueue** sheet; `last_error` column will show the last failure.

(See `docs/TROUBLESHOOTING.md` for deeper fixes.)

---

## Development

- All logic lives in a single Apps Script file `Code.gs`.
- The code is idempotent and won’t enqueue duplicates for the same `(sheet,row)` in **Queue**/**NotesQueue**.
- Contributions welcome — see `CONTRIBUTING.md`.

---

## License

MIT
