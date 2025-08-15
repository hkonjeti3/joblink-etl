# Troubleshooting

## Symptoms & fixes

### Pasting a URL does nothing
- Most common: typo in code (`getNumRows` vs `getNumRows()`).
- Verify `onOpen` ran at least once to create the custom menu.
- Ensure the column header is exactly **Link**.

### Status shows `ok` but Company/Role are empty
- Open **Source** column:
  - If `provider=gh-api`/`lever-api` but still empty, check if the job is closed (some APIs return minimal fields).
  - If `provider=direct` and `signals=heuristic`, try enabling renderer (`RENDERER_*`) and LLM extractor.

### NotesQueue keeps errors like LLM 429
- Reduce `NOTES_PER_MINUTE`.
- Confirm your LLM service limits and increase quota if possible.
- Notes will fall back to template if `USE_LLM=0`.

### “job details” or “careers” appears as role
- That’s filtered as “generic”. The extractor LLM will try to infer a role using snippet signals. Make sure `USE_EXTRACT_LLM=1`.

### Aggregator URL doesn’t unwrap
- The page may not link to ATS in the first HTML load. The renderer step attempts a second pass. If it still fails, paste the ATS link directly if available.
