

async function initConfig() {
  const data = await chrome.storage.local.get(['cfg']);

  let cfg = {
    dropcontactKey: '',
    lemlistKey: '',
    apolloKey: '',
    useApollo: false,
    keywords: [],
    ...data.cfg
  };

  if (!cfg.keywords || cfg.keywords.length === 0) {
    try {
      const res = await fetch(chrome.runtime.getURL('default_keywords.txt'));
      const text = await res.text();

      cfg.keywords = text.split('\n').map(k => k.trim()).filter(Boolean);

      await chrome.storage.local.set({ cfg });

      console.log('Default keywords loaded:', cfg.keywords.length);
    } catch (e) {
      console.error('Keyword load error', e);
    }
  }

  return cfg;
}

// override loadConfig to ensure compatibility
async function loadConfig() {
  return await initConfig();
}


const KEYWORD_WEIGHTS = {
  "socio": 5,
  "titolare": 5,
  "proprietario": 5,
  "owner": 5,
  "founder": 5,
  "co-founder": 5,
  "cofondatore": 5,
  "ceo": 5,
  "chief executive officer": 5,
  "presidente": 5,
  "president": 5,
  "chairman": 5,
  "amministratore": 5,
  "administrator": 5,
  "legale rappresentante": 5,
  "managing director": 5,
  "general manager": 5,
  "ad": 4,
  "gm": 4,
  "coo": 4,
  "chief operating officer": 4,
  "direttore": 4,
  "director": 4,
  "dirigente": 4,
  "responsabile": 3,
  "board": 3,
  "cda": 3,
  "consigliere": 3,
  "vice presidente": 3,
  "vice president": 3,
  "direzione": 3,
  "imprenditore": 3,
  "chief": 2,
  "service": 2,
  "assistenza": 2,
  "purchas": 2,
  "it": 1
};

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/[^a-z0-9+#&/ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreContactRole(role, keywords = []) {
  const text = normalizeText(role);
  let score = 0;
  const matched = [];

  for (const rawKw of keywords) {
    const kw = normalizeText(rawKw);
    if (!kw) continue;

    if (text.includes(kw)) {
      const weight = KEYWORD_WEIGHTS[kw] || 1;
      score += weight;
      matched.push({ keyword: rawKw, weight });
    }
  }

  return { score, matched };
}

function rankContacts(contacts, keywords = []) {
  return (contacts || [])
    .map(contact => {
      const roleText = contact.role || contact.headline || contact.rawText || "";
      const result = scoreContactRole(roleText, keywords);

      return {
        ...contact,
        targetScore: result.score,
        matchedKeywords: result.matched
      };
    })
    .filter(c => c.targetScore >= 2)
    .sort((a, b) => b.targetScore - a.targetScore);
}



async function loadDefaultKeywords() {
  const res = await fetch(chrome.runtime.getURL('default_keywords.txt'));
  const text = await res.text();
  return text.replace(/\r/g, '').split('\n').map(k => k.trim()).filter(Boolean);
}

const $ = id => document.getElementById(id);

const MAKE_WEBHOOK_URL_FALLBACK = 'https://hook.eu2.make.com/szgez9azswbys5z12czvs9oqblfq7yz1';
const getMakeWebhookUrl = () => cfg.makeWebhookSc4 || MAKE_WEBHOOK_URL_FALLBACK;

function normalizeLinkedinCompanyUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const companyMatch = parsed.pathname.match(/\/company\/([^\/?#]+)/i);
    if (companyMatch && companyMatch[1]) {
      return `https://www.linkedin.com/company/${companyMatch[1]}`.toLowerCase();
    }

    const cleanPath = parsed.pathname.replace(/\/+$|\/people.*$/gi, '');
    if (!cleanPath) return '';
    return `https://www.linkedin.com${cleanPath}`.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

function buildMakePayload(contact, email) {
  const nameParts = (contact.fullName || contact.name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = contact.firstName || nameParts[0] || '';
  const lastName = contact.lastName || nameParts.slice(1).join(' ') || '';
  const cleanCompany = cleanCompanyName(contact.company || '');
  const cleanWebsite = contact.companyWebsite || '';
  const cleanCompanyDomain = cleanDomain(contact.companyDomain || contact.companyWebsite || '');
  const companyLinkedinUrl = normalizeLinkedinCompanyUrl(contact.companyLinkedinUrl || state.currentCompany?.url || '');

  return {
    source: 'grizzly-extension',
    action: 'send_to_lemlist_via_make',
    sentAt: new Date().toISOString(),
    contact: {
      firstName,
      lastName,
      fullName: contact.fullName || [firstName, lastName].filter(Boolean).join(' '),
      email: email || '',
      role: contact.role || '',
      jobDescription: contact.jobDescription || contact.role || '',
      linkedinUrl: contact.profileUrl || '',
    },
    company: {
      name: cleanCompany,
      website: cleanWebsite,
      domain: cleanCompanyDomain,
      linkedinUrl: companyLinkedinUrl,
    },
    meta: {
      targetScore: Number(contact.targetScore || 0),
      matchReason: contact.matchReason || '',
      matchedKeywords: contact.matchedKeywords || [],
      positiveSignals: contact.positiveSignals || [],
      negativeSignals: contact.negativeSignals || [],
      rawText: contact.rawText || '',
      // ── v2: tracciamento sorgente per routing in Make ────────────────────
      sourceType: contact._source === 'linkedin_persona_first' ? 'linkedin_persona_first' : 'linkedin_company',
      searchQuery: contact._searchQuery || '',
      searchUrl: contact._searchUrl || '',
      searchFilters: contact._searchChips || [],
      emailStrategy: contact._source === 'linkedin_persona_first' ? (cfg.searchEmailStrategy || 'apollo_fallback') : 'cascade',
    },
    rawContact: {
      ...contact,
      email: email || contact.email || '',
      company: cleanCompany,
      companyWebsite: cleanWebsite,
      companyDomain: cleanCompanyDomain,
      companyLinkedinUrl,
    },
  };
}


// ── STATO BATCH ──────────────────────────────────────────────────────────────
let batchState = {
  running: false,
  stopped: false,
  queue: [],      // array di URL string
  current: 0,
  total: 0,
  allResults: [], // [{companyUrl, companyName, contacts:[...]}]
};

// ── STATO ────────────────────────────────────────────────────────────────────
let state = {
  running: false,
  stopped: false,
  mode: 'auto',     // 'auto' | 'manual'
  found: 0,
  added: 0,
  emailsFound: 0,
  noEmail: 0,
  contacts: [],     // tutti i contatti trovati
  results: [],      // contatti processati
  currentCompany: null,
  lockedTabId: null,
  lockedTabUrl: '',
};

let cfg = {
  lemlistKey: '',
  dropcontactKey: '',
  keywords: [],
  keywordRules: [],
  penaltyRules: [],
  useDropcontact: false,
  useLemlistEmail: false,
  maxProfiles: 30,
  delay: 5, // v2: default alzato da 3 a 5 per max prudenza umana sul flow Ricerca
  // ── v2: Opzioni Ricerca Persone ───────────────────────────────────────────
  searchMaxPages: 5,
  searchEmailStrategy: 'apollo_fallback', // 'apollo_fallback' | 'apollo_only' | 'standard_cascade'
  searchApplyScoring: false,
  // ── v3.2: Cache progresso per resume ricerche ─────────────────────────────
  // { [searchUrlKey]: { lastPage, completedAt, totalContacts, originalUrl } }
  searchProgress: {},
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseEnabled: false,
};

// ── TABS ─────────────────────────────────────────────────────────────────────


// ── MODE ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  state.mode = m;
  if ($('modeAuto')) $('modeAuto').classList.toggle('active', m === 'auto');
  if ($('modeManual')) $('modeManual').classList.toggle('active', m === 'manual');
}

// ── LOG ──────────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const container = $('logContainer');
  const empty = container.querySelector('.log-empty');
  if (empty) empty.remove();

  const icons = { ok: '✓', error: '✕', warn: '⚠', info: '·' };
  const now = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = now;
  const iconEl = document.createElement('span');
  iconEl.className = 'log-icon';
  iconEl.textContent = icons[type] || '·';
  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = msg;
  entry.appendChild(timeEl);
  entry.appendChild(iconEl);
  entry.appendChild(msgEl);
  container.appendChild(entry);
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

// ── STATS ────────────────────────────────────────────────────────────────────
function updateStats() {
  if ($('statFound')) $('statFound').textContent = state.found;
  if ($('statFoundResults')) $('statFoundResults').textContent = state.found;
  if ($('statEmails')) $('statEmails').textContent = state.emailsFound || 0;
  if ($('statEmailsResults')) $('statEmailsResults').textContent = state.emailsFound || 0;
  if ($('statNoEmail')) $('statNoEmail').textContent = state.noEmail;
  if ($('statNoEmailResults')) $('statNoEmailResults').textContent = state.noEmail;
}


function getTargetTabId() {
  return state.lockedTabId || null;
}

async function getTrackedTab() {
  const res = await chrome.runtime.sendMessage({
    type: 'GET_ACTIVE_TAB',
    tabId: getTargetTabId() || undefined,
  });
  return res?.tab || null;
}

async function execInTrackedPage(funcName, args = []) {
  return await chrome.runtime.sendMessage({
    type: 'EXECUTE_IN_PAGE',
    funcName,
    args,
    tabId: getTargetTabId() || undefined,
  });
}

// ── POLLING COMPANY PAGE ─────────────────────────────────────────────────────
async function detectCompanyPage() {
  try {
    const tab = await getTrackedTab();
    if (!tab) {
      if (!state.running) {
        state.currentCompany = null;
        const banner2 = $('companyBanner');
        if (banner2) {
          banner2.innerHTML = '';
          const notFound = document.createElement('div');
          notFound.className = 'company-notfound';
          notFound.textContent = 'Naviga su una company page LinkedIn per iniziare';
          banner2.appendChild(notFound);
        }
        const btnStart = $('btnStart');
        if (btnStart) btnStart.disabled = true;
      }
      return;
    }

    const url = tab.url || '';
    const isCompany = url.includes('/company/');

    if (isCompany) {
      let name = '';
      try {
        const pageRes = await execInTrackedPage('__grizzly_getCompanyName');
        name = cleanCompanyName(pageRes?.result || '');
      } catch (e) {}

      if (!name) name = cleanCompanyName(tab.title || '');

      state.currentCompany = { ...(state.currentCompany || {}), url, name, tabId: tab.id };
      if (state.lockedTabId && tab.id === state.lockedTabId) {
        state.lockedTabUrl = url;
      }

      const b = $('companyBanner');
      if (b) {
        b.innerHTML = '';
        const nd = document.createElement('div');
        nd.className = 'company-name';
        nd.textContent = cleanCompanyName(name) || 'Azienda LinkedIn';
        const ud = document.createElement('div');
        ud.className = 'company-url';
        ud.textContent = state.lockedTabId ? `${url} (tab bloccata)` : url;
        b.appendChild(nd);
        b.appendChild(ud);
      }

      const onPeople = url.includes('/people');
      const btnStart = $('btnStart');
      if (btnStart) { btnStart.disabled = false; btnStart.textContent = onPeople ? '🐻 Avvia Grizzly' : '🐻 Avvia Grizzly (vai su Persone prima)'; }
    } else if (!state.running && !state.lockedTabId) {
      state.currentCompany = null;
      const banner2 = $('companyBanner');
      if (banner2) {
        banner2.innerHTML = '';
        const notFound = document.createElement('div');
        notFound.className = 'company-notfound';
        notFound.textContent = 'Naviga su una company page LinkedIn per iniziare';
        banner2.appendChild(notFound);
      }
      const btnStart = $('btnStart');
      if (btnStart) btnStart.disabled = true;
    }
  } catch (e) {
    console.error('detectCompanyPage:', e);
  }
}

// ── SLEEP// ── SLEEP// ── SLEEP ─────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const humanDelay = () => sleep((cfg.delay * 1000) + Math.random() * 2000);

// ── ATTENDI CARICAMENTO TAB ───────────────────────────────────────────────────
// LinkedIn è una SPA: il tab può restare in status "loading" a lungo.
// Strategia: aspettiamo che l'URL sia arrivato su linkedin.com e si stabilizzi
// (stesso URL per 2 poll consecutivi), poi procediamo.
async function waitForTabLoad(tabId, timeout = 60000) {
  const start = Date.now();
  let lastUrl = '';
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_TAB_URL', tabId });
      const url = res?.url || '';
      const status = res?.status || '';

      if (url.includes('linkedin.com')) {
        if (url === lastUrl) {
          stableCount++;
          // URL stabile per 2 poll consecutivi → pagina pronta
          if (stableCount >= 2) return url;
        } else {
          stableCount = 1;
          lastUrl = url;
        }
      } else {
        // URL non ancora LinkedIn: reset
        lastUrl = '';
        stableCount = 0;
      }
    } catch (e) { /* ignora errori transitori */ }
    await sleep(1000);
  }
  addLog('Timeout attesa caricamento pagina LinkedIn', 'warn');
  return null;
}





function cleanDomain(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function strictNormalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9+#&/ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function strictEscapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function strictTokenPattern(keyword) {
  const kw = strictNormalizeText(keyword);
  if (!kw) return null;
  if (!kw.includes(' ')) {
    return new RegExp(`(^|[^a-z0-9])${strictEscapeRegex(kw)}([^a-z0-9]|$)`, 'i');
  }
  const parts = kw.split(' ').filter(Boolean).map(strictEscapeRegex);
  const pattern = parts.join('[^a-z0-9]+');
  return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i');
}

function strictKeywordMatches(keyword, normalizedText) {
  const rx = strictTokenPattern(keyword);
  if (!rx) return false;
  return rx.test(normalizedText);
}

function dedupeRuleMatches(rules) {
  const seen = new Set();
  const out = [];
  for (const r of rules || []) {
    const key = `${strictNormalizeText(r.keyword)}::${Number(r.weight || 0)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function analyzeLeadStrict(person) {
  const name = String(person?.name || person?.fullName || '').trim();
  const role = String(person?.role || '').trim();
  const jobDescription = String(person?.jobDescription || role || '').trim();
  const sourceText = [role, jobDescription, person?.rawText || ''].filter(Boolean).join(' ');
  const normalized = strictNormalizeText(sourceText);
  const rules = (typeof getKeywordRules === 'function' ? getKeywordRules() : []);

  const matchedRules = [];
  let score = 0;

  for (const rule of rules) {
    const keyword = String(rule.keyword || '').trim();
    const weight = Number(rule.weight || 0);
    if (!keyword) continue;
    if (strictKeywordMatches(keyword, normalized)) {
      matchedRules.push({ keyword, weight });
      score += weight;
    }
  }

  const dedupedMatches = dedupeRuleMatches(matchedRules);
  score = dedupedMatches.reduce((acc, r) => acc + Number(r.weight || 0), 0);

  const negativeHits = [];
  const penaltyRules = getPenaltyRules();
  for (const rule of penaltyRules) {
    const kw = String(rule.keyword || '').trim();
    const weight = Number(rule.weight || 0);
    if (!kw) continue;
    if (strictKeywordMatches(kw, normalized)) {
      negativeHits.push({ keyword: kw, weight });
      score += weight;
    }
  }

  const notPerson = !name || (typeof isLikelyCompanyLabel === 'function' && isLikelyCompanyLabel(name)) || String(name).trim().split(/\s+/).length < 2;
  if (notPerson) score -= 10;

  const accepted = !notPerson && dedupedMatches.length > 0 && score >= 2;

  const reasonParts = [];
  if (dedupedMatches.length) {
    reasonParts.push('match: ' + dedupedMatches.map(r => `${r.keyword} (${r.weight > 0 ? '+' : ''}${r.weight})`).join(', '));
  }
  if (negativeHits.length) {
    reasonParts.push('penalita: ' + negativeHits.map(r => `${r.keyword} (${r.weight})`).join(', '));
  }
  if (notPerson) {
    reasonParts.push('non-persona/azienda');
  }

  return {
    accepted,
    score,
    matchedRules: dedupedMatches,
    negativeHits,
    reason: reasonParts.join(' | ') || 'nessun match'
  };
}


function cleanCompanyName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*[:\-–|]\s*(persone|people|panoramica|overview)\s*$/i, '')
    .replace(/\s*[:\-–|]\s*(persone|people|panoramica|overview).*$/i, '')
    .replace(/\|\s*linkedin.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeMatchText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+#&/ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function defaultPenaltyRules() {
  return [
    { keyword: 'assistant', weight: -4 },
    { keyword: 'executive assistant', weight: -4 },
    { keyword: 'recruiter', weight: -4 },
    { keyword: 'talent acquisition', weight: -4 },
    { keyword: 'intern', weight: -5 },
    { keyword: 'trainee', weight: -5 },
    { keyword: 'student', weight: -5 },
    { keyword: 'hr', weight: -3 },
    { keyword: 'human resources', weight: -3 },
    { keyword: 'engineer', weight: -2 },
    { keyword: 'ingegnere', weight: -2 },
    { keyword: 'tecnico', weight: -2 },
    { keyword: 'progettista', weight: -2 },
    { keyword: 'consultant', weight: -2 },
    { keyword: 'consulente', weight: -2 },
    { keyword: 'specialist', weight: -1 },
    { keyword: 'specialista', weight: -1 },
    { keyword: 'marketing', weight: -2 },
    { keyword: 'project manager', weight: -3 },
    { keyword: 'sales', weight: -3 },
    { keyword: 'jr', weight: -3 }
  ];
}

function defaultWeightForKeyword(kw) {
  const key = normalizeMatchText(kw);
  const map = {
    'socio': 5, 'titolare': 5, 'proprietario': 5, 'owner': 5, 'founder': 5, 'co-founder': 5, 'cofondatore': 5,
    'ceo': 5, 'chief executive officer': 5, 'presidente': 5, 'president': 5, 'chairman': 5, 'amministratore': 5,
    'administrator': 5, 'legale rappresentante': 5, 'managing director': 5, 'general manager': 5,
    'ad': 4, 'gm': 4, 'coo': 4, 'chief operating officer': 4, 'direttore': 4, 'director': 4, 'dirigente': 4,
    'responsabile': 3, 'board': 3, 'cda': 3, 'c.d.a.': 4, 'maintenance': 3, 'operativo': 2, 'manager': 2, 'consigliere': 3, 'vice presidente': 3, 'vice president': 3,
    'direzione': 3, 'imprenditore': 3, 'chief': 2, 'purchas': 2, 'it': 1, 'service': 1, 'assistenza': 1
  };
  return map[key] || 1;
}


function getPenaltyRules() {
  if (Array.isArray(cfg.penaltyRules) && cfg.penaltyRules.length > 0) {
    return cfg.penaltyRules
      .map(r => ({ keyword: String(r.keyword || '').trim(), weight: Number(r.weight || 0) }))
      .filter(r => r.keyword);
  }
  return defaultPenaltyRules();
}

function getKeywordRules() {
  if (Array.isArray(cfg.keywordRules) && cfg.keywordRules.length > 0) {
    return cfg.keywordRules
      .map(r => ({ keyword: String(r.keyword || '').trim(), weight: Number(r.weight || 0) }))
      .filter(r => r.keyword);
  }
  if (Array.isArray(cfg.keywords) && cfg.keywords.length > 0) {
    return cfg.keywords
      .map(k => ({ keyword: String(k || '').trim(), weight: defaultWeightForKeyword(k) }))
      .filter(r => r.keyword);
  }
  return [];
}

function keywordMatchesText(keyword, normalizedText) {
  return strictKeywordMatches(keyword, normalizedText);
}

function deriveRoleAndDescription(rawRole) {
  const jobDescription = String(rawRole || '').trim();
  if (!jobDescription) return { role: '', jobDescription: '' };

  const separators = [' | ', ' — ', ' - ', ' presso ', ' @'];
  let role = jobDescription;
  for (const sep of separators) {
    const idx = role.indexOf(sep);
    if (idx > 0) {
      role = role.slice(0, idx).trim();
      break;
    }
  }
  if (role.length > 90) role = role.slice(0, 90).trim();
  return { role, jobDescription };
}

function isLikelyCompanyLabel(name) {
  return /\b(s\.?r\.?l\.?|s\.?p\.?a\.?|ltd|llc|inc|holding|group)\b/i.test(String(name || ''));
}


function analyzeTarget(person) {
  return analyzeLeadStrict(person);
}

function analyzeLead(person) {
  return analyzeLeadStrict(person);
}

async function findEmailApollo(contact) {
  if (!cfg.apolloKey || !cfg.useApollo) return null;
  addLog(`Apollo enrichment: provo ${contact.fullName}${contact.companyDomain ? ' @ ' + contact.companyDomain : ''}`, 'info');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'API_CALL',
      url: 'https://api.apollo.io/api/v1/people/match',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': cfg.apolloKey,
      },
      body: {
        first_name: contact.firstName,
        last_name: contact.lastName,
        linkedin_url: contact.profileUrl,
        reveal_personal_emails: false,
      }
    });
    const email = res?.data?.person?.email;
    if (email && email.includes('@')) {
      addLog(`Apollo → ${email}`, 'ok');
      return email;
    }
    addLog(`Apollo enrichment: nessuna email (status: ${res?.data?.person?.email_status || 'n/d'})`, 'warn');
  } catch(e) {
    addLog(`Apollo errore: ${e.message}`, 'warn');
  }
  return null;
}

// ── CERCA EMAIL CON DROPCONTACT ──────────────────────────────────────────────

function extractDropcontactEmail(data) {
  try {
    const payload = Array.isArray(data?.data) ? data.data[0] : null;
    const emails = payload?.email;
    if (Array.isArray(emails) && emails.length > 0) {
      const best = emails.find(e => (e?.qualification || '').startsWith('nominative@')) || emails[0];
      return best?.email || null;
    }
    if (typeof emails === 'string' && emails.includes('@')) return emails;
  } catch (e) {}
  return null;
}


async function pollDropcontactResult(requestId, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await sleep(i === 0 ? 4000 : 5000);
    const result = await chrome.runtime.sendMessage({
      type: 'API_CALL',
      url: `https://api.dropcontact.com/v1/enrich/all/${requestId}?forceResults=true`,
      method: 'GET',
      headers: { 'X-Access-Token': cfg.dropcontactKey },
    });

    const email = extractDropcontactEmail(result?.data);
    addLog(`Dropcontact poll ${i + 1}/${tries}: ${email ? 'email trovata' : 'ancora niente'}`, email ? 'ok' : 'info');
    if (email) return email;
  }
  return null;
}

