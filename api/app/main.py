import os
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import firestore as admin_firestore

from app.auth import get_uid_from_token, verify_id_token
from app.firestore import (
    get_firestore_client,
    get_record_doc_ref,
    get_user_doc_ref,
    get_user_record_doc_ref,
    get_user_records_collection,
)
from app.models import (
    HealthResponse,
    MyRecordItem,
    MyRecordsResponse,
    PingResponse,
    ProfileGetResponse,
    ProfilePostRequest,
    ProfilePostResponse,
    RegisterRequest,
    RegisterResponse,
    UploadUrlRequest,
    UploadUrlResponse,
)
from app.storage import (
    build_raw_object_path,
    generate_upload_signed_url,
    object_exists,
)

load_dotenv()

app = FastAPI(title="MoraCollect API", version="0.4.0")
logger = logging.getLogger("moracollect.api")

PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "moracollect-watlab")
STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "").strip()
MIN_DISPLAY_NAME_LENGTH = 2
MAX_DISPLAY_NAME_LENGTH = 20
UPLOAD_URL_EXPIRES_SEC = 600
ALLOWED_UPLOAD_CONTENT_TYPES = {
    "webm": "audio/webm",
    "mp4": "audio/mp4",
}
STEP6_DEFAULT_SCRIPT_ID = "step5-free-script"
STEP6_DEFAULT_PROMPT_ID = "step5-free-prompt"
DEFAULT_MY_RECORDS_LIMIT = 20
MAX_MY_RECORDS_LIMIT = 50

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


def normalize_upload_ext(ext: str) -> str:
    normalized = ext.strip().lower().lstrip(".")
    if normalized not in ALLOWED_UPLOAD_CONTENT_TYPES:
        allowed_exts = ", ".join(sorted(ALLOWED_UPLOAD_CONTENT_TYPES))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"ext must be one of: {allowed_exts}",
        )
    return normalized


def normalize_upload_content_type(content_type: str) -> str:
    normalized = content_type.split(";")[0].strip().lower()
    if normalized not in ALLOWED_UPLOAD_CONTENT_TYPES.values():
        allowed_types = ", ".join(sorted(set(ALLOWED_UPLOAD_CONTENT_TYPES.values())))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"content_type must be one of: {allowed_types}",
        )
    return normalized


def normalize_record_id(record_id: str) -> str:
    normalized = record_id.strip()
    try:
        return str(UUID(normalized))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="record_id must be a valid UUID",
        ) from exc


def normalize_register_raw_path(raw_path: str, uid: str, record_id: str) -> str:
    normalized_path = raw_path.strip().lstrip("/")
    parts = normalized_path.split("/")
    if len(parts) != 3 or parts[0] != "raw":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="raw_path must follow raw/{uid}/{record_id}.{ext}",
        )

    path_uid = parts[1]
    if path_uid != uid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="raw_path uid must match authenticated user",
        )

    filename = parts[2]
    if "." not in filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="raw_path must include file extension",
        )

    path_record_id, ext = filename.rsplit(".", 1)
    if path_record_id != record_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="raw_path record_id must match record_id",
        )

    normalized_ext = normalize_upload_ext(ext)
    return build_raw_object_path(uid=uid, record_id=record_id, ext=normalized_ext)


def normalize_recording_meta(recording_meta: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}

    mime_type = recording_meta.get("mime_type")
    if isinstance(mime_type, str):
        value = mime_type.strip()
        if value:
            normalized["mime_type"] = value

    size_bytes = recording_meta.get("size_bytes")
    if isinstance(size_bytes, (int, float)) and not isinstance(size_bytes, bool):
        if size_bytes >= 0:
            normalized["size_bytes"] = int(size_bytes)

    duration_ms = recording_meta.get("duration_ms")
    if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool):
        if duration_ms >= 0:
            normalized["duration_ms"] = int(duration_ms)

    return normalized


def as_optional_str(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def as_optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def format_timestamp(value: Any) -> str | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


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


@app.post("/v1/upload-url", response_model=UploadUrlResponse)
def post_upload_url(
    payload: UploadUrlRequest,
    decoded_token: dict = Depends(verify_id_token),
) -> UploadUrlResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    ext = normalize_upload_ext(payload.ext)
    content_type = normalize_upload_content_type(payload.content_type)
    expected_content_type = ALLOWED_UPLOAD_CONTENT_TYPES[ext]
    if content_type != expected_content_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"content_type must be {expected_content_type} when ext is {ext}",
        )

    record_id = str(uuid4())
    raw_path = build_raw_object_path(uid=uid, record_id=record_id, ext=ext)

    try:
        upload_url = generate_upload_signed_url(
            bucket_name=STORAGE_BUCKET,
            object_path=raw_path,
            content_type=content_type,
            expires_sec=UPLOAD_URL_EXPIRES_SEC,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to generate upload URL: uid=%s bucket=%s raw_path=%s error_type=%s error=%s",
            uid,
            STORAGE_BUCKET,
            raw_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate upload URL",
        ) from exc

    return UploadUrlResponse(
        ok=True,
        record_id=record_id,
        raw_path=raw_path,
        upload_url=upload_url,
        method="PUT",
        required_headers={"Content-Type": content_type},
        expires_in_sec=UPLOAD_URL_EXPIRES_SEC,
    )


