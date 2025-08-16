/**
 * joblink-etl (Google Apps Script)
 * -----------------------------------------------------------
 * Paste a job link into a Google Sheet and this script will:
 *  1) Enqueue the row for parsing.
 *  2) Fetch & parse the target page (ATS APIs → HTML → renderer fallback → unwrap aggregators).
 *  3) Extract Company, Role, Canonical URL and write them to the sheet.
 *  4) Enqueue a second task to generate LinkedIn outreach notes (LLM or template).
 *  5) Keep a human-readable audit trail in the "Source" column (provider, signals, confidence, etc.).
 *
 * SHEET REQUIREMENTS (Row 1 header names must match exactly):
 *  - Link
 *  - Canonical Link
 *  - Company (auto)
 *  - Role (auto)
 *  - Status
 *  - Source
 *  - LI Invite
 *  - LI Follow-up
 *
 * OPTIONAL Script Properties (File → Project properties → Script properties):
 *  - RENDERER_URL:  Cloud Run (or similar) endpoint for Playwright renderer. e.g., https://<service>.run.app/render
 *  - RENDERER_KEY:  Secret header key your renderer expects (x-renderer-key).
 *  - USE_EXTRACT_LLM: "1" to enable LLM fallback for extracting company/role when signals are weak.
 *  - LLM_ENDPOINT:   Chat Completions-compatible endpoint.
 *  - LLM_API_KEY:    Bearer token for the endpoint.
 *  - LLM_MODEL:      e.g., "llama-3.1-8b-instant"
 *  - EXTRACT_LLM_MODEL: (optional) override for extraction-only model.
 *  - BATCH_SIZE:     Max parse jobs per drain cycle (default 12).
 *  - REQUESTS_PER_MINUTE: Throttle network calls (default 60).
 *  - NOTES_BATCH_SIZE: Max notes jobs per drain cycle (default 12).
 *  - NOTES_PER_MINUTE: Throttle notes LLM calls (default 60).
 *
 * HOW TO USE
 *  - Paste job URLs into the "Link" column.
 *  - The onEditHandler auto-enqueues, then drainAllQueues() processes parsing + notes.
 *  - If auto-enqueue is disabled (e.g., wrong trigger), select rows → Menu "Job Parser" → "Enqueue selected rows".
 *
 * DEBUG HELPERS
 *  - debugRenderer(): quick check the renderer wiring using httpbin.org.
 *  - debugNotesOnce(): run a small notes batch once (useful during development).
 */

/********** CONFIG: header names (must match row 1 exactly) **********/
const HEADERS = {
  link:       'Link',             // Where the user pastes the job URL
  canonical:  'Canonical Link',   // Normalized URL (no tracking params)
  company:    'Company (auto)',   // Extracted Name of hiring org (NOT the aggregator)
  role:       'Role (auto)',      // Extracted job title (cleaned)
  status:     'Status',           // ok | error | queued (for human feedback)
  source:     'Source',           // audit trail: parse signals, fetch provider, confidence, notes provenance
  // Notes (LinkedIn outreach)
  liInvite:   'LI Invite',        // ≤ 280 chars – connection request
  liFollow:   'LI Follow-up',     // 280–500 chars – DM after accept
};

const QUEUE_SHEET_NAME   = 'Queue';       // Internal parse queue (do not edit)
const NOTES_QUEUE_SHEET  = 'NotesQueue';  // Internal notes queue (do not edit)
const PROFILE_SHEET_NAME = 'Profile';     // Small profile sheet with your hook/skills/headline
const HEADER_ROW = 1;

/********** Utilities **********/

/** Returns a Date for consistent “now” writes (used when queueing). */
function now_() { return new Date(); }

/**
 * Build a mapping of header names → column numbers for a given sheet.
 * - First occurrence of a header wins (protects against accidentally duplicated headers).
 * Example:
 *   Row1: ["Link","Company (auto)","Role (auto)"]
 *   returns: { "Link":1, "Company (auto)":2, "Role (auto)":3 }
 */
function getHeaderMap_(sheet) {
  const row = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  row.forEach((h, i) => { if (h && !(h in map)) map[h] = i + 1; });
  return map;
}

/**
 * Get (or create) the parse queue sheet.
 * Queue schema:
 *  sheet_name | row_index | url | status | tries | enqueued_at | next_attempt_at | last_error
 */
function getQueueSheet_() {
  const ss = SpreadsheetApp.getActive();
  let q = ss.getSheetByName(QUEUE_SHEET_NAME);
  if (!q) {
    q = ss.insertSheet(QUEUE_SHEET_NAME);
    q.getRange(1,1,1,8).setValues([[
      'sheet_name','row_index','url','status','tries','enqueued_at','next_attempt_at','last_error'
    ]]);
  }
  return q;
}

/**
 * Get (or create) the notes queue sheet.
 * Queue schema:
 *  sheet_name | row_index | phase | status | enqueued_at | last_error
 */
function getNotesQueueSheet_() {
  const ss = SpreadsheetApp.getActive();
  let q = ss.getSheetByName(NOTES_QUEUE_SHEET);
  if (!q) {
    q = ss.insertSheet(NOTES_QUEUE_SHEET);
    q.getRange(1,1,1,6).setValues([[
      'sheet_name','row_index','phase','status','enqueued_at','last_error'
    ]]);
  } else {
    // If somebody overwrote headers, fix them silently
    const h = q.getRange(1,1,1,Math.max(6,q.getLastColumn())).getValues()[0];
    if (!String(h[0]||'').match(/sheet_name/i)) {
      q.getRange(1,1,1,6).setValues([[
        'sheet_name','row_index','phase','status','enqueued_at','last_error'
      ]]);
    }
  }
  return q;
}

/** Normalize a URL’s hostname to compare hosts reliably (e.g., drop “www.”). */
function hostFromUrl_(u) {
  try { const h = new URL(u).hostname.toLowerCase(); return h.startsWith('www.') ? h.slice(4) : h; }
  catch(e) { return ''; }
}

/********** Menu **********/

