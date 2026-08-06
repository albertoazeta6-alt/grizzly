"""
classifica.py — modulo di classificazione settori per Azure App Service.

Legge SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY dalle env vars.
Viene chiamato dagli endpoint /classifica/* in app.py.
"""

import datetime
import json
import os
import re
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SETTORI_VALIDI = {
    "Facility management", "Ascensori", "Gru", "Carrelli", "Fotovoltaico",
    "Antincendio", "Automazione industriale", "Impianti", "Costruttore",
    "Componentistica", "Produzione", "Manutenzione", "Wholesale", "Altro",
}

MAX_CARATTERI_SITO = 6000
PAUSA              = 0.3
TIMEOUT_HTTP       = 15

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
)

# Flag per evitare run concorrenti
_running = False
_last_result = {"classificate": 0, "errori": 0, "avviato_il": None}



# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def _sb_headers(key, extra=None):
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def get_da_classificare(sb_url, sb_key, limit=500, run_start=None):
    import urllib.request, urllib.parse
    p = {
        "settore": "is.null", "sito_web": "neq.", "select": "id,nome,sito_web",
        "order": "creato_il.asc", "limit": str(limit),
    }
    if run_start:
        p["creato_il"] = f"gte.{run_start}"
    params = urllib.parse.urlencode(p)
    url = f"{sb_url}/rest/v1/companies?{params}"
    req = urllib.request.Request(url, headers=_sb_headers(sb_key))
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())
    except Exception:
        return []


def count_da_classificare(sb_url, sb_key, run_start=None):
    import urllib.request, urllib.parse
    p = {"settore": "is.null", "sito_web": "neq.", "select": "id", "limit": "1"}
    if run_start:
        p["creato_il"] = f"gte.{run_start}"
    params = urllib.parse.urlencode(p)
    url = f"{sb_url}/rest/v1/companies?{params}"
    req = urllib.request.Request(url, headers=_sb_headers(sb_key, {"Prefer": "count=exact", "Range": "0-0"}))
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            cr = r.headers.get("content-range", "0/0")
            return int(cr.split("/")[-1]) if "/" in cr else 0
    except Exception:
        return -1


