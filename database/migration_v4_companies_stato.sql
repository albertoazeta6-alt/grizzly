-- Migration v4: aggiunge stato 'contatti_trovati' alla tabella companies
-- Esegui nel SQL Editor di Supabase

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_stato_check;
ALTER TABLE companies ADD CONSTRAINT companies_stato_check CHECK (stato IN (
  'sito_mancante',
  'url_ambigua',
  'linkedin_ok',
  'contatti_trovati',
  'scartato'
));
