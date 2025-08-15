# Design: Job Parser for Google Sheets

## Goals
- Paste a job link → reliably extract **Company** + **Role**, with provenance and confidence.
- Prefer **deterministic** sources (ATS APIs, JSON-LD) over heuristics; use **LLM only as a last resort**.
- Produce **non-destructive**, human-readable audit trail in the **Source** column.
- Generate concise LinkedIn outreach notes without ever modifying extracted fields.

## Non-goals
- Full ATS catalog normalization or canonical company database.
- Browser automation from Apps Script (we offload to a separate renderer).

## Components
- **Google Sheet** with required headers.
- **Apps Script** (`Code.gs`) containing:
  - **Auto-enqueue** onEdit handler + manual “Enqueue selected rows”.
  - **Queue processors**: `processNextBatch` and `processNotesBatch`, wrapped by `drainAllQueues`.
  - **Fetch layer** with strategy:
    1. ATS APIs (Greenhouse, Lever).
    2. Direct HTML fetch.
    3. Playwright renderer (Cloud Run) **only if needed**.
    4. Aggregator unwrap → find first ATS link → re-fetch.
  - **Extraction pipeline**:
    - JSON-LD (`JobPosting.hiringOrganization.name`, `title`)
    - ATS tenant slug in URL (e.g., `jobs.lever.co/<tenant>/...`)
    - H1 → `og:title` → `<title>`
    - Optional **LLM extractor** if nothing/generic.
  - **Notes pipeline**:
    - Build snippet (canonical URL, page signals, 1k body preview, your Profile sheet).
    - Call Notes LLM (or template fallback).
    - Write **LI Invite** and **LI Follow-up**; mark `notes:{mode=llm|template}`.

## Data model
- **Queue**: `sheet_name,row_index,url,status,tries,enqueued_at,next_attempt_at,last_error`
- **NotesQueue**: `sheet_name,row_index,phase,status,enqueued_at,last_error`
- **Profile**: free-form key/value pairs used by notes (e.g., “headline”, “top skills”).

## Confidence & provenance
- Confidence weightings (approx):
  - JSON-LD org/title: **+0.5** each
  - ATS slug: **+0.35**
  - H1: **+0.35**; `og:title`: **+0.25**; `<title>`: **+0.15**
  - Clamp if missing company/role.
- `Source` cell tokens:
  - `parse:{provider=..., signals=..., conf=...}`
  - Optional `extract:{mode=llm, err?=...}`
  - `notes:{mode=llm|template}`

## Key decisions
- **No hardcoded domain→company map.** We rely on structured data and slugs.
- **LLM extraction only when needed**, never the first line.
- **Notes never overwrite parse fields.**

## Extensibility
- Add more ATS detections (Workday API equivalents when available).
- Teach aggregator unwrap more hosts.
- Swap LLMs via properties.
