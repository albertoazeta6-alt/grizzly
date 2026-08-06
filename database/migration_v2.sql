-- ============================================================
-- GRIZZLY DATABASE — Migration v2
-- ============================================================
-- Esegui nell'editor SQL di Supabase DOPO schema.sql
-- È idempotente: puoi rilanciarla più volte senza danni
-- ============================================================


-- ------------------------------------------------------------
-- 1. AGGIORNA stati companies
--    Aggiunge: sito_mancante, url_ambigua
-- ------------------------------------------------------------
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_stato_check;

ALTER TABLE companies
  ADD CONSTRAINT companies_stato_check
  CHECK (stato IN (
    'nuovo',            -- appena importata, non ancora lavorata
    'sito_mancante',    -- NEW: manca il sito web, in coda revisione
    'classificata',     -- classificatore ha già girato
    'url_ambigua',      -- NEW: company page LinkedIn da verificare manualmente
    'linkedin_ok',      -- URL LinkedIn verificato
    'contatti_trovati', -- Grizzly ha trovato almeno un contatto
    'in_campagna',      -- campagna Lemlist attiva
    'hubspot_sync',     -- sincronizzata su HubSpot
    'nogo',             -- campagna conclusa, nessuna conversione
    'esclusa'           -- fuori perimetro o scelta manuale
  ));


-- ------------------------------------------------------------
-- 2. AGGIORNA stati contacts
--    Aggiunge: da_approvare
-- ------------------------------------------------------------
ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_stato_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_stato_check
  CHECK (stato IN (
    'trovato',            -- Grizzly lo ha trovato sulla company page
    'da_approvare',       -- NEW: in coda approvazione manuale
    'scartato',           -- NEW: scartato nella revisione
    'email_trovata',      -- email arricchita
    'email_non_trovata',
    'inviato',            -- inserito in campagna Lemlist
    'aperto',             -- ha aperto la mail
    'risposto',           -- ha risposto
    'convertito',         -- ha accettato un appuntamento
    'rimbalzato',         -- email non consegnata
    'disiscritto'         -- opt-out
  ));


-- ------------------------------------------------------------
-- 3. NUOVA TABELLA: tassonomia
--    I 14 settori + descrizioni (oggi in tassonomia.txt)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tassonomia (
  id          BIGSERIAL PRIMARY KEY,
  nome        TEXT NOT NULL UNIQUE,   -- es. 'Ascensori'
  descrizione TEXT,                   -- descrizione usata nel prompt del classificatore
  keywords    JSONB,                  -- parole chiave per il matching
  esempi      TEXT,                   -- esempi di aziende tipiche
  attivo      BOOLEAN DEFAULT TRUE,
  ordine      INTEGER DEFAULT 0,      -- ordine di visualizzazione
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  aggiornato_il TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_tassonomia_updated
  BEFORE UPDATE ON tassonomia
  FOR EACH ROW EXECUTE FUNCTION touch_aggiornato_il();

-- Seed con i 14 settori attuali (da tassonomia.txt)
INSERT INTO tassonomia (nome, ordine) VALUES
  ('Facility management',       1),
  ('Ascensori',                 2),
  ('Gru',                       3),
  ('Carrelli',                  4),
  ('Fotovoltaico',              5),
  ('Antincendio',               6),
  ('Automazione industriale',   7),
  ('Impianti',                  8),
  ('Costruttore',               9),
  ('Componentistica',          10),
  ('Produzione',               11),
  ('Manutenzione',             12),
  ('Wholesale',                13),
  ('Altro',                    14)
ON CONFLICT (nome) DO NOTHING;


-- ------------------------------------------------------------
-- 4. NUOVA TABELLA: settings
--    API keys e configurazioni (una riga per chiave)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id          BIGSERIAL PRIMARY KEY,
  chiave      TEXT NOT NULL UNIQUE,   -- es. 'openai_api_key'
  valore      TEXT,                   -- valore (cifrato lato app per i segreti)
  tipo        TEXT NOT NULL DEFAULT 'text'
              CHECK (tipo IN ('text', 'secret', 'json', 'boolean', 'number')),
  categoria   TEXT,                   -- es. 'ai', 'crm', 'prospecting', 'campagne'
  descrizione TEXT,
  aggiornato_il TIMESTAMPTZ DEFAULT NOW(),
  aggiornato_da TEXT                  -- email utente che ha modificato
);

