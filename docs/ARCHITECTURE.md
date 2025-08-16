
# Architecture & Design — *joblink-etl*

> **Goal:** Paste any job link into Google Sheets and get back **Company**, **Role**, **Canonical URL**, and recruiter-ready **LinkedIn notes** — with a clear, human‑readable **Source** trail that explains exactly how each value was produced.

This document explains the moving parts, the control flow, the parsing rules, optional LLM usage, and the provenance model. It’s intentionally **text‑first** (no Mermaid), so it renders reliably on GitHub.

---

## 1) Components

**In Google Sheets**
- **Main tab(s):** Your tracker. Must include these headers (row 1):
  - `Link`, `Canonical Link`, `Company (auto)`, `Role (auto)`, `Status`, `Source`  
  - (Optional for outreach) `LI Invite`, `LI Follow-up`
- **Queue:** Work queue for parsing (`sheet_name`, `row_index`, `url`, `status`, …).
- **NotesQueue:** Work queue for outreach note generation.

**Apps Script (serverless, inside the Sheet)**
- **Triggers**
  - **onEditHandler** — when you paste into the **Link** column, enqueue a job.
  - **drainAllQueues** — time-based trigger that drains both queues in bursts.
- **Batches & rate limiting**
  - `BATCH_SIZE`, `REQUESTS_PER_MINUTE`, `NOTES_BATCH_SIZE`, `NOTES_PER_MINUTE` (Script Properties).

**Fetchers (inside Apps Script)**
- **ATS APIs** (preferred): Greenhouse, Lever.
- **Direct HTML** (cheap): fetch page; if it contains useful signals, parse.
- **Renderer (optional)**: a tiny **Playwright** service on **Cloud Run** to render JS-heavy pages (`GET /render?url=…` with an `x-renderer-key` header).

**Parsers (signal priority)**
1. **JSON‑LD JobPosting** (company + title)
2. **ATS slug in URL** (e.g., `/boards.greenhouse.io/<company>/jobs/<id>`)
3. **H1**, then **`og:title`**, then **`<title>`** (for **Role** only)
4. **`og:site_name`** → **Company** *(ignored for known aggregators)*
5. **Title-split rescue**: if title looks like `Company — Role`