async function findEmailDropcontact(contact) {
  if (!cfg.dropcontactKey || !cfg.useDropcontact) return null;
  try {
    const website = contact.companyWebsite || '';
    const domain = cleanDomain(website || contact.companyDomain || '');
    const payload = {
      first_name: contact.firstName || '',
      last_name: contact.lastName || '',
      full_name: contact.fullName || '',
      company: contact.company || '',
      linkedin: contact.profileUrl || '',
    };
    if (website) payload.website = website;
    if (contact.role) payload.job = contact.role;

    addLog(`Dropcontact: provo ${contact.fullName}${domain ? ' @ ' + domain : ''}`, 'info');

    const res = await chrome.runtime.sendMessage({
      type: 'API_CALL',
      url: 'https://api.dropcontact.com/v1/enrich/all',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': cfg.dropcontactKey,
      },
      body: {
        data: [payload],
        siren: false,
        language: 'en',
      }
    });

    const requestId = res?.data?.request_id;
    if (!requestId) {
      addLog('Dropcontact: request_id mancante', 'warn');
      return null;
    }

    const email = await pollDropcontactResult(requestId, 6);
    if (email) {
      addLog(`Dropcontact → ${email}`, 'ok');
      return email;
    }

    addLog('Dropcontact: nessun risultato', 'warn');
  } catch(e) {
    addLog(`Dropcontact errore: ${e.message}`, 'warn');
  }
  return null;
}

// ── AGGIUNGI A LEMLIST ────────────────────────────────────────────────────────

async function findEmailLemlist(contact) {
  if (!cfg.lemlistKey || !cfg.useLemlistEmail) return null;

  try {
    const auth = btoa(`:${cfg.lemlistKey}`);
    const domain = cleanDomain(contact.companyWebsite || contact.companyDomain || '');
    const params = new URLSearchParams({
      findEmail: 'true',
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      companyName: cleanCompanyName(contact.company || ''),
      companyDomain: domain,
      linkedinUrl: contact.profileUrl || '',
    });

    addLog(`Lemlist enrichment: provo ${contact.fullName}${domain ? ' @ ' + domain : ''}`, 'info');

    const createRes = await chrome.runtime.sendMessage({
      type: 'API_CALL',
      url: `https://api.lemlist.com/api/enrich?${params.toString()}`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
      },
    });

    const enrichId = createRes?.data?.id;
    if (!enrichId) {
      const raw = JSON.stringify(createRes?.data || createRes).slice(0, 300);
      addLog(`Lemlist enrichment: id mancante — risposta: ${raw}`, 'warn');
      return null;
    }

    for (let i = 0; i < 6; i++) {
      await sleep(i === 0 ? 3000 : 4000);
      const result = await chrome.runtime.sendMessage({
        type: 'API_CALL',
        url: `https://api.lemlist.com/api/enrich/${encodeURIComponent(enrichId)}`,
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + auth,
        },
      });

      const status = result?.data?.enrichmentStatus;
      const email = result?.data?.data?.email?.email || result?.data?.data?.find_email?.email || null;
      addLog(`Lemlist enrichment poll ${i + 1}/6: ${status || 'pending'}`, email ? 'ok' : 'info');

      if (email && email.includes('@')) {
        addLog(`Lemlist enrichment → ${email}`, 'ok');
        return email;
      }

      if (status === 'failed') break;
    }
  } catch (e) {
    addLog(`Lemlist enrichment errore: ${e.message}`, 'warn');
  }

  return null;
}

async function sendToMake(contact, email) {
  // Architettura v3: i contatti vengono scritti su Supabase e processati dalla webapp (Sc.4)
  addLog(`⬡ ${contact.fullName || contact.name || 'Contatto'} salvato su Supabase — verrà caricato tramite webapp`, 'info');
  return true;
}

async function addToLemlist(contact, email) {
  return await sendToMake(contact, email);
}


// ── PROCESSA UN CONTATTO ──────────────────────────────────────────────────────
async function processContact(contact) {
  addLog(`Processando: ${contact.fullName} — ${contact.role}`, 'info');
  if (contact.matchReason) addLog(`Motivo match: ${String(contact.matchReason).replace(/^match:\s*/i, '')}`, 'info');

  let email = null;

  if (cfg.useDropcontact && cfg.dropcontactKey) {
    email = await findEmailDropcontact(contact);
  }

  if (!email && cfg.useLemlistEmail && cfg.lemlistKey) {
    email = await findEmailLemlist(contact);
  }

  if (!email && cfg.useApollo && cfg.apolloKey) {
    email = await findEmailApollo(contact);
  }

  if (!email) {
    addLog(`Nessuna email trovata per ${contact.fullName}`, 'warn');
    state.noEmail++;
  } else {
    state.emailsFound++;
  }

  const added = false;

  const result = {
    ...contact,
    email,
    added,
    enriched: true,
    ts: new Date().toISOString(),
  };

  const existingIndex = state.results.findIndex(r => (r.profileUrl && r.profileUrl === contact.profileUrl) || (r.fullName === contact.fullName && r.role === contact.role));
  if (existingIndex >= 0) {
    state.results[existingIndex] = { ...state.results[existingIndex], ...result };
  } else {
    state.results.push(result);
  }

  updateStats();
  renderResults();

  return result;
}

// ── SCROLL E CARICA// ── SCROLL E CARICA PIÙ ───────────────────────────────────────────────────────
async function scrollAndLoadMore(maxScrolls = 6) {
  for (let i = 0; i < maxScrolls; i++) {
    if (state.stopped) break;

    // Chiudi eventuali modal aperti
    await execInTrackedPage('__grizzly_closeModal');
    await sleep(300);

    // Scroll naturale fino all'ultimo profilo visibile
    await execInTrackedPage('__grizzly_naturalScroll');
    await sleep(2000 + Math.random() * 1000);

    // Clicca "Mostra altri risultati" con log dettagliato
    const showMoreRes = await execInTrackedPage('__grizzly_clickShowMore');
    const smResult = showMoreRes?.result;
    if (smResult?.clicked) {
      addLog('Cliccato: "' + smResult.text + '"', 'ok');
      await sleep(2500);
    } else if (smResult?.candidates?.length > 0) {
      smResult.candidates.forEach(c => {
        addLog('Candidato non cliccato: "' + c.text + '" | product:' + c.isProduct + ' modal:' + c.inModal, 'warn');
      });
    }
  }
}