/**
 * Adds the custom menu “Job Parser” in Google Sheets UI.
 * - Enqueue selected rows: convenient manual mode if onEdit is off.
 * - Drain all queues: parse + notes until queues are empty or time budget is hit.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Job Parser')
    .addItem('Enqueue selected rows', 'enqueueSelectedRows')
    .addItem('Drain all queues (parse + notes)', 'drainAllQueues')
    .addToUi();
}

/********** AUTO enqueue on paste/edit in Link col, then drain **********/

/**
 * onEditHandler
 * Trigger: Simple onEdit trigger (must be named exactly "onEdit" or bound to onEditHandler via installable trigger).
 *
 * What it does:
 *  - If the edited range touches the "Link" column, enqueue those rows (idempotently).
 *  - Immediately call drainAllQueues() to process both parsing and notes.
 *
 * Example:
 *  If you paste 10 new URLs into the Link column, those 10 rows are queued and then processed.
 */
function onEditHandler(e) {
  try {
    if (!e || !e.range) return; // Safety for manual runs
    const sheet = e.range.getSheet();
    const headerMap = getHeaderMap_(sheet);
    const linkCol = headerMap[HEADERS.link];
    if (!linkCol) return; // If the sheet isn’t a tracked sheet (no "Link" column), ignore.

    // Determine whether the edited range includes the Link column
    const r = e.range;
    const startRow = r.getRow();
    const endRow   = r.getRow() + r.getNumRows() - 1;
    const startCol = r.getColumn();
    const endCol   = r.getColumn() + r.getNumColumns() - 1;
    if (!(linkCol >= startCol && linkCol <= endCol)) return;

    const q = getQueueSheet_();
    const qVals = q.getDataRange().getValues();
    const toAppend = [];
    const statusCol = headerMap[HEADERS.status];

    for (let row = startRow; row <= endRow; row++) {
      if (row <= HEADER_ROW) continue; // skip header

      const url = sheet.getRange(row, linkCol).getDisplayValue().trim();
      if (!/^https?:\/\//i.test(url)) continue; // only queue valid-looking URLs

      // idempotency: at most one queued/processing item per (sheet,row)
      const exists = qVals.some((v,i) =>
        i>0 && v[0]===sheet.getName() && v[1]===row && (v[3]==='queued' || v[3]==='processing')
      );
      if (exists) continue;

      toAppend.push([sheet.getName(), row, url, 'queued', 0, now_(), '', '']);
      if (statusCol) sheet.getRange(row, statusCol).setValue('queued');
    }

    if (toAppend.length) {
      q.getRange(q.getLastRow()+1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
    }
    // Kick off processing now (parse + notes)
    drainAllQueues();
  } catch (err) {
    console.error(err);
  }
}

/********** Manual enqueue **********/

/**
 * Enqueue selected rows (useful if onEdit is disabled).
 * Steps:
 *  - Reads Link from each selected row.
 *  - Queues each row once.
 *  - Sets Status="queued".
 *  - Immediately drains queues.
 */
function enqueueSelectedRows() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getActiveSheet();
  const headerMap = getHeaderMap_(sheet);
  const linkCol = headerMap[HEADERS.link];
  if (!linkCol) { SpreadsheetApp.getUi().alert(`Couldn't find header "${HEADERS.link}" on row 1.`); return; }

  const sel = sheet.getActiveRangeList().getRanges();
  const q = getQueueSheet_();
  const qVals = q.getDataRange().getValues();

  const toAppend = [];
  const statusCol = headerMap[HEADERS.status];

  sel.forEach(range => {
    const rows = range.getValues();
    rows.forEach((_, i) => {
      const rowIndex = range.getRow() + i;
      if (rowIndex <= HEADER_ROW) return;

      const url = sheet.getRange(rowIndex, linkCol).getDisplayValue().trim();
      if (!/^https?:\/\//i.test(url)) return;

      const exists = qVals.some((v,ix) =>
        ix>0 && v[0]===sheet.getName() && v[1]===rowIndex && (v[3]==='queued' || v[3]==='processing')
      );
      if (exists) return;

      toAppend.push([sheet.getName(), rowIndex, url, 'queued', 0, now_(), '', '']);
      if (statusCol) sheet.getRange(rowIndex, statusCol).setValue('queued');
    });
  });

  if (toAppend.length) {
    q.getRange(q.getLastRow()+1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
  }
  drainAllQueues();
}

/********** Drain both queues until empty or time budget (~4:45) **********/

/**
 * drainAllQueues()
 * - Runs in a loop until:
 *    a) both queues are empty for this pass, or
 *    b) ~4:45 minutes have elapsed (leaves headroom below the 6-minute Apps Script limit).
 * - Each pass:
 *    1) processNextBatch() parses a batch of links.
 *    2) processNotesBatch() creates outreach notes for a batch of rows.
 */
function drainAllQueues() {
  const start = Date.now();
  const budgetMs = 5*60*1000 - 15000; // stop ~15s early for safety
  while (Date.now() - start < budgetMs) {
    const didParse = processNextBatch(true);
    const didNotes = processNotesBatch(true);
    if (!didParse && !didNotes) break;
  }
}

/********** Networking helpers **********/

/**
 * Regex test for ATS hosts (Greenhouse, Lever, Workday, Ashby, etc.).
 * Why: these hosts usually have clean APIs or predictable HTML structure.
 * Example: "jobs.lever.co/acme/role-123" → true
 */
function isAtsHost_(h) {
  const re = /(lever\.co|ashbyhq\.com|job-boards\.greenhouse\.io|boards\.greenhouse\.io|myworkdayjobs\.com|workdayjobs\.com|smartrecruiters\.com|jobvite\.com|apply\.workable\.com|ats\.rippling\.com|recruiting(?:2)?\.ultipro\.com|icims\.com|oraclecloud\.com|brassring\.com|paylocity\.com)/i;
  return re.test(h);
}

/**
 * Regex test for aggregator hosts (LinkedIn, Indeed, BuiltIn, etc.).
 * Why: these are often “wrappers” that link to the underlying ATS.
 * Example: "www.linkedin.com/jobs/view/..." → true
 */
function isAggregatorHost_(h) {
  const re = /(jobright\.ai|allup\.world|ycombinator\.com|linkedin\.com|indeed\.com|glassdoor\.com|levels\.fyi|builtin\.(?:com|nyc|chicago|sf)|wellfound\.com|angel\.co|dice\.com|monster\.com|ziprecruiter\.com)/i;
  return re.test(h);
}

/**
 * isGenericTitle_
 * Returns true if a string looks like a boilerplate page title (e.g., “Job details”, “Sign in”).
 * Used to decide whether a page has “useful signals” for parsing the role.
 */
function isGenericTitle_(s) {
  const t = String(s||'').toLowerCase().trim();
  if (!t) return true;
  const bad = [
    'job details','job detail','careers','career portal',
    'choose your sign in option','sign in','signin','login','log in',
    'home','open positions','all jobs','search results','job search','apply now',
    'opportunities','join our team'
  ];
  if (bad.some(p => t.includes(p))) return true;
  if (t.length <= 2) return true;
  return false;
}

/**
 * hasUsefulSignal_
 * Heuristic to decide if the HTML likely contains enough signal to parse:
 *  - JSON-LD present? (common for JobPosting)
 *  - H1/OG:title/title exist and are not generic
 */
function hasUsefulSignal_(html) {
  if (!html) return false;
  const hasJson = /<script[^>]+application\/ld\+json/i.test(html);
  const h1 = getH1_(html);
  const ogTitle = getMeta_(html, 'og:title', 'property');
  const title = getTitle_(html);
  const goodTitle =
    (h1 && !isGenericTitle_(h1)) ||
    (ogTitle && !isGenericTitle_(ogTitle)) ||
    (title && !isGenericTitle_(title));
  return hasJson || goodTitle;
}

/**
 * directFetch_
 * Simple UrlFetch GET with a desktop user-agent.
 * Desktop UA helps some sites return richer HTML than headless/mobile defaults.
 */
function directFetch_(url) {
  const resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
  });
  return { status: resp.getResponseCode(), finalUrl: url, html: resp.getContentText(), provider: 'direct' };
}

/**
 * fetchViaAtsApis_
 * Fastest + most reliable path when a link is clearly Greenhouse or Lever:
 *  - Greenhouse Boards API
 *  - Lever Postings API
 * Returns a synthetic “fetch result” with apiCompany/apiRole filled where possible.
 *
 * Examples:
 *  - https://boards.greenhouse.io/acme/jobs/12345
 *    → GET https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345
 *  - https://jobs.lever.co/acme/senior-swe-123
 *    → GET https://api.lever.co/v0/postings/acme/senior-swe-123?mode=json
 */
function fetchViaAtsApis_(url) {
  // Greenhouse
  const ghm = url.match(/https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([^\/?#]+)\/jobs\/(\d+)/i);
  if (ghm) {
    const company = ghm[1], jobId = ghm[2];
    const api = 'https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(company) + '/jobs/' + jobId;
    const resp = UrlFetchApp.fetch(api, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() < 400) {
      const data = JSON.parse(resp.getContentText());
      const role = data.title || '';
      const canonical = makeCanonical_('https://boards.greenhouse.io/' + company + '/jobs/' + jobId);
      return { status: 200, finalUrl: canonical, html: '', provider: 'gh-api', apiCompany: niceCase_(company), apiRole: role };
    }
  }
  // Lever
  const lvm = url.match(/https?:\/\/jobs\.lever\.co\/([^\/?#]+)\/([^\/?#]+)/i);
  if (lvm) {
    const company = lvm[1], jobId = lvm[2];
    const api = 'https://api.lever.co/v0/postings/' + encodeURIComponent(company) + '/' + encodeURIComponent(jobId) + '?mode=json';
    const resp = UrlFetchApp.fetch(api, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() < 400) {
      const data = JSON.parse(resp.getContentText());
      const role = (data && (data.text || data.title)) || '';
      const canonical = makeCanonical_('https://jobs.lever.co/' + company + '/' + jobId);
      return { status: 200, finalUrl: canonical, html: '', provider: 'lever-api', apiCompany: niceCase_(company), apiRole: role };
    }
  }
  return null;
}

/**
 * fetchViaRenderer_
 * Calls your Playwright renderer to get server-side rendered HTML for JS-heavy pages.
 * Requires:
 *  - Script Property RENDERER_URL
 *  - Script Property RENDERER_KEY (sent as header x-renderer-key)
 */
function fetchViaRenderer_(url) {
  const PROPS = PropertiesService.getScriptProperties();
  const base = PROPS.getProperty('RENDERER_URL'); // e.g., https://<service>.run.app/render
  const key  = PROPS.getProperty('RENDERER_KEY');
  if (!base || !key) return null;
  const api = base + (base.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
  const resp = UrlFetchApp.fetch(api, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'x-renderer-key': key }
  });
  if (resp.getResponseCode() >= 400) return null;
  try {
    const j = JSON.parse(resp.getContentText());
    return { status: j.status, finalUrl: j.finalUrl || url, html: j.html || '', provider: 'renderer' };
  } catch (_) { return null; }
}

/**
 * findFirstAtsLinkIn_
 * Scan HTML for the first <a href="..."> pointing to a known ATS.
 * Used to unwrap aggregator pages to the ATS target.
 */
function findFirstAtsLinkIn_(html) {
  const hrefRe = /href=["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html))) {
    try { if (isAtsHost_(hostFromUrl_(m[1]))) return m[1]; } catch(_) {}
  }
  return '';
}

/**
 * fetchSmartFree_
 * Best-effort fetch strategy (cheap → richer):
 *   1) ATS APIs (Greenhouse/Lever) if URL matches → RETURN
 *   2) Direct fetch (desktop UA). If it has useful signals → RETURN
 *   3) Playwright renderer fallback (if JS-heavy). If useful signals → RETURN
 *   4) If the input URL is an aggregator, try to find an ATS link and re-fetch (API → HTML → renderer).
 *   5) Last resort: whichever of direct/rendered we have.
 */
function fetchSmartFree_(url) {
  // 1) ATS API (free, fast)
  const viaApi = fetchViaAtsApis_(url);
  if (viaApi) return viaApi;

  // 2) Direct fetch
  let direct = directFetch_(url);
  if (direct.status < 400 && hasUsefulSignal_(direct.html)) return direct;

  // 3) Renderer fallback (only if the page looks thin)
  const rendered = fetchViaRenderer_(url);
  if (rendered && hasUsefulSignal_(rendered.html)) return rendered;

  // 4) Aggregator unwrap; try both direct HTML then rendered HTML to find ATS
  const h = hostFromUrl_(url);
  if (isAggregatorHost_(h)) {
    const firstHtml = (rendered && rendered.html) || (direct && direct.html) || '';
    let atsUrl = findFirstAtsLinkIn_(firstHtml);
    if (!atsUrl && !rendered) {
      const r = fetchViaRenderer_(url);
      if (r) atsUrl = findFirstAtsLinkIn_(r.html || '');
    }

    if (atsUrl) {
      const viaApi2 = fetchViaAtsApis_(atsUrl);
      if (viaApi2) return viaApi2;

      let d2 = directFetch_(atsUrl);
      if (!(d2.status < 400 && hasUsefulSignal_(d2.html))) {
        const r2 = fetchViaRenderer_(atsUrl);
        if (r2 && hasUsefulSignal_(r2.html)) d2 = r2;
      }
      if (d2.status < 400 && hasUsefulSignal_(d2.html)) {
        d2.provider = (d2.provider || 'direct') + '-unwrapped';
        return d2;
      }
    }
  }

  // 5) Last resort
  return rendered || direct;
}

/********** Extractors (helpers that mine HTML/JSON-LD for signals) **********/

/** Get a <meta property="..."> or <meta name="..."> content by key. */
function getMeta_(html, key, attr) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i');
  const m = re.exec(html);
  return m ? m[1].trim() : '';
}

/** Get <title>…</title> content (trimmed to a single line). */
function getTitle_(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g,' ').trim() : '';
}

/** Get first <h1>…</h1> text with tags removed and whitespace collapsed. */
function getH1_(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}

/**
 * parseJsonLdJobPosting_
 * Looks for <script type="application/ld+json"> blocks and traverses to find a JobPosting node.
 * Returns { company, role } if found.
 */
function parseJsonLdJobPosting_(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    try {
      const json = JSON.parse(raw);
      const jp = findJobPosting_(json);
      if (jp) {
        const org = (jp.hiringOrganization && (jp.hiringOrganization.name || jp.hiringOrganization)) || '';
        const title = jp.title || '';
        return { company: String(org || ''), role: String(title || '') };
      }
    } catch(_) {}
  }
  return { company: '', role: '' };
}

/** Recursively search a JSON object/array for an object with @type including “JobPosting”. */
function findJobPosting_(node) {
  if (!node) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findJobPosting_(n); if (r) return r; } return null; }
  if (typeof node === 'object') {
    const t = node['@type'];
    const tstr = Array.isArray(t) ? t.join(',').toLowerCase() : String(t || '').toLowerCase();
    if (tstr.includes('jobposting')) return node;
    if (node['@graph']) { const r = findJobPosting_(node['@graph']); if (r) return r; }
    for (const k in node) { if (typeof node[k] === 'object') { const r = findJobPosting_(node[k]); if (r) return r; } }
  }
  return null;
}

/** Convert an ATS slug like “acme-corp” to “Acme Corp”. */
function niceCase_(slug) { return slug.replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g, s => s.toUpperCase()); }

