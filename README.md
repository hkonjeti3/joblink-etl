# joblink-etl

**Paste a job link → your Google Sheet auto-fills _Company_, _Role_, and two LinkedIn messages (invite + follow-up).**  
Deterministic parsers first (ATS APIs, JSON-LD, H1/OG/Title), an optional LLM only when needed, and a tiny Playwright renderer on **Google Cloud Run** for JS-heavy pages. Every step leaves a human-readable trail in **Source**.

---

## Why this exists

When you’re applying across LinkedIn/boards/aggregators, half the links redirect to the **same ATS posting**. Without a system, you re-apply, mislabel titles, and lose time.

**joblink-etl** turns that chaos into an **ETL for Google Sheets**:
- **Extract** truthy data from the link (prefer ATS APIs).
- **Transform** into clean fields + outreach copy.
- **Load** into your sheet with a clear provenance trail—plus **Sheets conditional formatting** so duplicates pop instantly.

You spend time on interviews and follow-ups, not data entry.

---

## What it does

- **Auto-parse**: hiring **Company**, cleaned **Role**, and a normalized **Canonical URL**.
- **Generate outreach**:  
  - **LI Invite** (≤280 chars) — crisp connection request  
  - **LI Follow-up** (280–500 chars) — message to send after they accept
- **Source** column for **provenance**: `parse:{provider=..., signals=..., conf=...} | extract:{mode=llm?} | notes:{mode=llm|template}`
- **Queues + idempotency**: safe to paste repeatedly; processed rows won’t re-enqueue.
- **Duplicate guard**: optional conditional formatting based on Company + Role.

---

## Tech stack

- **Google Sheets + Apps Script** (onEdit trigger, queues, idempotent writes)
- **Deterministic parsing**: ATS APIs (Greenhouse/Lever) → JSON-LD → H1/OG/Title → aggregator unwrap
- **Playwright renderer** on **Google Cloud Run** (only when the HTML looks thin/JS-heavy)
- **LLM (OpenAI-compatible endpoint, optional)**  
  - Extraction rescue for Company/Role (last resort)  
  - Notes generator (strict JSON output) with safe template fallback

> Getting started? Go to **[docs/setup.md](docs/setup.md)**.  
> Want internals? See **[docs/architecture.md](docs/architecture.md)**.

---

## Who it’s for

- **Active job seekers** who want clean tracking + scalable, respectful outreach  