// ── SCRAPING PRINCIPALE ───────────────────────────────────────────────────────
async function startScraping() {
  // Ricarica settings prima di partire (assicura che le API key siano caricate)
  await loadSettings();
  
  if (!state.currentCompany) {
    addLog('Naviga su una company page LinkedIn prima di avviare', 'error');
    return;
  }
  
  addLog(`Config: Lemlist ${cfg.lemlistKey ? '✓' : '✗'} | Dropcontact ${cfg.dropcontactKey ? '✓' : '✗'} | Apollo ${cfg.apolloKey ? '✓' : '✗'}`, 'info');

  const activeRes = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
  const activeTab = activeRes?.tab || null;
  if (activeTab?.id) {
    state.lockedTabId = activeTab.id;
    state.lockedTabUrl = activeTab.url || '';
    state.currentCompany = { ...(state.currentCompany || {}), tabId: activeTab.id, url: activeTab.url || state.currentCompany?.url || '' };
  }

  state.running = true;
  state.stopped = false;
  state.found = 0;
  state.added = 0;
  state.emailsFound = 0;
  state.noEmail = 0;
  state.contacts = [];
  updateStats();

  $('btnStart').disabled = true;
  $('btnStop').style.display = 'inline-flex';

  addLog(`🐻 Grizzly avviato su: ${cleanCompanyName(state.currentCompany.name)}`, 'info');

  try {
    // 0. Prova a estrarre il sito aziendale dalla pagina corrente
    try {
      const siteRes = await execInTrackedPage('__grizzly_extractCompanyWebsite');
      const website = siteRes?.result?.website || '';
      const domain = siteRes?.result?.domain || '';
      if (website || domain) {
        state.currentCompany.website = website;
        state.currentCompany.domain = domain;
        addLog(`Sito aziendale rilevato: ${domain || website}`, 'info');
      }
    } catch (e) {}

    // 1. Controlla se siamo sulla pagina People
    const isPeople = await execInTrackedPage('__grizzly_isPeoplePage');

    if (!isPeople?.result) {
      addLog('Navigando sulla pagina Persone...', 'info');
      await execInTrackedPage('__grizzly_clickPeopleTab');
      await sleep(3000);
    }

    // 1b. Riprova a leggere il sito anche sulla pagina People
    if (!state.currentCompany.website && !state.currentCompany.domain) {
      try {
        const siteRes2 = await execInTrackedPage('__grizzly_extractCompanyWebsite');
        const website2 = siteRes2?.result?.website || '';
        const domain2 = siteRes2?.result?.domain || '';
        if (website2 || domain2) {
          state.currentCompany.website = website2;
          state.currentCompany.domain = domain2;
          addLog(`Sito aziendale rilevato: ${domain2 || website2}`, 'info');
        }
      } catch (e) {}
    }

    // 2. Scroll e carica tutti i risultati solo se necessario
    addLog('Caricando tutti i risultati...');
    // Prima estrai quello che è già visibile
    const preCheck = await chrome.runtime.sendMessage({
      type: 'EXECUTE_IN_PAGE',
      funcName: '__grizzly_extractPeople',
    });
    const preCount = (preCheck?.result || []).length;
    if (preCount < 20) {
      // Solo se ci sono pochi profili, fai scroll
      await scrollAndLoadMore(6);
    }

    // 2b. Aspetta che la pagina si stabilizzi
    await sleep(2000);
    
    // Verifica che siamo ancora sulla pagina people
    const stillPeople = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVE_TAB'
    });
    const currentUrl = stillPeople?.tab?.url || '';
    addLog('URL corrente: ' + currentUrl.substring(0, 60), 'info');
    
    // 3. Estrai contatti dalla pagina
    addLog('Estraendo contatti dalla pagina...');
    const res = await chrome.runtime.sendMessage({
      type: 'EXECUTE_IN_PAGE',
      funcName: '__grizzly_extractPeople',
    });

    let allPeople = res?.result || [];
    const dbg = allPeople._debug || {};
    addLog(`Cards trovate: ${dbg.cardsFound || 0} | Link /in/: ${dbg.linksFound || 0} | Estratti: ${allPeople.length}`, allPeople.length > 0 ? 'ok' : 'warn');
    
    // Se estrazione normale fallisce, usa quella di emergenza
    if (allPeople.length === 0) {
      addLog('Provo estrazione di emergenza...', 'warn');
      const emergRes = await chrome.runtime.sendMessage({
        type: 'EXECUTE_IN_PAGE',
        funcName: '__grizzly_extractPeopleEmergency',
      });
      allPeople = emergRes?.result || [];
      addLog(`Emergenza: trovati ${allPeople.length} profili`, allPeople.length > 0 ? 'ok' : 'error');
    }
    
    if (dbg.skipped?.length > 0) addLog(`Skippati: ${dbg.skipped.length}`, 'warn');
    // Mostra primi 3 profili per debug
    allPeople.slice(0, 3).forEach(p => {
      addLog(`  📋 ${p.name} | ruolo: "${p.role || '(vuoto)'}"`, 'info');
    });

    // 4. Filtra con score spiegabile
    const analyzedPeople = allPeople.map(p => {
      const roleParts = deriveRoleAndDescription(p.role || '');
      const analysis = analyzeLeadStrict({
        name: p.name,
        role: roleParts.role,
        jobDescription: roleParts.jobDescription,
        rawText: p.rawText || `${p.name || ''} ${p.role || ''}`,
      });
      return {
        ...p,
        role: roleParts.role || p.role || '',
        jobDescription: roleParts.jobDescription || p.role || '',
        targetScore: analysis.score,
        matchedKeywords: analysis.matchedKeywords,
        positiveSignals: analysis.positiveSignals,
        negativeSignals: analysis.negativeSignals,
        matchReason: analysis.reason,
        accepted: analysis.accepted,
      };
    });

    const targets = analyzedPeople
      .filter(p => p.accepted)
      .sort((a, b) => b.targetScore - a.targetScore);

    addLog(`${targets.length} contatti in target per le keyword configurate`, targets.length > 0 ? 'ok' : 'warn');
    targets.slice(0, 8).forEach(p => {
      addLog(`Score ${p.targetScore} | ${p.name} | ${p.matchReason}`, 'info');
    });

    state.found = targets.length;
    updateStats();

    if (targets.length === 0) {
      addLog('Nessun contatto in target trovato. Prova ad aggiungere più keyword nelle impostazioni.', 'warn');
      finishRun();
      return;
    }

    // 5. Prepara contatti
    const contacts = targets.map(p => {
      const parts = p.name.split(' ');
      return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' ') || '',
        fullName: p.name,
        role: p.role || '',
        jobDescription: p.jobDescription || p.role || '',
        profileUrl: p.profileUrl,
        company: state.currentCompany.name,
        companyWebsite: state.currentCompany.website || '',
        companyDomain: state.currentCompany.domain || '',
        targetScore: p.targetScore || 0,
        matchedKeywords: p.matchedKeywords || [],
        positiveSignals: p.positiveSignals || [],
        negativeSignals: p.negativeSignals || [],
        matchReason: p.matchReason || '',
        rawText: p.rawText || '',
      };
    });

    // 6. Fase review: mostra subito i risultati, senza enrichment
    state.results = contacts.map(c => ({
      ...c,
      keep: true,
      enriched: false,
      added: false,
      email: '',
      ts: new Date().toISOString(),
    }));
    renderResults();

    // Scrivi su Supabase se abilitato
    writeContactsToSupabase(state.results, state.currentCompany?.url || '', state.currentCompany?.name || '');

    // porta automaticamente al tab risultati
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    const resultsTabBtn = document.querySelector('.tab[data-tab="results"]');
    if (resultsTabBtn) resultsTabBtn.classList.add('active');
    ['run','batch','results','keywords','settings'].forEach(n => {
      const el = document.getElementById('tab-' + n);
      if (el) el.style.display = n === 'results' ? 'block' : 'none';
    });

    addLog(`Review pronta: ${contacts.length} profili caricati. Scarta quelli fuori target e poi clicca "Cerca email selezionati".`, 'ok');

  } catch(e) {
    addLog(`Errore: ${e.message}`, 'error');
  }

  finishRun();
}

// ── MODALITÀ APPROVAZIONE ────────────────────────────────────────────────────
async function processWithApproval(contacts) {
  $('pendingCards').style.display = 'block';
  const list = $('pendingList');
  list.innerHTML = '';

  for (let i = 0; i < contacts.length; i++) {
    if (state.stopped) break;

    const contact = contacts[i];
    const cardId = `card_${i}`;

    // Prima cerca l'email
    addLog(`Cercando email per ${contact.fullName}...`);
    let email = null;
    if (cfg.useDropcontact && cfg.dropcontactKey) email = await findEmailDropcontact(contact);
    if (!email && cfg.useLemlistEmail && cfg.lemlistKey) email = await findEmailLemlist(contact);
    if (!email && cfg.useApollo && cfg.apolloKey) email = await findEmailApollo(contact);

    // Crea la card
    const card = document.createElement('div');
    card.className = 'contact-card';
    card.id = cardId;
    const nameEl2 = document.createElement('div');
    nameEl2.className = 'contact-name';
    nameEl2.textContent = contact.fullName;
    const roleEl2 = document.createElement('div');
    roleEl2.className = 'contact-role';
    roleEl2.textContent = `${contact.role || ''} — ${cleanCompanyName(contact.company || '')}`;
    const emailEl = document.createElement('div');
    emailEl.className = 'contact-email' + (email ? '' : ' notfound');
    emailEl.id = 'email_' + i;
    emailEl.textContent = email ? '✉ ' + email : '✕ Email non trovata';
    const actions = document.createElement('div');
    actions.className = 'contact-actions';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-secondary btn-sm';
    approveBtn.textContent = '✓ Aggiungi';
    approveBtn.addEventListener('click', () => approveContact(i));
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-danger btn-sm';
    rejectBtn.textContent = '✕ Salta';
    rejectBtn.addEventListener('click', () => rejectContact(i));
    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    if (contact.profileUrl) {
      const linkedinBtn = document.createElement('button');
      linkedinBtn.className = 'btn btn-secondary btn-sm';
      linkedinBtn.textContent = 'LinkedIn';
      linkedinBtn.addEventListener('click', () => openLinkedInProfile(contact.profileUrl));
      actions.appendChild(linkedinBtn);
    }
    card.appendChild(nameEl2);
    card.appendChild(roleEl2);
    if (contact.jobDescription && contact.jobDescription !== contact.role) {
      const descEl2 = document.createElement('div');
      descEl2.className = 'contact-role';
      descEl2.textContent = contact.jobDescription;
      card.appendChild(descEl2);
    }
    const reasonEl2 = document.createElement('div');
    reasonEl2.className = 'result-reason';
    reasonEl2.textContent = `Motivo: ${String(contact.matchReason || 'n/d').replace(/^match:\s*/i, '')}`;
    card.appendChild(reasonEl2);
    card.appendChild(emailEl);
    card.appendChild(actions);
    card.dataset.contact = JSON.stringify(contact);
    card.dataset.email = email || '';
    list.appendChild(card);

    // Aspetta l'approvazione (polling)
    await waitForApproval(cardId);
  }
}

function waitForApproval(cardId) {
  return new Promise(resolve => {
    const check = setInterval(() => {
      const card = $(cardId);
      if (!card || card.classList.contains('approved') || card.classList.contains('rejected')) {
        clearInterval(check);
        resolve();
      }
    }, 300);
  });
}

async function approveContact(i) {
  const card = $(`card_${i}`);
  if (!card) return;
  const contact = JSON.parse(card.dataset.contact);
  const email = card.dataset.email || null;
  card.classList.add('approved');
  const actionsDiv = card.querySelector('.contact-actions');
  if (actionsDiv) {
    actionsDiv.innerHTML = '';
    const doneSpan = document.createElement('span');
    doneSpan.style.cssText = 'color:var(--green);font-size:11px';
    doneSpan.textContent = '✓ Inviato a Make';
    actionsDiv.appendChild(doneSpan);
  }
  await addToLemlist(contact, email);
  state.added++;
  updateStats();
};

function rejectContact(i) {
  const card = $(`card_${i}`);
  if (card) card.classList.add('rejected');
};

// ── STOP ─────────────────────────────────────────────────────────────────────
function stopScraping() {
  state.stopped = true;
  addLog('⏹ Stop richiesto...', 'warn');
}

function finishRun() {
  state.running = false;
  state.lockedTabId = null;
  state.lockedTabUrl = '';
  $('btnStart').disabled = false;
  $('btnStop').style.display = 'none';
  addLog(`🏁 Completato — ${state.found} trovati, ${state.emailsFound || 0} con email, ${state.noEmail} senza email`, state.found > 0 ? 'ok' : 'warn');
}


// ── GOOGLE SHEETS INTEGRATION ─────────────────────────────────────────────────

// Converte un URL di Google Sheet in URL di export CSV
function buildSheetCsvUrl(sheetUrl) {
  try {
    const url = new URL(String(sheetUrl || '').trim());
    // Estrai spreadsheet ID dal path
    const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return null;
    const id = match[1];
    // Estrai gid dai parametri (se presente)
    const gid = url.hash.match(/gid=(\d+)/)?.[1] || url.searchParams.get('gid') || '0';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  } catch (e) {
    return null;
  }
}

// Parsing CSV minimale (gestisce virgolette e virgole)
function parseCsvRow(row) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Legge il Google Sheet, auto-rileva colonne LinkedIn e filtra per Stato
async function fetchUrlsFromSheet() {
  const sheetUrl = (cfg.sheetUrl || '').trim();
  if (!sheetUrl) {
    return { error: 'URL Google Sheet non configurato. Vai in ⚙ Config e inserisci l\'URL.' };
  }

  const csvUrl = buildSheetCsvUrl(sheetUrl);
  if (!csvUrl) {
    return { error: 'URL Google Sheet non valido. Controlla il formato.' };
  }

  try {
    addLog('Leggo Google Sheet...', 'info');
    const res = await fetch(csvUrl);
    if (!res.ok) {
      return { error: `Errore HTTP ${res.status} — verifica che lo Sheet sia condiviso pubblicamente` };
    }
    // Rimuovi BOM UTF-8 se presente (Google Sheets a volte lo include)
    const raw_text = await res.text();
    const text = raw_text.replace(/^\uFEFF/, '');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) return { urls: [], total: 0, found: 0, skipped: 0 };

    // ── Colonna LinkedIn: usa sempre quella configurata (default E) ──────────
    const colLetter = (cfg.sheetCol || 'E').trim().toUpperCase();
    const linkedinColIndex = colLetter.charCodeAt(0) - 65;
    addLog(`Leggo URL da colonna ${colLetter} (indice ${linkedinColIndex})`, 'info');

    // ── Processa righe dati (skip header) ────────────────────────────────────
    const urls = [];
    let skippedNoUrl = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvRow(lines[i]);
      const raw = (cols[linkedinColIndex] || '').trim();

      if (!raw) {
        skippedNoUrl++;
        continue;
      }

      const normalized = normalizeLinkedinCompanyUrl(raw);
      if (normalized.includes('linkedin.com/company/')) {
        urls.push(normalized);
      } else {
        addLog(`Riga ${i}: valore colonna ${colLetter} = "${raw.slice(0, 80)}" — non è un URL company`, 'warn');
        skippedNoUrl++;
      }
    }

    // Deduplicazione
    const beforeDedup = urls.length;
    const unique = [...new Set(urls)];
    const deduped = beforeDedup - unique.length;
    let logMsg = `Risultato: ${unique.length} URL validi`;
    if (deduped > 0) logMsg += ` | ${deduped} duplicati rimossi`;
    if (skippedNoUrl > 0) logMsg += ` | ${skippedNoUrl} righe senza URL company`;
    addLog(logMsg, 'info');
    return { urls: unique, total: lines.length - 1, found: unique.length, skipped: 0, skippedNoUrl, deduped };
  } catch (e) {
    return { error: `Errore fetch: ${e.message}` };
  }
}

// Carica gli URL dallo Sheet e popola la textarea del batch
async function loadFromSheet(showFeedback = true) {
  const msgEl = document.getElementById('sheetLoadMsg');
  const textarea = document.getElementById('batchUrls');

  if (msgEl) {
    msgEl.style.display = 'block';
    msgEl.style.color = 'var(--text2)';
    msgEl.textContent = '⏳ Caricamento in corso...';
  }

  const result = await fetchUrlsFromSheet();

  if (result.error) {
    if (msgEl) {
      msgEl.style.color = 'var(--red)';
      msgEl.textContent = '✕ ' + result.error;
    }
    if (showFeedback) addLog('Sheet: ' + result.error, 'error');
    return false;
  }

  if (result.urls.length === 0) {
    if (msgEl) {
      msgEl.style.color = 'var(--accent)';
      msgEl.textContent = `⚠ Nessun URL LinkedIn trovato (${result.total} righe analizzate)`;
    }
    if (showFeedback) addLog(`Sheet: nessun URL LinkedIn trovato nella colonna configurata`, 'warn');
    return false;
  }

  if (textarea) {
    textarea.value = result.urls.join('\n');
  }

  if (msgEl) {
    msgEl.style.color = 'var(--green)';
    let uiMsg = `✓ ${result.found} URL caricati (${result.total} righe totali)`;
    if (result.deduped > 0) uiMsg += ` — ${result.deduped} duplicati rimossi`;
    if (result.skippedNoUrl > 0) uiMsg += ` — ⚠ ${result.skippedNoUrl} righe senza URL LinkedIn (vedi log)`;
    msgEl.textContent = uiMsg;
  }

  if (showFeedback) addLog(`📊 Sheet: ${result.found} URL LinkedIn caricati nel batch`, 'ok');
  return true;
}

// ── POLLING GOOGLE SHEET (background) ─────────────────────────────────────────
let sheetPollingTimer = null;
let lastSheetUrlCount = 0;

async function checkSheetForUpdates() {
  if (!cfg.sheetUrl || !cfg.sheetPolling) return;

  const result = await fetchUrlsFromSheet();
  if (result.error || !result.urls) return;

  const newCount = result.urls.length;

  if (newCount > 0 && newCount !== lastSheetUrlCount) {
    lastSheetUrlCount = newCount;

    // Aggiorna la textarea se è vuota o se il conteggio è cambiato
    const textarea = document.getElementById('batchUrls');
    if (textarea && (!textarea.value.trim() || newCount > (textarea.value.trim().split('\n').filter(Boolean).length))) {
      textarea.value = result.urls.join('\n');
      const msgEl = document.getElementById('sheetLoadMsg');
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.color = 'var(--green)';
        msgEl.textContent = `✓ ${newCount} URL aggiornati automaticamente dallo Sheet`;
      }
    }

    // Badge sull'icona extension
    try {
      await chrome.action.setBadgeText({ text: String(newCount) });
      await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } catch (e) { /* ignora se non disponibile */ }
  } else if (newCount === 0) {
    // Rimuovi badge
    try { await chrome.action.setBadgeText({ text: '' }); } catch (e) {}
  }
}

function startSheetPolling() {
  if (sheetPollingTimer) clearInterval(sheetPollingTimer);
  if (!cfg.sheetPolling || !cfg.sheetUrl) return;
  // Controlla subito, poi ogni 3 minuti
  checkSheetForUpdates();
  sheetPollingTimer = setInterval(checkSheetForUpdates, 3 * 60 * 1000);
  addLog('📊 Monitoraggio Sheet attivo (ogni 3 minuti)', 'info');
}