/**
 * guessCompanyFromUrl_
 * If we can infer the company from the ATS URL itself (host path segment), do it.
 * Examples:
 *  - https://jobs.lever.co/acme/foo → "Acme"
 *  - https://boards.greenhouse.io/megacorp/jobs/12345 → "Megacorp"
 */
function guessCompanyFromUrl_(url) {
  const u = url.toLowerCase(); let m;
  if ( (m = u.match(/(?:job-boards|boards)\.greenhouse\.io\/([^\/?#]+)\/jobs\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/jobs\.lever\.co\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/jobs\.ashbyhq\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/apply\.workable\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/jobs\.smartrecruiters\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/jobs\.jobvite\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/ats\.rippling\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/myworkdayjobs\.com\/(?:[a-z-]+\/)?([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/workdayjobs\.com\/(?:[a-z-]+\/)?([^\/?#]+)\//)) ) return niceCase_(m[1]);
  if ( (m = u.match(/recruiting\.paylocity\.com\/.*\/Details\/\d+\/([^\/?#]+)/)) ) return niceCase_(m[1]);
  return '';
}

/********** Emoji + HTML helpers + Role cleaner **********/

/** Remove emoji and variation selectors to clean titles without breaking CJK/RTL. */
function stripEmojis_(s) {
  try { return String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, ''); }
  catch (e) {
    // Fallback for environments without \p support
    return String(s || '')
      .replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u27BF\u2B00-\u2BFF\u2600-\u26FF]/g, '')
      .replace(/\uFE0F/g, '');
  }
}

/** Minimal HTML entity decode (common entities only). */
function decodeHtml_(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

/**
 * cleanRole_
 * Remove company prefixes/suffixes, req IDs, trailing locations, and extra punctuation.
 * Examples:
 *  - "Acme — Senior Software Engineer – Req#8932, CA" → "Senior Software Engineer"
 *  - "Senior SWE - New York, NY" → "Senior SWE"
 */
function cleanRole_(title, company) {
  if (!title) return '';
  let r = String(title).replace(/<[^>]*>/g, ''); // strip tags
  r = decodeHtml_(r);
  r = stripEmojis_(r);
  if (company) {
    const c = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    r = r.replace(new RegExp('^\\s*' + c + '\\s*[-–—:]*\\s*', 'i'), ''); // “Company — Role”
    r = r.replace(new RegExp('\\s*[-–—:]*\\s*' + c + '\\s*$', 'i'), ''); // “Role — Company”
  }
  r = r.replace(/\s*-\s*[A-Z][a-z]+(?:,?\s*[A-Z]{2})?$/, '');            // trailing location
  r = r.replace(/\s*[-–—]?\s*((JR|Req|R|ID|Job)[\s#:]*\d+|\d{5,})\s*$/i, ''); // trailing Req/ID
  return r.replace(/\s+/g, ' ').trim();
}

/**
 * makeCanonical_
 * Strip common tracking params for consistent deduplication.
 */
function makeCanonical_(url) {
  try {
    const u = new URL(url);
    const del = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gh_src','src','source','vq_campaign','vq_source','__jvst','__jvsd','codes','gh_jid'];
    del.forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch(e) { return url; }
}

/********** LLM extractor for company/role (optional) **********/

/**
 * llmExtractCompanyRole_
 * When deterministic signals are weak (no JSON-LD/H1/OG), ask a small model to infer:
 * Returns: { company, role } or null.
 * Input snippet includes: canonical URL, h1/og/title, and a short body preview.
 */
function llmExtractCompanyRole_(snippet) {
  const PROPS = PropertiesService.getScriptProperties();
  const endpoint = PROPS.getProperty('LLM_ENDPOINT');
  const key = PROPS.getProperty('LLM_API_KEY');
  const model = PROPS.getProperty('EXTRACT_LLM_MODEL') || PROPS.getProperty('LLM_MODEL') || 'llama-3.1-8b-instant';
  if (!endpoint || !key) return null;

  const sys = [
    "You are a precise extractor. Infer the HIRING company (not the aggregator) and the ROLE title from partial page signals.",
    "Return STRICT JSON only: {\"company\":\"...\",\"role\":\"...\"}. No commentary.",
    "Prefer signals in order: JSON-LD→H1→OG:title→title→body preview hints.",
    "Normalize: company as proper name, role as a clean job title."
  ].join('\n');

  const user = "Signals:\n" + JSON.stringify(snippet, null, 2);

  const payload = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: user }
    ],
    temperature: 0.2,
    max_tokens: 120
  };

  const resp = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code >= 400) throw new Error('extract-llm HTTP ' + code);

  try {
    const j = JSON.parse(resp.getContentText());
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const trimmed = (content || '').trim();
    const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const out = JSON.parse(trimmed.slice(start, end+1));
      return { company: (out.company||'').trim(), role: (out.role||'').trim() };
    }
  } catch (_) {}
  return null;
}

/********** Decision logic with confidence (+ optional LLM escalation) **********/

/**
 * decideCompanyRole_
 * Given HTML + final URL:
 *  - Try JSON-LD JobPosting (company+title).
 *  - Else infer company from ATS slug in URL (e.g., jobs.lever.co/acme/… → "Acme").
 *  - Infer role from H1 → OG:title → <title>.
 *  - Use og:site_name as company only when not an aggregator (prevents “LinkedIn” as company).
 *  - If title is “Company — Role”, split and rescue.
 *  - Clean role (strip emojis, IDs, locations).
 *  - If results look weak (missing company or generic role), ask LLM as last resort.
 *  - Compute a rough confidence score and return a readable “notes” trail of signals used.
 */
function decideCompanyRole_(html, finalUrl) {
  const host = hostFromUrl_(finalUrl);
  const isAgg = isAggregatorHost_(host);
  const canonical = makeCanonical_(finalUrl);

  const json = parseJsonLdJobPosting_(html);
  const ogSite = getMeta_(html, 'og:site_name', 'property');
  const h1 = getH1_(html);
  const ogTitle = getMeta_(html, 'og:title', 'property');
  const title = getTitle_(html);

  let company = '';
  let role = '';
  let conf = 0.0;     // rough confidence (0..1), bumped by each “good” signal
  let notes = [];     // human-readable list of signals used (for Source column)
  const extraTokens = []; // additional audit entries (e.g., extract:{mode=llm})

  // JSON-LD (strongest signal when present)
  if (json.company) { company = json.company; conf += 0.5; notes.push('jsonld-org'); }
  if (json.role)    { role    = json.role;    conf += 0.5; notes.push('jsonld-title'); }

  // ATS slug (e.g., jobs.lever.co/acme/… → "Acme")
  if (!company) {
    const fromUrl = guessCompanyFromUrl_(finalUrl);
    if (fromUrl) { company = fromUrl; conf += 0.35; notes.push('ats-slug'); }
  }

  // Role from H1 → OG:title → <title>
  if (!role) {
    if (h1)          { role = h1;       conf += 0.35; notes.push('h1'); }
    else if (ogTitle){ role = ogTitle;  conf += 0.25; notes.push('og:title'); }
    else if (title)  { role = title;    conf += 0.15; notes.push('title'); }
  }

  // og:site_name only if NOT an aggregator (prevents “Glassdoor”, “LinkedIn”, etc.)
  if (!company && ogSite && !isAgg) { company = ogSite; conf += 0.25; notes.push('og:site_name'); }

  // Rescue “Company — Role” in the role field, e.g., "Acme – Senior SWE"
  if (!company && role && /.+\s[-–—]\s.+/.test(role)) {
    const parts = role.split(/\s[-–—]\s/);
    if (parts.length >= 2) {
      company = parts[0].trim();
      role = parts.slice(1).join(' - ').trim();
      notes.push('title-split');
      conf = Math.max(conf, 0.55);
    }
  }

  // Final cleanup
  role = cleanRole_(role, company);

  // If results look weak, escalate to LLM extractor (when enabled)
  const PROPS = PropertiesService.getScriptProperties();
  const useExtractLLM = (PROPS.getProperty('USE_EXTRACT_LLM') || '1') === '1';
  const looksGeneric = !role || isGenericTitle_(role);

  if (useExtractLLM && (looksGeneric || !company)) {
    let extractErr = null;
    try {
      const snippet = {
        url: canonical,
        h1, ogTitle, ogSite, title,
        body_preview: textPreview_(html, 2000) // include 2KB of preview for extra hints
      };
      const guess = llmExtractCompanyRole_(snippet);
      if (guess && (guess.company || guess.role)) {
        if (!company && guess.company) company = guess.company;
        if (looksGeneric && guess.role) role = cleanRole_(guess.role, company);
        conf = Math.max(conf, 0.6); // bump since we now have a combined signal
        extraTokens.push({ kind: 'extract', obj: { mode: 'llm' } });
      } else {
        extractErr = 'no-output';
      }
    } catch (e) {
      extractErr = String(e.message || e);
    }
    if (extractErr) extraTokens.push({ kind: 'extract', obj: { mode: 'llm', err: extractErr } });
  }

  // Clamp confidence to [0,1] and penalize missing fields
  if (!company) conf = Math.min(conf, 0.5);
  if (!role)    conf = Math.min(conf, 0.5);
  conf = Math.max(0, Math.min(1, conf));

  return { company, role, canonical, conf, decision: notes.join('+') || 'heuristic', extraTokens };
}

/********** Source helpers (readable & non-destructive) **********/

/**
 * appendSourceToken_
 * Append or replace a single "token" inside the Source cell in a readable format:
 *   kind:{k=v, k2=v2}
 * If the same kind exists already, it is replaced (to keep Source compact).
 * Examples:
 *  - parse:{provider=gh-api, signals=jsonld-org+h1, conf=0.90}
 *  - extract:{mode=llm}
 *  - notes:{mode=template}
 */
function appendSourceToken_(sheetName, rowIndex, kind, tokenObject) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headerMap = getHeaderMap_(sheet);
  const col = headerMap[HEADERS.source];
  if (!col) return;

  const prev = sheet.getRange(rowIndex, col).getDisplayValue().trim();

  const pretty = kind + ':{' + Object.keys(tokenObject)
    .map(k => `${k}=${String(tokenObject[k])}`)
    .join(', ') + '}';

  // Replace previous token of the same kind if present
  let out = prev || '';
  const re = new RegExp(`${kind}:\\{[^}]*\\}`);
  if (re.test(out)) out = out.replace(re, pretty);
  else out = out ? (out + ' | ' + pretty) : pretty;

  sheet.getRange(rowIndex, col).setValue(out);
}

/********** Write back (parse fields only) **********/

/**
 * writeBack_
 * Writes Canonical/Company/Role to the row (non-destructive across other columns),
 * then appends a parse token to the Source column with provider/signals/confidence.
 */
function writeBack_(sheetName, rowIndex, parsed, fetchRes) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  const headerMap = getHeaderMap_(sheet);

  const cols = [];
  const vals = [];
  if (headerMap[HEADERS.canonical]) { cols.push(headerMap[HEADERS.canonical]); vals.push(parsed.canonical); }
  if (headerMap[HEADERS.company])   { cols.push(headerMap[HEADERS.company]);   vals.push(parsed.company); }
  if (headerMap[HEADERS.role])      { cols.push(headerMap[HEADERS.role]);      vals.push(parsed.role); }

  // Write a sparse range [minCol..maxCol] to avoid multiple setValues calls
  if (cols.length) {
    const minCol = Math.min.apply(null, cols);
    const maxCol = Math.max.apply(null, cols);
    const out = new Array(maxCol - minCol + 1).fill('');
    cols.forEach((c, i) => { out[c - minCol] = vals[i]; });
    sheet.getRange(rowIndex, minCol, 1, out.length).setValues([out]);
  }

  // Readable parse source
  appendSourceToken_(sheetName, rowIndex, 'parse', {
    provider: (fetchRes.provider || 'direct'),
    signals: parsed.decision || 'heuristic',
    conf: parsed.conf.toFixed(2)
  });

  // Any extra tokens (e.g., extract:{...})
  if (parsed.extraTokens && parsed.extraTokens.length) {
    parsed.extraTokens.forEach(t => appendSourceToken_(sheetName, rowIndex, t.kind, t.obj || {}));
  }
}

/********** Parse queue **********/

/**
 * processNextBatch(returnBoolean=false)
 * - Pulls up to BATCH_SIZE queued rows from the parse queue.
 * - For each:
 *    a) fetchSmartFree_(url)
 *    b) decideCompanyRole_(html, finalUrl)
 *    c) if conf===0 and fetch wasn’t via renderer, try renderer once more
 *    d) writeBack_ + maybeEnqueueNote_ + updateStatusCell_("ok")
 * - Deletes processed queue rows bottom-up.
 *
 * Return:
 *  - If returnBoolean=true, returns true if we processed any items; else false.
 */
function processNextBatch(returnBoolean=false) {
  const PROPS = PropertiesService.getScriptProperties();
  const batchSize = Number(PROPS.getProperty('BATCH_SIZE') || 12);
  const perMinute = Number(PROPS.getProperty('REQUESTS_PER_MINUTE') || 60);
  const gapMs = Math.floor(60000 / Math.max(1, perMinute));

  const q = getQueueSheet_();
  const vals = q.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][3] === 'queued') {
      items.push({ qi: i + 1, sheetName: vals[i][0], rowIndex: vals[i][1], url: vals[i][2] });
      if (items.length >= batchSize) break;
    }
  }
  if (!items.length) return returnBoolean ? false : undefined;

  const toDelete = [];
  items.forEach((item, idx) => {
    try {
      const first = fetchSmartFree_(item.url);
      let html = first.html || '';
      let finalUrl = first.finalUrl || item.url;

      let parsed = decideCompanyRole_(html, finalUrl);

      // If nothing extracted (conf===0), escalate once to renderer and re-parse
      if (parsed.conf === 0 && first.provider !== 'renderer') {
        const rer = fetchViaRenderer_(finalUrl);
        if (rer && rer.html) {
          const parsed2 = decideCompanyRole_(rer.html, rer.finalUrl || finalUrl);
          if (parsed2.conf > parsed.conf) {
            parsed = parsed2;
            appendSourceToken_(item.sheetName, item.rowIndex, 'fetch', { escalated: 'renderer' });
          }
        }
      }

      writeBack_(item.sheetName, item.rowIndex, parsed, { provider: first.provider });

      // enqueue notes idempotently (only if missing)
      maybeEnqueueNote_(item.sheetName, item.rowIndex, parsed);

      // status cell
      updateStatusCell_(item.sheetName, item.rowIndex, 'ok');
    } catch (err) {
      // Any runtime/network error → mark row error with short message
      updateStatusCell_(item.sheetName, item.rowIndex, 'error', String(err.message||err).slice(0,300));
    }
    toDelete.push(item.qi);
    if (idx < items.length - 1) Utilities.sleep(gapMs); // throttle to avoid rate limits
  });

  // Clean queue (delete processed rows bottom-up so indices don't shift)
  toDelete.sort((a,b)=>b-a).forEach(qi => q.deleteRow(qi));
  return returnBoolean ? true : undefined;
}

/**
 * updateStatusCell_
 * Writes Status (“ok” / “error” / “queued”) and optionally appends a text to Source.
 */
function updateStatusCell_(sheetName, rowIndex, status, sourceAppend) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sheet) return;
  const headerMap = getHeaderMap_(sheet);
  if (headerMap[HEADERS.status]) sheet.getRange(rowIndex, headerMap[HEADERS.status]).setValue(status);
  if (sourceAppend && headerMap[HEADERS.source]) {
    const prev = sheet.getRange(rowIndex, headerMap[HEADERS.source]).getDisplayValue().trim();
    sheet.getRange(rowIndex, headerMap[HEADERS.source]).setValue(prev ? (prev + ' | ' + sourceAppend) : sourceAppend);
  }
}

