// background.js — Service Worker

async function enableSidePanelOnClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnClick);
enableSidePanelOnClick();

// Apre il pannello laterale quando si clicca sull'icona
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Leggi tab attiva o tab specifica
  if (msg.type === "GET_ACTIVE_TAB") {
    if (msg.tabId) {
      chrome.tabs.get(msg.tabId, (tab) => {
        if (chrome.runtime.lastError) {
          return sendResponse({ error: chrome.runtime.lastError.message, tab: null });
        }
        sendResponse({ tab: tab || null });
      });
      return true;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tab: tabs[0] || null });
    });
    return true;
  }

  // Esegui funzione nel content script tramite funcName
  if (msg.type === "EXECUTE_IN_PAGE") {
    const runOnTab = async (tab) => {
      if (!tab?.id) return sendResponse({ error: "Nessuna tab attiva" });
      try {
        // Prima assicurati che il content script sia iniettato
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });
        } catch(injectErr) {
          // Già iniettato o non necessario, continua
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (name, args) => {
            const fn = window[name];
            return fn ? fn(...(args||[])) : { error: 'Function not found: ' + name };
          },
          args: [msg.funcName, msg.args || []],
        });
        sendResponse({ result: results?.[0]?.result });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    };

    if (msg.tabId) {
      chrome.tabs.get(msg.tabId, async (tab) => {
        if (chrome.runtime.lastError) {
          return sendResponse({ error: chrome.runtime.lastError.message });
        }
        await runOnTab(tab);
      });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        await runOnTab(tabs[0]);
      });
    }
    return true;
  }

  // API call esterna
  if (msg.type === "API_CALL") {
    (async () => {
      try {
        const res = await fetch(msg.url, {
          method: msg.method || "GET",
          headers: msg.headers || {},
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });
        const text = await res.text();
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {
          data = text;
        }
        sendResponse({ status: res.status, data });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // Esegui debug direttamente (fallback se content script non risponde)
  if (msg.type === "EXECUTE_DIRECT") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return sendResponse({ error: "Nessuna tab" });
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const info = {
              url: window.location.href,
              lisItems: document.querySelectorAll('li').length,
              ulItems: document.querySelectorAll('ul').length,
              peopleClasses: [],
              profileLinks: [],
              sampleHTML: '',
            };
            const classSet = new Set();
            document.querySelectorAll('[class]').forEach(el => {
              const cls = el.className?.toString() || '';
              if (/people|person|profile|member|org-/i.test(cls)) {
                cls.split(' ').forEach(c => { if(/people|person|profile|member|org-/i.test(c)) classSet.add(c); });
              }
            });
            info.peopleClasses = Array.from(classSet).slice(0, 20);
            const profileLinks = document.querySelectorAll('a[href*="/in/"]');
            profileLinks.forEach(link => {
              const card = link.closest('li') || link.closest('div');
              if (card) {
                info.profileLinks.push({
                  href: link.href.split('?')[0],
                  text: (card.innerText||'').trim().substring(0, 100),
                  cls: (card.className||'').toString().substring(0, 100)
                });
              }
            });
            info.profileLinks = info.profileLinks.slice(0, 5);
            const firstLi = document.querySelector('li:has(a[href*="/in/"])');
            if (firstLi) info.sampleHTML = firstLi.outerHTML.substring(0, 500);
            return info;
          }
        });
        sendResponse({ result: results?.[0]?.result });
      } catch(e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  // Scroll pagina
  if (msg.type === "SCROLL_PAGE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]?.id) return sendResponse({ ok: false });
      await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (amount) => window.scrollBy({ top: amount, behavior: "smooth" }),
        args: [msg.amount || 600],
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  // Naviga a URL (tab attiva)
  if (msg.type === "NAVIGATE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]?.id) return sendResponse({ ok: false });
      await chrome.tabs.update(tabs[0].id, { url: msg.url });
      sendResponse({ ok: true });
    });
    return true;
  }

  // Naviga una tab specifica a un URL (batch mode)
  if (msg.type === "NAVIGATE_TAB") {
    chrome.tabs.update(msg.tabId, { url: msg.url }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }

  // Controlla URL e stato di caricamento di una tab specifica
  if (msg.type === "CHECK_TAB_URL") {
    chrome.tabs.get(msg.tabId, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message, url: '', status: 'error' });
      } else {
        sendResponse({ url: tab?.url || '', status: tab?.status || 'loading' });
      }
    });
    return true;
  }
});
