# Architecture & Design

This document explains the moving parts: triggers, queues, parsers, renderer, LLM usage, and the provenance model.

---

## Big picture

```mermaid
flowchart TD
  subgraph Sheets
    U([Paste link in Sheet])
    Q[[Queue]]
    NQ[[NotesQueue]]
  end

  U -->|onEditHandler| Q
  Q -->|processNextBatch| P[Parse row]

  P --> F{Fetch strategy}
  F -->|ATS API| A1[Greenhouse / Lever JSON]
  F -->|Direct HTML| A2[HTML (meta + body)]
  F -->|Renderer| A3[Playwright (Cloud Run)]

  A1 --> X[decideCompanyRole()]
  A2 --> X
  A3 --> X

  X --> W[Write Company / Role / Canonical]
  W --> NQ

  NQ -->|processNotesBatch| G[Generate Notes]
  G --> W2[Write LI Invite / Follow-up]
```
> Non-destructive by design: only target columns are written; the **Source** column captures how results were produced.

---

## Parsing decision tree

```mermaid
flowchart TD
  start([finalUrl, html]) --> json

  json{{JSON-LD JobPosting present?}} -->|yes| set1[Set company & role from JSON-LD\nconf += 1.0]
  json -->|no| slug

  slug{{ATS slug in URL?}} -->|yes| setC[Company from ATS slug\nconf += 0.35]
  slug -->|no| h1

  h1{{H1 / OG:title / <title> present?}} -->|yes| setR[Role from H1/OG/Title\nconf += 0.35/0.25/0.15]
  h1 -->|no| site

  site{{og:site_name and not aggregator?}} -->|yes| setS[Company from site name\nconf += 0.25]
  site -->|no| split

  split{{Title looks like 'Company – Role'?}} -->|yes| fix[Split into company & role\nconf = max(conf, 0.55)]
  split --> llm
  set1 --> llm
  setC --> llm
  setR --> llm
  setS --> llm
  fix --> llm

  llm{{Missing or generic role/company?}} -->|yes| setLLM[LLM fills gaps (guardrails)]
  llm -->|no| end([Return fields + decision notes])
  setLLM --> end
```

**Notes**
- *Aggregator awareness:* `og:site_name` is ignored on known aggregators.
- *Role cleaner:* removes company echoes, req IDs, location suffixes, and emojis.
- *Confidence clamp:* if company or role is still empty, confidence ≤ 0.5.

---

## Queues & idempotency

```mermaid
flowchart TD
  L[Link column edit] --> ENQ[Enqueue (Queue)]
  ENQ --> BATCH[processNextBatch]
  BATCH --> PARSE[Fetch + Decide + Write]
  PARSE --> NENQ[Enqueue (NotesQueue) if notes empty]
  NENQ --> NBATCH[processNotesBatch]
  NBATCH --> NOTES[LLM or template -> write notes]
  NOTES --> CLEAN[Delete processed rows from queues]
```
- Queue rows are unique per `(sheet_name, row_index)`.
- Status cells are updated, but the **Source** column carries the readable audit trail.

---

## Renderer

- A minimal **Playwright** service runs on **Google Cloud Run**.
- Apps Script calls it *only when* a page looks thin (no JSON-LD/H1/OG) or is JS-heavy.
- The service returns `{ status, finalUrl, html }`; no cookies or auth persisted.

---

## LLM usage (two places)

1) **Extraction (optional, last resort)** — If role is missing/too generic or company is unknown, we send a compact snippet

   *(H1/OG/Title + short body preview)* to an extractor model. Any inferred fields are clearly tagged.

2) **Notes** — We combine your **Profile** sheet (headline, skills, “one-line hook”) with the job snippet to generate two strings:

   **LI Invite** (≤280 chars) and **LI Follow‑up** (280–500 chars). If the LLM is throttled or returns nothing, a curated **template** is used.

Both paths record provenance in **Source** (`extract:{mode=llm}` and `notes:{mode=llm|template}`).

---

## Provenance examples

```
parse:{provider=gh-api, signals=jsonld-org+h1, conf=0.90}
extract:{mode=llm}
notes:{mode=template}
```

---

## Why this shape

- **Deterministic-first** keeps results stable and auditable.

- **Renderer on-demand** saves cost and avoids brittle scraping.

- **Non-destructive writes** let you override anything by hand.

- **Readable Source** means you can trust and verify every row.
