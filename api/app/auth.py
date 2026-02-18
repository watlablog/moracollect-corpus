import os
from typing import Any

import firebase_admin
from fastapi import Header, HTTPException, status
from firebase_admin import auth, credentials


def _initialize_firebase_admin() -> None:
    if firebase_admin._apps:
        return

    cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if cred_path:
        firebase_admin.initialize_app(credentials.Certificate(cred_path))
        return

    firebase_admin.initialize_app()


def get_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format",
        )

    return token


def verify_id_token(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token = get_bearer_token(authorization)
    _initialize_firebase_admin()

    try:
        return auth.verify_id_token(token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        ) from exc
