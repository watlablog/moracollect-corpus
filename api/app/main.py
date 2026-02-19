import os

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import firestore as admin_firestore

from app.auth import get_uid_from_token, verify_id_token
from app.firestore import get_user_doc_ref
from app.models import (
    HealthResponse,
    PingResponse,
    ProfileGetResponse,
    ProfilePostRequest,
    ProfilePostResponse,
)

load_dotenv()

app = FastAPI(title="MoraCollect API", version="0.2.0")

PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "moracollect-watlab")
MIN_DISPLAY_NAME_LENGTH = 2
MAX_DISPLAY_NAME_LENGTH = 20

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
    uid = get_uid_from_token(decoded_token)
    return PingResponse(
        ok=True,
        uid=uid,
        email=decoded_token.get("email"),
        project_id=PROJECT_ID,
    )


def normalize_display_name(display_name: str) -> str:
    normalized = display_name.strip()
    if len(normalized) < MIN_DISPLAY_NAME_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"display_name must be at least {MIN_DISPLAY_NAME_LENGTH} characters",
        )
    if len(normalized) > MAX_DISPLAY_NAME_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"display_name must be at most {MAX_DISPLAY_NAME_LENGTH} characters",
        )
    return normalized


@app.get("/v1/profile", response_model=ProfileGetResponse)
def get_profile(decoded_token: dict = Depends(verify_id_token)) -> ProfileGetResponse:
    uid = get_uid_from_token(decoded_token)

    try:
        snapshot = get_user_doc_ref(uid).get()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load profile",
        ) from exc

    if not snapshot.exists:
        return ProfileGetResponse(
            ok=True,
            uid=uid,
            display_name="",
            profile_exists=False,
        )

    data = snapshot.to_dict() or {}
    display_name = data.get("display_name")
    if not isinstance(display_name, str):
        display_name = ""

    return ProfileGetResponse(
        ok=True,
        uid=uid,
        display_name=display_name,
        profile_exists=True,
    )


@app.post("/v1/profile", response_model=ProfilePostResponse)
def post_profile(
    payload: ProfilePostRequest,
    decoded_token: dict = Depends(verify_id_token),
) -> ProfilePostResponse:
    uid = get_uid_from_token(decoded_token)
    display_name = normalize_display_name(payload.display_name)
    user_ref = get_user_doc_ref(uid)

    try:
        snapshot = user_ref.get()
        if snapshot.exists:
            user_ref.set(
                {
                    "display_name": display_name,
                    "updated_at": admin_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
        else:
            user_ref.set(
                {
                    "display_name": display_name,
                    "role": "collector",
                    "created_at": admin_firestore.SERVER_TIMESTAMP,
                    "updated_at": admin_firestore.SERVER_TIMESTAMP,
                }
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save profile",
        ) from exc

    return ProfilePostResponse(ok=True, uid=uid, display_name=display_name)
