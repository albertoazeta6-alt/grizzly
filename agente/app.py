import threading
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from core import verify
import classifica

app = FastAPI(title="Company Page Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class VerifyRequest(BaseModel):
    legal_name: Optional[str] = None
    website: str
    city: Optional[str] = None
    candidate_url_1: Optional[str] = None
    candidate_url_2: Optional[str] = None

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/verify")
def verify_endpoint(req: VerifyRequest):
    return verify(req.model_dump())

# ── Classificazione settori ───────────────────────────────────────────────────

class ClassificaRequest(BaseModel):
    supabase_url: str
    supabase_key: str
    openai_api_key: str
    openai_model: Optional[str] = "gpt-4o-mini"
    run_start: Optional[str] = None  # ISO timestamp — filtra solo aziende del run corrente

@app.post("/classifica/avvia")
def classifica_avvia(req: ClassificaRequest):
    """Avvia la classificazione in background. Risponde subito."""
    if classifica._running:
        return {"status": "già_in_corso"}
    t = threading.Thread(
        target=classifica.run_classificazione,
        args=(req.supabase_url, req.supabase_key, req.openai_api_key, req.openai_model, req.run_start),
        daemon=True
    )
    t.start()
    return {"status": "avviato"}

@app.get("/classifica/stato")
def classifica_stato(supabase_url: str, supabase_key: str):
    """Ritorna quante aziende restano da classificare."""
    return classifica.stato(supabase_url, supabase_key)