function stopSheetPolling() {
  if (sheetPollingTimer) {
    clearInterval(sheetPollingTimer);
    sheetPollingTimer = null;
  }
  try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
}

// ── BATCH MODE ────────────────────────────────────────────────────────────────

function updateBatchProgress(current, total, companyName) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  // Progress bar nel tab Batch
  const bar = document.getElementById('batchProgressBar');
  const text = document.getElementById('batchProgressText');
  if (bar) bar.style.width = pct + '%';
  if (text) text.textContent = `[${current}/${total}] ${companyName || ''}`;

  // Wide progress bar nel tab Log
  const logOuter = document.getElementById('logProgressOuter');
  const logWrap = document.getElementById('logProgressWrap');
  const logBar = document.getElementById('logProgressBar');
  const logCounter = document.getElementById('logProgressCounter');
  const logText = document.getElementById('logProgressText');
  if (logOuter) logOuter.style.display = total > 0 ? 'flex' : 'none';
  if (logWrap) logWrap.style.display = total > 0 ? 'flex' : 'none';
  if (logBar) logBar.style.width = pct + '%';
  if (logCounter) logCounter.textContent = `${current} / ${total}`;
  if (logText) logText.textContent = `${companyName || ''} · ${pct}%`;
}

// ═══════════════════════════════════════════════════════════════════════════
// v2 — LinkedIn Search support (Persona-First flow)
// ═══════════════════════════════════════════════════════════════════════════

// Scala le pause "umane" del flow search in base a cfg.delay (Config tab) + jitter.
// Base = cfg.delay/3 (floor 0.8), poi un fattore casuale ±25% per evitare pattern fissi.
// Esempi (delay=5 → base 1.67):
//   ogni chiamata torna un valore casuale tra 1.25 (1.67×0.75) e 2.09 (1.67×1.25)
// Cosi ogni pausa ha un fattore leggermente diverso, niente cadenza ritmica.
function searchHumanScale() {
  const base = Math.max(0.8, (cfg.delay || 3) / 3);
  const jitter = 0.75 + Math.random() * 0.5; // 0.75 - 1.25
  return Math.max(0.5, base * jitter);
}

// Pausa "umana" scalata: prende min/max in ms e applica searchHumanScale
function searchHumanPause(minMs, maxMs) {
  const scale = searchHumanScale();
  const base = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(base * scale));
}

// Chiave normalizzata per il progress cache: ignora origin/timestamp,
// tiene solo i filtri "veri" (keywords, geo, settore, network, lingua, ecc.)
// Così se l'utente apre la stessa ricerca da SERP o da "Tutte le ricerche" la chiave è la stessa.
function _searchUrlKey(url) {
  try {
    const u = new URL(url);
    const keep = ['keywords', 'geoUrn', 'industry', 'network', 'currentCompany', 'pastCompany', 'languageUsedOnLinkedIn', 'firstName', 'lastName', 'school', 'title', 'serviceCategory', 'titleFreeText'];
    const params = new URLSearchParams();
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v) params.set(k, v);
    }
    return `${u.pathname}?${params.toString()}`;
  } catch (e) {
    return String(url || '');
  }
}

// Reset di tutta la cache progresso ricerche (chiamato dal bottone in UI)
async function resetSearchProgress() {
  cfg.searchProgress = {};
  await chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
  addLog('🔄 Reset progresso ricerche · al prossimo Avvia tutte le ricerche ripartono da pagina 1', 'ok');
  updateResetSearchProgressUi();
}

// Aggiorna label del bottone Reset in base a quante cache ci sono
function updateResetSearchProgressUi() {
  const btn = document.getElementById('btnResetSearchProgress');
  const info = document.getElementById('searchProgressInfo');
  if (!btn) return;
  const entries = Object.entries(cfg.searchProgress || {});
  if (entries.length === 0) {
    btn.disabled = true;
    btn.textContent = '🔄 Reset';
    if (info) info.textContent = 'Nessuna ricerca in cache';
    return;
  }
  btn.disabled = false;
  btn.textContent = `🔄 Reset (${entries.length})`;
  if (info) {
    const totalPages = entries.reduce((acc, [, v]) => acc + (v.lastPage || 0), 0);
    info.textContent = `${entries.length} ricerc${entries.length === 1 ? 'a' : 'he'} in cache · ${totalPages} pagine totali`;
  }
}

// Classifica un URL LinkedIn come 'company' | 'search' | 'unknown'
function classifyLinkedinUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return 'unknown';
  if (/linkedin\.com\/search\/results\/people/i.test(url)) return 'search';
  if (/linkedin\.com\/company\//i.test(url)) return 'company';
  return 'unknown';
}

// Conta gli URL in un textarea e classifica per tipo atteso
function _countUrlsInTextarea(taId, expectedType) {
  const ta = document.getElementById(taId);
  if (!ta) return { valid: 0, wrong: 0, total: 0 };
  const lines = (ta.value || '').split('\n').map(l => l.trim()).filter(Boolean);
  let valid = 0, wrong = 0;
  for (const l of lines) {
    const t = classifyLinkedinUrl(l);
    if (t === expectedType) valid++;
    else wrong++;
  }
  return { valid, wrong, total: lines.length };
}

// Aggiorna i counter sotto ogni textarea + riepilogo totale
function updateBatchUrlsPreview() {
  const company = _countUrlsInTextarea('batchUrls', 'company');
  const search = _countUrlsInTextarea('batchSearchUrls', 'search');

  // Counter sotto la textarea Company
  const companyOut = document.getElementById('batchCompanyCount');
  if (companyOut) {
    if (company.total === 0) {
      companyOut.textContent = '';
    } else {
      const parts = [];
      if (company.valid > 0) parts.push(`${company.valid} URL Company validi`);
      if (company.wrong > 0) parts.push(`${company.wrong} non Company`);
      companyOut.textContent = parts.join(' · ');
      companyOut.style.color = company.wrong > 0 ? 'var(--accent)' : 'var(--green)';
    }
  }

  // Counter sotto la textarea Ricerca
  const searchOut = document.getElementById('batchSearchCount');
  if (searchOut) {
    if (search.total === 0) {
      searchOut.textContent = '';
    } else {
      const parts = [];
      if (search.valid > 0) parts.push(`${search.valid} URL Ricerca validi`);
      if (search.wrong > 0) parts.push(`${search.wrong} non Ricerca`);
      searchOut.textContent = parts.join(' · ');
      searchOut.style.color = search.wrong > 0 ? 'var(--accent)' : 'var(--green)';
    }
  }

  // Riepilogo totale + label del pulsante Avvia
  const total = company.valid + search.valid;
  const summaryEl = document.getElementById('batchTotalSummary');
  if (summaryEl) {
    if (total === 0) {
      summaryEl.style.display = 'none';
    } else {
      summaryEl.style.display = 'block';
      summaryEl.innerHTML = `Coda totale: <span style="color:var(--hi)">${total} URL</span> · <span style="color:var(--blue)">${company.valid} Company</span> · <span style="color:var(--accent)">${search.valid} Ricerca</span>`;
    }
  }
  const btn = document.getElementById('btnStartBatch');
  if (btn) btn.textContent = total > 0 ? `🚀 Avvia Batch (${total} URL)` : '🚀 Avvia Batch';
}

// Strategie email per i contatti estratti da ricerca persone
// strategy: 'apollo_fallback' | 'apollo_only' | 'standard_cascade'
async function findEmailWithStrategy(contact, strategy) {
  let email = null;

  if (strategy === 'apollo_only') {
    if (cfg.apolloKey) {
      // Forzo l'uso di Apollo anche se useApollo è OFF (strategia esplicita)
      const wasUseApollo = cfg.useApollo;
      cfg.useApollo = true;
      email = await findEmailApollo(contact);
      cfg.useApollo = wasUseApollo;
    } else {
      addLog('Apollo API key mancante — impossibile applicare strategia "Solo Apollo"', 'warn');
    }
    return email;
  }

  if (strategy === 'apollo_fallback') {
    // Apollo first
    if (cfg.apolloKey) {
      const wasUseApollo = cfg.useApollo;
      cfg.useApollo = true;
      email = await findEmailApollo(contact);
      cfg.useApollo = wasUseApollo;
    }
    // Fallback ai provider attivi
    if (!email && cfg.useDropcontact && cfg.dropcontactKey) email = await findEmailDropcontact(contact);
    if (!email && cfg.useLemlistEmail && cfg.lemlistKey) email = await findEmailLemlist(contact);
    return email;
  }

  // standard_cascade: stesso ordine del batch company
  if (cfg.useDropcontact && cfg.dropcontactKey) email = await findEmailDropcontact(contact);
  if (!email && cfg.useLemlistEmail && cfg.lemlistKey) email = await findEmailLemlist(contact);
  if (!email && cfg.useApollo && cfg.apolloKey) email = await findEmailApollo(contact);
  return email;
}

// Helper: converte un profilo grezzo SERP in un contatto pronto per Make/UI
function _buildSearchContact(p, queryInfo, searchUrl) {
  const parts = (p.name || '').split(/\s+/).filter(Boolean);
  const c = {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
    fullName: p.name || '',
    role: p.role || p.headline || '',
    jobDescription: p.headline || p.role || '',
    profileUrl: p.profileUrl,
    company: p.company || '',
    companyWebsite: '',
    companyDomain: '',
    companyLinkedinUrl: '',
    location: p.location || '',
    targetScore: 0,
    matchedKeywords: [],
    matchReason: '',
    rawText: `${p.name || ''} ${p.headline || ''} ${p.location || ''}`.trim(),
    keep: true,
    enriched: false,
    added: false,
    email: '',
    _source: 'linkedin_persona_first',
    _searchQuery: queryInfo.keywords || '',
    _searchUrl: searchUrl,
    _searchChips: queryInfo.activeChips || [],
  };
  if (cfg.searchApplyScoring) {
    const analysis = analyzeLeadStrict({
      name: c.fullName,
      role: c.role,
      jobDescription: c.jobDescription,
      rawText: c.rawText,
    });
    c.targetScore = analysis.score;
    c.matchedKeywords = analysis.matchedRules || [];
    c.matchReason = analysis.reason;
    if (!analysis.accepted) c.keep = false;
  }
  return c;
}

// Scraping di una singola pagina di ricerca LinkedIn
// onPageDone(pageContacts, meta) viene chiamato dopo ogni pagina per UI progressiva
async function scrapeSearchPage(searchUrl, onPageDone) {
  // ── Resume: se ho già scraperato questa ricerca, riprendo da N+1 ──────────
  const progressKey = _searchUrlKey(searchUrl);
  const prev = (cfg.searchProgress || {})[progressKey];
  let startPage = 1;
  let effectiveUrl = searchUrl;
  if (prev?.lastPage > 0) {
    startPage = prev.lastPage + 1;
    try {
      const u = new URL(searchUrl);
      u.searchParams.set('page', String(startPage));
      effectiveUrl = u.toString();
    } catch (e) {}
    addLog(`↺ Riprendo da pagina ${startPage} (run precedente: fino a pag.${prev.lastPage}, ${prev.totalContacts || 0} profili)`, 'info');
  }

  await chrome.runtime.sendMessage({ type: 'NAVIGATE_TAB', tabId: state.lockedTabId, url: effectiveUrl });
  addLog(`🔍 Apro ricerca: ${effectiveUrl.substring(0, 80)}...`, 'info');

  const loadedUrl = await waitForTabLoad(state.lockedTabId, 30000);
  if (!loadedUrl) {
    addLog(`Timeout su ricerca: ${searchUrl}`, 'warn');
    return [];
  }

  // ── Apertura pagina: "sto guardando cosa è uscito" ────────────────────────
  await searchHumanPause(3000, 5500); // 3-5.5s di "lettura iniziale" (×scale)

  // Chiudi eventuali modal (paywall premium, "Are you sure?", upsell)
  try { await execInTrackedPage('__grizzly_closeModal'); } catch (e) {}
  await searchHumanPause(400, 1000);

  // Leggi info query per audit
  let queryInfo = { keywords: '', activeChips: [] };
  try {
    const r = await execInTrackedPage('__grizzly_getSearchQueryInfo');
    queryInfo = r?.result || queryInfo;
  } catch (e) {}
  const queryLabel = queryInfo.keywords || 'ricerca';
  const chipsLabel = (queryInfo.activeChips || []).slice(0, 6).join(' · ');
  addLog(`Query: "${queryLabel}"${chipsLabel ? ' · ' + chipsLabel : ''}`, 'info');

  const maxPages = Math.max(1, Math.min(20, parseInt(cfg.searchMaxPages || 5, 10)));
  const allContacts = [];          // contatti già filtrati/scored
  const seen = new Set();          // dedupe per profileUrl

  for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
    if (batchState.stopped || state.stopped) break;
    const currentPage = startPage + pageIdx; // pagina LinkedIn reale (1-N)

    // Aspetta che almeno qualche profilo sia renderizzato (max 10s)
    let visibleLinks = 0;
    for (let waitTry = 0; waitTry < 20; waitTry++) {
      if (batchState.stopped || state.stopped) break;
      try {
        const r = await execInTrackedPage('__grizzly_countSearchProfileLinks');
        visibleLinks = Number(r?.result || 0);
      } catch (e) {}
      if (visibleLinks >= 3) break;
      await sleep(500);
    }
    addLog(`Profili visibili nel DOM: ${visibleLinks}`, visibleLinks > 0 ? 'info' : 'warn');

    // Se sono in resume (startPage > 1) e la prima pagina è vuota → esaurita
    if (pageIdx === 0 && startPage > 1 && visibleLinks === 0) {
      addLog(`Pagina ${currentPage} non ha risultati. La ricerca era già stata processata fino in fondo nelle run precedenti. Per ricominciare clicca 🔄 Reset nella card Ricerca.`, 'warn');
      break;
    }

    // ── "Reading time" prima dello scroll: sto guardando i primi profili ───
    await searchHumanPause(1800, 4000); // 1.8-4s (×scale)

    // Scroll organico (con scroll-up casuali, vedi __grizzly_scrollSearchResults)
    try { await execInTrackedPage('__grizzly_scrollSearchResults'); } catch (e) {}

    // ── "Reading time" dopo lo scroll: leggo il resto della pagina ─────────
    await searchHumanPause(1500, 3300); // 1.5-3.3s (×scale)

    // Chiudi modal di nuovo (LinkedIn ne pop-uppa spesso a metà sessione)
    try { await execInTrackedPage('__grizzly_closeModal'); } catch (e) {}
    await searchHumanPause(300, 800);

    // Estrai profili (shape: { results, debug })
    const res = await chrome.runtime.sendMessage({
      type: 'EXECUTE_IN_PAGE', funcName: '__grizzly_extractSearchResults', tabId: state.lockedTabId
    });
    const payload = res?.result || {};
    const profiles = Array.isArray(payload) ? payload : (payload.results || []);
    const dbg = (Array.isArray(payload) ? {} : payload.debug) || {};
    const triedSummary = (dbg.tried || []).join(' | ') || 'nessuna strategia ha matchato';

    // Costruisci contatti per i SOLI profili nuovi di questa pagina
    const pageContacts = [];
    for (const p of profiles) {
      if (!p.profileUrl || seen.has(p.profileUrl)) continue;
      seen.add(p.profileUrl);
      const contact = _buildSearchContact(p, queryInfo, searchUrl);
      // Se lo scoring è ON, scarta a monte (non li emetto nemmeno alla UI)
      if (cfg.searchApplyScoring && contact.keep === false) continue;
      pageContacts.push(contact);
      allContacts.push(contact);
    }

    if (pageContacts.length > 0) {
      addLog(`Pagina ${currentPage} (run ${pageIdx + 1}/${maxPages}): ${pageContacts.length} nuovi · totale run ${allContacts.length} [${triedSummary}]`, 'ok');
    } else {
      addLog(`Pagina ${currentPage} (run ${pageIdx + 1}/${maxPages}): 0 estratti su ${dbg.cardsFound || 0} card · ${dbg.linksTotal || 0} link /in/ totali [${triedSummary}]`, 'warn');
      if (dbg.sampleHTML) addLog(`HTML sample card: ${dbg.sampleHTML.substring(0, 200)}`, 'info');
    }

    // ── Salva progresso DOPO aver estratto questa pagina ───────────────────
    if (pageContacts.length > 0 || visibleLinks > 0) {
      cfg.searchProgress = cfg.searchProgress || {};
      cfg.searchProgress[progressKey] = {
        lastPage: currentPage,
        completedAt: Date.now(),
        totalContacts: (prev?.totalContacts || 0) + allContacts.length,
        originalUrl: searchUrl,
      };
      chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
    }

    // ── UI progressiva: emetto i contatti di questa pagina al chiamante ────
    if (typeof onPageDone === 'function' && pageContacts.length > 0) {
      try { onPageDone(pageContacts, { pageIdx, currentPage, queryInfo, totalSoFar: allContacts.length }); } catch (e) {}
    }

    if (pageIdx + 1 >= maxPages) break;

    // ── "Decision time": pausa prima di andare alla pagina successiva ──────
    // (un umano legge ancora qualcosa, decide se continuare, poi clicca)
    const scale = searchHumanScale();
    const baseDecision = 2500 + Math.random() * 3500; // 2.5-6s base
    const decisionPause = Math.round(baseDecision * scale);
    addLog(`Pausa "lettura" prima di paginare: ${Math.round(decisionPause / 1000)}s (jitter×${scale.toFixed(2)})`, 'info');
    await sleep(decisionPause);

    // Strategia A: click sul bottone "Successiva" (più "umano")
    const nextRes = await execInTrackedPage('__grizzly_clickNextSearchPage');
    let paginated = !!nextRes?.result?.clicked;
    if (paginated) {
      addLog(`Click pagina successiva via ${nextRes.result.method || 'unknown'}`, 'ok');
    } else {
      // Diagnostica: cosa ho trovato di "pagination-like" sulla pagina
      const dbg = nextRes?.result?.debug || {};
      addLog(`Click "Successiva" fallito · selettori provati: ${(dbg.tried || []).join(' | ') || 'nessuno'}`, 'warn');
      if (dbg.candidates?.length) {
        dbg.candidates.slice(0, 4).forEach(c => {
          addLog(`  candidato pagination: text="${c.text}" aria="${c.aria}" disabled=${c.disabled} cls="${c.cls.substring(0, 60)}"`, 'info');
        });
      }

      // Strategia B: fallback su navigazione URL con &page=N+1
      const currentPage = (await execInTrackedPage('__grizzly_getCurrentSearchPage'))?.result || (pageIdx + 1);
      const nextUrl = (await execInTrackedPage('__grizzly_buildNextPageUrl', [currentPage + 1]))?.result;
      if (nextUrl) {
        addLog(`Fallback: navigo direttamente a page=${currentPage + 1}`, 'info');
        await chrome.runtime.sendMessage({ type: 'NAVIGATE_TAB', tabId: state.lockedTabId, url: nextUrl });
        paginated = true;
      } else {
        addLog('Nessuna pagina successiva disponibile (né click né URL fallback), fermo qui.', 'warn');
        break;
      }
    }

    // Attendi che la nuova pagina sia stabile
    await searchHumanPause(3500, 6000); // 3.5-6s (×scale)
    await waitForTabLoad(state.lockedTabId, 15000);
    // "Reading time" sulla nuova pagina prima di riprendere
    await searchHumanPause(2000, 4000); // 2-4s (×scale)
  }

  addLog(`Estratti ${allContacts.length} profili da "${queryLabel}"${cfg.searchApplyScoring ? ' (filtro scoring attivo)' : ''}`, allContacts.length > 0 ? 'ok' : 'warn');
  // Aggiorna il counter del bottone Reset (potrebbe esserci una nuova cache)
  try { updateResetSearchProgressUi(); } catch (e) {}
  return allContacts;
}

