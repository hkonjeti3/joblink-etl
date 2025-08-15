# Runbook

## First-time setup
1. Create Sheet with required headers.
2. Paste `Code.gs` into Apps Script.
3. Set script properties (`RENDERER_*`, `LLM_*`, batches, rates).
4. Save, run `onOpen` once to authorize.
5. (Optional) Add time-based trigger for `drainAllQueues` every 1–5 minutes.

## Daily operations
- Paste job links in **Link**. Confirm `Status = queued` appears on paste.
- Keep an eye on the **Source** tokens and **NotesQueue.last_error** for hiccups.
- Throttle knobs:
  - `REQUESTS_PER_MINUTE`, `BATCH_SIZE` for parsing.
  - `NOTES_PER_MINUTE`, `NOTES_BATCH_SIZE` for notes.

## Playbooks

### Auto-enqueue isn’t firing
- Confirm the header **Link** exactly matches.
- Ensure the “Job Parser” custom menu is visible (means script loaded).
- Check **Triggers**: simple `onEdit` exists by default; add an installable on-edit if desired.
- Look at **Executions** in Apps Script for runtime errors.

### Queue is stuck / not draining
- Manually run `drainAllQueues` from the editor.
- Check script properties for typos.
- Reduce request rates if you’re hitting quotas.

### LLM 429 / provider overload
- Lower `NOTES_PER_MINUTE`.
- Confirm your LLM service limits and increase quota if possible.
- Temporarily set `USE_LLM=0` to use template messages.

### Renderer flakiness
- Verify `RENDERER_URL` and `RENDERER_KEY`.
- Use **Job Parser → Enqueue selected rows** to retry after fixing.

### Fields are wrong / empty
- Inspect `Source` tokens:
  - `signals=...` shows which heuristics fired.
  - If `conf=0.00`, allow a re-run or switch `USE_EXTRACT_LLM=1`.
