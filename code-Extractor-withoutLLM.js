// MVP-3 [looking good on extraction, but having credits problem so going to a different approach, this supports app link sheet.]
/********** CONFIG **********/
// Default header texts (must match row 1 exactly when used)
const HEADERS = {
    link:       'link',
    canonical:  'Canonical/Changed Link',
    company:    'Company name (auto)',
    role:       'Role name (auto)',
    status:     'Current Status',
    source:     'Source Details',
  };
  
  
  // If you want to restrict auto-processing to specific tabs, list them here.
  // Set to null to allow all tabs.
  const SHEETS_WHITELIST = ['App Link']; // <- add/remove sheet names as needed
  
  // If a sheet uses different header names, override here by sheet name.
  // Leave empty or identical to HEADERS if not needed.
  const HEADERS_PER_SHEET = {
    // Example (same as default; change only if your App Link tab uses different labels)
    'App Link': {
      link:       'Link',
      canonical:  'Canonical Link',
      company:    'Company (auto)',
      role:       'Role (auto)',
      status:     'Status',
      source:     'Source',
    },
    // 'Some Other Sheet': { link: 'Job URL', ... }
  };
  
  const QUEUE_SHEET_NAME = 'Queue';
  const HEADER_ROW = 1;
  
  /********** Utilities **********/
  function headersForSheet_(sheetName) {
    const overrides = HEADERS_PER_SHEET[sheetName];
    return overrides ? overrides : HEADERS;
  }
  
  function getHeaderMap_(sheet) {
    const row = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
    const map = {};
    row.forEach((h, i) => { map[h] = i + 1; });
    return map;
  }
  
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
  
  function now_() { return new Date(); }
  
  function hostFromUrl_(u) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h.startsWith('www.') ? h.slice(4) : h;
    } catch(e) { return ''; }
  }
  
  /********** Menu **********/
  function onOpen() {
    SpreadsheetApp.getUi()
      .createMenu('Job Parser')
      .addItem('Enqueue selected rows', 'enqueueSelectedRows')
      .addItem('Process next batch now', 'processNextBatch')
      .addToUi();
  }
  
  /********** AUTO: enqueue on paste/edit in Link column, then process **********/
  function onEditHandler(e) {
    try {
      const sheet = e.range.getSheet();
      const name = sheet.getName();
  
      if (SHEETS_WHITELIST && !SHEETS_WHITELIST.includes(name)) return;
  
      const HEAD = headersForSheet_(name);
      const headerMap = getHeaderMap_(sheet);
      const linkCol = headerMap[HEAD.link];
      if (!linkCol) return;
  
      const r = e.range;
      const startRow = r.getRow();
      const endRow = r.getRow() + r.getNumRows() - 1;
      const startCol = r.getColumn();
      const endCol = r.getColumn() + r.getNumColumns() - 1;
  
      const touchesLinkCol = (linkCol >= startCol && linkCol <= endCol);
      if (!touchesLinkCol) return;
  
      const q = getQueueSheet_();
      const qVals = q.getDataRange().getValues();
      const toAppend = [];
      const statusCol = headerMap[HEAD.status];
  
      for (let row = startRow; row <= endRow; row++) {
        if (row <= HEADER_ROW) continue;
        const url = sheet.getRange(row, linkCol).getDisplayValue().trim();
        if (!/^https?:\/\//i.test(url)) continue;
        // Avoid duplicate queue entries for same sheet/row
        const exists = qVals.some((v,i) => i>0 && v[0]===name && v[1]===row);
        if (exists) continue;
        toAppend.push([name, row, url, 'queued', 0, now_(), '', '']);
        if (statusCol) sheet.getRange(row, statusCol).setValue('queued');
      }
  
      if (toAppend.length) {
        q.getRange(q.getLastRow() + 1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
        processNextBatch(); // immediate
      }
    } catch (err) { console.error(err); }
  }
  
  /********** Manual enqueue (optional) **********/
  function enqueueSelectedRows() {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getActiveSheet();
    const name = sheet.getName();
  
    if (SHEETS_WHITELIST && !SHEETS_WHITELIST.includes(name)) {
      SpreadsheetApp.getUi().alert('This tab is not whitelisted for parsing.');
      return;
    }
  
    const HEAD = headersForSheet_(name);
    const headerMap = getHeaderMap_(sheet);
    const linkCol = headerMap[HEAD.link];
    if (!linkCol) { SpreadsheetApp.getUi().alert(`Couldn't find header "${HEAD.link}" on row 1.`); return; }
  
    const sel = sheet.getActiveRangeList().getRanges();
    const q = getQueueSheet_();
    const qVals = q.getDataRange().getValues();
  
    const toAppend = [];
    const statusCol = headerMap[HEAD.status];
  
    sel.forEach(range => {
      const rows = range.getValues();
      rows.forEach((_, i) => {
        const rowIndex = range.getRow() + i;
        if (rowIndex <= HEADER_ROW) return;
        const url = sheet.getRange(rowIndex, linkCol).getDisplayValue().trim();
        if (!/^https?:\/\//i.test(url)) return;
        const exists = qVals.some((v,ix) => ix>0 && v[0]===name && v[1]===rowIndex);
        if (exists) return;
        toAppend.push([name, rowIndex, url, 'queued', 0, now_(), '', '']);
        if (statusCol) sheet.getRange(rowIndex, statusCol).setValue('queued');
      });
    });
  
    if (toAppend.length) {
      q.getRange(q.getLastRow() + 1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
      processNextBatch();
    }
  }
  
  /********** Batch processing (single attempt; deletes queue rows after) **********/
  function processNextBatch() {
    const PROPS = PropertiesService.getScriptProperties();
    const batchSize = Number(PROPS.getProperty('BATCH_SIZE') || 10);
    const perMinute = Number(PROPS.getProperty('REQUESTS_PER_MINUTE') || 60);
    const gapMs = Math.floor(60000 / Math.max(1, perMinute));
  
    const ss = SpreadsheetApp.getActive();
    const q = getQueueSheet_();
    const vals = q.getDataRange().getValues();
    const items = [];
  
    for (let i = 1; i < vals.length; i++) {
      if (vals[i][3] === 'queued') {
        items.push({ qi: i + 1, sheetName: vals[i][0], rowIndex: vals[i][1], url: vals[i][2] });
        if (items.length >= batchSize) break;
      }
    }
    if (!items.length) return;
  
    const toDelete = [];
    items.forEach((item, idx) => {
      try {
        // 1) Fetch original
        const first = fetchRendered_(item.url); // {status, finalUrl, html, provider}
        // 2) Maybe unwrap aggregator to ATS & optionally refetch once
        const resolved = resolveTargetUrl_(item.url, first);
        const html = resolved.html || first.html;
        const finalUrl = resolved.finalUrl || first.finalUrl || item.url;
        const provider = resolved.provider || first.provider;
  
        // 3) Extract company/role with confidence and decision path
        const parsed = decideCompanyRole_(html, finalUrl); // {company, role, canonical, conf, decision}
  
        // 4) Write back
        writeBack_(item.sheetName, item.rowIndex, parsed, { provider });
  
        // Mark status ok
        updateStatusCell_(item.sheetName, item.rowIndex, 'ok', `${provider} | ${parsed.decision} | conf=${parsed.conf.toFixed(2)}`);
      } catch (err) {
        const msg = (err && err.message) ? String(err.message) : String(err);
        updateStatusCell_(item.sheetName, item.rowIndex, 'error', msg.slice(0, 200));
      }
      toDelete.push(item.qi);
      if (idx < items.length - 1) Utilities.sleep(gapMs);
    });
  
    // Clean queue (bottom-up)
    toDelete.sort((a,b)=>b-a).forEach(qi => q.deleteRow(qi));
  }
  
  /********** Update status/source **********/
  function updateStatusCell_(sheetName, rowIndex, status, source) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) return;
  
    const HEAD = headersForSheet_(sheetName);
    const headerMap = getHeaderMap_(sheet);
  
    if (headerMap[HEAD.status]) sheet.getRange(rowIndex, headerMap[HEAD.status]).setValue(status);
    if (headerMap[HEAD.source]) sheet.getRange(rowIndex, headerMap[HEAD.source]).setValue(source || '');
  }
  
  /********** Network fetch (scrape.do → ScrapingBee → direct) **********/
  function fetchRendered_(url) {
    const PROPS = PropertiesService.getScriptProperties();
    const beeKey = PROPS.getProperty('SCRAPINGBEE_API_KEY');   // optional fallback
    const doToken = PROPS.getProperty('SCRAPEDO_API_TOKEN');   // main provider
  
    if (beeKey) {
      const base = PROPS.getProperty('SCRAPINGBEE_BASE') || 'https://app.scrapingbee.com/api/v1/';
      const api = base + '?api_key=' + encodeURIComponent(beeKey) +
                  '&url=' + encodeURIComponent(url) +
                  '&render_js=true&wait_browser=domcontentloaded';
      const resp = UrlFetchApp.fetch(api, { muteHttpExceptions:true, followRedirects:true });
      const status = resp.getResponseCode();
      const headers = resp.getAllHeaders ? resp.getAllHeaders() : resp.getHeaders();
      const finalUrl = (headers['X-Scrapingbee-Final-Url'] || headers['x-scrapingbee-final-url'] || url);
      if (status < 400) return { status, finalUrl, html: resp.getContentText(), provider: 'scrapingbee' };
      throw new Error('Bee ' + status + ': ' + resp.getContentText().slice(0,300));
    }
  
    if (doToken) {
      const base = PROPS.getProperty('SCRAPEDO_BASE') || 'https://api.scrape.do/';
      const api = base + '?token=' + encodeURIComponent(doToken) +
                  '&url=' + encodeURIComponent(url) +
                  '&render=true';
      const resp = UrlFetchApp.fetch(api, { muteHttpExceptions:true, followRedirects:true });
      const status = resp.getResponseCode();
      if (status < 400) return { status, finalUrl: url, html: resp.getContentText(), provider: 'scrape.do' };
      throw new Error('Scrape.do ' + status + ': ' + resp.getContentText().slice(0,300));
    }
  
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
    });
    return { status: resp.getResponseCode(), finalUrl: url, html: resp.getContentText(), provider: 'direct' };
  }
  
  /********** Aggregator detection + unwrap to ATS **********/
  function isAtsHost_(h) {
    const re = /(lever\.co|ashbyhq\.com|job-boards\.greenhouse\.io|boards\.greenhouse\.io|myworkdayjobs\.com|workdayjobs\.com|smartrecruiters\.com|jobvite\.com|apply\.workable\.com|ats\.rippling\.com|recruiting(?:2)?\.ultipro\.com|icims\.com|oraclecloud\.com|brassring\.com|paylocity\.com)/i;
    return re.test(h);
  }
  function isAggregatorHost_(h) {
    const re = /(jobright\.ai|allup\.world|ycombinator\.com|linkedin\.com|indeed\.com|glassdoor\.com|levels\.fyi|builtin\.(?:com|nyc|chicago|sf)|wellfound\.com|angel\.co|dice\.com|monster\.com|ziprecruiter\.com)/i;
    return re.test(h);
  }
  function findFirstAtsLink_(html) {
    const hrefRe = /href=["'](https?:\/\/[^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(html))) {
      try {
        const h = hostFromUrl_(m[1]);
        if (isAtsHost_(h)) return m[1];
      } catch(_) { /* ignore */ }
    }
    return '';
  }
  function resolveTargetUrl_(originalUrl, firstFetch) {
    const h = hostFromUrl_(firstFetch.finalUrl || originalUrl);
    if (!isAggregatorHost_(h)) {
      return { finalUrl: firstFetch.finalUrl || originalUrl, html: firstFetch.html, provider: firstFetch.provider, decision: 'direct' };
    }
    // unwrap to first ATS link, if any
    const atsUrl = findFirstAtsLink_(firstFetch.html);
    if (!atsUrl) {
      // stay on aggregator; parser will try JSON-LD / OG
      return { finalUrl: firstFetch.finalUrl || originalUrl, html: firstFetch.html, provider: firstFetch.provider, decision: 'aggregator-no-unwrap' };
    }
    // Refetch once on ATS for clean title/H1/JSON-LD
    const second = fetchRendered_(atsUrl);
    return { finalUrl: second.finalUrl || atsUrl, html: second.html, provider: second.provider, decision: 'aggregator-unwrapped' };
  }
  
  /********** Extractors (JSON-LD, META, H1, URL patterns) **********/
  function getMeta_(html, key, attr) {
    const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i');
    const m = re.exec(html);
    return m ? m[1].trim() : '';
  }
  function getTitle_(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return m ? m[1].replace(/\s+/g,' ').trim() : '';
  }
  function getH1_(html) {
    const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (!m) return '';
    return m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  }
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
  function niceCase_(slug) {
    return slug.replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g, s => s.toUpperCase());
  }
  function guessCompanyFromUrl_(url) {
    const u = url.toLowerCase();
    let m;
    // Greenhouse (both hosts)
    if ( (m = u.match(/(?:job-boards|boards)\.greenhouse\.io\/([^\/?#]+)\/jobs\//)) ) return niceCase_(m[1]);
    // Lever
    if ( (m = u.match(/jobs\.lever\.co\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // Ashby
    if ( (m = u.match(/jobs\.ashbyhq\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // Workable
    if ( (m = u.match(/apply\.workable\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // SmartRecruiters
    if ( (m = u.match(/jobs\.smartrecruiters\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // Jobvite
    if ( (m = u.match(/jobs\.jobvite\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // Rippling ATS
    if ( (m = u.match(/ats\.rippling\.com\/([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // Workday (tenant anywhere after domain, handles /en-US/<tenant>/)
    if ( (m = u.match(/myworkdayjobs\.com\/(?:[a-z-]+\/)?([^\/?#]+)\//)) ) return niceCase_(m[1]);
    if ( (m = u.match(/workdayjobs\.com\/(?:[a-z-]+\/)?([^\/?#]+)\//)) ) return niceCase_(m[1]);
    // Paylocity trailing company segment
    if ( (m = u.match(/recruiting\.paylocity\.com\/.*\/Details\/\d+\/([^\/?#]+)/)) ) return niceCase_(m[1]);
    // UltiPro / Oracle / Brassring -> often rely on OG/JSON-LD
    return '';
  }
  
  /********** Emoji + HTML entity helpers **********/
  function stripEmojis_(s) {
    try {
      return String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
    } catch (e) {
      return String(s || '')
        .replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u27BF\u2B00-\u2BFF\u2600-\u26FF]/g, '')
        .replace(/\uFE0F/g, '');
    }
  }
  function decodeHtml_(s) {
    return String(s || '')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }
  
  /********** Keep original role; remove emojis only **********/
  function cleanRole_(title, company) {
    if (!title) return '';
    let r = String(title).replace(/<[^>]*>/g, ''); // strip any HTML tags
    r = decodeHtml_(r);
    r = stripEmojis_(r);
    r = r.replace(/\s+/g, ' ').trim();
    return r;
  }
  
  function makeCanonical_(url) {
    try {
      const u = new URL(url);
      const del = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gh_src','src','source','vq_campaign','vq_source','__jvst','__jvsd','codes','gh_jid'];
      del.forEach(k => u.searchParams.delete(k));
      return u.toString();
    } catch(e) { return url; }
  }
  
  /********** Decision logic with confidence **********/
  function decideCompanyRole_(html, finalUrl) {
    const host = hostFromUrl_(finalUrl);
  
    // Try JSON-LD first
    const json = parseJsonLdJobPosting_(html);
    const ogSite = getMeta_(html, 'og:site_name', 'property');
    const h1 = getH1_(html);
    const ogTitle = getMeta_(html, 'og:title', 'property');
    const title = getTitle_(html);
  
    // Prefer H1 → then OG:title → then <title> (e.g., Intuit → “Software Engineer 2”)
    const pageTitle = h1 || ogTitle || title;
  
    let company = '';
    let role = '';
  
    let conf = 0.0;
    let notes = [];
  
    if (json.company) { company = json.company; conf += 0.5; notes.push('jsonld-org'); }
    if (json.role)    { role    = json.role;    conf += 0.5; notes.push('jsonld-title'); }
  
    // ATS slug
    if (!company) {
      const fromUrl = guessCompanyFromUrl_(finalUrl);
      if (fromUrl) { company = fromUrl; conf += 0.35; notes.push('ats-slug'); }
    }
  
    // Role from H1/OG/TITLE
    if (!role) {
      if (h1)          { role = h1;       conf += 0.35; notes.push('h1'); }
      else if (ogTitle){ role = ogTitle;  conf += 0.25; notes.push('og:title'); }
      else if (title)  { role = title;    conf += 0.15; notes.push('title'); }
    }
  
    // Company from og:site_name if still empty
    if (!company && ogSite) { company = ogSite; conf += 0.25; notes.push('og:site_name'); }
  
    // Cleanup (emoji strip only)
    role = cleanRole_(role, company);
    const canonical = makeCanonical_(finalUrl);
  
    // Clamp confidence
    if (!company) conf = Math.min(conf, 0.5);
    if (!role)    conf = Math.min(conf, 0.5);
    conf = Math.max(0, Math.min(1, conf));
  
    return { company, role, canonical, conf, decision: notes.join('+') || 'heuristic' };
  }
  
  /********** Write back **********/
  function writeBack_(sheetName, rowIndex, parsed, fetchRes) {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  
    const HEAD = headersForSheet_(sheetName);
    const headerMap = getHeaderMap_(sheet);
  
    const cols = [];
    const vals = [];
    if (headerMap[HEAD.canonical]) { cols.push(headerMap[HEAD.canonical]); vals.push(parsed.canonical); }
    if (headerMap[HEAD.company])   { cols.push(headerMap[HEAD.company]);   vals.push(parsed.company); }
    if (headerMap[HEAD.role])      { cols.push(headerMap[HEAD.role]);      vals.push(parsed.role); }
    if (headerMap[HEAD.source])    { cols.push(headerMap[HEAD.source]);    vals.push((fetchRes.provider||'direct')); }
  
    if (cols.length) {
      const minCol = Math.min.apply(null, cols);
      const maxCol = Math.max.apply(null, cols);
      const out = new Array(maxCol - minCol + 1).fill('');
      cols.forEach((c, i) => { out[c - minCol] = vals[i]; });
      sheet.getRange(rowIndex, minCol, 1, out.length).setValues([out]);
    }
  }
  
  /********** Debug helper **********/
  function debugScrapeDo() {
    const PROPS = PropertiesService.getScriptProperties();
    const token = PROPS.getProperty('SCRAPEDO_API_TOKEN');
    if (!token) throw new Error('No SCRAPEDO_API_TOKEN set.');
    const url = 'https://httpbin.org/html';
    const api = (PROPS.getProperty('SCRAPEDO_BASE') || 'https://api.scrape.do/') +
                '?token=' + encodeURIComponent(token) +
                '&url=' + encodeURIComponent(url) +
                '&render=true';
    const r = UrlFetchApp.fetch(api, { muteHttpExceptions:true });
    Logger.log('Status: ' + r.getResponseCode());
    Logger.log('Body first 200: ' + r.getContentText().slice(0,200));
  }  