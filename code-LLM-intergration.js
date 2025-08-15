/********** CONFIG: header names (must match row 1 exactly) **********/
const HEADERS = {
    link:       'Link',
    canonical:  'Canonical Link',
    company:    'Company (auto)',
    role:       'Role (auto)',
    status:     'Status',
    source:     'Source',
    // Notes
    liInvite:   'LI Invite',
    liFollow:   'LI Follow-up',
  };
  
  const QUEUE_SHEET_NAME   = 'Queue';
  const NOTES_QUEUE_SHEET  = 'NotesQueue';
  const PROFILE_SHEET_NAME = 'Profile';
  const HEADER_ROW = 1;
  
  /********** Utilities **********/
  function now_() { return new Date(); }
  
  function getHeaderMap_(sheet) {
    const row = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
    const map = {};
    row.forEach((h, i) => { if (h && !(h in map)) map[h] = i + 1; }); // first occurrence wins
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
  
  function getNotesQueueSheet_() {
    const ss = SpreadsheetApp.getActive();
    let q = ss.getSheetByName(NOTES_QUEUE_SHEET);
    if (!q) {
      q = ss.insertSheet(NOTES_QUEUE_SHEET);
      q.getRange(1,1,1,6).setValues([[
        'sheet_name','row_index','phase','status','enqueued_at','last_error'
      ]]);
    } else {
      const h = q.getRange(1,1,1,Math.max(6,q.getLastColumn())).getValues()[0];
      if (!String(h[0]||'').match(/sheet_name/i)) {
        q.getRange(1,1,1,6).setValues([[
          'sheet_name','row_index','phase','status','enqueued_at','last_error'
        ]]);
      }
    }
    return q;
  }
  
  function hostFromUrl_(u) {
    try { const h = new URL(u).hostname.toLowerCase(); return h.startsWith('www.') ? h.slice(4) : h; }
    catch(e) { return ''; }
  }
  
  /********** Menu **********/
  function onOpen() {
    SpreadsheetApp.getUi()
      .createMenu('Job Parser')
      .addItem('Enqueue selected rows', 'enqueueSelectedRows')
      .addItem('Drain all queues (parse + notes)', 'drainAllQueues')
      .addToUi();
  }
  
  /********** AUTO enqueue on paste/edit in Link col, then drain **********/
  function onEditHandler(e) {
    try {
      if (!e || !e.range) return;
      const sheet = e.range.getSheet();
      const headerMap = getHeaderMap_(sheet);
      const linkCol = headerMap[HEADERS.link];
      if (!linkCol) return;
  
      const r = e.range;
      const startRow = r.getRow();
      const endRow   = r.getRow() + r.getNumRows() - 1;
      const startCol = r.getColumn();
      const endCol = r.getColumn() + r.getNumColumns() - 1;
      if (!(linkCol >= startCol && linkCol <= endCol)) return;
  
      const q = getQueueSheet_();
      const qVals = q.getDataRange().getValues();
      const toAppend = [];
      const statusCol = headerMap[HEADERS.status];
  
      for (let row = startRow; row <= endRow; row++) {
        if (row <= HEADER_ROW) continue;
        const url = sheet.getRange(row, linkCol).getDisplayValue().trim();
        if (!/^https?:\/\//i.test(url)) continue;
  
        // idempotency: only one queued/processing per (sheet,row)
        const exists = qVals.some((v,i) => i>0 && v[0]===sheet.getName() && v[1]===row && (v[3]==='queued' || v[3]==='processing'));
        if (exists) continue;
  
        toAppend.push([sheet.getName(), row, url, 'queued', 0, now_(), '', '']);
        if (statusCol) sheet.getRange(row, statusCol).setValue('queued');
      }
  
      if (toAppend.length) {
        q.getRange(q.getLastRow()+1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
      }
      drainAllQueues();
    } catch (err) { console.error(err); }
  }
  
  /********** Manual enqueue **********/
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
  
        const exists = qVals.some((v,ix) => ix>0 && v[0]===sheet.getName() && v[1]===rowIndex && (v[3]==='queued' || v[3]==='processing'));
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
  function drainAllQueues() {
    const start = Date.now();
    const budgetMs = 5*60*1000 - 15000;
    while (Date.now() - start < budgetMs) {
      const didParse = processNextBatch(true);
      const didNotes = processNotesBatch(true);
      if (!didParse && !didNotes) break;
    }
  }
  
  /********** Networking helpers **********/
  function isAtsHost_(h) {
    const re = /(lever\.co|ashbyhq\.com|job-boards\.greenhouse\.io|boards\.greenhouse\.io|myworkdayjobs\.com|workdayjobs\.com|smartrecruiters\.com|jobvite\.com|apply\.workable\.com|ats\.rippling\.com|recruiting(?:2)?\.ultipro\.com|icims\.com|oraclecloud\.com|brassring\.com|paylocity\.com)/i;
    return re.test(h);
  }
  function isAggregatorHost_(h) {
    const re = /(jobright\.ai|allup\.world|ycombinator\.com|linkedin\.com|indeed\.com|glassdoor\.com|levels\.fyi|builtin\.(?:com|nyc|chicago|sf)|wellfound\.com|angel\.co|dice\.com|monster\.com|ziprecruiter\.com)/i;
    return re.test(h);
  }
  
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
  
  function directFetch_(url) {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
    });
    return { status: resp.getResponseCode(), finalUrl: url, html: resp.getContentText(), provider: 'direct' };
  }
  
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
  
  // Cloud Run Playwright renderer
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
  
  function findFirstAtsLinkIn_(html) {
    const hrefRe = /href=["'](https?:\/\/[^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(html))) {
      try { if (isAtsHost_(hostFromUrl_(m[1]))) return m[1]; } catch(_) {}
    }
    return '';
  }
  
  // Best-effort fetch with renderer fallback only when needed
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
  
  /********** Extractors **********/
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
  function niceCase_(slug) { return slug.replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g, s => s.toUpperCase()); }
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
  function stripEmojis_(s) {
    try { return String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, ''); }
    catch (e) {
      return String(s || '')
        .replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u27BF\u2B00-\u2BFF\u2600-\u26FF]/g, '')
        .replace(/\uFE0F/g, '');
    }
  }
  function decodeHtml_(s) {
    return String(s || '')
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  }
  function cleanRole_(title, company) {
    if (!title) return '';
    let r = String(title).replace(/<[^>]*>/g, '');
    r = decodeHtml_(r);
    r = stripEmojis_(r);
    if (company) {
      const c = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      r = r.replace(new RegExp('^\\s*' + c + '\\s*[-–—:]*\\s*', 'i'), '');
      r = r.replace(new RegExp('\\s*[-–—:]*\\s*' + c + '\\s*$', 'i'), '');
    }
    r = r.replace(/\s*-\s*[A-Z][a-z]+(?:,?\s*[A-Z]{2})?$/, '');
    r = r.replace(/\s*[-–—]?\s*((JR|Req|R|ID|Job)[\s#:]*\d+|\d{5,})\s*$/i, '');
    return r.replace(/\s+/g, ' ').trim();
  }
  function makeCanonical_(url) {
    try {
      const u = new URL(url);
      const del = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gh_src','src','source','vq_campaign','vq_source','__jvst','__jvsd','codes','gh_jid'];
      del.forEach(k => u.searchParams.delete(k));
      return u.toString();
    } catch(e) { return url; }
  }
  
  /********** LLM extractor for company/role (optional) **********/
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
    let conf = 0.0;
    let notes = [];
    const extraTokens = [];
  
    if (json.company) { company = json.company; conf += 0.5; notes.push('jsonld-org'); }
    if (json.role)    { role    = json.role;    conf += 0.5; notes.push('jsonld-title'); }
  
    if (!company) {
      const fromUrl = guessCompanyFromUrl_(finalUrl);
      if (fromUrl) { company = fromUrl; conf += 0.35; notes.push('ats-slug'); }
    }
  
    if (!role) {
      if (h1)          { role = h1;       conf += 0.35; notes.push('h1'); }
      else if (ogTitle){ role = ogTitle;  conf += 0.25; notes.push('og:title'); }
      else if (title)  { role = title;    conf += 0.15; notes.push('title'); }
    }
  
    // Only trust og:site_name if NOT an aggregator
    if (!company && ogSite && !isAgg) { company = ogSite; conf += 0.25; notes.push('og:site_name'); }
  
    // Rescue split: "Company – Role"
    if (!company && role && /.+\s[-–—]\s.+/.test(role)) {
      const parts = role.split(/\s[-–—]\s/);
      if (parts.length >= 2) {
        company = parts[0].trim();
        role = parts.slice(1).join(' - ').trim();
        notes.push('title-split');
        conf = Math.max(conf, 0.55);
      }
    }
  
    role = cleanRole_(role, company);
  
    // Optional LLM extractor if empty or role looks generic
    const PROPS = PropertiesService.getScriptProperties();
    const useExtractLLM = (PROPS.getProperty('USE_EXTRACT_LLM') || '1') === '1';
    const looksGeneric = !role || isGenericTitle_(role);
  
    if (useExtractLLM && (looksGeneric || !company)) {
      let extractErr = null;
      try {
        const snippet = {
          url: canonical,
          h1, ogTitle, ogSite, title,
          body_preview: textPreview_(html, 2000)
        };
        const guess = llmExtractCompanyRole_(snippet);
        if (guess && (guess.company || guess.role)) {
          if (!company && guess.company) company = guess.company;
          if (looksGeneric && guess.role) role = cleanRole_(guess.role, company);
          conf = Math.max(conf, 0.6);
          extraTokens.push({ kind: 'extract', obj: { mode: 'llm' } });
        } else {
          extractErr = 'no-output';
        }
      } catch (e) {
        extractErr = String(e.message || e);
      }
      if (extractErr) extraTokens.push({ kind: 'extract', obj: { mode: 'llm', err: extractErr } });
    }
  
    // Clamp confidence
    if (!company) conf = Math.min(conf, 0.5);
    if (!role)    conf = Math.min(conf, 0.5);
    conf = Math.max(0, Math.min(1, conf));
  
    return { company, role, canonical, conf, decision: notes.join('+') || 'heuristic', extraTokens };
  }
  
  /********** Source helpers (readable & non-destructive) **********/
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
  
        // If nothing extracted, escalate once to renderer and re-parse
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
  
        // enqueue notes idempotently
        maybeEnqueueNote_(item.sheetName, item.rowIndex, parsed);
  
        // status cell
        updateStatusCell_(item.sheetName, item.rowIndex, 'ok');
      } catch (err) {
        updateStatusCell_(item.sheetName, item.rowIndex, 'error', String(err.message||err).slice(0,300));
      }
      toDelete.push(item.qi);
      if (idx < items.length - 1) Utilities.sleep(gapMs);
    });
  
    toDelete.sort((a,b)=>b-a).forEach(qi => q.deleteRow(qi));
    return returnBoolean ? true : undefined;
  }
  
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
  function textPreview_(html, limit=1200) {
    if (!html) return '';
    const noTags = html.replace(/<script[\s\S]*?<\/script>/gi,' ')
                       .replace(/<style[\s\S]*?<\/style>/gi,' ')
                       .replace(/<[^>]+>/g,' ')
                       .replace(/\s+/g,' ').trim();
    return noTags.slice(0, limit);
  }
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
  function debugRenderer() {
    const r = fetchViaRenderer_('https://httpbin.org/html');
    Logger.log(JSON.stringify({
      ok: !!r, status: r && r.status, final: r && r.finalUrl,
      first200: r && (r.html||'').slice(0,200)
    }, null, 2));
  }
  function debugNotesOnce() {
    processNotesBatch(true);
  }
  