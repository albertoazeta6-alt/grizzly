-- ============================================================
-- GRIZZLY DATABASE — Schema Supabase
-- ============================================================
-- Esegui questo file nell'editor SQL di Supabase
-- (https://supabase.com → progetto → SQL Editor → New query)
-- ============================================================


-- ------------------------------------------------------------
-- TABELLA: companies
-- Fonte di verità per tutte le aziende nel pipeline
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (

  -- Chiavi
  id                    BIGSERIAL PRIMARY KEY,
  hubspot_id            TEXT UNIQUE,          -- ID record HubSpot (es. "432617702623")
  partita_iva           TEXT,                 -- usata come chiave di dedup secondaria

  -- Anagrafica
  nome                  TEXT NOT NULL,
  sito_web              TEXT,
  linkedin_url          TEXT,                 -- URL company LinkedIn verificato
  citta                 TEXT,
  regione               TEXT,
  paese                 TEXT DEFAULT 'IT',

  -- Classificazione (dal classificatore AI)
  settore               TEXT,                 -- uno dei 14 settori della tassonomia
  settore_confidenza    TEXT CHECK (settore_confidenza IN ('alta','media','bassa',NULL)),
  settore_motivazione   TEXT,
  icebreaker            TEXT,                 -- descrizione commerciale generata dal modello
  classificato_il       TIMESTAMPTZ,          -- quando è stato classificato

  -- Stato nel pipeline prospecting
  stato                 TEXT NOT NULL DEFAULT 'nuovo'
                        CHECK (stato IN (
                          'nuovo',            -- appena importata, non ancora lavorata
                          'classificata',     -- classificatore ha già girato
                          'linkedin_ok',      -- URL LinkedIn verificato
                          'contatti_trovati', -- Grizzly ha trovato almeno un contatto
                          'in_campagna',      -- campagna Lemlist attiva
                          'hubspot_sync',     -- sincronizzata su HubSpot
                          'nogo',             -- campagna conclusa, nessuna conversione
                          'esclusa'           -- fuori perimetro o scelta manuale
                        )),

  -- Metadati origine
  fonte                 TEXT,                 -- 'easybusiness', 'manuale', 'gee_2025', ecc.
  hubspot_fase          TEXT,                 -- fase trattativa HubSpot al momento dell'import
  hubspot_stato_lead    TEXT,                 -- stato lead HubSpot

  -- Timestamps
  creato_il             TIMESTAMPTZ DEFAULT NOW(),
  aggiornato_il         TIMESTAMPTZ DEFAULT NOW()
);

-- Indici per le operazioni più frequenti
CREATE INDEX IF NOT EXISTS idx_companies_sito_web    ON companies (sito_web);
CREATE INDEX IF NOT EXISTS idx_companies_partita_iva ON companies (partita_iva);
CREATE INDEX IF NOT EXISTS idx_companies_settore     ON companies (settore);
CREATE INDEX IF NOT EXISTS idx_companies_stato       ON companies (stato);

-- Aggiorna automaticamente aggiornato_il
CREATE OR REPLACE FUNCTION touch_aggiornato_il()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.aggiornato_il = NOW(); RETURN NEW; END;
$$;
CREATE OR REPLACE TRIGGER trg_companies_updated
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION touch_aggiornato_il();


-- ------------------------------------------------------------
-- TABELLA: contacts
-- Persone trovate da Grizzly sulle company page LinkedIn
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (

  id                    BIGSERIAL PRIMARY KEY,
  company_id            BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  hubspot_contact_id    TEXT,                 -- ID contatto HubSpot se già sincronizzato

  -- Anagrafica
  nome                  TEXT,
  cognome               TEXT,
  nome_completo         TEXT,
  ruolo                 TEXT,
  ruolo_descrizione     TEXT,                 -- headline completa LinkedIn
  email                 TEXT,

  -- LinkedIn
  linkedin_url          TEXT UNIQUE,          -- chiave di dedup: stesso profilo = stesso contatto

  -- Scoring Grizzly
  target_score          INTEGER DEFAULT 0,
  matched_keywords      JSONB,               -- es. [{"keyword":"ceo","weight":5}]

  -- Stato arricchimento
  email_cercata         BOOLEAN DEFAULT FALSE,
  email_fonte           TEXT,                -- 'dropcontact','lemlist','apollo'

  -- Stato campagna
  stato                 TEXT NOT NULL DEFAULT 'trovato'
                        CHECK (stato IN (
                          'trovato',          -- Grizzly lo ha trovato
                          'email_trovata',    -- email arricchita
                          'email_non_trovata',
                          'in_coda',          -- dati mancanti (company, email o linkedin)
                          'inviato',          -- inserito in campagna Lemlist
                          'aperto',           -- ha aperto la mail
                          'risposto',         -- ha risposto
                          'convertito',       -- ha accettato un appuntamento
                          'rimbalzato',       -- email non consegnata
                          'disiscritto'       -- opt-out
                        )),

  -- Campagna associata
  lemlist_campaign_id   TEXT,
  inviato_il            TIMESTAMPTZ,

  -- Timestamps
  creato_il             TIMESTAMPTZ DEFAULT NOW(),
  aggiornato_il         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company_id  ON contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_stato        ON contacts (stato);
CREATE INDEX IF NOT EXISTS idx_contacts_email        ON contacts (email);

CREATE OR REPLACE TRIGGER trg_contacts_updated
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION touch_aggiornato_il();


-- ------------------------------------------------------------
-- TABELLA: routing_rules
-- Mappa settore + tipo ruolo → campagna Lemlist
-- È la logica di routing automatico delle campagne
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_rules (

  id                    BIGSERIAL PRIMARY KEY,

  -- Condizioni (entrambe devono corrispondere per fare match)
  settore               TEXT NOT NULL,        -- es. 'Ascensori'
  ruolo_pattern         TEXT NOT NULL,        -- es. 'ceo', 'direttore', 'titolare'
                                              -- usa % per wildcard (ILIKE matching)

  -- Destinazione
  lemlist_campaign_id   TEXT NOT NULL,
  lemlist_campaign_nome TEXT,                 -- solo per leggibilità

  -- Priorità: se più regole fanno match, vince quella con priorità più alta
  priorita              INTEGER DEFAULT 0,

  -- Attiva o no
  attiva                BOOLEAN DEFAULT TRUE,

  -- Timestamps
  creato_il             TIMESTAMPTZ DEFAULT NOW()
);

-- Dati di partenza: le regole vanno compilate con i tuoi campaign ID reali
-- Questo è un esempio da aggiornare con gli ID Lemlist veri
INSERT INTO routing_rules (settore, ruolo_pattern, lemlist_campaign_id, lemlist_campaign_nome, priorita) VALUES
  ('Ascensori',             '%ceo%',          'CAMPAIGN_ID_QUI', 'Ascensori - Decision maker', 10),
  ('Ascensori',             '%titolare%',     'CAMPAIGN_ID_QUI', 'Ascensori - Decision maker', 10),
  ('Ascensori',             '%direttore%',    'CAMPAIGN_ID_QUI', 'Ascensori - Decision maker', 8),
  ('Ascensori',             '%responsabile%', 'CAMPAIGN_ID_QUI', 'Ascensori - Responsabile',   5),
  ('Antincendio',           '%ceo%',          'CAMPAIGN_ID_QUI', 'Antincendio - Decision maker', 10),
  ('Antincendio',           '%titolare%',     'CAMPAIGN_ID_QUI', 'Antincendio - Decision maker', 10),
  ('Impianti',              '%ceo%',          'CAMPAIGN_ID_QUI', 'Impianti - Decision maker',  10),
  ('Impianti',              '%titolare%',     'CAMPAIGN_ID_QUI', 'Impianti - Decision maker',  10),
  ('Fotovoltaico',          '%ceo%',          'CAMPAIGN_ID_QUI', 'Fotovoltaico - Decision maker', 10),
  ('Costruttore',           '%ceo%',          'CAMPAIGN_ID_QUI', 'Costruttore - Decision maker', 10),
  ('Automazione industriale','%ceo%',         'CAMPAIGN_ID_QUI', 'Automazione - Decision maker', 10),
  ('Carrelli',              '%ceo%',          'CAMPAIGN_ID_QUI', 'Carrelli - Decision maker',  10),
  ('Gru',                   '%ceo%',          'CAMPAIGN_ID_QUI', 'Gru - Decision maker',       10)
ON CONFLICT DO NOTHING;


-- ------------------------------------------------------------
-- VISTA: v_routing
-- Per ogni contatto trovato, calcola la campagna target
-- Usata da Make per sapere dove mandare ogni lead
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_routing AS
SELECT
  co.id                   AS contact_id,
  co.nome_completo,
  co.ruolo,
  co.email,
  co.linkedin_url,
  co.target_score,
  co.stato                AS contact_stato,
  az.id                   AS company_id,
  az.nome                 AS company_nome,
  az.settore,
  az.icebreaker,
  az.sito_web,
  az.linkedin_url         AS company_linkedin,
  rr.lemlist_campaign_id,
  rr.lemlist_campaign_nome,
  rr.priorita
FROM contacts co
JOIN companies az ON co.company_id = az.id
LEFT JOIN LATERAL (
  SELECT lemlist_campaign_id, lemlist_campaign_nome, priorita
  FROM routing_rules
  WHERE attiva = TRUE
    AND settore = az.settore
    AND lower(co.ruolo) ILIKE ruolo_pattern
  ORDER BY priorita DESC
  LIMIT 1
) rr ON TRUE
WHERE co.stato IN ('trovato', 'email_trovata');
