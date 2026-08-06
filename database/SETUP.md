# Setup Database Grizzly

Questa guida porta il DB online in meno di 30 minuti.

---

## 1. Crea il progetto Supabase (5 minuti)

1. Vai su **[supabase.com](https://supabase.com)** → Sign up (gratis, no carta di credito)
2. **New project** → scegli un nome (es. `grizzly`) → scegli la regione **West EU (Ireland)** → imposta una password → **Create project**
3. Aspetta che il progetto si avvii (circa 1 minuto)

---

## 2. Crea le tabelle (2 minuti)

1. Nel menu a sinistra: **SQL Editor** → **New query**
2. Copia tutto il contenuto di **`schema.sql`** (stessa cartella di questo file)
3. Incolla nell'editor → **Run** (▶)
4. Dovresti vedere: `Success. No rows returned`

---

## 3. Copia le credenziali (2 minuti)

1. **Project Settings** (ingranaggio in basso a sinistra) → **API**
2. Copia:
   - **Project URL** (es. `https://abcdefgh.supabase.co`)
   - **service_role key** (sotto "Project API keys" → `service_role` → mostra → copia)
     > Usa la `service_role`, non la `anon`: serve per scrivere senza restrizioni

3. Crea il file **`classificatore/supabase.txt`** con esattamente due righe:
   ```
   https://abcdefgh.supabase.co
   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```
   > ⚠️ Non condividere questo file. Non metterlo in cartelle condivise. È come una password.

---

## 4. Migra le aziende esistenti da HubSpot (5 minuti)

1. Copia il file **`tutti-gli-elementi-aziende.csv`** (l'export HubSpot completo)
   nella cartella **`database/`**

2. Apri il Prompt dei comandi in questa cartella e lancia:
   ```
   python migra_hubspot.py --prova 10
   ```
   Controlla che i primi 10 vadano a buon fine.

3. Se è tutto OK, migra tutto:
   ```
   python migra_hubspot.py
   ```
   Ci vuole circa 1-2 minuti per le 3.800 aziende.

4. Verifica su Supabase: **Table Editor** → `companies` → dovresti vedere le righe.

---

## 5. Attiva il classificatore con Supabase (1 minuto)

Il classificatore ora scrive automaticamente su Supabase se trova `supabase.txt`.
Non devi fare nulla: la prossima volta che lanci `AVVIA.bat` vedrai:

```
Supabase: connesso ✓  (i risultati verranno scritti anche nel DB)
```

Ogni azienda classificata aggiorna direttamente la tabella `companies`.
Non serve più il ciclo CSV → revisione → import HubSpot per il settore.

---

## 6. Compila le routing rules (10 minuti)

Le routing rules determinano quale campagna Lemlist riceve ogni contatto
in base al settore dell'azienda e al ruolo del contatto.

1. In Supabase: **Table Editor** → `routing_rules`
2. Sostituisci `CAMPAIGN_ID_QUI` con i tuoi ID campagna Lemlist reali
   (li trovi in Lemlist → campagna → URL della pagina)
3. Aggiungi le righe che mancano per i tuoi settori e ruoli

**Esempio di logica:**
- Azienda settore `Ascensori` + contatto ruolo `CEO` → campagna "Ascensoristi - DM"
- Azienda settore `Ascensori` + contatto ruolo `Responsabile manutenzione` → campagna "Ascensoristi - Tecnici"
- Azienda settore `Impianti` + contatto ruolo `Titolare` → campagna "Impiantisti - DM"

---

## Come funziona il routing in Make

Quando Grizzly trova un contatto e lo manda al webhook Make, Make dovrà:

1. **Cercare l'azienda** in Supabase per `company_linkedin_url` o `sito_web`
2. **Leggere il settore** dell'azienda
3. **Interrogare `v_routing`** con `contact_id` per ottenere `lemlist_campaign_id`
4. **Inserire il contatto** nella campagna corretta

La vista `v_routing` fa già tutto il matching: basta interrogarla per `contact_id`.

Endpoint da chiamare da Make (HTTP GET):
```
GET https://xxxx.supabase.co/rest/v1/v_routing?contact_id=eq.123
Headers:
  apikey: tua-anon-key
  Authorization: Bearer tua-anon-key
```

---

## Struttura file

```
database/
├── schema.sql          ← esegui su Supabase (una volta sola)
├── migra_hubspot.py    ← migrazione iniziale da HubSpot
├── SETUP.md            ← questa guida
└── tutti-gli-elementi-aziende.csv  ← metti qui l'export HubSpot

classificatore/
└── supabase.txt        ← crea tu questo file con URL e chiave
```

---

## Verifica che tutto funzioni

Dopo la migrazione, in Supabase **SQL Editor** lancia:

```sql
-- Quante aziende per stato
SELECT stato, COUNT(*) FROM companies GROUP BY stato ORDER BY COUNT(*) DESC;

-- Quante classificate (hanno il settore)
SELECT settore, COUNT(*) FROM companies WHERE settore IS NOT NULL
GROUP BY settore ORDER BY COUNT(*) DESC;

-- Vista routing: i contatti pronti per la campagna
SELECT * FROM v_routing LIMIT 10;
```