/********** Profile + snippets (for Notes) **********/

/**
 * readProfile_
 * Reads key/value pairs from the "Profile" sheet (2 columns: key, value).
 * Example rows:
 *  - headline | Staff-level full-stack engineer
 *  - one-line hook | I ship customer-facing features fast
 *  - top skills | React, Node, Postgres, GCP
 */
function readProfile_() {
  const ss = SpreadsheetApp.getActive();
  const s = ss.getSheetByName(PROFILE_SHEET_NAME);
  if (!s) return {};
  const vals = s.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < vals.length; i++) {
    const k = (vals[i][0]||'').toString().trim();
    const v = (vals[i][1]||'').toString().trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Removes tags/scripts/styles and returns a compact text preview for LLM prompts. */
function textPreview_(html, limit=1200) {
  if (!html) return '';
  const noTags = html.replace(/<script[\s\S]*?<\/script>/gi,' ')
                     .replace(/<style[\s\S]*?<\/style>/gi,' ')
                     .replace(/<[^>]+>/g,' ')
                     .replace(/\s+/g,' ').trim();
  return noTags.slice(0, limit);
}

/**
 * buildNoteSnippet_
 * Packages job page + parsed fields + user profile for the notes LLM/template.
 * This is the single source of truth for the notes prompt data.
 */
function buildNoteSnippet_(url, html, parsed, sheetName) {
  const h1 = getH1_(html);
  const ogTitle = getMeta_(html, 'og:title', 'property');
  const ogSite  = getMeta_(html, 'og:site_name', 'property');
  const title   = getTitle_(html);
  const body    = textPreview_(html, 1000);
  const profile = readProfile_();
  return {
    url: makeCanonical_(url),
    company: parsed.company || '',
    role: parsed.role || '',
    h1, ogTitle, ogSite, title,
    body_preview: body,
    profile,
    sheet: sheetName
  };
}

/********** Notes LLM (optional) **********/

/**
 * llmNotes_
 * Generates LinkedIn outreach JSON { invite, followup, meta } using your LLM endpoint.
 * Guardrails:
 *  - System prompt forces STRICT JSON, short invite, and a longer follow-up.
 *  - If LLM fails, caller will fall back to template.
 */
function llmNotes_(snippet) {
  const PROPS = PropertiesService.getScriptProperties();
  const endpoint = PROPS.getProperty('LLM_ENDPOINT');
  const key = PROPS.getProperty('LLM_API_KEY');
  const model = PROPS.getProperty('LLM_MODEL') || 'llama-3.1-8b-instant';
  if (!endpoint || !key) return null;

  const sys = [
    "You craft brief LinkedIn outreach.",
    "Return STRICT JSON: {\"invite\":\"...\",\"followup\":\"...\",\"meta\":\"llm\"}. No extra text.",
    "invite: <=280 chars. No emojis. Friendly, recruiter-appropriate.",
    "followup: 280–500 chars; specific hook from job/company if present; no emojis.",
    "Write for a generic recruiter/manager (no personal names)."
  ].join('\n');

  const user = "Snippet:\n" + JSON.stringify(snippet, null, 2);

  const payload = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: user }
    ],
    temperature: 0.4,
    max_tokens: 380
  };

  const resp = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) throw new Error('LLM ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0,300));
  try {
    const j = JSON.parse(resp.getResponseCode() === 204 ? '{}' : resp.getContentText());
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const trimmed = (content || '').trim();
    const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end+1));
  } catch (_) {}
  return null;
}

