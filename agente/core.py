import re
from urllib.parse import urlparse

LEGAL_SUFFIXES = {"srl","spa","snc","sas","sapa","sa","gmbh","ltd","inc","llc","company","group","holding","holdings","co"}

def normalize_url(url):
    if not url:
        return None
    url = url.lower().strip()
    url = re.sub(r"\?.*$", "", url)
    url = url.replace("http://", "").replace("https://", "")
    url = url.replace("www.", "")
    url = url.rstrip("/")
    url = url.replace("/about", "")
    return url

def extract_slug(url):
    if not url:
        return ""
    parts = [p for p in normalize_url(url).split("/") if p]
    return parts[-1] if parts else ""

def normalize_text(text):
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()

def collapse(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())

def tokens(text):
    return [t for t in normalize_text(text).split() if len(t) > 1]

def website_brand(website):
    try:
        netloc = urlparse(website).netloc.lower().replace("www.", "")
    except:
        netloc = ""
    root = netloc.split(".")[0]
    return collapse(root)

def extract_linkedin_from_multi(url):
    """Se il campo contiene più URL separati da virgola, estrae solo quello LinkedIn company.
    Restituisce None se non trova un URL LinkedIn valido."""
    if not url:
        return None
    if "," in url:
        parts = [p.strip() for p in url.split(",")]
        for p in parts:
            if re.search(r"linkedin\.com/company/", p, re.IGNORECASE):
                return p
        return None  # campo multi-URL senza LinkedIn → scarta
    return url

def is_clean_linkedin(url):
    """Restituisce True se l'URL è un singolo URL LinkedIn company pulito."""
    if not url:
        return False
    return bool(re.search(r"linkedin\.com/company/[^,\s]+$", url.strip(), re.IGNORECASE))

def score(url, website, legal_name, is_clean=False):
    slug = extract_slug(url)
    slug_c = collapse(slug)
    brand = website_brand(website)
    s = 0

    if brand and brand in slug_c:
        s += 10

    for t in tokens(legal_name):
        if t in slug:
            s += 2

    if "france" in slug or "germany" in slug:
        s -= 5

    # Bonus per URL LinkedIn company diretto e pulito (non estratto da multi-URL)
    if is_clean:
        s += 3

    return s

def verify(payload):
    raw_c1 = payload.get("candidate_url_1")
    raw_c2 = payload.get("candidate_url_2")

    # Regola: se il candidato contiene più URL (virgola), estrai solo LinkedIn company
    raw_c1 = extract_linkedin_from_multi(raw_c1)
    raw_c2 = extract_linkedin_from_multi(raw_c2)

    # Memorizza se erano URL puliti prima della normalizzazione
    clean_c1 = is_clean_linkedin(raw_c1)
    clean_c2 = is_clean_linkedin(raw_c2)

    c1 = normalize_url(raw_c1)
    c2 = normalize_url(raw_c2)

    # Costruisci lista candidati con flag "clean"
    candidates = []
    seen = set()
    for url, is_clean in [(c1, clean_c1), (c2, clean_c2)]:
        if url and url not in seen:
            candidates.append((url, is_clean))
            seen.add(url)

    if not candidates:
        return {"verified_url": None, "status": "not_found", "confidence": 0.2, "notes": "no candidates"}

    scored = [(c, score(c, payload.get("website"), payload.get("legal_name"), is_clean=ic)) for c, ic in candidates]
    scored.sort(key=lambda x: x[1], reverse=True)

    top = scored[0]

    return {
        "verified_url": "https://" + top[0],
        "status": "matched",
        "confidence": 0.9,
        "notes": "best match"
    }
