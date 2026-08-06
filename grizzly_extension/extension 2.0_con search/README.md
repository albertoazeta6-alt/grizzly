# 🐻 GRIZZLY — Chrome Extension

Estensione Chrome per automatizzare il prospecting LinkedIn.
Trova le buyer persona in target, cerca le email con Dropcontact e Lemlist,
e le aggiunge alla campagna Lemlist — tutto dal tuo browser.

---

## Installazione (5 minuti)

### 1. Crea le icone
Hai bisogno di due file PNG: `icon16.png` e `icon48.png`

**Modo rapido:** vai su https://cloudconvert.com/svg-to-png
- Converti `icon.svg` in PNG
- Salva come `icon48.png` (48×48px)
- Salva come `icon16.png` (16×16px)

**Oppure** usa qualsiasi immagine 48×48 che vuoi come icona.

### 2. Installa in Chrome
1. Apri Chrome → vai su `chrome://extensions`
2. Attiva **Modalità sviluppatore** (in alto a destra)
3. Clicca **Carica estensione non pacchettizzata**
4. Seleziona la cartella `grizzly-extension`
5. L'estensione apparirà nella barra Chrome 🐻

### 3. Configura le API
1. Clicca sull'icona Grizzly nella barra Chrome
2. Si apre il pannello laterale → vai su **⚙ Config**
3. Inserisci:
   - **Lemlist API Key** (da Lemlist → Settings → API)
   - **Lemlist Campaign ID** (dall'URL della campagna: `cam_xxxxx`)
   - **Dropcontact API Key** (da Dropcontact → Settings)
4. Clicca **Salva configurazione**

---

## Novità v2

- **Due metodi di estrazione visivamente separati nel tab Batch**: card blu *Company page* (flusso classico) e card ambra *Ricerca persone* (`/search/results/people/?...`)
- **Strategia email persona-first** dentro la card Ricerca: Apollo + fallback, solo Apollo, o cascata standard
- **Tab Keyword dedicato**: keyword e penalità spostate fuori da Config in un tab più ordinato
- **Coda mista nello stesso batch**: incolla URL Company in una card, URL Ricerca nell'altra. Il sistema processa prima tutti i Company e poi tutti i Ricerca, con delay umano tra l'uno e l'altro

## Utilizzo

### Flusso A — Company page (come prima)

Incolla nella **card blu COMPANY** uno o più URL `https://www.linkedin.com/company/nome-azienda/`, premi **Avvia Batch**. Grizzly naviga alla pagina Persone di ogni azienda, estrae i contatti, applica scoring keyword, e prepara l'enrichment.

### Flusso B — Ricerca persone (persona-first)

1. Su LinkedIn fai una ricerca persone con i tuoi filtri (keyword + località + settore + livello collegamento, ecc.)
2. Copia l'URL della SERP (es. `https://www.linkedin.com/search/results/people/?keywords=responsabile%20service&geoUrn=...`)
3. Incollalo nella **card ambra RICERCA** del tab Batch
4. Configura nella stessa card:
   - **Max pagine per ricerca** (default 5 ≈ 50 profili)
   - **Strategia email**:
     - *Apollo + fallback* (consigliato) — Apollo per primo, se non trova → Dropcontact/Lemlist
     - *Solo Apollo* — niente fallback, scarta i profili senza email Apollo
     - *Cascata standard* — Dropcontact → Lemlist → Apollo come nel flusso Company
   - **Applica scoring keyword** (default OFF: hai già pre-filtrato con LinkedIn)
5. Premi **Avvia Batch**

I lead arrivano a Make con `meta.sourceType = 'linkedin_persona_first'` e `meta.searchQuery` per il routing.

---

## Keyword configurabili

Spostate nel tab **🏷 Keyword**. Modifica direttamente keyword e peso (anche negativi nelle Penalità), poi clicca *Salva keyword*. Le keyword corte (IT, AD) fanno match solo come parola intera.

---

## Limiti consigliati

| Parametro | Default |
|---|---|
| Max profili per sessione | 30 |
| Delay tra profili | 3-5 secondi |
| Aziende al giorno | max 10-15 |

---

## Struttura file

```
grizzly-extension/
├── manifest.json      ← configurazione estensione
├── background.js      ← service worker (API calls)
├── content.js         ← script iniettato in LinkedIn
├── sidepanel.html     ← interfaccia pannello laterale
├── icon16.png         ← icona piccola (da creare)
├── icon48.png         ← icona grande (da creare)
└── README.md
```

---

## Troubleshooting

**"Naviga su una company page" anche se ci sono già**
→ Ricarica la pagina LinkedIn e riapri il pannello

**Nessun contatto trovato sulla pagina People**
→ LinkedIn cambia spesso i selettori CSS — apri la console (F12) e cerca il selettore corretto, poi aggiornalo in `content.js`

**Lemlist dà errore 401**
→ Verifica API key e Campaign ID nelle impostazioni