// Scraping di una singola azienda (senza aggiornare la UI del tab Run)
async function scrapeOneCompany(url) {
  // Naviga alla company page
  await chrome.runtime.sendMessage({ type: 'NAVIGATE_TAB', tabId: state.lockedTabId, url });
  addLog(`Navigo: ${url}`, 'info');

  // Attendi caricamento
  const loadedUrl = await waitForTabLoad(state.lockedTabId, 30000);
  if (!loadedUrl) {
    addLog(`Timeout su: ${url}`, 'warn');
    return [];
  }
  await sleep(2500 + Math.random() * 1500);

  // Reset company state
  state.currentCompany = { url, name: '', website: '', domain: '', tabId: state.lockedTabId };

  // Leggi nome azienda
  try {
    const nameRes = await execInTrackedPage('__grizzly_getCompanyName');
    state.currentCompany.name = cleanCompanyName(nameRes?.result || '');
  } catch (e) {}

  // Leggi sito aziendale
  try {
    const siteRes = await execInTrackedPage('__grizzly_extractCompanyWebsite');
    state.currentCompany.website = siteRes?.result?.website || '';
    state.currentCompany.domain = siteRes?.result?.domain || '';
  } catch (e) {}

  addLog(`Azienda: ${state.currentCompany.name || url}`, 'info');

  // Vai alla tab People se non siamo già lì
  const isPeople = await execInTrackedPage('__grizzly_isPeoplePage');
  if (!isPeople?.result) {
    addLog('Navigo su Persone...', 'info');
    await execInTrackedPage('__grizzly_clickPeopleTab');
    await sleep(3000 + Math.random() * 1000);
    // Riprova a leggere il sito dalla pagina People
    try {
      if (!state.currentCompany.website) {
        const siteRes2 = await execInTrackedPage('__grizzly_extractCompanyWebsite');
        state.currentCompany.website = siteRes2?.result?.website || '';
        state.currentCompany.domain = siteRes2?.result?.domain || '';
      }
    } catch (e) {}
  }

  // Scroll e carica profili
  const preCheck = await chrome.runtime.sendMessage({
    type: 'EXECUTE_IN_PAGE', funcName: '__grizzly_extractPeople', tabId: state.lockedTabId
  });
  if ((preCheck?.result || []).length < 20) {
    await scrollAndLoadMore(6);
  }
  await sleep(2000);

  // Estrai persone
  const res = await chrome.runtime.sendMessage({
    type: 'EXECUTE_IN_PAGE', funcName: '__grizzly_extractPeople', tabId: state.lockedTabId
  });
  let allPeople = res?.result || [];

  if (allPeople.length === 0) {
    addLog('Provo estrazione di emergenza...', 'warn');
    const emergRes = await chrome.runtime.sendMessage({
      type: 'EXECUTE_IN_PAGE', funcName: '__grizzly_extractPeopleEmergency', tabId: state.lockedTabId
    });
    allPeople = emergRes?.result || [];
  }

  addLog(`${allPeople.length} profili grezzi da: ${state.currentCompany.name}`, allPeople.length > 0 ? 'ok' : 'warn');

  // Analizza e filtra
  const targets = allPeople.map(p => {
    const roleParts = deriveRoleAndDescription(p.role || '');
    const analysis = analyzeLeadStrict({
      name: p.name,
      role: roleParts.role,
      jobDescription: roleParts.jobDescription,
      rawText: p.rawText || `${p.name || ''} ${p.role || ''}`,
    });
    return {
      ...p,
      role: roleParts.role || p.role || '',
      jobDescription: roleParts.jobDescription || p.role || '',
      targetScore: analysis.score,
      matchedKeywords: analysis.matchedKeywords,
      matchReason: analysis.reason,
      accepted: analysis.accepted,
    };
  }).filter(p => p.accepted).sort((a, b) => b.targetScore - a.targetScore);

  addLog(`${targets.length} in target per: ${state.currentCompany.name}`, targets.length > 0 ? 'ok' : 'warn');

  return targets.map(p => {
    const parts = (p.name || '').split(' ');
    return {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      fullName: p.name,
      role: p.role || '',
      jobDescription: p.jobDescription || p.role || '',
      profileUrl: p.profileUrl,
      company: state.currentCompany.name,
      companyWebsite: state.currentCompany.website || '',
      companyDomain: state.currentCompany.domain || '',
      companyLinkedinUrl: url,
      targetScore: p.targetScore || 0,
      matchedKeywords: p.matchedKeywords || [],
      matchReason: p.matchReason || '',
      rawText: p.rawText || '',
      keep: true,
      enriched: false,
      added: false,
      email: '',
    };
  });
}

