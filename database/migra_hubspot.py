#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Migrazione HubSpot → Supabase

Legge l'export CSV di HubSpot (tutti-gli-elementi-aziende.csv) e popola
la tabella companies in Supabase come seed iniziale del database.

Non sovrascrive mai un'azienda già presente (upsert su hubspot_id):
puoi lanciare questo script più volte in sicurezza.

Uso:
    python migra_hubspot.py                         # migra tutto
    python migra_hubspot.py --prova 50              # solo le prime 50
    python migra_hubspot.py --file mio_export.csv   # file diverso
"""

import argparse
import csv
import datetime
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CARTELLA = Path(__file__).resolve().parent

# Leggi le credenziali Supabase dallo stesso file usato dal classificatore
FILE_SUPABASE = CARTELLA.parent / "classificatore" / "supabase.txt"

# File di input: metti qui l'export HubSpot oppure passa --file
FILE_DEFAULT = CARTELLA / "tutti-gli-elementi-aziende.csv"

# Pausa tra una chiamata API e l'altra (secondi)
PAUSA = 0.05

# Quante aziende inviare per batch (Supabase accetta upsert multipli)
BATCH_SIZE = 50

# ── Mappatura fasi trattativa HubSpot → stato DB ─────────────────────────────
FASE_TO_STATO = {
    "nogo":           "nogo",
    "in campagna":    "in_campagna",
    "avvicinamento":  "in_campagna",
    "decisione":      "in_campagna",
    "qualificazione": "in_campagna",
    "marcatura":      "in_campagna",
    "identificazione":"in_campagna",
    "implementazione":"in_campagna",
    "proposta":       "in_campagna",
    "lost":           "nogo",
    "trasferita aiblink": "nogo",
}

# ── Colonne HubSpot usate ─────────────────────────────────────────────────────
COL_ID          = "ID record"
COL_NOME        = "Nome azienda"
COL_SITO        = "URL sito web"
COL_LINKEDIN    = "Pagina LinkedIn dell'azienda"
COL_PIVA        = "Partita IVA"
COL_CITTA       = "Città"
COL_REGIONE     = "Stato/regione"
COL_SETTORE     = "Settore"
COL_DESCR       = "Descrizione"
COL_STATO_LEAD  = "Stato lead"
COL_FASE_VITA   = "Fase del ciclo di vita"
COL_FONTE       = "Fonte record"
COL_SOURCE      = "Source"
COL_DATA_CR     = "Data di creazione"


def leggi_credenziali():
    if not FILE_SUPABASE.exists():
        print(f"Non trovo {FILE_SUPABASE}")
        print("Crea il file supabase.txt nella cartella classificatore con:")
        print("  riga 1: https://xxxx.supabase.co")
        print("  riga 2: la tua service role key")
        sys.exit(1)
    righe = [r.strip() for r in FILE_SUPABASE.read_text(encoding="utf-8").splitlines() if r.strip()]
    if len(righe) < 2:
        print("supabase.txt incompleto: servono URL (riga 1) e chiave (riga 2)")
        sys.exit(1)
    return righe[0].rstrip("/"), righe[1]


def normalizza_linkedin(url):
    if not url:
        return None
    url = str(url).strip()
    import re
    m = re.search(r'linkedin\.com/company/([^/?#,\s]+)', url, re.IGNORECASE)
    if m:
        return f"https://www.linkedin.com/company/{m.group(1).lower()}"
    return None


def determina_stato(riga):
    """Ricava lo stato DB dalla fase trattativa o dallo stato lead HubSpot."""
    fase = (riga.get("Fase trattativa", "") or "").strip().lower()
    if fase in FASE_TO_STATO:
        return FASE_TO_STATO[fase]
    stato_lead = (riga.get(COL_STATO_LEAD, "") or "").strip().lower()
    if stato_lead == "non qualificato":
        return "esclusa"
    fase_vita = (riga.get(COL_FASE_VITA, "") or "").strip().lower()
    if fase_vita in ("cliente",):
        return "hubspot_sync"
    if fase_vita in ("opportunità", "lead qualificato vendite"):
        return "in_campagna"
    settore = (riga.get(COL_SETTORE, "") or "").strip()
    if settore:
        return "classificata"
    return "nuovo"


def riga_to_record(riga):
    hubspot_id = str(riga.get(COL_ID, "") or "").strip()
    if not hubspot_id or "E+" in hubspot_id.upper():
        return None

    linkedin = normalizza_linkedin(riga.get(COL_LINKEDIN, ""))
    sito = (riga.get(COL_SITO, "") or "").strip() or None
    settore = (riga.get(COL_SETTORE, "") or "").strip() or None
    piva = (riga.get(COL_PIVA, "") or "").strip() or None

    record = {
        "hubspot_id":         hubspot_id,
        "nome":               (riga.get(COL_NOME, "") or "").strip() or "—",
        "stato":              determina_stato(riga),
        "fonte":              (riga.get(COL_SOURCE, "") or riga.get(COL_FONTE, "") or "").strip() or None,
        "hubspot_stato_lead": (riga.get(COL_STATO_LEAD, "") or "").strip() or None,
        "hubspot_fase":       (riga.get("Fase trattativa", "") or
                               riga.get(COL_FASE_VITA, "") or "").strip() or None,
    }
    if sito:        record["sito_web"]  = sito
    if linkedin:    record["linkedin_url"] = linkedin
    if piva:        record["partita_iva"] = piva
    if settore:     record["settore"]   = settore

    citta   = (riga.get(COL_CITTA, "") or "").strip()
    regione = (riga.get(COL_REGIONE, "") or "").strip()
    if citta:   record["citta"]   = citta
    if regione: record["regione"] = regione

    descr = (riga.get(COL_DESCR, "") or "").strip()
    if descr:   record["icebreaker"] = descr  # la descrizione HubSpot esistente

    # Rimuovi None espliciti (già fatto sopra, ma per sicurezza)
    return {k: v for k, v in record.items() if v is not None}


def normalizza_batch(records):
    """Assicura che tutti i record abbiano le stesse chiavi (richiesto da Supabase)."""
    # Raccogli tutte le chiavi presenti nell'intero batch
    tutte_le_chiavi = set()
    for r in records:
        tutte_le_chiavi.update(r.keys())
    # Riempi i campi mancanti con None (= NULL in SQL)
    return [{k: r.get(k, None) for k in tutte_le_chiavi} for r in records]


def upsert_batch(url_base, key, records):
    """Invia un batch di record a Supabase con upsert su hubspot_id."""
    records = normalizza_batch(records)
    endpoint = f"{url_base}/rest/v1/companies?on_conflict=hubspot_id"
    data = json.dumps(records).encode()
    req = urllib.request.Request(endpoint, data=data, method="POST")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "resolution=merge-duplicates,return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def main():
    ap = argparse.ArgumentParser(description="Migrazione HubSpot → Supabase")
    ap.add_argument("--file", default=str(FILE_DEFAULT),
                    help="percorso del CSV export HubSpot")
    ap.add_argument("--prova", type=int, metavar="N",
                    help="migra solo le prime N aziende")
    args = ap.parse_args()

    url_base, key = leggi_credenziali()
    print(f"Supabase: {url_base}")

    file_input = Path(args.file)
    if not file_input.exists():
        print(f"\nNon trovo il file: {file_input}")
        print("Metti l'export HubSpot nella cartella database/ con il nome:")
        print("  tutti-gli-elementi-aziende.csv")
        print("oppure passa il percorso con --file PERCORSO")
        sys.exit(1)

    with open(file_input, newline="", encoding="utf-8-sig") as f:
        righe = list(csv.DictReader(f))

    if args.prova:
        righe = righe[: args.prova]

    print(f"Aziende nel file : {len(righe)}")

    records = []
    saltate = 0
    for r in righe:
        rec = riga_to_record(r)
        if rec:
            records.append(rec)
        else:
            saltate += 1

    print(f"Record validi    : {len(records)}  (saltate {saltate} con ID mancante/corrotto)")
    print(f"Invio in batch da {BATCH_SIZE}...\n")

    ok_tot = 0
    err_tot = 0
    inizio = time.time()

    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i: i + BATCH_SIZE]
        status, msg = upsert_batch(url_base, key, batch)
        fine_batch = i + len(batch)
        if status in (200, 201):
            ok_tot += len(batch)
            print(f"  [{fine_batch:4d}/{len(records)}] ✓ batch OK", flush=True)
        else:
            err_tot += len(batch)
            print(f"  [{fine_batch:4d}/{len(records)}] ✗ HTTP {status}: {msg}", flush=True)
        time.sleep(PAUSA)

    elapsed = time.time() - inizio
    print(f"\n{'─'*50}")
    print(f"Completato in {elapsed:.0f} secondi")
    print(f"  Inseriti/aggiornati : {ok_tot}")
    print(f"  Errori              : {err_tot}")
    if err_tot == 0:
        print("\nMigrazione riuscita. Le 3.800 aziende sono ora nel DB.")
    else:
        print(f"\nAttenzione: {err_tot} record non migrati. Controlla i messaggi sopra.")


if __name__ == "__main__":
    main()