@app.post("/v1/register", response_model=RegisterResponse)
def post_register(
    payload: RegisterRequest,
    decoded_token: dict = Depends(verify_id_token),
) -> RegisterResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    record_id = normalize_record_id(payload.record_id)
    raw_path = normalize_register_raw_path(payload.raw_path, uid=uid, record_id=record_id)
    client_meta = payload.client_meta if isinstance(payload.client_meta, dict) else {}
    recording_meta = normalize_recording_meta(
        payload.recording_meta if isinstance(payload.recording_meta, dict) else {}
    )

    record_ref = get_record_doc_ref(record_id)
    user_record_ref = get_user_record_doc_ref(uid, record_id)

    try:
        if not object_exists(STORAGE_BUCKET, raw_path):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="raw object not found",
            )

        existing_snapshot = record_ref.get()
        if existing_snapshot.exists:
            existing_data = existing_snapshot.to_dict() or {}
            existing_uid = as_optional_str(existing_data.get("uid"))
            if existing_uid and existing_uid != uid:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="record_id already owned by different uid",
                )

            existing_raw_path = as_optional_str(existing_data.get("raw_path"))
            if existing_raw_path and existing_raw_path != raw_path:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="record_id already registered with different raw_path",
                )

            existing_status = as_optional_str(existing_data.get("status")) or "uploaded"
            existing_script_id = (
                as_optional_str(existing_data.get("script_id"))
                or STEP6_DEFAULT_SCRIPT_ID
            )
            existing_prompt_id = (
                as_optional_str(existing_data.get("prompt_id"))
                or STEP6_DEFAULT_PROMPT_ID
            )
            existing_recording = existing_data.get("recording")
            if not isinstance(existing_recording, dict):
                existing_recording = {}

            resolved_size_bytes = as_optional_int(existing_recording.get("size_bytes"))
            if resolved_size_bytes is None:
                resolved_size_bytes = as_optional_int(recording_meta.get("size_bytes"))

            resolved_duration_ms = as_optional_int(existing_recording.get("duration_ms"))
            if resolved_duration_ms is None:
                resolved_duration_ms = as_optional_int(recording_meta.get("duration_ms"))

            user_record_ref.set(
                {
                    "record_id": record_id,
                    "status": existing_status,
                    "raw_path": raw_path,
                    "script_id": existing_script_id,
                    "prompt_id": existing_prompt_id,
                    "mime_type": as_optional_str(
                        existing_recording.get("mime_type")
                    )
                    or as_optional_str(recording_meta.get("mime_type")),
                    "size_bytes": resolved_size_bytes,
                    "duration_ms": resolved_duration_ms,
                    "created_at": existing_data.get(
                        "created_at", admin_firestore.SERVER_TIMESTAMP
                    ),
                },
                merge=True,
            )

            return RegisterResponse(
                ok=True,
                record_id=record_id,
                status=existing_status,
                already_registered=True,
            )

        record_doc = {
            "record_id": record_id,
            "uid": uid,
            "script_id": STEP6_DEFAULT_SCRIPT_ID,
            "prompt_id": STEP6_DEFAULT_PROMPT_ID,
            "raw_path": raw_path,
            "wav_path": "",
            "status": "uploaded",
            "client": client_meta,
            "recording": recording_meta,
            "created_at": admin_firestore.SERVER_TIMESTAMP,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        }
        user_record_doc = {
            "record_id": record_id,
            "status": "uploaded",
            "raw_path": raw_path,
            "script_id": STEP6_DEFAULT_SCRIPT_ID,
            "prompt_id": STEP6_DEFAULT_PROMPT_ID,
            "mime_type": as_optional_str(recording_meta.get("mime_type")),
            "size_bytes": as_optional_int(recording_meta.get("size_bytes")),
            "duration_ms": as_optional_int(recording_meta.get("duration_ms")),
            "created_at": admin_firestore.SERVER_TIMESTAMP,
        }

        batch = get_firestore_client().batch()
        batch.set(record_ref, record_doc)
        batch.set(user_record_ref, user_record_doc)
        batch.commit()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to register record: uid=%s record_id=%s raw_path=%s error_type=%s error=%s",
            uid,
            record_id,
            raw_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to register record",
        ) from exc

    return RegisterResponse(
        ok=True,
        record_id=record_id,
        status="uploaded",
        already_registered=False,
    )


@app.get("/v1/my-records", response_model=MyRecordsResponse)
def get_my_records(
    limit: int = Query(
        default=DEFAULT_MY_RECORDS_LIMIT,
        ge=1,
        le=MAX_MY_RECORDS_LIMIT,
    ),
    decoded_token: dict = Depends(verify_id_token),
) -> MyRecordsResponse:
    uid = get_uid_from_token(decoded_token)

    try:
        query = (
            get_user_records_collection(uid)
            .order_by("created_at", direction=admin_firestore.Query.DESCENDING)
            .limit(limit)
        )
        snapshots = query.stream()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load my records",
        ) from exc

    records: list[MyRecordItem] = []
    for snapshot in snapshots:
        data = snapshot.to_dict() or {}
        records.append(
            MyRecordItem(
                record_id=as_optional_str(data.get("record_id")) or snapshot.id,
                status=as_optional_str(data.get("status")) or "uploaded",
                script_id=as_optional_str(data.get("script_id"))
                or STEP6_DEFAULT_SCRIPT_ID,
                prompt_id=as_optional_str(data.get("prompt_id"))
                or STEP6_DEFAULT_PROMPT_ID,
                raw_path=as_optional_str(data.get("raw_path")) or "",
                mime_type=as_optional_str(data.get("mime_type")),
                size_bytes=as_optional_int(data.get("size_bytes")),
                duration_ms=as_optional_int(data.get("duration_ms")),
                created_at=format_timestamp(data.get("created_at")),
            )
        )

    return MyRecordsResponse(ok=True, records=records)