async function startBatch() {
  // Ricarica settings prima di partire (assicura che le API key siano caricate)
  await loadSettings();
  // ── v3: due textarea separate, processo prima Company poi Ricerca ─────────
  const companyRaw = (document.getElementById('batchUrls')?.value || '').trim();
  const searchRaw = (document.getElementById('batchSearchUrls')?.value || '').trim();

  if (!companyRaw && !searchRaw) {
    // Auto-load da Supabase: companies con stato=linkedin_ok
    if (!cfg.supabaseEnabled || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      addLog('Inserisci almeno un URL nella card Company o nella card Ricerca', 'error');
      return;
    }
    addLog('⬡ Nessun URL inserito — carico aziende da Supabase (stato=linkedin_ok)...', 'info');
    try {
      const sbUrl = cfg.supabaseUrl.replace(/\/$/, '');
      const key = cfg.supabaseAnonKey;
      const r = await fetch(`${sbUrl}/rest/v1/companies?select=linkedin_url&stato=eq.linkedin_ok&linkedin_url=not.is.null&limit=200`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (!r.ok) throw new Error(await r.text());
      const rows = await r.json();
      if (!rows.length) { addLog('⬡ Nessuna azienda con company page verificata in Supabase', 'warn'); return; }
      const textarea = document.getElementById('batchUrls');
      if (textarea) textarea.value = rows.map(r => r.linkedin_url).join('\n');
      addLog(`⬡ ${rows.length} aziende caricate da Supabase`, 'ok');
      // Rileggi i valori aggiornati
      Object.assign({companyRaw: ''}, {companyRaw: (document.getElementById('batchUrls')?.value || '').trim()});
    } catch(e) {
      addLog('⬡ Errore caricamento da Supabase: ' + e.message, 'error');
      return;
    }
    // Rileggi dopo auto-fill
    const companyRawFilled = (document.getElementById('batchUrls')?.value || '').trim();
    if (!companyRawFilled) return;
    // Riavvia con i dati caricati
    return startBatch();
  }

  const urls = [];
  let skippedWrongType = 0;

  // Prima coda: Company (estraggo solo URL company validi)
  for (const line of companyRaw.split('\n').map(u => u.trim()).filter(Boolean)) {
    const kind = classifyLinkedinUrl(line);
    if (kind === 'company') {
      urls.push({ url: normalizeLinkedinCompanyUrl(line), type: 'company' });
    } else {
      skippedWrongType++;
    }
  }

  // Seconda coda: Ricerca (estraggo solo URL search validi)
  for (const line of searchRaw.split('\n').map(u => u.trim()).filter(Boolean)) {
    const kind = classifyLinkedinUrl(line);
    if (kind === 'search') {
      urls.push({ url: line, type: 'search' });
    } else {
      skippedWrongType++;
    }
  }

  if (urls.length === 0) {
    addLog('Nessun URL LinkedIn valido. Controlla i formati: /company/nome o /search/results/people/?...', 'error');
    return;
  }
  if (skippedWrongType > 0) addLog(`⚠ ${skippedWrongType} URL nel textarea sbagliato (o non LinkedIn) ignorati`, 'warn');

  // Blocca la tab attiva
  const tabRes = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
  const tab = tabRes?.tab;
  if (!tab?.id) {
    addLog('Nessuna tab LinkedIn attiva. Apri LinkedIn in una tab Chrome prima di avviare il batch.', 'error');
    return;
  }
  state.lockedTabId = tab.id;

  // Inizializza stato batch
  batchState.queue = urls;
  batchState.current = 0;
  batchState.total = urls.length;
  batchState.allResults = [];
  batchState.running = true;
  batchState.stopped = false;
  state.stopped = false;

  // Aggiorna "Aziende in lista" nel tab Log
  const logTotal = document.getElementById('logStatTotal');
  if (logTotal) logTotal.textContent = urls.length;

  document.getElementById('btnStartBatch').disabled = true;
  const stopBtn = document.getElementById('btnStopBatch');
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  const stopBtnLog = document.getElementById('btnStopBatchLog');
  // visibilità gestita da logProgressOuter
  const progressEl = document.getElementById('batchProgress');
  if (progressEl) progressEl.style.display = 'block';

  // Passa al tab Run così il log è visibile
  switchToTab('run');

  const nCompany = urls.filter(u => u.type === 'company').length;
  const nSearch = urls.filter(u => u.type === 'search').length;
  addLog(`🚀 Batch avviato: ${urls.length} URL in coda (${nCompany} Company · ${nSearch} Ricerca)`, 'ok');

  for (let i = 0; i < urls.length; i++) {
    if (batchState.stopped || state.stopped) break;

    batchState.current = i + 1;
    const item = urls[i];
    const url = item.url;
    const sourceType = item.type;
    const tag = sourceType === 'search' ? '🔍 RICERCA' : '🏢 COMPANY';
    updateBatchProgress(batchState.current, batchState.total, url);
    addLog(`\n── [${i + 1}/${batchState.total}] ${tag}: ${url.substring(0, 80)}`, 'info');

    // ── v3.1: pusho subito un'entry vuota così l'utente vede il gruppo apparire
    //          nel tab Risultati come "in corso", poi lo popolo incrementalmente
    const entryIdx = batchState.allResults.length;
    batchState.allResults.push({
      companyUrl: url,
      companyName: sourceType === 'search' ? 'Ricerca in corso...' : (url || 'In corso...'),
      sourceType,                          // 'company' | 'search'
      sourceUrl: url,
      contacts: [],
    });
    renderBatchResults();

    try {
      if (sourceType === 'search') {
        // Callback: dopo ogni pagina, aggiungo i contatti nuovi all'entry e ridisegno
        const onPageDone = (pageContacts, meta) => {
          batchState.allResults[entryIdx].contacts.push(...pageContacts);
          // Imposta il label leggibile alla prima pagina (quando ho la query)
          if (meta?.queryInfo?.keywords && batchState.allResults[entryIdx].companyName === 'Ricerca in corso...') {
            batchState.allResults[entryIdx].companyName = `"${meta.queryInfo.keywords}"`;
          }
          renderBatchResults();
        };
        await scrapeSearchPage(url, onPageDone);
      } else {
        const contacts = await scrapeOneCompany(url);
        batchState.allResults[entryIdx].contacts = contacts;
        batchState.allResults[entryIdx].companyName = state.currentCompany?.name || url;
      }
    } catch (e) {
      addLog(`Errore su ${url}: ${e.message}`, 'error');
    }

    renderBatchResults();

    // Supabase: scrivi i contatti — cattura companyName subito per evitare race con detectCompanyPage
    const entryContacts = batchState.allResults[entryIdx]?.contacts || [];
    const snapshotName = batchState.allResults[entryIdx]?.companyName || url;
    if (entryContacts.length) writeContactsToSupabase(entryContacts, url, snapshotName);

    // Delay umano tra un URL e il prossimo
    if (i < urls.length - 1 && !batchState.stopped) {
      const delay = 10000 + Math.random() * 8000; // 10-18 secondi
      addLog(`Attendo ${Math.round(delay / 1000)}s prima del prossimo URL...`, 'info');
      await sleep(delay);
    }
  }

  batchState.running = false;
  state.lockedTabId = null;
  document.getElementById('btnStartBatch').disabled = false;
  if (stopBtn) stopBtn.style.display = 'none';
  // stopBtnLog si nasconde con logProgressOuter

  const totalContacts = batchState.allResults.reduce((acc, r) => acc + r.contacts.length, 0);
  const completedItems = batchState.allResults.length;
  addLog(`🏁 Batch completato: ${completedItems} URL processati, ${totalContacts} contatti in target`, 'ok');

  // Svuota il form Company così il prossimo avvio ricarica da Supabase
  const batchUrlsEl = document.getElementById('batchUrls');
  if (batchUrlsEl) batchUrlsEl.value = '';

  renderBatchResults();
  updateBatchProgress(completedItems, batchState.total, 'Completato ✓');
}

function switchToTab(name) {
  const ALL_TABS = ['run', 'batch', 'results', 'keywords', 'settings'];
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  ALL_TABS.forEach(n => {
    const el = document.getElementById('tab-' + n);
    if (el) el.style.display = n === name ? (n === 'run' ? 'flex' : 'block') : 'none';
  });
}

function stopBatch() {
  batchState.stopped = true;
  state.stopped = true;
  addLog('⏹ Stop batch richiesto...', 'warn');
}

function renderBatchResults() {
  const container = document.getElementById('batchResultsList');
  if (!container) return;
  container.innerHTML = '';

  if (batchState.allResults.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🚀</div>Incolla gli URL e avvia il batch per vedere i risultati qui</div>';
    return;
  }

  let totalKept = 0;
  let totalEmails = 0;
  let totalAll = 0;

  batchState.allResults.forEach((company, ci) => {
    const kept = company.contacts.filter(c => c.keep !== false).length;
    const withEmail = company.contacts.filter(c => c.email).length;
    totalKept += kept;
    totalEmails += withEmail;
    totalAll += company.contacts.length;

    const group = document.createElement('div');
    group.className = 'batch-company-group';
    // Bordo ambra per i gruppi da ricerca persone
    if (company.sourceType === 'search') {
      group.style.borderColor = 'rgba(245,158,11,0.3)';
    }

    // Header azienda + chip sorgente
    const header = document.createElement('div');
    header.className = 'batch-company-header';
    if (company.sourceType === 'search') {
      header.style.background = 'rgba(245,158,11,0.06)';
    }

    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;flex:1';

    const sourceChip = document.createElement('span');
    sourceChip.className = 'source-chip ' + (company.sourceType === 'search' ? 'search' : 'company');
    sourceChip.textContent = company.sourceType === 'search' ? 'RICERCA' : 'COMPANY';
    headerLeft.appendChild(sourceChip);

    const nameEl = document.createElement('span');
    nameEl.className = 'batch-company-name';
    nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    nameEl.textContent = company.companyName || company.companyUrl;
    headerLeft.appendChild(nameEl);

    const countBadge = document.createElement('span');
    countBadge.className = 'badge ' + (kept > 0 ? 'badge-green' : 'badge-amber');
    countBadge.textContent = `${kept} / ${company.contacts.length}`;

    header.appendChild(headerLeft);
    header.appendChild(countBadge);
    group.appendChild(header);

    // Sotto-header: filtri ricerca (solo per gruppi search)
    if (company.sourceType === 'search' && company.contacts.length > 0) {
      const sample = company.contacts[0];
      const chips = sample?._searchChips || [];
      if (chips.length > 0) {
        const chipsRow = document.createElement('div');
        chipsRow.style.cssText = 'font-size:9px;color:var(--text2);padding:5px 12px;background:var(--surface);border-bottom:1px solid var(--border);font-family:var(--mono);letter-spacing:0.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        chipsRow.textContent = chips.slice(0, 6).join(' · ');
        group.appendChild(chipsRow);
      }
    }

    if (company.contacts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'batch-no-contacts';
      empty.textContent = 'Nessun contatto in target trovato';
      group.appendChild(empty);
    } else {
      company.contacts.forEach((contact, idx) => {
        const item = document.createElement('div');
        item.className = 'result-item batch-contact-item';
        if (contact.keep === false) item.style.opacity = '0.45';

        // Riga nome + badge
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px';

        const nameSp = document.createElement('span');
        nameSp.className = 'result-name';
        nameSp.textContent = contact.fullName || '';
        row.appendChild(nameSp);

        const scoreBadge = document.createElement('span');
        scoreBadge.className = 'badge ' + ((contact.targetScore || 0) >= 4 ? 'badge-green' : 'badge-amber');
        scoreBadge.textContent = `SCORE ${contact.targetScore || 0}`;
        row.appendChild(scoreBadge);

        if (contact.email) {
          const emailBadge = document.createElement('span');
          emailBadge.className = 'badge badge-green';
          emailBadge.textContent = 'EMAIL ✓';
          row.appendChild(emailBadge);
        }
        if (contact.added) {
          const addedBadge = document.createElement('span');
          addedBadge.className = 'badge badge-green';
          addedBadge.textContent = 'INVIATO';
          row.appendChild(addedBadge);
        }

        const meta = document.createElement('div');
        meta.className = 'result-meta';
        // Per i contatti da ricerca: mostra "Ruolo · Azienda" (l'azienda è diversa per ogni profilo)
        if (contact._source === 'linkedin_persona_first' && contact.company) {
          meta.textContent = `${contact.role || contact.headline || 'Ruolo'} · ${contact.company}`;
        } else {
          meta.textContent = contact.role || 'Ruolo non disponibile';
        }

        const reason = document.createElement('div');
        reason.className = 'result-reason';
        reason.textContent = `Motivo: ${String(contact.matchReason || 'n/d').replace(/^match:\s*/i, '')}`;

        if (contact.email) {
          const emailEl = document.createElement('div');
          emailEl.className = 'result-email';
          emailEl.textContent = contact.email;
          item.appendChild(row);
          item.appendChild(meta);
          item.appendChild(reason);
          item.appendChild(emailEl);
        } else {
          item.appendChild(row);
          item.appendChild(meta);
          item.appendChild(reason);
        }

        // Azioni
        const actions = document.createElement('div');
        actions.className = 'result-actions';

        if (contact.keep !== false) {
          const discardBtn = document.createElement('button');
          discardBtn.className = 'btn btn-secondary btn-sm';
          discardBtn.textContent = 'Scarta';
          discardBtn.onclick = () => {
            batchState.allResults[ci].contacts[idx].keep = false;
            renderBatchResults();
          };
          actions.appendChild(discardBtn);
        } else {
          const restoreBtn = document.createElement('button');
          restoreBtn.className = 'btn btn-secondary btn-sm';
          restoreBtn.textContent = 'Ripristina';
          restoreBtn.onclick = () => {
            batchState.allResults[ci].contacts[idx].keep = true;
            renderBatchResults();
          };
          actions.appendChild(restoreBtn);
        }

        if (contact.profileUrl) {
          const liBtn = document.createElement('button');
          liBtn.className = 'btn btn-secondary btn-sm';
          liBtn.textContent = 'LinkedIn';
          liBtn.onclick = () => openLinkedInProfile(contact.profileUrl);
          actions.appendChild(liBtn);
        }

        if (contact.email && !contact.added) {
          const sendBtn = document.createElement('button');
          sendBtn.className = 'btn btn-primary btn-sm';
          sendBtn.textContent = 'Invia a Make';
          sendBtn.onclick = async () => {
            sendBtn.disabled = true;
            const ok = await addToLemlist(contact, contact.email);
            if (ok) {
              batchState.allResults[ci].contacts[idx].added = true;
              renderBatchResults();
            } else {
              sendBtn.disabled = false;
            }
          };
          actions.appendChild(sendBtn);
        }

        item.appendChild(actions);
        group.appendChild(item);
      });
    }

    container.appendChild(group);
  });

  // Aggiorna statistiche nel tab Log
  const statProcessed = document.getElementById('logStatProcessed');
  const statLeads = document.getElementById('logStatLeads');
  const statEmailsEl = document.getElementById('logStatEmails');
  if (statProcessed) statProcessed.textContent = batchState.allResults.length;
  if (statLeads) statLeads.textContent = totalKept;
  if (statEmailsEl) statEmailsEl.textContent = totalEmails;
}

// ── ENRICHMENT DA SUPABASE (modalità Grizzly webapp) ────────────────────────
let _stopEnrichSupabase = false;

async function enrichFromSupabase() {
  if (!cfg.supabaseEnabled || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    addLog('⚡ Supabase non configurato — vai in Impostazioni', 'error');
    return;
  }

  const btn     = document.getElementById('btnEnrichFromSupabase');
  const btnStop = document.getElementById('btnStopEnrichSupabase');
  if (btn) { btn.disabled = true; btn.style.display = 'none'; }
  if (btnStop) btnStop.style.display = '';
  _stopEnrichSupabase = false;
  await loadSettings();
  addLog(`Config: Dropcontact ${cfg.dropcontactKey ? '✓' : '✗'} | Lemlist ${cfg.lemlistKey ? '✓' : '✗'} | Apollo ${cfg.apolloKey ? '✓' : '✗'} (${cfg.useApollo ? 'abilitato' : 'disabilitato'})`, 'info');

  switchToTab('run');

  const sbUrl = cfg.supabaseUrl.replace(/\/$/, '');
  const key   = cfg.supabaseAnonKey;
  const hdr   = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  // 1. Leggi contatti in coda da Supabase
  let rows = [];
  try {
    const r = await fetch(
      `${sbUrl}/rest/v1/contacts?stato=eq.enrichment_richiesto&select=id,nome_completo,ruolo,linkedin_url,company_id,companies(nome,sito_web)&limit=200`,
      { headers: hdr }
    );
    if (!r.ok) throw new Error(await r.text());
    rows = await r.json();
  } catch(e) {
    addLog('Errore lettura contatti da Supabase: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.style.display = ''; }
    if (btnStop) btnStop.style.display = 'none';
    return;
  }

  if (!rows.length) {
    addLog('⬡ Nessun contatto con stato enrichment_richiesto in Supabase', 'warn');
    if (btn) { btn.disabled = false; btn.style.display = ''; }
    if (btnStop) btnStop.style.display = 'none';
    return;
  }

  addLog(`✉ ${rows.length} contatti da arricchire (da Grizzly webapp)`, 'info');

  let found = 0, notFound = 0;

  for (let i = 0; i < rows.length; i++) {
    if (_stopEnrichSupabase) { addLog('⏹ Enrichment interrotto', 'warn'); break; }

    const row = rows[i];
    const nameParts = (row.nome_completo || '').trim().split(/\s+/);
    const contact = {
      fullName:        row.nome_completo || '',
      firstName:       nameParts[0] || '',
      lastName:        nameParts.slice(1).join(' ') || '',
      role:            row.ruolo || '',
      profileUrl:      row.linkedin_url || '',
      company:         row.companies?.nome || '',
      companyWebsite:  row.companies?.sito_web || '',
      companyDomain:   (row.companies?.sito_web || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
    };

    addLog(`[${i+1}/${rows.length}] ${contact.fullName} @ ${contact.company || '—'}`, 'info');

    // Cascata email: Dropcontact → Lemlist → Apollo (stessa logica di processContact)
    let email = null;
    if (cfg.useDropcontact && cfg.dropcontactKey) email = await findEmailDropcontact(contact);
    if (!email && cfg.useLemlistEmail && cfg.lemlistKey) email = await findEmailLemlist(contact);
    if (!email && cfg.useApollo && cfg.apolloKey)       email = await findEmailApollo(contact);

    const nuovoStato = email ? 'email_trovata' : 'email_non_trovata';
    if (email) { found++; addLog(`✓ ${email}`, 'ok'); }
    else       { notFound++; addLog(`✗ nessuna email trovata`, 'warn'); }

    // Aggiorna Supabase
    try {
      await fetch(`${sbUrl}/rest/v1/contacts?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...hdr, Prefer: 'return=minimal' },
        body: JSON.stringify({ email: email || null, stato: nuovoStato }),
      });
    } catch(e) {
      addLog(`Errore salvataggio ${contact.fullName}: ${e.message}`, 'warn');
    }

    await humanDelay();
  }

  addLog(`✉ Enrichment completato: ${found} email trovate, ${notFound} non trovate`, found > 0 ? 'ok' : 'warn');
  if (btn) { btn.disabled = false; btn.style.display = ''; }
  if (btnStop) btnStop.style.display = 'none';
}

async function enrichBatchSelected() {
  const btn = document.getElementById('btnEnrichBatch');
  if (btn?.disabled) return;   // anti-doppio-click
  if (btn) btn.disabled = true;

  const toEnrich = [];
  batchState.allResults.forEach((company, ci) => {
    company.contacts.forEach((contact, idx) => {
      if (contact.keep !== false && !contact.enriched) {
        toEnrich.push({ contact, ci, idx });
      }
    });
  });

  if (toEnrich.length === 0) {
    addLog('Nessun contatto da arricchire (tutti già processati o scartati)', 'warn');
    if (btn) btn.disabled = false;
    return;
  }

  // Passa al tab Run così il log è visibile
  switchToTab('run');

  addLog(`✉ Avvio enrichment su ${toEnrich.length} contatti selezionati`, 'info');
  updateBatchProgress(0, toEnrich.length, '');

  for (let i = 0; i < toEnrich.length; i++) {
    if (batchState.stopped) break;
    const { contact, ci, idx } = toEnrich[i];

    updateBatchProgress(i + 1, toEnrich.length, contact.fullName || '');
    const isFromSearch = contact._source === 'linkedin_persona_first';
    const tagLog = isFromSearch ? `🔍 ${cfg.searchEmailStrategy || 'apollo_fallback'}` : '🏢 cascade';
    addLog(`[${i + 1}/${toEnrich.length}] ${tagLog} · ${contact.fullName} @ ${contact.company || '—'}`, 'info');

    let email = null;
    if (isFromSearch) {
      email = await findEmailWithStrategy(contact, cfg.searchEmailStrategy || 'apollo_fallback');
    } else {
      if (cfg.useDropcontact && cfg.dropcontactKey) email = await findEmailDropcontact(contact);
      if (!email && cfg.useLemlistEmail && cfg.lemlistKey) email = await findEmailLemlist(contact);
      if (!email && cfg.useApollo && cfg.apolloKey) email = await findEmailApollo(contact);
    }

    const updated = { ...contact, email: email || '', enriched: true };

    batchState.allResults[ci].contacts[idx] = {
      ...batchState.allResults[ci].contacts[idx],
      ...updated,
      keep: batchState.allResults[ci].contacts[idx].keep,
    };

    renderBatchResults();
    await humanDelay();
  }

  addLog('Enrichment batch completato', 'ok');
  updateBatchProgress(toEnrich.length, toEnrich.length, 'Completato ✓');
  if (btn) btn.disabled = false;

  // Torna al tab Risultati per mostrare i risultati aggiornati
  switchToTab('results');
}

function exportBatchCSV() {
  const allContacts = batchState.allResults.flatMap(c => c.contacts);
  if (allContacts.length === 0) { addLog('Nessun dato da esportare', 'warn'); return; }

  const headers = ['Nome', 'Ruolo', 'Company', 'Email', 'Score', 'Motivo', 'LinkedIn', 'Inviato'];
  const rows = allContacts.map(r => [
    r.fullName || '', r.role || '', r.company || '', r.email || '',
    r.targetScore || 0, r.matchReason || '', r.profileUrl || '', r.added ? 'SI' : 'NO',
  ]);

  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `grizzly_batch_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── DEBUG PAGE ────────────────────────────────────────────────────────────────
async function debugPage() {
  addLog('🔍 Analisi pagina in corso...', 'info');
  
  // Prova prima con funcName (content script)
  let res = await execInTrackedPage('__grizzly_debugPage');

  // Se non funziona, inietta direttamente la funzione
  if (!res?.result) {
    addLog('Content script non risponde, inietto direttamente...', 'warn');
    res = await chrome.runtime.sendMessage({
      type: 'EXECUTE_DIRECT',
    });
  }

  const info = res?.result;
  if (!info) { 
    addLog('Debug fallito — ricarica la pagina LinkedIn e riprova', 'error'); 
    return; 
  }
  addLog('URL: ' + info.url.substring(0, 70), 'info');
  addLog('LI: ' + info.lisItems + ' | UL: ' + info.ulItems, 'info');
  addLog('Classi people: ' + (info.peopleClasses.slice(0,5).join(', ') || 'nessuna'), info.peopleClasses.length > 0 ? 'ok' : 'warn');
  addLog('Link /in/ trovati: ' + info.profileLinks.length, info.profileLinks.length > 0 ? 'ok' : 'warn');
  if (info.profileLinks.length > 0) {
    info.profileLinks.slice(0,3).forEach(p => {
      addLog('→ ' + p.href.substring(0,50) + ' | ' + (p.text||'').substring(0,40), 'ok');
      addLog('  classe: ' + (p.cls||'').substring(0,60), 'info');
    });
  }
  if (info.sampleHTML) {
    addLog('HTML: ' + info.sampleHTML.substring(0,120), 'info');
  }
}

// ── RESULTS ──────────────────────────────────────────────────────────────────
function renderResults() {
  const list = $('resultsList');
  if (!list) return;
  list.innerHTML = '';
  if (state.results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Nessun contatto ancora';
    list.appendChild(empty);
    return;
  }

  state.results.forEach((r, idx) => {
    const item = document.createElement('div');
    item.className = 'result-item';
    if (r.keep === false) item.style.opacity = '0.55';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap';

    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = r.fullName || '';

    const badge = document.createElement('span');
    let badgeClass = 'badge-amber';
    let badgeText = 'DA RIVEDERE';
    if (r.keep === false) {
      badgeText = 'SCARTATO';
    } else if (r.added) {
      badgeClass = 'badge-green';
      badgeText = 'AGGIUNTO';
    } else if (r.enriched && r.email) {
      badgeClass = 'badge-green';
      badgeText = 'PRONTO';
    } else if (r.enriched && !r.email) {
      badgeText = 'NO EMAIL';
    } else if (r.keep !== false) {
      badgeClass = 'badge-green';
      badgeText = 'TENUTO';
    }
    badge.className = 'badge ' + badgeClass;
    badge.textContent = badgeText;

    const score = document.createElement('span');
    score.className = 'badge ' + ((r.targetScore || 0) >= 4 ? 'badge-green' : 'badge-amber');
    score.textContent = `SCORE ${r.targetScore || 0}`;

    row.appendChild(name);
    row.appendChild(badge);
    row.appendChild(score);

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    meta.textContent = `${r.role || 'Ruolo non trovato'} — ${cleanCompanyName(r.company || '')}`;

    const desc = document.createElement('div');
    desc.className = 'result-meta';
    desc.style.marginTop = '4px';
    desc.textContent = r.jobDescription || '';

    const reason = document.createElement('div');
    reason.className = 'result-reason';
    reason.textContent = `Motivo: ${String(r.matchReason || 'n/d').replace(/^match:\s*/i, '')}`;

    const email = document.createElement('div');
    email.className = 'result-email';
    email.textContent = r.email || '—';

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    if (r.keep !== false) {
      const discardBtn = document.createElement('button');
      discardBtn.className = 'btn btn-secondary btn-sm';
      discardBtn.textContent = 'Scarta';
      discardBtn.addEventListener('click', () => setResultKeepState(idx, false));
      actions.appendChild(discardBtn);
    }

    if (r.profileUrl) {
      const linkedinBtn = document.createElement('button');
      linkedinBtn.className = 'btn btn-secondary btn-sm';
      linkedinBtn.textContent = 'LinkedIn';
      linkedinBtn.addEventListener('click', () => openLinkedInProfile(r.profileUrl));
      actions.appendChild(linkedinBtn);
    }

    if (r.email && !r.added) {
      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-primary btn-sm';
      sendBtn.textContent = 'Invia a Make';
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Invio...';
        const ok = await sendResultToLemlist(idx);
        if (!ok) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Invia a Make';
        }
      });
      actions.appendChild(sendBtn);
    }

    item.appendChild(row);
    item.appendChild(meta);
    if (r.jobDescription && r.jobDescription !== r.role) item.appendChild(desc);
    item.appendChild(reason);
    item.appendChild(email);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

async function sendResultToLemlist(index) {
  const r = state.results[index];
  if (!r || !r.email) {
    addLog('Invio a Make impossibile: email mancante', 'warn');
    return false;
  }

  const ok = await addToLemlist(r, r.email);
  if (ok) {
    state.results[index].added = true;
    state.added++;
    updateStats();
    renderResults();
    addLog(`✓ Inviato a Make: ${r.fullName} | ruolo: ${r.role || '-'}`, 'ok');
    return true;
  }

  addLog(`Invio a Make fallito: ${r.fullName}`, 'warn');
  return false;
}


function openLinkedInProfile(url) {
  if (!url) return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    location.href = url;
  }
}


function setResultKeepState(index, keep) {
  if (!state.results[index]) return;
  state.results[index].keep = !!keep;
  renderResults();
}

function restoreAllResults() {
  state.results = (state.results || []).map(r => ({ ...r, keep: true }));
  renderResults();
}

async function enrichSelectedResults() {
  const selected = (state.results || []).filter(r => r.keep !== false && !r.enriched);
  if (selected.length === 0) {
    addLog('Nessun profilo selezionato da arricchire', 'warn');
    return;
  }

  // switch to run tab to show logs
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  const runTabBtn = document.querySelector('.tab[data-tab="run"]');
  if (runTabBtn) runTabBtn.classList.add('active');
  ['run','batch','results','keywords','settings'].forEach(n => {
    const el = document.getElementById('tab-' + n);
    if (el) el.style.display = n === 'run' ? 'flex' : 'none';
  });

  addLog(`Avvio enrichment su ${selected.length} profili selezionati`, 'info');

  for (let i = 0; i < state.results.length; i++) {
    const r = state.results[i];
    if (state.stopped) break;
    if (!r || r.keep === false || r.enriched) continue;

    addLog(`[${i + 1}/${state.results.length}] Enrichment ${r.fullName}`, 'info');
    const processed = await processContact(r);
    state.results[i] = { ...state.results[i], ...processed, keep: state.results[i].keep };
    renderResults();
    await (typeof humanDelay === 'function' ? humanDelay() : sleep((cfg.delay * 1000) + Math.random() * 1500));
  }

  addLog('Enrichment selezionati completato', 'ok');

  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  const resultsTabBtn = document.querySelector('.tab[data-tab="results"]');
  if (resultsTabBtn) resultsTabBtn.classList.add('active');
  ['run','batch','results','keywords','settings'].forEach(n => {
    const el = document.getElementById('tab-' + n);
    if (el) el.style.display = n === 'results' ? 'block' : 'none';
  });
}

function exportResults() {
  if (!state.results || state.results.length === 0) {
    addLog('Nessun dato da esportare', 'warn');
    return;
  }

  const headers = ['Nome','Ruolo','Job Description','Company','Email','Score','Motivo Match','Keyword Matchate','Penalita','Lemlist','LinkedIn'];
  const rows = state.results.map(r => [
    r.fullName || '',
    r.role || '',
    r.jobDescription || '',
    cleanCompanyName(r.company || ''),
    r.email || '',
    r.targetScore || 0,
    r.matchReason || '',
    (r.matchedRules || []).map(x => `${x.keyword}:${x.weight}`).join(' | '),
    (r.negativeHits || []).map(x => `${x.keyword}:${x.weight}`).join(' | '),
    r.added ? 'SI' : 'NO',
    r.profileUrl || ''
  ]);

  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v || '').replace(/"/g,'""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `grizzly_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ── EXPORT / IMPORT KEYWORD ──────────────────────────────────────────────────
function exportKeywords() {
  const keywordRules = getKeywordRules();
  const penaltyRules = getPenaltyRules();
  if (keywordRules.length === 0 && penaltyRules.length === 0) {
    addLog('Nessuna keyword da esportare', 'warn');
    return;
  }
  const payload = { keywordRules, penaltyRules, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `grizzly_keywords_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  addLog(`Keyword esportate: ${keywordRules.length} keyword, ${penaltyRules.length} penalità`, 'ok');
}

function importKeywords() {
  const fileInput = $('importKeywordsFile');
  if (!fileInput) return;
  fileInput.value = '';
  fileInput.click();
}

function handleImportKeywordsFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const keywordRules = data.keywordRules;
      const penaltyRules = data.penaltyRules;
      if (!Array.isArray(keywordRules)) {
        addLog('File non valido: campo keywordRules mancante', 'error');
        return;
      }
      cfg.keywordRules = keywordRules.filter(r => r.keyword).map(r => ({
        keyword: String(r.keyword).trim(),
        weight: Number(r.weight || 0),
      }));
      cfg.keywords = cfg.keywordRules.map(r => r.keyword);
      if (Array.isArray(penaltyRules)) {
        cfg.penaltyRules = penaltyRules.filter(r => r.keyword).map(r => ({
          keyword: String(r.keyword).trim(),
          weight: Number(r.weight || 0),
        }));
      }
      await chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
      renderKeywords();
      renderPenaltyRules();
      addLog(`Keyword importate: ${cfg.keywordRules.length} keyword, ${cfg.penaltyRules?.length || 0} penalità`, 'ok');
    } catch (err) {
      addLog('Errore lettura file: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// ── KEYWORDS// ── KEYWORDS ─────────────────────────────────────────────────────────────────
function renderKeywords() {
  const container = $('kwContainer');
  if (!container) return;
  container.innerHTML = '';

  const rules = getKeywordRules();
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'kw-empty';
    empty.textContent = 'Nessuna keyword caricata';
    container.appendChild(empty);
    return;
  }

  rules.forEach((rule, i) => {
    const row = document.createElement('div');
    row.className = 'kw-row';

    const keyInput = document.createElement('input');
    keyInput.className = 'kw-key';
    keyInput.type = 'text';
    keyInput.value = rule.keyword;
    keyInput.placeholder = 'keyword';

    const weightInput = document.createElement('input');
    weightInput.className = 'kw-weight';
    weightInput.type = 'number';
    weightInput.value = Number(rule.weight || 0);
    weightInput.min = '-10';
    weightInput.max = '10';
    weightInput.step = '1';

    const remove = document.createElement('button');
    remove.className = 'btn btn-secondary btn-sm';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const current = getKeywordRules();
      current.splice(i, 1);
      cfg.keywordRules = current;
      cfg.keywords = current.map(r => r.keyword);
      renderKeywords();
    });

    row.appendChild(keyInput);
    row.appendChild(weightInput);
    row.appendChild(remove);
    container.appendChild(row);
  });
}


function renderPenaltyRules() {
  const container = $('penaltyContainer');
  if (!container) return;
  container.innerHTML = '';

  const rules = getPenaltyRules();
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'kw-empty';
    empty.textContent = 'Nessuna penalità caricata';
    container.appendChild(empty);
    return;
  }

  rules.forEach((rule, i) => {
    const row = document.createElement('div');
    row.className = 'kw-row';

    const keyInput = document.createElement('input');
    keyInput.className = 'kw-key';
    keyInput.type = 'text';
    keyInput.value = rule.keyword;
    keyInput.placeholder = 'penalità';

    const weightInput = document.createElement('input');
    weightInput.className = 'kw-weight';
    weightInput.type = 'number';
    weightInput.value = Number(rule.weight || 0);
    weightInput.min = '-10';
    weightInput.max = '10';
    weightInput.step = '1';

    const remove = document.createElement('button');
    remove.className = 'btn btn-secondary btn-sm';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const current = getPenaltyRules();
      current.splice(i, 1);
      cfg.penaltyRules = current;
      renderPenaltyRules();
    });

    row.appendChild(keyInput);
    row.appendChild(weightInput);
    row.appendChild(remove);
    container.appendChild(row);
  });
}

function addPenalty() {
  const input = $('penaltyInput');
  const val = input.value.trim();
  if (!val) return;
  const current = getPenaltyRules();
  const exists = current.some(r => normalizeMatchText(r.keyword) === normalizeMatchText(val));
  if (!exists) {
    current.push({ keyword: val, weight: -1 });
    cfg.penaltyRules = current;
    renderPenaltyRules();
  }
  input.value = '';
}

function addKeyword() {
  const input = $('kwInput');
  const val = input.value.trim();
  if (!val) return;

  const current = getKeywordRules();
  const exists = current.some(r => normalizeMatchText(r.keyword) === normalizeMatchText(val));
  if (!exists) {
    current.push({ keyword: val, weight: defaultWeightForKeyword(val) });
    cfg.keywordRules = current;
    cfg.keywords = current.map(r => r.keyword);
    renderKeywords();
  }
  input.value = '';
}

// removeKeyword gestito da event delegation in renderKeywords()

// ── SETTINGS ─────────────────────────────────────────────────────────────────
// ── SUPABASE: scrivi contatti nel DB ────────────────────────────────────────
async function writeContactsToSupabase(contacts, companyUrl, companyName) {
  if (!cfg.supabaseEnabled || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return { ok: false, skipped: true };
  const sbUrl = cfg.supabaseUrl.replace(/\/$/, '');
  const key = cfg.supabaseAnonKey;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  // Helper: cerca company_id per nome (con cache per evitare chiamate duplicate)
  const companyCache = {};
  const lookupCompanyByName = async (nome) => {
    if (!nome) return null;
    const k = nome.trim().toLowerCase();
    if (k in companyCache) return companyCache[k];
    try {
      const r = await fetch(`${sbUrl}/rest/v1/companies?select=id&nome=ilike.*${encodeURIComponent(nome.trim())}*&limit=1`, { headers });
      const id = (r.ok && (await r.json())[0]?.id) || null;
      companyCache[k] = id;
      return id;
    } catch { companyCache[k] = null; return null; }
  };

  // Modalità company page: un solo lookup per tutto il batch
  const isSerp = !companyUrl || !companyUrl.includes('linkedin.com/company/');
  let globalCompanyId = null;
  if (!isSerp) {
    try {
      const liUrl = companyUrl.split('?')[0].replace(/\/$/, '');
      const slug = liUrl.split('linkedin.com/company/')[1]?.split('/')[0];
      if (slug) {
        const r = await fetch(`${sbUrl}/rest/v1/companies?select=id&linkedin_url=ilike.*${encodeURIComponent(slug)}*&limit=1`, { headers });
        if (r.ok) { const rows = await r.json(); globalCompanyId = rows[0]?.id || null; }
      }
    } catch {}
    // Fallback per nome globale
    if (!globalCompanyId) globalCompanyId = await lookupCompanyByName(companyName);
  }

  // Costruisce i record: in SERP lookup per-contatto, altrimenti usa globalCompanyId
  const records = [];
  for (const c of contacts.filter(c => c.profileUrl || c.linkedin_url)) {
    let companyId = globalCompanyId;
    if (isSerp && !companyId) {
      companyId = await lookupCompanyByName(c.company || c.azienda || '');
    }
    records.push({
      company_id: companyId || null,
      nome_completo: c.fullName || c.name || '',
      ruolo: c.role || '',
      ruolo_descrizione: c.jobDescription || '',
      linkedin_url: c.profileUrl || c.linkedin_url || null,
      email: c.email || null,
      target_score: c.targetScore || 0,
      matched_keywords: c.matchedKeywords || [],
      stato: 'trovato',
    });
  }

  if (!records.length) return { ok: true, count: 0 };

  try {
    const r = await fetch(`${sbUrl}/rest/v1/contacts?on_conflict=linkedin_url`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(records),
    });
    if (r.ok) {
      const found = records.filter(r=>r.company_id).length;
      addLog(`⬡ ${records.length} contatti salvati su Supabase (${found} con company_id, ${records.length-found} senza)`, 'ok');
      // Aggiorna stato azienda → contatti_trovati (così non viene ricaricata nel prossimo batch)
      if (globalCompanyId) {
        try {
          await fetch(`${sbUrl}/rest/v1/companies?id=eq.${globalCompanyId}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ stato: 'contatti_trovati', aggiornato_il: new Date().toISOString() }),
          });
        } catch {}
      }
      return { ok: true, count: records.length };
    } else {
      const err = await r.text();
      addLog(`⬡ Supabase errore: ${err.slice(0, 80)}`, 'warn');
      return { ok: false, error: err };
    }
  } catch (e) {
    addLog(`⬡ Supabase non raggiungibile: ${e.message}`, 'warn');
    return { ok: false, error: e.message };
  }
}