def aggiorna_company(sb_url, sb_key, company_id, dati):
    import urllib.request, urllib.error
    url = f"{sb_url}/rest/v1/companies?id=eq.{company_id}"
    body = json.dumps(dati).encode()
    req = urllib.request.Request(
        url, data=body, method="PATCH",
        headers=_sb_headers(sb_key, {"Prefer": "return=minimal"})
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status in (200, 204)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Scraping siti
# ---------------------------------------------------------------------------

def normalizza_url(u):
    u = (u or "").strip()
    if not u:
        return ""
    u = re.sub(r"^https?://(https?://)?", "", u, flags=re.I).strip("/")
    return "https://" + u if u else ""


def estrai_testo(html):
    from bs4 import BeautifulSoup
    zuppa = BeautifulSoup(html, "html.parser")
    for tag in zuppa(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    righe = [r.strip() for r in zuppa.get_text(separator="\n").splitlines() if len(r.strip()) > 2]
    pulite, prec = [], None
    for r in righe:
        if r != prec:
            pulite.append(r)
        prec = r
    return "\n".join(pulite)


def scarica_sito(url):
    import requests
    for v in [url, url.replace("://www.", "://"), url.replace("https://", "http://")]:
        try:
            r = requests.get(v, timeout=TIMEOUT_HTTP,
                             headers={"User-Agent": USER_AGENT, "Accept-Language": "it,en"},
                             allow_redirects=True)
            if r.status_code == 200 and r.content:
                r.encoding = r.apparent_encoding or r.encoding
                testo = estrai_testo(r.text)
                if len(testo) >= 250:
                    return testo[:MAX_CARATTERI_SITO]
        except Exception:
            continue
    return ""


# ---------------------------------------------------------------------------
# Classificazione OpenAI
# ---------------------------------------------------------------------------

def _leggi_tassonomia():
    f = Path(__file__).parent / "tassonomia.txt"
    if f.exists():
        return f.read_text(encoding="utf-8")
    raise RuntimeError("tassonomia.txt non trovato nella cartella dell'app")


def _estrai_json(testo):
    testo = re.sub(r"^```(?:json)?|```$", "", (testo or "").strip(), flags=re.M).strip()
    try:
        return json.loads(testo)
    except Exception:
        m = re.search(r"\{.*\}", testo, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return None


def _pulisci_icebreaker(s):
    s = re.sub(r"\s+", " ", (s or "").strip())
    if s and s[0].isupper() and not s.startswith(("SPA", "SRL")):
        s = s[0].lower() + s[1:]
    return s


def classifica_azienda(client, modello, sistema, nome, sito_web, testo_sito, tentativi=3):
    parti = [f"NOME AZIENDA: {nome}", f"SITO WEB: {sito_web}"]
    if testo_sito:
        parti.append(f"TESTO DEL SITO WEB:\n{testo_sito}")
    else:
        parti.append("TESTO DEL SITO WEB: non disponibile. Classifica solo se gli altri indizi bastano.")
    domanda = "\n\n".join(parti)

    for n in range(tentativi):
        try:
            r = client.chat.completions.create(
                model=modello,
                messages=[{"role": "system", "content": sistema}, {"role": "user", "content": domanda}],
                response_format={"type": "json_object"},
            )
            dati = _estrai_json(r.choices[0].message.content)
            if not dati:
                raise ValueError("risposta non JSON")
            settore = (dati.get("settore") or "").strip()
            trovato = next((s for s in SETTORI_VALIDI if s.lower() == settore.lower()), None)
            if not trovato:
                raise ValueError(f"settore non valido: {settore!r}")
            conf = (dati.get("confidenza") or "media").strip().lower()
            if conf not in {"alta", "media", "bassa"}:
                conf = "media"
            return {
                "settore":              trovato,
                "settore_confidenza":   conf,
                "settore_motivazione":  re.sub(r"\s+", " ", (dati.get("motivazione") or "").strip()),
                "icebreaker":           _pulisci_icebreaker(dati.get("icebreaker")),
                "classificato_il":      datetime.datetime.utcnow().isoformat() + "Z",
            }
        except Exception:
            if n < tentativi - 1:
                time.sleep(2 * (n + 1))
    return None


# ---------------------------------------------------------------------------
# Runner principale (gira in background thread)
# ---------------------------------------------------------------------------

def run_classificazione(sb_url, sb_key, ai_key, modello="gpt-4o-mini", run_start=None):
    global _running, _last_result
    if _running:
        return False

    _running = True
    _last_result = {"classificate": 0, "errori": 0, "avviato_il": datetime.datetime.utcnow().isoformat() + "Z", "run_start": run_start}

    try:
        from openai import OpenAI
        modello = (modello or "gpt-4o-mini").strip() or "gpt-4o-mini"
        client  = OpenAI(api_key=ai_key)
        sistema = _leggi_tassonomia()

        aziende = get_da_classificare(sb_url, sb_key, run_start=run_start)
        _last_result["totale"] = len(aziende)
        for az in aziende:
            _last_result["nome_corrente"] = az.get("nome", "")
            try:
                sito   = normalizza_url(az.get("sito_web", ""))
                testo  = scarica_sito(sito) if sito else ""
                dati   = classifica_azienda(client, modello, sistema, az.get("nome", ""), sito, testo)
                if dati and aggiorna_company(sb_url, sb_key, az["id"], dati):
                    _last_result["classificate"] += 1
                else:
                    _last_result["errori"] += 1
            except Exception:
                _last_result["errori"] += 1
            time.sleep(PAUSA)
        _last_result["nome_corrente"] = None
    except Exception as e:
        _last_result["errore_fatale"] = str(e)
    finally:
        _running = False

    return True


def stato(sb_url, sb_key):
    run_start = _last_result.get("run_start") if _last_result else None
    try:
        n = count_da_classificare(sb_url, sb_key, run_start=run_start)
    except Exception:
        n = -1
    return {
        "in_coda":    n,
        "in_corso":   _running,
        "ultimo_run": _last_result,
    }
