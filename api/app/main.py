import os

from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import verify_id_token
from app.models import HealthResponse, PingResponse

load_dotenv()

app = FastAPI(title="MoraCollect API", version="0.1.0")

PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "moracollect-watlab")

allowed_origins = [
    "http://localhost:5173",
    f"https://{PROJECT_ID}.web.app",
    f"https://{PROJECT_ID}.firebaseapp.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    return HealthResponse(ok=True)


@app.get("/v1/ping", response_model=PingResponse)
def ping(decoded_token: dict = Depends(verify_id_token)) -> PingResponse:
    return PingResponse(
        ok=True,
        uid=str(decoded_token.get("uid", "")),
        email=decoded_token.get("email"),
        project_id=PROJECT_ID,
    )
