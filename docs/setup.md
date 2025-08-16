# Setup & Usage

This guide helps you install joblink-etl in a new or existing Google Sheet, deploy the optional renderer, and (optionally) enable the LLM.

---

## Prerequisites

- A Google account with **Google Sheets** and **Apps Script** access
- Optional (recommended): a Google Cloud project to deploy the **Playwright renderer** on **Cloud Run**
- Optional: an **OpenAI-compatible** API endpoint + key (OpenAI, Groq, OpenRouter, etc.)

---

## 1) Prepare the Sheet

### A. Main sheet headers (row 1, exact text)

```
Link | Canonical Link | Company (auto) | Role (auto) | Status | Source | LI Invite | LI Follow-up
```

> You can name the tab anything (e.g., “Applied”). The script keys off the header text.

### B. Profile sheet

Create a sheet named `Profile` with two columns: `Key | Value`. Suggested keys:

```
name
headline            (or one-line hook)
top skills
portfolio           (optional)
highlights          (optional)
industries          (optional)
```

---

## 2) Install the Apps Script

1. In your Sheet, go to **Extensions → Apps Script**.
2. Create/overwrite `Code.gs` with the project script from `/apps_script/Code.gs`.
3. **Save**.

> The project uses a **simple `onEdit` trigger**. No manual trigger setup is needed—Apps Script runs it automatically when you paste into the sheet.

---

## 3) Configure Script Properties

In the Apps Script editor: **Project Settings → Script properties**. Add keys as needed:

| Key | Meaning | Example / Default |
|---|---|---|
| `RENDERER_URL` | Cloud Run endpoint `/render?url=` | `https://<service>.run.app/render` |
| `RENDERER_KEY` | Shared secret header `x-renderer-key` | `long-random-token` |
| `LLM_ENDPOINT` | Chat Completions endpoint | `https://api.openai.com/v1/chat/completions` |
| `LLM_API_KEY` | LLM key | `sk-...` |
| `LLM_MODEL` | Model for **notes** | `gpt-4o-mini` / `llama-3.1-8b-instant` |
| `EXTRACT_LLM_MODEL` | Model for **company/role rescue** | (defaults to `LLM_MODEL`) |
| `USE_LLM` | Use LLM for notes | `1` (default) or `0` |
| `USE_EXTRACT_LLM` | Use LLM to rescue company/role | `1` (default) or `0` |
| `BATCH_SIZE` | Parse batch size | `12` |
| `REQUESTS_PER_MINUTE` | Parse throttle | `60` |
| `NOTES_BATCH_SIZE` | Notes batch size | `12` |
| `NOTES_PER_MINUTE` | Notes throttle | `60` |

> If you omit LLM keys, notes will always use the **template fallback** and extraction LLM won’t run.

---

## 4) (Optional) Deploy the Playwright Renderer on Cloud Run

Use your own Docker image or any Playwright headless renderer you trust.

High-level steps:
1. **Containerize** a tiny Node/Playwright service exposing `GET /render?url=<...>` returning `{ status, finalUrl, html }`.
2. `gcloud run deploy <service> --source . --region <region> --allow-unauthenticated`
3. Add an **API key** check (e.g., `x-renderer-key`) and set it as `RENDERER_KEY`.
4. Put the resulting URL into `RENDERER_URL`.

**Smoke test** (replace values):

```bash
curl -H "x-renderer-key: <RENDERER_KEY>"   "https://<service>.run.app/render?url=https://httpbin.org/html"
```

You should see JSON with `html`.

---

## 5) Use it

1. In the **Link** column, paste any job link.  
2. The script enqueues work and fills:
   - **Canonical Link**, **Company (auto)**, **Role (auto)**
   - **Source** (provenance)
   - **LI Invite**, **LI Follow-up**
3. If you paste multiple links, a background loop drains the queues.

---

## 6) Duplicate highlighting (optional)

Add a conditional formatting rule (adjust columns to your sheet):

```
=COUNTIFS($C:$C,$C2,$D:$D,$D2,$B:$B,$B2)>1
```

Assumes: B=Canonical Link, C=Company (auto), D=Role (auto).

---

## Troubleshooting

- **Nothing happens on paste**  
  - Check header texts match exactly.  
  - Confirm you edited the bound script (open **Extensions → Apps Script** from the Sheet).  
  - Try **Reload** the sheet; ensure no syntax errors in `Code.gs` (View → Logs).

- **Company/Role missing or wrong**  
  - Inspect **Source**: if `provider=renderer` is absent, your page may be JS-heavy—configure `RENDERER_URL/KEY`.  
  - If `conf=0.00` and fields are blank, enable `USE_EXTRACT_LLM=1` and set `LLM_*` properties.

- **Notes not generated**  
  - Ensure columns `LI Invite` and `LI Follow-up` exist.  
  - If `USE_LLM=0` or `LLM_*` missing, the template fallback will be used.  
  - Check `NotesQueue` for errors in the last column.

- **Quota/rate limits**  
  - Lower `REQUESTS_PER_MINUTE` / `NOTES_PER_MINUTE`.  
  - Cloud Run cold starts are normal; first render may be slower.

---

## Next steps

- Learn how it works under the hood: **[Architecture & Design](./architecture.md)**.