**LLM (optional)**
- **Extractor** (last resort): infers missing **Company**/**Role** from a concise snippet.
- **Notes writer**: produces **LI Invite** (≤ 280 chars) and **LI Follow‑up** (280–500).  
  If unavailable or unsure, a curated **template** fallback is used.

**Provenance**
- Every step appends readable tokens to **Source**, e.g.  
  `parse:{provider=gh-api, signals=jsonld-org+h1, conf=0.90} | notes:{mode=llm}`

---

## 2) Data model (columns)

| Column            | Type    | Who writes it | Notes |
|-------------------|---------|---------------|-------|
| Link              | URL     | user          | Raw link you paste. |
| Canonical Link    | URL     | app           | Normalized URL (UTM/SRC removed; redirects collapsed). |
| Company (auto)    | string  | app           | Hiring org (never aggregator). |
| Role (auto)       | string  | app           | Clean job title (no emojis, no req IDs/locations). |
| Status            | enum    | app           | `queued` / `ok` / `error`. |
| Source            | string  | app           | Human‑readable audit trail. |
| LI Invite         | string  | app           | Short connection note. |
| LI Follow‑up      | string  | app           | Longer message after connect. |

---

## 3) Control flow (high level)

**A. Enqueue**
1. User pastes a link into **Link**.
2. `onEditHandler` checks it touched the **Link** column →
3. Adds a row to **Queue** if not already queued (`sheet_name`, `row_index`, `url`, `status=queued`).  
   Also sets `Status=queued` in the tracker.

**B. Parse batch** (`processNextBatch`)
1. Take up to `BATCH_SIZE` queued items.
2. For each item:
   - **Fetch** via `fetchSmartFree(url)`:
     1) Try **ATS APIs** (Greenhouse/Lever).  
     2) Else **Direct HTML**; if **useful signals** exist → keep.  
     3) Else try the **Renderer** (Cloud Run).  
     4) If link is an **aggregator**, attempt to **unwrap** to a first ATS link and re‑fetch.
   - **Decide** via `decideCompanyRole_(html, finalUrl)` (section 4).  
   - **Write back** `Canonical Link`, `Company (auto)`, `Role (auto)`; append a `parse:{…}` token to **Source**.
   - **Maybe enqueue notes** (if invite/follow-up cells are empty).  
   - Set `Status=ok` (or `error` with a short message).
3. Delete processed queue rows (bottom‑up).

**C. Notes batch** (`processNotesBatch`)
1. Pull from **NotesQueue**.
2. Build a **snippet**: (canonical URL, H1, OG, Title, short body preview) + **Profile** sheet.
3. Try **LLM** (if enabled) → strict JSON: `{"invite":"…","followup":"…"}`.  
   If it fails or is rate‑limited, use the **template** fallback.
4. Write **LI Invite** & **LI Follow‑up**; append `notes:{mode=llm|template}` to **Source**.
5. Delete processed queue rows.

---

## 4) Parsing rules & confidence

We combine multiple signals to balance **accuracy** and **coverage**. Confidence is additive and then clamped.

**Signals (in order)**
- **JSON‑LD JobPosting**: `company += 0.5`, `role += 0.5`
- **ATS slug in URL** (Greenhouse/Lever/Ashby/Workday/etc.): `company += 0.35`
- **Role from page text**: `h1 += 0.35` → `og:title += 0.25` → `<title> += 0.15`
- **Company from `og:site_name`** *(ignored for known aggregators)*: `+ 0.25`
- **Title‑split rescue** if it looks like `Company — Role`: split; `conf = max(conf, 0.55)`

**Cleanups**
- Strip emojis/HTML entities.
- Remove company echoes at either end of the title.
- Remove location suffixes and req IDs (`Req#`, numeric tails).
- Normalize whitespace/case.

**LLM extractor (last resort)**
- Only when **Company is empty** or **Role looks generic** (e.g., *Job details*, *Careers*).
- Inputs: canonical URL + H1/OG/Title + short body preview.
- If the LLM suggests values, we **keep your manual edits** and only **fill blanks**.
- Provenance: `extract:{mode=llm}` (or `extract:{mode=llm, err=…}` if attempted but failed).

**Confidence clamp**
- If **Company** or **Role** is still empty, overall confidence ≤ `0.5`.

---

## 5) Provenance (“Source” column)

We never overwrite your manual edits. Instead, we log **how** each value was derived, for example:

- `parse:{provider=gh-api, signals=jsonld-org+h1, conf=0.90}`
- `parse:{provider=direct-unwrapped, signals=ats-slug+title, conf=0.60}`
- `extract:{mode=llm}` *(LLM used to infer missing Company/Role)*
- `notes:{mode=llm}` or `notes:{mode=template}` *(how outreach was generated)*

Tokens are **replaced in-place by kind** (e.g., the latest `parse:{…}` replaces the previous `parse:{…}`) to keep the cell readable.

---

## 6) Idempotency & queues

- **Unique work item** is `(sheet_name, row_index)`. We ignore duplicates in the queues.
- After a batch finishes, processed rows are **deleted bottom‑up** from each queue.
- The main **Status** column reflects the last parse result; **Source** is the durable audit trail.

---

## 7) Configuration (Script Properties)

| Key | Meaning |
|-----|--------|
| `BATCH_SIZE` | Max rows per parse batch (default: `12`) |
| `REQUESTS_PER_MINUTE` | Parse batch throttle (default: `60`) |
| `NOTES_BATCH_SIZE` | Max rows per notes batch (default: `12`) |
| `NOTES_PER_MINUTE` | Notes batch throttle (default: `60`) |
| `RENDERER_URL` | Cloud Run endpoint, e.g., `https://<service>.run.app/render` |
| `RENDERER_KEY` | Shared secret header: `x-renderer-key` |
| `LLM_ENDPOINT` | Chat completions endpoint |
| `LLM_API_KEY` | Bearer token for LLM provider |
| `LLM_MODEL` | Model for **notes** (default: `llama-3.1-8b-instant`) |
| `USE_LLM` | `"1"` to enable notes LLM (default: `"1"`) |
| `EXTRACT_LLM_MODEL` | Model for **extractor** (optional) |
| `USE_EXTRACT_LLM` | `"1"` to enable extractor LLM (default: `"1"`) |

Secrets live only in **Script Properties**; no keys are stored in the sheet.

---

## 8) Failure modes

- **Renderer unavailable:** We stay on direct HTML; confidence may be lower. `Source` will show `provider=direct`.
- **ATS API miss:** We fall back to HTML parsing and/or renderer.
- **LLM rate limited:** Notes fall back to template. `Source` shows `notes:{mode=template}` and the **NotesQueue** row logs the error message.
- **Aggregator traps:** If we can’t unwrap to ATS, we parse the aggregator page (with `og:site_name` explicitly ignored).

---

## 9) Extending the system

- **Add an ATS**: update the slug detector and (if available) an API fetcher.
- **Add an aggregator**: extend the aggregator host list for better unwrap.
- **Tweak cleaning rules**: adjust `cleanRole_` for a new suffix or pattern.
- **Change priorities**: reorder signal weights if your sources differ.
- **Add columns**: the parser only writes known columns; extra columns are safe.

---

## 10) Operational tips

- Keep an eye on the **Queue**/**NotesQueue** tabs; they should drain steadily.
- The **Source** column is your friend when investigating a weird row.
- Use the provided debug helpers in Apps Script:
  - `debugRenderer()` — quick smoke test to the Cloud Run renderer.
  - `debugNotesOnce()` — run a single notes batch by hand.

---

**Summary:** *joblink‑etl* is a small, reliable ETL sitting on top of Google Sheets and Apps Script. It prefers **deterministic truth** (ATS APIs & structured markup), uses a **renderer only when needed**, and keeps **LLMs behind guardrails**. Most importantly, it’s **non‑destructive** and **auditable** — perfect for a high‑signal job search workflow.
