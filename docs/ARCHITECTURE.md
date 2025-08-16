# Architecture & Design

This document explains the moving parts: triggers, queues, parsers, renderer, LLM usage, and the provenance model.

---

## Big picture

```mermaid
flowchart TD
  U[Paste link in Sheet] -->|onEdit| Q[Queue]
  Q --> P[processNextBatch()]
  P --> F[fetchSmartFree_(url)]
  F -->|ATS API| A[Greenhouse/Lever JSON]
  F -->|Direct HTML| H[HTML signals]
  F -->|JS-heavy| R[Playwright Renderer (Cloud Run)]
  H --> D[decideCompanyRole_()]
  A --> D
  R --> D
  D --> W[Write Company/Role/Canonical]
  D --> S1[append Source: parse{...}]
  W --> NQ[NotesQueue]
  NQ --> N[processNotesBatch()]
  N --> SN[Build snippet (H1/OG/Title + preview) + Profile]
  SN -->|LLM JSON| L[Notes LLM (optional)]
  SN -->|Fallback| T[Template]
  L --> WN[Write LI Invite/Follow-up]
  T --> WN
  WN --> S2[append Source: notes{mode=llm|template}]
```

---

## Components

### 1) Triggers & Queues
- **`onEditHandler`**: fires when a user edits the sheet; if the `Link` column changed, enqueue `(sheet,row,url)` into **`Queue`** (idempotent).
- **`processNextBatch`**: drains **`Queue`**, fetches page(s), extracts fields, writes outputs, and enqueues **`NotesQueue`** if notes are needed.
- **`processNotesBatch`**: drains **`NotesQueue`**, builds a snippet + Profile, calls the **Notes LLM** (or template), writes messages.

**Idempotency**:  
- A row won’t be re-enqueued if it’s already `queued/processing`.  
- Notes won’t re-enqueue if both note columns are already filled.

### 2) Fetch strategy (`fetchSmartFree_`)
1. **ATS APIs** (Greenhouse/Lever) → authoritative, zero-render cost.  
2. **Direct fetch** → if HTML contains useful signals (JSON-LD; good H1/OG/Title).  
3. **Renderer (Cloud Run, Playwright)** → only when HTML looks thin/JS-heavy.  
4. **Aggregator unwrap** → follow the first ATS link found and refetch once.

### 3) Extraction (`decideCompanyRole_`)
- Prefer **JSON-LD** (`JobPosting.hiringOrganization.name`, `title`).
- Else **H1 → OG:title → <title>** (with a conservative cleaner to strip emojis/IDs/locations and remove company prefixes).
- If **company/role** are empty or look generic, and `USE_EXTRACT_LLM=1`, call the **Extraction LLM** with a small signal bundle. Any improvement is accepted and marked with `extract:{mode=llm}`.

### 4) Notes generation
- Build a **snippet** (H1/OG/Title + short body preview) + **Profile** sheet inputs.  
- Call the **Notes LLM** to return strict JSON:
  ```json
  { "invite": "...", "followup": "...", "meta": "llm" }
  ```
- If LLM is rate-limited or uncertain, use a **template fallback**.  
- Write **LI Invite** and **LI Follow-up**, and append `notes:{mode=llm|template}` to **Source**.

### 5) Provenance (Source)
- Human-readable tokens appended/updated in the **Source** column:
  - `parse:{provider=gh-api|direct|renderer[-unwrapped], signals=..., conf=0.85}`
  - `extract:{mode=llm, err=?}` if the rescue LLM was attempted
  - `notes:{mode=llm|template}` for outreach generation mode
- Non-destructive: never overwrites your manual edits to fields; only appends/updates tokens.

---

## Design choices

- **Deterministic before generative**: Prefer structured truth (APIs/JSON-LD) to avoid hallucination and keep results stable.
- **Renderer on demand**: Playwright only runs for JS-heavy pages, minimizing cost/latency.
- **LLM with tight IO**: Small, structured prompts; strict JSON outputs; **template fallback** ensures forward progress.
- **Queues + throttles**: `BATCH_SIZE`, `REQUESTS_PER_MINUTE`, `NOTES_*` keep the pipeline smooth under quotas.
- **Auditable by default**: The **Source** column acts as a paper trail for debugging and trust.

---

## Error handling & recovery

- **Network/renderer errors**: The row is marked `error` in **Status** with a short message; re-pasting or using the menu action re-queues safely.
- **LLM errors**: Logged in `NotesQueue.last_error`; notes fall back to template.
- **Conf=0**: The pipeline auto-escalates (renderer → extraction LLM if enabled).

---

## Security & privacy

- Secrets live in **Script Properties** (not in the sheet).  
- Only short **snippets** are sent to the LLM (not entire pages).  
- The renderer should validate a shared `x-renderer-key`.

---

## Extensibility

- Add more ATS patterns in `guessCompanyFromUrl_` or more signals in `decideCompanyRole_`.
- Add more note types (e.g., email subject/body) by extending the Notes LLM prompt.
- Swap LLM providers by changing `LLM_ENDPOINT` and `LLM_MODEL`.

---

## Operational knobs

- **Throughput**: `BATCH_SIZE`, `REQUESTS_PER_MINUTE`, `NOTES_BATCH_SIZE`, `NOTES_PER_MINUTE`
- **Confidence behavior**: tweak heuristics in `decideCompanyRole_`
- **Renderer budget**: keep it as an escalation to control cost
