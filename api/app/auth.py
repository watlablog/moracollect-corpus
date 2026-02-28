import os
from typing import Any

import firebase_admin
from fastapi import Header, HTTPException, status
from firebase_admin import auth, credentials


def initialize_firebase_admin() -> None:
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
    initialize_firebase_admin()

    try:
        decoded_token = auth.verify_id_token(token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        ) from exc

    firebase_claim = decoded_token.get("firebase")
    sign_in_provider = ""
    if isinstance(firebase_claim, dict):
        provider = firebase_claim.get("sign_in_provider")
        if isinstance(provider, str):
            sign_in_provider = provider

    if sign_in_provider == "password" and decoded_token.get("email_verified") is not True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email verification required",
        )

    return decoded_token


def get_uid_from_token(decoded_token: dict[str, Any]) -> str:
    uid = decoded_token.get("uid") or decoded_token.get("sub")
    if not uid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        )
    return str(uid)