function saveSettings() {
  cfg.lemlistKey = $('cfgLemlistKey').value.trim();
  cfg.dropcontactKey = $('cfgDropcontactKey').value.trim();
  cfg.apolloKey = $('cfgApolloKey')?.value?.trim() || '';
  cfg.useApollo = $('useApollo')?.checked || false;
  cfg.useDropcontact = $('useDropcontact').checked;
  cfg.useLemlistEmail = $('useLemlistEmail').checked;
  cfg.maxProfiles = parseInt($('cfgMaxProfiles').value) || 30;
  cfg.delay = parseInt($('cfgDelay').value) || 5;

  // ── v2: Opzioni Ricerca Persone ─────────────────────────────────────────
  cfg.searchMaxPages = parseInt($('cfgSearchMaxPages')?.value || '5', 10) || 5;
  cfg.searchApplyScoring = $('cfgSearchApplyScoring')?.checked || false;
  const selectedStrategy = document.querySelector('.radio-option.selected')?.dataset?.strategy;
  if (selectedStrategy) cfg.searchEmailStrategy = selectedStrategy;

  const rules = Array.from(document.querySelectorAll('#kwContainer .kw-row')).map(row => {
    const keyword = row.querySelector('.kw-key')?.value?.trim() || '';
    const weight = parseInt(row.querySelector('.kw-weight')?.value || '0', 10);
    return { keyword, weight };
  }).filter(r => r.keyword);

  cfg.keywordRules = rules;
  cfg.keywords = rules.map(r => r.keyword);

  const penaltyRules = Array.from(document.querySelectorAll('#penaltyContainer .kw-row')).map(row => {
    const keyword = row.querySelector('.kw-key')?.value?.trim() || '';
    const weight = parseInt(row.querySelector('.kw-weight')?.value || '0', 10);
    return { keyword, weight };
  }).filter(r => r.keyword);
  cfg.penaltyRules = penaltyRules;

  // Supabase
  cfg.supabaseUrl = $('cfgSupabaseUrl')?.value?.trim() || '';
  cfg.supabaseAnonKey = $('cfgSupabaseKey')?.value?.trim() || '';
  cfg.supabaseEnabled = $('cfgSupabaseEnabled')?.checked || false;

  chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
  addLog('Configurazione salvata', 'ok');
  $('saveMsg').style.display = 'block';
  setTimeout(() => $('saveMsg').style.display = 'none', 2000);
}