-- Chiavi predefinite (valori vuoti — da compilare nella UI)
INSERT INTO settings (chiave, tipo, categoria, descrizione) VALUES
  ('openai_api_key',        'secret', 'ai',          'API key OpenAI per il classificatore'),
  ('openai_model',          'text',   'ai',          'Modello OpenAI (es. gpt-4o-mini)'),
  ('hubspot_api_key',       'secret', 'crm',         'API key HubSpot (Private App Token)'),
  ('lemlist_api_key',       'secret', 'campagne',    'API key Lemlist'),
  ('phantom_api_key',       'secret', 'prospecting', 'API key Phantombuster'),
  ('dropcontact_api_key',   'secret', 'prospecting', 'API key Dropcontact'),
  ('apollo_api_key',        'secret', 'prospecting', 'API key Apollo.io'),
  ('make_webhook_pulizia',  'text',   'make',        'Webhook Make — Sc.0 Pulizia fogli'),
  ('make_webhook_import',   'text',   'make',        'Webhook Make — Sc.1 Import CSV'),
  ('make_webhook_company',  'text',   'make',        'Webhook Make — Sc.2/3 Company page'),
  ('make_webhook_hubspot',  'text',   'make',        'Webhook Make — Sc.4 Aggiornamento HubSpot'),
  ('make_webhook_email',    'text',   'make',        'Webhook Make — Sc.6 Carica contatto'),
  ('phantom_company_finder','text',   'prospecting', 'ID Phantom Company URL Finder'),
  ('phantom_dipendenti',    'text',   'prospecting', 'ID Phantom Dipendenti'),
  ('phantom_email',         'text',   'prospecting', 'ID Phantom Email'),
  ('supabase_url',          'text',   'sistema',     'URL progetto Supabase'),
  ('supabase_anon_key',     'text',   'sistema',     'Chiave anon Supabase (per la webapp)')
ON CONFLICT (chiave) DO NOTHING;


-- ------------------------------------------------------------
-- 5. NUOVA TABELLA: pipeline_runs
--    Traccia ogni batch di import con metriche
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              BIGSERIAL PRIMARY KEY,
  nome            TEXT,                    -- es. 'Import EB 2026-07-31'
  fonte           TEXT DEFAULT 'easybusiness',
  stato           TEXT NOT NULL DEFAULT 'in_corso'
                  CHECK (stato IN ('in_corso','completato','errore','annullato')),

  -- Metriche
  totale          INTEGER DEFAULT 0,       -- aziende nel file
  nuove           INTEGER DEFAULT 0,       -- inserite (non duplicate)
  duplicate       INTEGER DEFAULT 0,       -- già presenti, saltate
  siti_mancanti   INTEGER DEFAULT 0,       -- finite in coda revisione
  errori          INTEGER DEFAULT 0,

  -- Dati run
  avviato_da      TEXT,                    -- email utente
  file_nome       TEXT,                    -- nome file originale
  note            TEXT,

  creato_il       TIMESTAMPTZ DEFAULT NOW(),
  completato_il   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_stato ON pipeline_runs (stato);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_creato ON pipeline_runs (creato_il DESC);


-- ------------------------------------------------------------
-- 6. INDICE aggiuntivo su companies per la dedup
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_companies_nome ON companies (lower(nome));


-- ------------------------------------------------------------
-- VERIFICA
-- ------------------------------------------------------------
-- Dopo aver eseguito, controlla con:
--
--   SELECT nome FROM tassonomia ORDER BY ordine;
--   SELECT chiave, categoria FROM settings ORDER BY categoria, chiave;
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'pipeline_runs' ORDER BY ordinal_position;