/********** Notes template fallback **********/

/**
 * renderTemplateNotes_
 * Deterministic backup when LLM is off/slow/failed.
 * Produces a short invite (≤280) + a longer follow-up, grounded in Profile + parsed fields.
 */
function renderTemplateNotes_(snippet) {
  const me = snippet.profile || {};
  const hook = me['one-line hook'] || me['headline'] || 'software engineer';
  const comp = snippet.company || 'your company';
  const role = snippet.role || 'this role';

  const invite = [
    `Hi there — I applied for ${role} at ${comp}.`,
    `I'm a ${hook} and would love to connect.`
  ].join(' ');

  const followup = [
    `Thanks for connecting! I just applied for ${role} at ${comp}.`,
    `My background includes ${me['top skills'] || 'full-stack development and shipping production features'}.`,
    `If there’s a chance to chat, I’d value 10–15 minutes to share how I can contribute.`
  ].join(' ');

  return { invite: invite.slice(0,280), followup, meta: 'template' };
}

/********** Notes queue **********/

/**
 * maybeEnqueueNote_
 * Adds the row to the notes queue only if the notes columns are empty (idempotent).
 * This is called after parsing finishes, so we don’t run the notes LLM twice.
 */
function maybeEnqueueNote_(sheetName, rowIndex, parsed) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headerMap = getHeaderMap_(sheet);
  const liInviteCol = headerMap[HEADERS.liInvite];
  const liFollowCol = headerMap[HEADERS.liFollow];
  if (!liInviteCol || !liFollowCol) return;

  // If both notes already exist, do nothing
  const inv = sheet.getRange(rowIndex, liInviteCol).getDisplayValue().trim();
  const fol = sheet.getRange(rowIndex, liFollowCol).getDisplayValue().trim();
  if (inv && fol) return;

  const nq = getNotesQueueSheet_();
  const vals = nq.getDataRange().getValues();
  const exists = vals.some((v,i)=> i>0 && v[0]===sheetName && v[1]===rowIndex && (v[3]==='queued' || v[3]==='processing'));
  if (exists) return;

  nq.getRange(nq.getLastRow()+1, 1, 1, 6).setValues([[sheetName, rowIndex, 'post-parse', 'queued', now_(), '']]);
}

