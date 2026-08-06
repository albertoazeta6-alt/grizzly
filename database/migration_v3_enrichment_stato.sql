-- Migration v3: aggiunge stato enrichment_richiesto alla tabella contacts
-- Necessario per il flusso Grizzly webapp → Estensione per ricerca email

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_stato_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_stato_check CHECK (stato IN (
    'trovato',              -- Grizzly lo ha trovato
    'enrichment_richiesto', -- webapp ha richiesto ricerca email
    'email_trovata',        -- email arricchita
    'email_non_trovata',    -- nessuna email trovata
    'in_coda',              -- dati mancanti (company, email o linkedin)
    'inviato'               -- inserito in campagna Lemlist
  ));