// ── EXPORT CONFIG ─────────────────────────────────────────────────────────────
async function exportConfig() {
  const data = await chrome.storage.local.get(['grizzlyCfg', 'cfg']);
  const stored = data.grizzlyCfg || data.cfg || {};
  // Esporta solo i campi di configurazione (non lo stato della sessione)
  const exportKeys = [
    'dropcontactKey','lemlistKey','apolloKey',
    'useDropcontact','useLemlistEmail','useApollo',
    'maxProfiles','delay',
    'keywordRules','penaltyRules','keywords',
    // v2:
    'searchMaxPages','searchEmailStrategy','searchApplyScoring',
  ];
  const exportData = {};
  exportKeys.forEach(k => { if (stored[k] !== undefined) exportData[k] = stored[k]; });

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'grizzly-extension-config.json';
  a.click();
  URL.revokeObjectURL(url);
  addLog('Config esportata in grizzly-extension-config.json', 'ok');
}

// ── IMPORT CONFIG ─────────────────────────────────────────────────────────────
async function importConfig(file) {
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    // Valida: deve avere almeno un campo noto
    const knownKeys = ['dropcontactKey','lemlistKey','sheetUrl','keywordRules','penaltyRules'];
    const hasKnown = knownKeys.some(k => imported[k] !== undefined);
    if (!hasKnown) throw new Error('File non valido: nessun campo riconosciuto');

    // Merge con config esistente
    const data = await chrome.storage.local.get(['grizzlyCfg','cfg']);
    const current = data.grizzlyCfg || data.cfg || {};
    const merged = { ...current, ...imported };
    await chrome.storage.local.set({ grizzlyCfg: merged, cfg: merged });
    cfg = merged;
    await loadSettings(); // aggiorna i campi UI
    addLog('Config importata correttamente', 'ok');
    $('saveMsg').textContent = '✓ Config importata';
    $('saveMsg').style.display = 'block';
    setTimeout(() => { $('saveMsg').style.display = 'none'; $('saveMsg').textContent = '✓ Salvato'; }, 2500);
  } catch(e) {
    addLog('Errore importazione config: ' + e.message, 'warn');
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['grizzlyCfg', 'cfg']);
  const stored = data.grizzlyCfg || data.cfg || {};

  cfg = { ...cfg, ...stored };

  if ((!Array.isArray(cfg.keywordRules) || cfg.keywordRules.length === 0) && Array.isArray(cfg.keywords) && cfg.keywords.length > 0) {
    cfg.keywordRules = cfg.keywords.map(k => ({ keyword: k, weight: defaultWeightForKeyword(k) }));
  }

  if (!Array.isArray(cfg.penaltyRules) || cfg.penaltyRules.length === 0) {
    cfg.penaltyRules = defaultPenaltyRules();
  }

  if ((!Array.isArray(cfg.keywordRules) || cfg.keywordRules.length === 0) && (!Array.isArray(cfg.keywords) || cfg.keywords.length === 0)) {
    try {
      const defaults = await loadDefaultKeywords();
      cfg.keywordRules = defaults.map(k => ({ keyword: k, weight: defaultWeightForKeyword(k) }));
      cfg.keywords = cfg.keywordRules.map(r => r.keyword);
      await chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
      addLog(`Keyword di default caricate: ${cfg.keywordRules.length}`, 'ok');
    } catch (e) {
      console.error('Errore caricamento keyword di default', e);
      addLog('Errore caricamento keyword di default', 'warn');
      cfg.keywordRules = [];
      cfg.keywords = [];
    }
  }

  const fields = {
    'cfgLemlistKey': 'lemlistKey',
    'cfgDropcontactKey': 'dropcontactKey',
    'cfgApolloKey': 'apolloKey',
    'cfgMaxProfiles': 'maxProfiles',
    'cfgDelay': 'delay',
    'cfgSupabaseUrl': 'supabaseUrl',
    'cfgSupabaseKey': 'supabaseAnonKey',
    'cfgSearchMaxPages': 'searchMaxPages',
  };
  Object.entries(fields).forEach(([id, key]) => {
    const el = $(id);
    if (el) el.value = cfg[key] ?? (key === 'searchMaxPages' ? 5 : '');
  });

  const toggles = {
    'useDropcontact': 'useDropcontact',
    'useLemlistEmail': 'useLemlistEmail',
    'useApollo': 'useApollo',
    'cfgSupabaseEnabled': 'supabaseEnabled',
    'cfgSearchApplyScoring': 'searchApplyScoring',
  };
  Object.entries(toggles).forEach(([id, key]) => {
    const el = $(id);
    if (el) el.checked = !!cfg[key];
  });

  // ── v2: sincronizza radio option per la strategia email ────────────────
  const strategy = cfg.searchEmailStrategy || 'apollo_fallback';
  document.querySelectorAll('.radio-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.strategy === strategy);
  });

  renderKeywords();
  renderPenaltyRules();
  return cfg;
}

// ── EVENT LISTENERS// ── EVENT LISTENERS (sostituisce onclick inline) ─────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Tabs (ora include anche "batch")
  const ALL_TABS = ['run', 'batch', 'results', 'keywords', 'settings'];
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const name = t.dataset.tab;
      ALL_TABS.forEach(n => {
        const el = document.getElementById('tab-' + n);
        if (el) el.style.display = n === name ? (n === 'run' ? 'flex' : 'block') : 'none';
      });
    });
  });

  // Carica da Sheets
  // Toggle card Ricerca
  const batchSearchHeader = document.getElementById('batchSearchHeader');
  if (batchSearchHeader) {
    batchSearchHeader.addEventListener('click', () => {
      const body = document.getElementById('batchSearchBody');
      const toggle = document.getElementById('batchSearchToggle');
      const open = body.style.display === 'none';
      body.style.display = open ? 'block' : 'none';
      toggle.textContent = open ? '▾' : '▸';
    });
  }

  // Batch buttons
  const btnStartBatch = document.getElementById('btnStartBatch');
  if (btnStartBatch) btnStartBatch.addEventListener('click', startBatch);

  const btnStopBatch = document.getElementById('btnStopBatch');
  if (btnStopBatch) btnStopBatch.addEventListener('click', stopBatch);

  const btnStopBatchLog = document.getElementById('btnStopBatchLog');
  if (btnStopBatchLog) btnStopBatchLog.addEventListener('click', stopBatch);

  const btnEnrichBatch = document.getElementById('btnEnrichBatch');
  if (btnEnrichBatch) btnEnrichBatch.addEventListener('click', enrichBatchSelected);

  const btnEnrichSupabase = document.getElementById('btnEnrichFromSupabase');
  if (btnEnrichSupabase) btnEnrichSupabase.addEventListener('click', enrichFromSupabase);

  const btnStopEnrichSb = document.getElementById('btnStopEnrichSupabase');
  if (btnStopEnrichSb) btnStopEnrichSb.addEventListener('click', () => { _stopEnrichSupabase = true; });

  const btnExportBatch = document.getElementById('btnExportBatch');
  if (btnExportBatch) btnExportBatch.addEventListener('click', exportBatchCSV);

  // Mode buttons
  const modeAutoBtn = document.getElementById('modeAuto');
  const modeManualBtn = document.getElementById('modeManual');
  if (modeAutoBtn) modeAutoBtn.addEventListener('click', () => setMode('auto'));
  if (modeManualBtn) modeManualBtn.addEventListener('click', () => setMode('manual'));

  // Start/Stop
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  if (btnStart) btnStart.addEventListener('click', startScraping);
  if (btnStop) btnStop.addEventListener('click', stopScraping);

  // Export / review actions
  const btnExport = document.getElementById('btnExport');
  if (btnExport) btnExport.addEventListener('click', exportResults);
  const btnRestoreAll = document.getElementById('btnRestoreAll');
  if (btnRestoreAll) btnRestoreAll.addEventListener('click', restoreAllResults);
  const btnEnrichSelected = document.getElementById('btnEnrichSelected');
  if (btnEnrichSelected) btnEnrichSelected.addEventListener('click', enrichSelectedResults);

  // Settings
  const btnSave = document.getElementById('btnSaveSettings');
  if (btnSave) btnSave.addEventListener('click', saveSettings);

  // Export / Import config
  const btnExportConfig = document.getElementById('btnExportConfig');
  if (btnExportConfig) btnExportConfig.addEventListener('click', exportConfig);

  const btnImportConfig = document.getElementById('btnImportConfig');
  const importConfigInput = document.getElementById('importConfigInput');
  if (btnImportConfig && importConfigInput) {
    btnImportConfig.addEventListener('click', () => importConfigInput.click());
    importConfigInput.addEventListener('change', e => {
      if (e.target.files[0]) importConfig(e.target.files[0]);
      e.target.value = '';
    });
  }

  // Add keyword
  const btnAddKw = document.getElementById('btnAddKeyword');
  if (btnAddKw) btnAddKw.addEventListener('click', addKeyword);

  const kwInput = document.getElementById('kwInput');
  if (kwInput) kwInput.addEventListener('keydown', e => { if(e.key==='Enter') addKeyword(); });

  const btnAddPenalty = document.getElementById('btnAddPenalty');
  if (btnAddPenalty) btnAddPenalty.addEventListener('click', addPenalty);

  const penaltyInput = document.getElementById('penaltyInput');
  if (penaltyInput) penaltyInput.addEventListener('keydown', e => { if(e.key==='Enter') addPenalty(); });

  // Export / Import keyword
  const btnExportKeywords = document.getElementById('btnExportKeywords');
  if (btnExportKeywords) btnExportKeywords.addEventListener('click', exportKeywords);

  const btnImportKeywords = document.getElementById('btnImportKeywords');
  if (btnImportKeywords) btnImportKeywords.addEventListener('click', importKeywords);

  const importKeywordsFile = document.getElementById('importKeywordsFile');
  if (importKeywordsFile) importKeywordsFile.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleImportKeywordsFile(file);
  });

  // ── v2: Radio option per strategia email ──────────────────────────────
  document.querySelectorAll('.radio-option').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.radio-option').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      cfg.searchEmailStrategy = el.dataset.strategy || 'apollo_fallback';
      // Persisti subito (UX: niente "salva" da premere)
      chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
    });
  });

  // ── v3: Live preview su entrambe le textarea (Company + Ricerca) ──────
  const batchUrlsEl = document.getElementById('batchUrls');
  if (batchUrlsEl) {
    batchUrlsEl.addEventListener('input', updateBatchUrlsPreview);
    batchUrlsEl.addEventListener('paste', () => setTimeout(updateBatchUrlsPreview, 50));
  }
  const batchSearchUrlsEl = document.getElementById('batchSearchUrls');
  if (batchSearchUrlsEl) {
    batchSearchUrlsEl.addEventListener('input', updateBatchUrlsPreview);
    batchSearchUrlsEl.addEventListener('paste', () => setTimeout(updateBatchUrlsPreview, 50));
  }

  // ── v2: Persisti subito le opzioni search quando cambiano ─────────────
  const searchMaxPagesEl = document.getElementById('cfgSearchMaxPages');
  if (searchMaxPagesEl) {
    searchMaxPagesEl.addEventListener('change', () => {
      cfg.searchMaxPages = parseInt(searchMaxPagesEl.value || '5', 10) || 5;
      chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
    });
  }
  const searchApplyScoringEl = document.getElementById('cfgSearchApplyScoring');
  if (searchApplyScoringEl) {
    searchApplyScoringEl.addEventListener('change', () => {
      cfg.searchApplyScoring = !!searchApplyScoringEl.checked;
      chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
    });
  }

  // ── v2: Save Keywords button nel tab Keyword ──────────────────────────
  const btnSaveKeywords = document.getElementById('btnSaveKeywords');
  if (btnSaveKeywords) btnSaveKeywords.addEventListener('click', () => {
    // Riusa la stessa logica di saveSettings ma solo per keyword/penalty
    const rules = Array.from(document.querySelectorAll('#kwContainer .kw-row')).map(row => {
      const keyword = row.querySelector('.kw-key')?.value?.trim() || '';
      const weight = parseInt(row.querySelector('.kw-weight')?.value || '0', 10);
      return { keyword, weight };
    }).filter(r => r.keyword);
    cfg.keywordRules = rules;
    cfg.keywords = rules.map(r => r.keyword);

    const penaltyRules = Array.from(document.querySelectorAll('#penaltyContainer .kw-row')).map(row => {
      const keyword = row.querySelector('.kw-key')?.value?.trim() || '';
      const weight = parseInt(row.querySelector('.kw-weight')?.value || '0', 10);
      return { keyword, weight };
    }).filter(r => r.keyword);
    cfg.penaltyRules = penaltyRules;

    chrome.storage.local.set({ grizzlyCfg: cfg, cfg });
    addLog(`Keyword salvate: ${rules.length} target, ${penaltyRules.length} penalità`, 'ok');
    const msgEl = document.getElementById('kwSaveMsg');
    if (msgEl) {
      msgEl.style.display = 'block';
      setTimeout(() => { msgEl.style.display = 'none'; }, 2000);
    }
  });

  // ── v3.2: Reset progresso ricerche ─────────────────────────────────────
  const btnResetSearchProgress = document.getElementById('btnResetSearchProgress');
  if (btnResetSearchProgress) {
    btnResetSearchProgress.addEventListener('click', async () => {
      if (Object.keys(cfg.searchProgress || {}).length === 0) return;
      await resetSearchProgress();
    });
  }

  // Init
  await loadSettings();
  renderResults();
  updateBatchUrlsPreview();
  updateResetSearchProgressUi();
  setInterval(detectCompanyPage, 2000);
  detectCompanyPage();
});



function exportResults() {
  if (!state.results || state.results.length === 0) {
    addLog('Nessun dato da esportare', 'warn');
    return;
  }

  const rows = [
    ['Name','Email','Company','Role','LinkedIn'],
    ...state.results.map(r => [
      r.fullName || '',
      r.email || '',
      r.company || '',
      r.role || '',
      r.profileUrl || ''
    ])
  ];

  const csv = rows.map(r => r.map(v => `"${(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `grizzly_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}