/**
 * processNotesBatch(returnBoolean=false)
 * - Pulls up to NOTES_BATCH_SIZE queued note jobs.
 * - For each:
 *    a) Fetch the job page again (same smart strategy) to build a fresh snippet.
 *    b) Use existing Company/Role from the row (do NOT overwrite).
 *    c) Try LLM; on failure or disabled, render template.
 *    d) Write LI Invite + LI Follow-up; mark notes:{mode=llm|template}.
 */
function processNotesBatch(returnBoolean=false) {
  const PROPS = PropertiesService.getScriptProperties();
  const batchSize = Number(PROPS.getProperty('NOTES_BATCH_SIZE') || 12);
  const perMinute = Number(PROPS.getProperty('NOTES_PER_MINUTE') || 60);
  const gapMs = Math.floor(60000 / Math.max(1, perMinute));
  const useLLM = (PROPS.getProperty('USE_LLM') || '1') === '1';

  const nq = getNotesQueueSheet_();
  const vals = nq.getDataRange().getValues();

  const items = [];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][3] === 'queued') {
      items.push({ qi:i+1, sheetName: vals[i][0], rowIndex: vals[i][1] });
      if (items.length >= batchSize) break;
    }
  }
  if (!items.length) return returnBoolean ? false : undefined;

  const toDelete = [];
  items.forEach((item, idx) => {
    try {
      const ss = SpreadsheetApp.getActive();
      const sheet = ss.getSheetByName(item.sheetName);
      if (!sheet) throw new Error('Sheet missing');

      const headerMap = getHeaderMap_(sheet);
      const linkCol = headerMap[HEADERS.link];
      const liInviteCol = headerMap[HEADERS.liInvite];
      const liFollowCol = headerMap[HEADERS.liFollow];
      if (!linkCol || !liInviteCol || !liFollowCol) throw new Error('Columns missing');

      // Idempotency before heavy work
      const inv0 = sheet.getRange(item.rowIndex, liInviteCol).getDisplayValue().trim();
      const fol0 = sheet.getRange(item.rowIndex, liFollowCol).getDisplayValue().trim();
      if (inv0 && fol0) { toDelete.push(item.qi); return; }

      // Fetch again for a fresh snippet (renderer fallback used)
      const url = sheet.getRange(item.rowIndex, linkCol).getDisplayValue().trim();
      const first = fetchSmartFree_(url);
      const html = first.html || '';
      const finalUrl = first.finalUrl || url;

      // Use already parsed company/role if present (DO NOT overwrite them)
      const company = headerMap[HEADERS.company] ? sheet.getRange(item.rowIndex, headerMap[HEADERS.company]).getDisplayValue().trim() : '';
      const role    = headerMap[HEADERS.role]    ? sheet.getRange(item.rowIndex, headerMap[HEADERS.role]).getDisplayValue().trim()    : '';
      const parsed = { company, role };

      const snippet = buildNoteSnippet_(finalUrl, html, parsed, item.sheetName);

      let note = null, mode = 'template';
      try {
        if (useLLM) {
          note = llmNotes_(snippet);
          if (note) mode = 'llm';
        }
      } catch (llmErr) {
        // Log the LLM error to the queue row; still fall back to template
        getNotesQueueSheet_().getRange(item.qi, 6).setValue(String(llmErr.message||llmErr).slice(0,300));
      }
      if (!note) note = renderTemplateNotes_(snippet);

      const invite = (note.invite || '').toString().slice(0, 280);
      const follow = (note.followup || '').toString();
      sheet.getRange(item.rowIndex, liInviteCol).setValue(invite);
      sheet.getRange(item.rowIndex, liFollowCol).setValue(follow);

      // Mark notes source (readable)
      appendSourceToken_(item.sheetName, item.rowIndex, 'notes', { mode });

    } catch (e) {
      nq.getRange(item.qi, 6).setValue(String(e.message||e).slice(0,300));
    }
    toDelete.push(item.qi);
    if (idx < items.length - 1) Utilities.sleep(gapMs);
  });

  toDelete.sort((a,b)=>b-a).forEach(qi => nq.deleteRow(qi));
  return returnBoolean ? true : undefined;
}

/********** Debug helpers **********/

/** Quick renderer sanity-check against a static test page. */
function debugRenderer() {
  const r = fetchViaRenderer_('https://httpbin.org/html');
  Logger.log(JSON.stringify({
    ok: !!r, status: r && r.status, final: r && r.finalUrl,
    first200: r && (r.html||'').slice(0,200)
  }, null, 2));
}

/** Run one small notes batch (useful when testing LLM/template behavior). */
function debugNotesOnce() {
  processNotesBatch(true);
}
