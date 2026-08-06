
function cleanCompanyName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*[:\-–|]\s*(persone|people|panoramica|overview)\s*$/i, '')
    .replace(/\s*[:\-–|]\s*(persone|people|panoramica|overview).*$/i, '')
    .replace(/\|\s*linkedin.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
// content.js — gira su ogni pagina LinkedIn

window.__grizzly_isPeoplePage = () => window.location.href.includes('/people');
window.__grizzly_isCompanyPage = () => window.location.href.includes('/company/');
window.__grizzly_getCompanyName = () => {
  let name = document.querySelector('h1')?.innerText?.trim() || '';
  return cleanCompanyName(name);
};

window.__grizzly_extractCompanyWebsite = () => {
  const normalize = (raw) => {
    if (!raw) return '';
    try {
      let url = raw;

      // LinkedIn redirect wrapper
      if (/linkedin\.com\/redir\/redirect/i.test(url)) {
        const u = new URL(url);
        const target = u.searchParams.get('url');
        if (target) url = decodeURIComponent(target);
      }

      if (!/^https?:\/\//i.test(url)) return '';
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();

      if (!host) return '';
      if (host.includes('linkedin.com')) return '';
      if (host.includes('facebook.com')) return '';
      if (host.includes('instagram.com')) return '';
      if (host.includes('x.com')) return '';
      if (host.includes('twitter.com')) return '';
      if (host.includes('youtube.com')) return '';

      return `https://${host}`;
    } catch (e) {
      return '';
    }
  };

  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.href || a.getAttribute('href') || '';
    const text = (a.innerText || a.textContent || '').trim().toLowerCase();
    const aria = (a.getAttribute('aria-label') || '').trim().toLowerCase();

    const looksRelevant =
      text.includes('website') ||
      text.includes('sito web') ||
      aria.includes('website') ||
      aria.includes('sito web') ||
      (/^https?:\/\//i.test(href) && !href.includes('linkedin.com'));

    if (!looksRelevant) continue;

    const normalized = normalize(href);
    if (normalized) {
      return {
        website: normalized,
        domain: normalized.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
      };
    }
  }

  return { website: '', domain: '' };
};


window.__grizzly_clickPeopleTab = () => {
  // Naviga SEMPRE direttamente — è il metodo più sicuro e preciso
  const match = window.location.href.match(/\/company\/([^/?#]+)/);
  if (match) {
    const companySlug = match[1];
    window.location.href = `https://www.linkedin.com/company/${companySlug}/people/`;
    return { clicked: true, method: 'direct', url: `https://www.linkedin.com/company/${companySlug}/people/` };
  }
  return { clicked: false, reason: 'Not on a company page' };
};

window.__grizzly_clickShowMore = () => {
  const btns = Array.from(document.querySelectorAll('button'));
  const candidates = [];
  
  for (const btn of btns) {
    const text = btn.innerText?.trim().toLowerCase();
    const isLoadMore = (text.includes('mostra altri') || text.includes('show more') || 
                        text.includes('carica altri') || text.includes('load more'));
    // Escludi qualsiasi bottone che menziona prodotti/aziende/connessioni
    const isProduct = (text.includes('prodott') || text.includes('product') ||
                       text.includes('aziend') || text.includes('compan') ||
                       text.includes('connession') || text.includes('connection') ||
                       text.includes('seguaci') || text.includes('follower'));
    const inModal = btn.closest('[role="dialog"]') || btn.closest('.artdeco-modal');
    
    if (isLoadMore) {
      candidates.push({
        text: btn.innerText?.trim(),
        isProduct,
        inModal: !!inModal,
        classes: btn.className?.toString().substring(0, 100),
        parentClasses: btn.parentElement?.className?.toString().substring(0, 100),
      });
      
      if (!isProduct && !inModal) {
        btn.click();
        return { clicked: true, text: btn.innerText?.trim() };
      }
    }
  }
  
  return { clicked: false, candidates };
};



window.__grizzly_naturalScroll = () => {
  // Scrolla fino all'ultimo profilo visibile invece di scrollBy
  const cards = document.querySelectorAll('li[class*="org-people-profile-card__profile-card-spacing"]');
  if (cards.length > 0) {
    const lastCard = cards[cards.length - 1];
    lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return cards.length;
  }
  // Fallback: scroll lento e graduale come farebbe un umano
  const currentPos = window.scrollY;
  const step = 150;
  let i = 0;
  const interval = setInterval(() => {
    window.scrollBy(0, step);
    i++;
    if (i >= 4) clearInterval(interval);
  }, 200);
  return 0;
};

window.__grizzly_closeModal = () => {
  // Chiudi qualsiasi modal/dialog aperto
  const closeSelectors = [
    'button[aria-label="Ignora"]',
    'button[aria-label="Dismiss"]', 
    'button[aria-label="Close"]',
    'button[aria-label="Chiudi"]',
    '[role="dialog"] button.artdeco-modal__dismiss',
    '.artdeco-modal__dismiss',
    '[data-test-modal-close-btn]',
    'button.modal__dismiss',
  ];
  for (const sel of closeSelectors) {
    const btn = document.querySelector(sel);
    if (btn) { btn.click(); return true; }
  }
  // Premi Escape
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return false;
};

window.__grizzly_debugPage = () => {
  const info = {
    url: window.location.href,
    lisItems: document.querySelectorAll('li').length,
    ulItems: document.querySelectorAll('ul').length,
    peopleClasses: [],
    profileLinks: [],
    sampleHTML: '',
  };

  const allEls = document.querySelectorAll('[class]');
  const classSet = new Set();
  allEls.forEach(el => {
    const cls = el.className?.toString() || '';
    if (/people|person|profile|member|org-/i.test(cls)) {
      cls.split(' ').forEach(c => {
        if (/people|person|profile|member|org-/i.test(c)) classSet.add(c);
      });
    }
  });
  info.peopleClasses = Array.from(classSet).slice(0, 20);

  const profileLinks = document.querySelectorAll('a[href*="/in/"]');
  profileLinks.forEach(link => {
    const card = link.closest('li') || link.closest('div');
    if (card) {
      const text = card.innerText?.trim().substring(0, 100);
      const cls = card.className?.toString().substring(0, 100);
      info.profileLinks.push({ href: link.href.split('?')[0], text, cls });
    }
  });
  info.profileLinks = info.profileLinks.slice(0, 5);

  const firstCard = document.querySelector('li[class*="org-people-profile-card__profile-card-spacing"]');
  if (firstCard) {
    info.sampleHTML = firstCard.outerHTML.substring(0, 800);
  }

  return info;
};

window.__grizzly_extractPeople = () => {
  const results = [];
  const seen = new Set();
  const debug = { cardsFound: 0, linksFound: 0, skipped: [] };

  // Strategia primaria: cards specifiche
  let cards = Array.from(document.querySelectorAll('li[class*="org-people-profile-card__profile-card-spacing"]'));
  debug.cardsFound = cards.length;

  // Strategia fallback: tutti li con link /in/
  if (cards.length === 0) {
    const allLinks = document.querySelectorAll('a[href*="/in/"]');
    const liSet = new Set();
    allLinks.forEach(a => {
      const li = a.closest('li');
      if (li) liSet.add(li);
    });
    cards = Array.from(liSet);
  }

  // Regex per filtrare testo non utile
  const JUNK = /^[\s·•\-–—|]+$|^\d+[°ºo]?\s*(grado|degree)|^collegamento|^connection|^membro|^member|^\+\s*segui|^follow|^messag|^connetti|^connect|^visualizza/i;

  cards.forEach(card => {
    const linkEl = card.querySelector('a[href*="/in/"]');
    const profileUrl = linkEl?.href?.split('?')[0];
    if (!profileUrl || seen.has(profileUrl)) return;
    seen.add(profileUrl);
    debug.linksFound++;

    let name = '';
    let role = '';

    // Nome: testo del link /in/ (più affidabile)
    const nameFromLink = linkEl?.innerText?.trim() || '';
    // Prendi solo la prima riga del link (potrebbe contenere più righe)
    name = nameFromLink.split('\n')[0].trim();
    // Rimuovi gradi collegamento dal nome
    name = name.replace(/\s*·\s*\d+[°ºo].*$/i, '').trim();
    name = name.replace(/\s*(Collegamento|Connection).*$/i, '').trim();

    // Ruolo: cerca elementi specifici per job title
    // LinkedIn usa vari selettori per il job title nella pagina people
    const roleSelectors = [
      '.org-people-profile-card__profile-info',
      '[data-anonymize="person-occupation"]', 
      '.artdeco-entity-lockup__subtitle',
      '.entity-result__primary-subtitle',
    ];
    
    for (const sel of roleSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const t = el.innerText?.trim().split('\n')[0].trim();
        if (t && t.length > 2 && !JUNK.test(t)) {
          role = t;
          break;
        }
      }
    }

    // Fallback ruolo: analizza le righe del card
    if (!role) {
      const allText = card.innerText?.trim() || '';
      const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
      let foundName = false;
      for (const line of lines) {
        if (JUNK.test(line)) continue;
        if (/^[·•]+$/.test(line)) continue;
        if (/\d[°ºo]/.test(line) && line.length < 10) continue;
        if (/collegamento|connection/i.test(line)) continue;
        if (/^(segui|follow|messag|connetti|connect)/i.test(line)) continue;
        
        if (!foundName && line.includes(name.split(' ')[0])) {
          foundName = true;
          continue;
        }
        if (foundName && !role) {
          role = line;
          break;
        }
      }
    }

    name = name.replace(/\s+/g, ' ').trim();
    role = role.replace(/\s+/g, ' ').trim();

    if (!name || /^(LinkedIn Member|Membro LinkedIn)$/i.test(name)) {
      debug.skipped.push(profileUrl);
      return;
    }

    results.push({ name, role, profileUrl });
  });

  results._debug = debug;
  return results;
};


window.__grizzly_extractPeopleEmergency = () => {
  const results = [];
  const seen = new Set();
  
  const allProfileLinks = document.querySelectorAll('a[href*="linkedin.com/in/"], a[href^="/in/"]');
  
  allProfileLinks.forEach(linkEl => {
    // Costruisci URL completo
    let rawHref = linkEl.getAttribute('href') || '';
    let profileUrl = '';
    if (rawHref.startsWith('http')) {
      profileUrl = rawHref.split('?')[0];
    } else if (rawHref.startsWith('/in/')) {
      profileUrl = 'https://www.linkedin.com' + rawHref.split('?')[0];
    } else {
      return; // skip
    }
    
    // Verifica che sia un profilo valido (non una pagina azienda o altro)
    if (!profileUrl.includes('/in/')) return;
    if (profileUrl === 'https://www.linkedin.com/in/') return;
    if (seen.has(profileUrl)) return;
    seen.add(profileUrl);
    
    // Cerca il contenitore più vicino
    const container = linkEl.closest('li') || linkEl.closest('[class*="result"]') || linkEl.closest('[class*="card"]') || linkEl.parentElement;
    const text = container?.innerText?.trim() || linkEl.innerText?.trim() || '';
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
    
    let name = lines[0] || '';
    name = name.replace(/\s*·\s*\d+[°ºo].*$/i, '').trim();
    let role = lines.find(l => l.length > 5 && !/^[·•\d]/.test(l) && l !== name && !/collegamento|connett|segui|messag/i.test(l)) || '';
    
    if (name && name.length > 1) {
      results.push({ name, role, profileUrl });
    }
  });
  
  results._debug = { emergency: true, found: results.length };
  return results;
};

// ═══════════════════════════════════════════════════════════════════════════
// LINKEDIN SEARCH RESULTS (Persona-First flow)
// ═══════════════════════════════════════════════════════════════════════════

window.__grizzly_isSearchPeoplePage = () => /linkedin\.com\/search\/results\/people/i.test(window.location.href);

window.__grizzly_getSearchQueryInfo = () => {
  try {
    const u = new URL(window.location.href);
    const keywords = u.searchParams.get('keywords') || '';
    const filters = {};
    const interesting = ['geoUrn', 'industry', 'network', 'currentCompany', 'pastCompany', 'origin', 'languageUsedOnLinkedIn'];
    interesting.forEach(k => {
      const v = u.searchParams.get(k);
      if (v) filters[k] = v;
    });
    const activeChips = Array.from(document.querySelectorAll('button[aria-pressed="true"], button.artdeco-pill--selected'))
      .map(b => (b.innerText || b.textContent || '').trim())
      .filter(t => t && t.length < 60 && t.length > 1)
      .slice(0, 8);
    return { keywords: decodeURIComponent(keywords), filters, activeChips, url: window.location.href };
  } catch (e) {
    return { keywords: '', filters: {}, activeChips: [], url: window.location.href, error: e.message };
  }
};

// Conta solo i link /in/ che sembrano risultati reali (esclude header/nav/me)
window.__grizzly_countSearchProfileLinks = () => {
  const links = document.querySelectorAll('a[href*="/in/"]');
  let count = 0;
  links.forEach(a => {
    if (a.closest('header, nav, [role="banner"], .global-nav')) return;
    const href = a.getAttribute('href') || '';
    if (!href || href === '/in/' || href === '#') return;
    count++;
  });
  return count;
};

window.__grizzly_extractSearchResults = () => {
  const results = [];
  const seen = new Set();
  const debug = { tried: [], cardsFound: 0, linksTotal: 0, sampleHTML: '' };

  debug.linksTotal = document.querySelectorAll('a[href*="/in/"]').length;

  // Strategia 1: classi storiche LinkedIn
  let cards = Array.from(document.querySelectorAll('li.reusable-search__result-container'));
  if (cards.length) debug.tried.push('li.reusable-search__result-container=' + cards.length);

  // Strategia 2: entity-result (UI 2022-2024)
  if (cards.length === 0) {
    cards = Array.from(document.querySelectorAll('div.entity-result, div[class*="entity-result"]'));
    if (cards.length) debug.tried.push('div.entity-result=' + cards.length);
  }

  // Strategia 3: data-view-name (UI 2025+)
  if (cards.length === 0) {
    cards = Array.from(document.querySelectorAll('[data-view-name*="search-result"], [data-chameleon-result-urn]'));
    if (cards.length) debug.tried.push('[data-view-name]=' + cards.length);
  }

  // Strategia 4: ul[role=list] dentro main (struttura generica)
  if (cards.length === 0) {
    const lists = document.querySelectorAll('main ul[role="list"], div.search-results-container ul, main ul');
    for (const ul of lists) {
      const lis = Array.from(ul.querySelectorAll(':scope > li')).filter(li => li.querySelector('a[href*="/in/"]'));
      if (lis.length > cards.length) cards = lis;
    }
    if (cards.length) debug.tried.push('main ul>li[hasProfile]=' + cards.length);
  }

  // Strategia 5 (emergency): tutti i link /in/ + risali al container
  if (cards.length === 0) {
    const links = document.querySelectorAll('a[href*="/in/"]');
    const containerSet = new Set();
    links.forEach(a => {
      if (a.closest('header, nav, [role="banner"], .global-nav')) return;
      const href = a.getAttribute('href') || '';
      if (!href || href === '/in/' || href === '#') return;
      // Sali fino a trovare un container "papabile" di risultato
      let c = a.closest('li');
      if (!c) c = a.closest('div[class*="result"], div[class*="card"], div[data-view-name], div[data-chameleon-result-urn]');
      if (!c) {
        // Risali finché il container ha abbastanza testo da essere un risultato
        let p = a.parentElement;
        let levels = 0;
        while (p && levels < 6) {
          const txt = (p.innerText || '').trim();
          if (txt.length > 40 && txt.split('\n').length >= 2) { c = p; break; }
          p = p.parentElement;
          levels++;
        }
      }
      if (c) containerSet.add(c);
    });
    cards = Array.from(containerSet);
    if (cards.length) debug.tried.push('emergency-fallback=' + cards.length);
  }

  debug.cardsFound = cards.length;
  if (cards.length > 0) {
    debug.sampleHTML = (cards[0].outerHTML || '').substring(0, 400);
  }

  const JUNK = /^[\s·•\-–—|]+$|^\d+[°ºo]?\s*(grado|degree)|^collegamento|^connection|^membro|^member|^\+\s*segui|^follow|^messag|^connetti|^connect|^visualizza|^view|^promosso|^promoted|^sponsoriz|^stato:|^status:/i;

  cards.forEach(card => {
    const link = card.querySelector('a[href*="/in/"]');
    if (!link) return;
    const rawHref = link.getAttribute('href') || link.href || '';
    let profileUrl = '';
    if (rawHref.startsWith('http')) profileUrl = rawHref.split('?')[0];
    else if (rawHref.startsWith('/in/')) profileUrl = 'https://www.linkedin.com' + rawHref.split('?')[0];
    else return;
    if (!profileUrl.includes('/in/') || profileUrl === 'https://www.linkedin.com/in/') return;
    if (seen.has(profileUrl)) return;
    seen.add(profileUrl);

    // ── Nome: provo selettori multipli, poi fallback su testo del link ────
    let name = '';
    const nameSelectors = [
      '.entity-result__title-text a span[aria-hidden="true"]',
      '.entity-result__title-text a',
      'span.entity-result__title-line span[aria-hidden="true"]',
      'a[href*="/in/"] span[aria-hidden="true"]',
      '[data-anonymize="person-name"]',
      'span[dir="ltr"]',
    ];
    for (const sel of nameSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.length > 1 && !/^\d/.test(t)) { name = t; break; }
      }
    }
    if (!name) {
      name = (link.innerText || link.textContent || '').split('\n')[0].trim();
    }
    name = name.replace(/\s*·\s*\d+[°ºo].*$/i, '').replace(/\s*\(Lui\/Lei\)|\s*\(He\/Him\)|\s*\(She\/Her\)/gi, '').replace(/\s+/g, ' ').trim();

    // ── Headline / job title + location dal testo del card ────────────────
    const allLines = (card.innerText || '').split('\n').map(l => l.trim()).filter(l => l && l.length > 1 && !JUNK.test(l));
    let headline = '';
    let location = '';

    // Provo prima i selettori specifici
    const headlineEl = card.querySelector('.entity-result__primary-subtitle, div.entity-result__primary-subtitle, [data-anonymize="person-occupation"]');
    if (headlineEl) headline = (headlineEl.innerText || headlineEl.textContent || '').trim();
    const locEl = card.querySelector('.entity-result__secondary-subtitle, div.entity-result__secondary-subtitle');
    if (locEl) location = (locEl.innerText || locEl.textContent || '').trim();

    // Fallback: nelle righe pulite, la riga dopo il nome è headline, la seguente è location
    if (!headline || !location) {
      const firstNameToken = (name.split(' ')[0] || '').toLowerCase();
      const nameIdx = allLines.findIndex(l => firstNameToken && l.toLowerCase().includes(firstNameToken));
      if (nameIdx >= 0) {
        if (!headline && allLines[nameIdx + 1]) headline = allLines[nameIdx + 1];
        if (!location && allLines[nameIdx + 2] && /,|italia|italy|spa|srl/i.test(allLines[nameIdx + 2]) === false && allLines[nameIdx + 2].length < 80) {
          // Le location di solito hanno virgole o sono brevi
          if (/,/.test(allLines[nameIdx + 2]) || allLines[nameIdx + 2].length < 50) location = allLines[nameIdx + 2];
        }
      }
    }

    if (!name || /^(LinkedIn Member|Membro LinkedIn)$/i.test(name)) return;
    // Permetto anche nomi mononomi (alcuni profili italiani)
    if (name.length < 2) return;

    let role = headline;
    let company = '';
    const presso = headline.match(/^(.+?)\s+(?:presso|@|at|in)\s+(.+)$/i);
    if (presso) {
      role = presso[1].trim();
      company = presso[2].trim();
    }

    results.push({ name, role, headline, company, location, profileUrl });
  });

  // Ritorno un OGGETTO (non array) così debug sopravvive alla serializzazione
  return { results, debug };
};

window.__grizzly_scrollSearchResults = () => {
  // Scroll organico: step di lunghezza variabile, pause irregolari,
  // occasionale "scroll-up" come quando un umano torna a leggere qualcosa
  const totalSteps = 6 + Math.floor(Math.random() * 4); // 6-9 step
  let i = 0;
  return new Promise(resolve => {
    function nextStep() {
      // Stop se siamo già in fondo o abbiamo fatto abbastanza step
      const nearBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 80;
      if (i >= totalSteps || nearBottom) {
        // Pausa finale "ho finito di scorrere, ora guardo"
        setTimeout(() => resolve({ scrolled: true, finalY: window.scrollY, steps: i }), 1100 + Math.random() * 1300);
        return;
      }
      // Ogni tanto (~15%) faccio uno scroll indietro breve, come per rileggere
      const goUp = Math.random() < 0.15 && window.scrollY > 250;
      const distance = goUp
        ? -(80 + Math.random() * 140)              // -80 a -220 px
        : 220 + Math.random() * 380;                // +220 a +600 px
      window.scrollBy({ top: distance, behavior: 'smooth' });
      i++;
      // Pausa irregolare tra uno scroll e l'altro
      const pause = goUp ? 600 + Math.random() * 900 : 350 + Math.random() * 900;
      setTimeout(nextStep, pause);
    }
    nextStep();
  });
};

window.__grizzly_clickNextSearchPage = () => {
  const debug = { tried: [], candidates: [] };

  // Strategia 1: aria-label noti (it/en + varianti)
  const ariaLabels = ['Successiva', 'Pagina successiva', 'Avanti', 'Next', 'Next page', 'Next Page'];
  for (const label of ariaLabels) {
    const btn = document.querySelector(`button[aria-label="${label}"], a[aria-label="${label}"]`);
    if (btn) {
      debug.tried.push(`aria="${label}"`);
      if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.getAttribute('disabled') === null) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Piccolo delay simulato prima del click via dispatch di mouseenter
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        btn.click();
        return { clicked: true, method: 'aria-label', label, debug };
      }
    }
  }

  // Strategia 2: classi artdeco standard
  const classSelectors = [
    'button.artdeco-pagination__button--next',
    'button.artdeco-pagination__button.artdeco-pagination__button--next',
    'li.artdeco-pagination__indicator--next button',
    'li.artdeco-pagination__indicator--next a',
  ];
  for (const sel of classSelectors) {
    const btn = document.querySelector(sel);
    if (btn) {
      debug.tried.push(`class=${sel}`);
      if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        btn.click();
        return { clicked: true, method: 'class', selector: sel, debug };
      }
    }
  }

  // Strategia 3: match per testo "Successiva" / "Next" / "Avanti" dentro button/a
  const all = document.querySelectorAll('button, a');
  for (const el of all) {
    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
    if (!txt || txt.length > 25) continue;
    if (/^(successiva|avanti|next|next page|pagina successiva|→|›)$/i.test(txt)) {
      const inFooter = el.closest('footer') || el.closest('.global-footer');
      if (inFooter) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.click();
      return { clicked: true, method: 'text-match', text: txt, debug };
    }
  }

  // Diagnostica: lista i bottoni di paginazione visibili
  document.querySelectorAll('.artdeco-pagination button, .artdeco-pagination a, [class*="pagination"] button, [class*="pagination"] a').forEach(el => {
    debug.candidates.push({
      text: (el.innerText || '').trim().substring(0, 30),
      aria: el.getAttribute('aria-label') || '',
      cls: (el.className || '').toString().substring(0, 80),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
    });
  });

  return { clicked: false, debug };
};

// Costruisce l'URL della pagina successiva incrementando ?page=N
window.__grizzly_buildNextPageUrl = (nextPageNum) => {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set('page', String(nextPageNum));
    return u.toString();
  } catch (e) {
    return null;
  }
};

window.__grizzly_getCurrentSearchPage = () => {
  const active = document.querySelector('.artdeco-pagination__indicator--number.active, .artdeco-pagination__indicator--number.selected');
  if (active) {
    const n = parseInt((active.innerText || active.textContent || '').trim(), 10);
    if (!isNaN(n)) return n;
  }
  try {
    const u = new URL(window.location.href);
    const p = parseInt(u.searchParams.get('page') || '1', 10);
    return isNaN(p) ? 1 : p;
  } catch (e) { return 1; }
};

console.log('[Grizzly] Content script caricato ✓ (v2 — search support)');
