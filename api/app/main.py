import os
import logging
import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Path, Query, status
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import firestore as admin_firestore
from google.api_core.exceptions import Forbidden

from app.auth import get_uid_from_token, verify_id_token
from app.firestore import (
    get_firestore_client,
    get_prompt_doc_ref,
    get_prompt_speaker_doc_ref,
    get_prompt_stats_doc_ref,
    get_prompts_by_script_snapshot_doc_ref,
    get_prompts_collection,
    get_record_doc_ref,
    get_script_doc_ref,
    get_script_speaker_doc_ref,
    get_script_stats_doc_ref,
    get_scripts_overview_snapshot_doc_ref,
    get_scripts_collection,
    get_users_collection,
    get_user_doc_ref,
    get_user_record_doc_ref,
    get_user_records_collection,
)
from app.models import (
    AvatarDeleteResponse,
    AvatarSaveRequest,
    AvatarSaveResponse,
    AvatarUploadUrlResponse,
    AvatarUrlResponse,
    DeleteMyRecordResponse,
    HealthResponse,
    LeaderboardItem,
    LeaderboardResponse,
    MyRecordItem,
    MyRecordPlaybackUrlResponse,
    MyRecordsResponse,
    PingResponse,
    PromptItem,
    PromptsResponse,
    ProfileGetResponse,
    ProfilePostRequest,
    ProfilePostResponse,
    RegisterRequest,
    RegisterResponse,
    ScriptItem,
    ScriptsResponse,
    UploadUrlRequest,
    UploadUrlResponse,
)
from app.storage import (
    build_avatar_object_path,
    build_raw_object_path,
    delete_object_if_exists,
    generate_download_signed_url,
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
PLAYBACK_URL_EXPIRES_SEC = 600
AVATAR_UPLOAD_URL_EXPIRES_SEC = 600
AVATAR_VIEW_URL_EXPIRES_SEC = 3600
ALLOWED_AVATAR_CONTENT_TYPE = "image/webp"
AVATAR_EXPORT_SIZE = 512
MAX_AVATAR_SIZE_BYTES = 10 * 1024 * 1024
ALLOWED_UPLOAD_CONTENT_TYPES = {
    "webm": "audio/webm",
    "mp4": "audio/mp4",
}
STEP6_DEFAULT_SCRIPT_ID = "step5-free-script"
STEP6_DEFAULT_PROMPT_ID = "step5-free-prompt"
DEFAULT_MY_RECORDS_LIMIT = 20
MAX_MY_RECORDS_LIMIT = 50
DEFAULT_LEADERBOARD_LIMIT = 10
MAX_LEADERBOARD_LIMIT = 50
IDENTIFIER_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$")

allowed_origins = [
    "http://localhost:5173",
    f"https://{PROJECT_ID}.web.app",
    f"https://{PROJECT_ID}.firebaseapp.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
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


@app.get("/v1/scripts", response_model=ScriptsResponse)
def get_scripts(decoded_token: dict = Depends(verify_id_token)) -> ScriptsResponse:
    _ = get_uid_from_token(decoded_token)

    try:
        scripts_from_snapshot = load_scripts_from_snapshot()
        if scripts_from_snapshot is not None:
            return ScriptsResponse(ok=True, scripts=scripts_from_snapshot)
        scripts_from_fallback = load_scripts_from_firestore_fallback()
        return ScriptsResponse(ok=True, scripts=scripts_from_fallback)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load scripts",
        ) from exc


@app.get("/v1/prompts", response_model=PromptsResponse)
def get_prompts(
    script_id: str = Query(...),
    decoded_token: dict = Depends(verify_id_token),
) -> PromptsResponse:
    _ = get_uid_from_token(decoded_token)
    normalized_script_id = normalize_identifier(script_id, "script_id")

    try:
        prompts_from_snapshot = load_prompts_from_snapshot(normalized_script_id)
        if prompts_from_snapshot is not None:
            return PromptsResponse(
                ok=True,
                script_id=normalized_script_id,
                prompts=prompts_from_snapshot,
            )
        prompts_from_fallback = load_prompts_from_firestore_fallback(normalized_script_id)
        return PromptsResponse(
            ok=True,
            script_id=normalized_script_id,
            prompts=prompts_from_fallback,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load prompts",
        ) from exc


def load_scripts_from_snapshot() -> list[ScriptItem] | None:
    try:
        snapshot = get_scripts_overview_snapshot_doc_ref().get()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to read scripts snapshot: %s", str(exc))
        return None

    if not snapshot.exists:
        return None

    data = snapshot.to_dict() or {}
    scripts_map = data.get("scripts_map")
    if not isinstance(scripts_map, dict):
        return []

    scripts: list[ScriptItem] = []
    for script_key, raw_item in scripts_map.items():
        if not isinstance(raw_item, dict):
            continue
        script_id = as_optional_str(raw_item.get("script_id")) or as_optional_str(script_key)
        if not script_id:
            continue
        item = ScriptItem(
            script_id=script_id,
            title=as_optional_str(raw_item.get("title")) or script_id,
            description=as_optional_str(raw_item.get("description")) or "",
            order=as_optional_int(raw_item.get("order")) or 0,
            is_active=as_bool(raw_item.get("is_active"), True),
            prompt_count=max(0, as_optional_int(raw_item.get("prompt_count")) or 0),
            total_records=max(0, as_optional_int(raw_item.get("total_records")) or 0),
            unique_speakers=max(
                0,
                as_optional_int(raw_item.get("unique_speakers")) or 0,
            ),
        )
        if item.is_active:
            scripts.append(item)

    scripts.sort(key=lambda item: (item.order, item.title, item.script_id))
    return scripts


def load_prompts_from_snapshot(script_id: str) -> list[PromptItem] | None:
    try:
        snapshot = get_prompts_by_script_snapshot_doc_ref(script_id).get()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to read prompts snapshot for script=%s: %s",
            script_id,
            str(exc),
        )
        return None

    if not snapshot.exists:
        return None

    data = snapshot.to_dict() or {}
    prompts_map = data.get("prompts_map")
    if not isinstance(prompts_map, dict):
        return []

    prompts: list[PromptItem] = []
    for prompt_key, raw_item in prompts_map.items():
        if not isinstance(raw_item, dict):
            continue
        prompt_id = as_optional_str(raw_item.get("prompt_id")) or as_optional_str(prompt_key)
        if not prompt_id:
            continue
        text = as_optional_str(raw_item.get("text")) or ""
        if not text:
            try:
                prompt_snapshot = get_prompt_doc_ref(prompt_id).get()
                if prompt_snapshot.exists:
                    prompt_data = prompt_snapshot.to_dict() or {}
                    text = as_optional_str(prompt_data.get("text")) or ""
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to recover prompt text from prompts collection: prompt_id=%s error=%s",
                    prompt_id,
                    str(exc),
                )
        item = PromptItem(
            prompt_id=prompt_id,
            text=text or prompt_id,
            order=as_optional_int(raw_item.get("order")) or 0,
            is_active=as_bool(raw_item.get("is_active"), True),
            total_records=max(0, as_optional_int(raw_item.get("total_records")) or 0),
            unique_speakers=max(
                0,
                as_optional_int(raw_item.get("unique_speakers")) or 0,
            ),
        )
        if item.is_active:
            prompts.append(item)

    prompts.sort(key=lambda item: (item.order, item.prompt_id))
    return prompts


def load_scripts_from_firestore_fallback() -> list[ScriptItem]:
    script_snapshots = get_scripts_collection().where("is_active", "==", True).stream()
    active_prompts = get_prompts_collection().where("is_active", "==", True).stream()

    prompt_counts_by_script: dict[str, int] = {}
    for prompt_snapshot in active_prompts:
        prompt_data = prompt_snapshot.to_dict() or {}
        script_id = as_optional_str(prompt_data.get("script_id"))
        if not script_id:
            continue
        prompt_counts_by_script[script_id] = prompt_counts_by_script.get(script_id, 0) + 1

    scripts: list[ScriptItem] = []
    for script_snapshot in script_snapshots:
        script_data = script_snapshot.to_dict() or {}
        script_id = as_optional_str(script_data.get("script_id")) or script_snapshot.id
        stats_snapshot = get_script_stats_doc_ref(script_id).get()
        stats_data = stats_snapshot.to_dict() if stats_snapshot.exists else {}
        scripts.append(
            ScriptItem(
                script_id=script_id,
                title=as_optional_str(script_data.get("title")) or script_id,
                description=as_optional_str(script_data.get("description")) or "",
                order=as_optional_int(script_data.get("order")) or 0,
                is_active=as_bool(script_data.get("is_active"), True),
                prompt_count=prompt_counts_by_script.get(script_id, 0),
                total_records=max(0, as_optional_int(stats_data.get("total_records")) or 0),
                unique_speakers=max(
                    0,
                    as_optional_int(stats_data.get("unique_speakers")) or 0,
                ),
            )
        )

    scripts.sort(key=lambda item: (item.order, item.title, item.script_id))
    return scripts


def load_prompts_from_firestore_fallback(script_id: str) -> list[PromptItem]:
    script_snapshot = get_script_doc_ref(script_id).get()
    if not script_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="script not found",
        )
    script_data = script_snapshot.to_dict() or {}
    if not as_bool(script_data.get("is_active"), True):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="script not found",
        )

    prompt_snapshots = (
        get_prompts_collection()
        .where("script_id", "==", script_id)
        .stream()
    )
    prompts: list[PromptItem] = []
    for prompt_snapshot in prompt_snapshots:
        prompt_data = prompt_snapshot.to_dict() or {}
        if not as_bool(prompt_data.get("is_active"), True):
            continue
        prompt_id = as_optional_str(prompt_data.get("prompt_id")) or prompt_snapshot.id
        stats_snapshot = get_prompt_stats_doc_ref(prompt_id).get()
        stats_data = stats_snapshot.to_dict() if stats_snapshot.exists else {}
        prompts.append(
            PromptItem(
                prompt_id=prompt_id,
                text=as_optional_str(prompt_data.get("text")) or "",
                order=as_optional_int(prompt_data.get("order")) or 0,
                is_active=as_bool(prompt_data.get("is_active"), True),
                total_records=max(0, as_optional_int(stats_data.get("total_records")) or 0),
                unique_speakers=max(
                    0,
                    as_optional_int(stats_data.get("unique_speakers")) or 0,
                ),
            )
        )

    prompts.sort(key=lambda item: (item.order, item.prompt_id))
    return prompts


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


def normalize_avatar_path(avatar_path: str, uid: str) -> str:
    normalized_path = avatar_path.strip().lstrip("/")
    parts = normalized_path.split("/")
    if len(parts) != 3 or parts[0] != "avatars":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="avatar_path must follow avatars/{uid}/{avatar_id}.webp",
        )

    path_uid = parts[1]
    if path_uid != uid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="avatar_path uid must match authenticated user",
        )

    filename = parts[2]
    if not filename.endswith(".webp"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="avatar_path must end with .webp",
        )
    avatar_id = filename[:-5].strip()
    if not avatar_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="avatar_path must include avatar_id",
        )

    return build_avatar_object_path(uid=uid, avatar_id=avatar_id)


def normalize_identifier(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} is required",
        )
    if not IDENTIFIER_PATTERN.match(normalized):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} is invalid",
        )
    return normalized


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


def as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return default


def format_timestamp(value: Any) -> str | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_leaderboard_display_name(user_data: dict[str, Any], uid: str) -> str:
    display_name = as_optional_str(user_data.get("display_name"))
    if display_name:
        return display_name
    return uid


def leaderboard_sort_key(item: LeaderboardItem) -> tuple[int, str, str]:
    return (
        -item.contribution_count,
        item.display_name.casefold(),
        item.uid,
    )


@admin_firestore.transactional
def create_record_and_update_stats(
    transaction: admin_firestore.Transaction,
    *,
    record_ref: admin_firestore.DocumentReference,
    user_record_ref: admin_firestore.DocumentReference,
    user_ref: admin_firestore.DocumentReference,
    prompt_stats_ref: admin_firestore.DocumentReference,
    prompt_speaker_ref: admin_firestore.DocumentReference,
    script_stats_ref: admin_firestore.DocumentReference,
    script_speaker_ref: admin_firestore.DocumentReference,
    scripts_overview_snapshot_ref: admin_firestore.DocumentReference,
    prompts_by_script_snapshot_ref: admin_firestore.DocumentReference,
    record_doc: dict[str, Any],
    user_record_doc: dict[str, Any],
    script_id: str,
    prompt_id: str,
    uid: str,
    script_snapshot_base: dict[str, Any],
    prompt_snapshot_base: dict[str, Any],
) -> tuple[bool, bool]:
    prompt_speaker_snapshot = prompt_speaker_ref.get(transaction=transaction)
    script_speaker_snapshot = script_speaker_ref.get(transaction=transaction)
    scripts_overview_snapshot = scripts_overview_snapshot_ref.get(transaction=transaction)
    prompts_by_script_snapshot = prompts_by_script_snapshot_ref.get(
        transaction=transaction
    )

    scripts_overview_data = (
        scripts_overview_snapshot.to_dict() if scripts_overview_snapshot.exists else {}
    )
    scripts_map = scripts_overview_data.get("scripts_map")
    if not isinstance(scripts_map, dict):
        scripts_map = {}

    existing_script_entry = scripts_map.get(script_id)
    if not isinstance(existing_script_entry, dict):
        existing_script_entry = {}
    next_script_entry = {**existing_script_entry, **script_snapshot_base}
    next_script_entry["total_records"] = max(
        0, (as_optional_int(existing_script_entry.get("total_records")) or 0) + 1
    )
    next_script_entry["unique_speakers"] = max(
        0,
        (as_optional_int(existing_script_entry.get("unique_speakers")) or 0)
        + (0 if script_speaker_snapshot.exists else 1),
    )
    scripts_map[script_id] = next_script_entry

    prompts_by_script_data = (
        prompts_by_script_snapshot.to_dict() if prompts_by_script_snapshot.exists else {}
    )
    prompts_map = prompts_by_script_data.get("prompts_map")
    if not isinstance(prompts_map, dict):
        prompts_map = {}

    existing_prompt_entry = prompts_map.get(prompt_id)
    if not isinstance(existing_prompt_entry, dict):
        existing_prompt_entry = {}
    next_prompt_entry = {**existing_prompt_entry, **prompt_snapshot_base}
    next_prompt_entry["total_records"] = max(
        0, (as_optional_int(existing_prompt_entry.get("total_records")) or 0) + 1
    )
    next_prompt_entry["unique_speakers"] = max(
        0,
        (as_optional_int(existing_prompt_entry.get("unique_speakers")) or 0)
        + (0 if prompt_speaker_snapshot.exists else 1),
    )
    prompts_map[prompt_id] = next_prompt_entry

    transaction.set(record_ref, record_doc)
    transaction.set(user_record_ref, user_record_doc)
    transaction.set(
        user_ref,
        {
            "contribution_count": admin_firestore.Increment(1),
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    transaction.set(
        prompt_stats_ref,
        {
            "script_id": script_id,
            "total_records": admin_firestore.Increment(1),
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
            "last_record_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    transaction.set(
        script_stats_ref,
        {
            "total_records": admin_firestore.Increment(1),
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
            "last_record_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    transaction.set(
        scripts_overview_snapshot_ref,
        {
            "scripts_map": scripts_map,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    transaction.set(
        prompts_by_script_snapshot_ref,
        {
            "script_id": script_id,
            "prompts_map": prompts_map,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    prompt_speaker_added = not prompt_speaker_snapshot.exists
    script_speaker_added = not script_speaker_snapshot.exists

    if prompt_speaker_added:
        transaction.set(
            prompt_speaker_ref,
            {
                "uid": uid,
                "created_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        transaction.set(
            prompt_stats_ref,
            {
                "unique_speakers": admin_firestore.Increment(1),
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

    if script_speaker_added:
        transaction.set(
            script_speaker_ref,
            {
                "uid": uid,
                "created_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        transaction.set(
            script_stats_ref,
            {
                "unique_speakers": admin_firestore.Increment(1),
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

    return (prompt_speaker_added, script_speaker_added)


@admin_firestore.transactional
def delete_record_and_update_stats(
    transaction: admin_firestore.Transaction,
    *,
    user_ref: admin_firestore.DocumentReference,
    user_record_ref: admin_firestore.DocumentReference,
    record_ref: admin_firestore.DocumentReference,
    prompt_stats_ref: admin_firestore.DocumentReference,
    prompt_speaker_ref: admin_firestore.DocumentReference,
    script_stats_ref: admin_firestore.DocumentReference,
    script_speaker_ref: admin_firestore.DocumentReference,
    scripts_overview_snapshot_ref: admin_firestore.DocumentReference,
    prompts_by_script_snapshot_ref: admin_firestore.DocumentReference,
    script_id: str,
    prompt_id: str,
    prompt_text: str | None,
    has_other_prompt_record: bool,
    has_other_script_record: bool,
) -> None:
    user_snapshot = user_ref.get(transaction=transaction)
    user_data = user_snapshot.to_dict() if user_snapshot.exists else {}
    previous_contribution_count = as_optional_int(user_data.get("contribution_count")) or 0
    next_contribution_count = max(0, previous_contribution_count - 1)

    prompt_stats_snapshot = prompt_stats_ref.get(transaction=transaction)
    prompt_stats_data = prompt_stats_snapshot.to_dict() if prompt_stats_snapshot.exists else {}
    next_prompt_total = max(
        0,
        (as_optional_int(prompt_stats_data.get("total_records")) or 0) - 1,
    )
    next_prompt_unique = max(
        0,
        (as_optional_int(prompt_stats_data.get("unique_speakers")) or 0)
        - (0 if has_other_prompt_record else 1),
    )

    script_stats_snapshot = script_stats_ref.get(transaction=transaction)
    script_stats_data = script_stats_snapshot.to_dict() if script_stats_snapshot.exists else {}
    next_script_total = max(
        0,
        (as_optional_int(script_stats_data.get("total_records")) or 0) - 1,
    )
    next_script_unique = max(
        0,
        (as_optional_int(script_stats_data.get("unique_speakers")) or 0)
        - (0 if has_other_script_record else 1),
    )

    scripts_overview_snapshot = scripts_overview_snapshot_ref.get(transaction=transaction)
    scripts_overview_data = (
        scripts_overview_snapshot.to_dict() if scripts_overview_snapshot.exists else {}
    )
    scripts_map = scripts_overview_data.get("scripts_map")
    if not isinstance(scripts_map, dict):
        scripts_map = {}
    existing_script_entry = scripts_map.get(script_id)
    if not isinstance(existing_script_entry, dict):
        existing_script_entry = {}
    next_script_entry = dict(existing_script_entry)
    next_script_entry["script_id"] = script_id
    next_script_entry["total_records"] = next_script_total
    next_script_entry["unique_speakers"] = next_script_unique
    scripts_map[script_id] = next_script_entry

    prompts_by_script_snapshot = prompts_by_script_snapshot_ref.get(transaction=transaction)
    prompts_by_script_data = (
        prompts_by_script_snapshot.to_dict() if prompts_by_script_snapshot.exists else {}
    )
    prompts_map = prompts_by_script_data.get("prompts_map")
    if not isinstance(prompts_map, dict):
        prompts_map = {}
    existing_prompt_entry = prompts_map.get(prompt_id)
    if not isinstance(existing_prompt_entry, dict):
        existing_prompt_entry = {}
    next_prompt_entry = dict(existing_prompt_entry)
    next_prompt_entry["prompt_id"] = prompt_id
    normalized_prompt_text = as_optional_str(prompt_text)
    if normalized_prompt_text:
        next_prompt_entry["text"] = normalized_prompt_text
    elif as_optional_str(existing_prompt_entry.get("text")):
        next_prompt_entry["text"] = as_optional_str(existing_prompt_entry.get("text"))
    else:
        next_prompt_entry["text"] = prompt_id
    next_prompt_entry["total_records"] = next_prompt_total
    next_prompt_entry["unique_speakers"] = next_prompt_unique
    prompts_map[prompt_id] = next_prompt_entry

    transaction.set(
        user_ref,
        {
            "contribution_count": next_contribution_count,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    transaction.set(
        prompt_stats_ref,
        {
            "total_records": next_prompt_total,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    if not has_other_prompt_record:
        transaction.set(
            prompt_stats_ref,
            {
                "unique_speakers": next_prompt_unique,
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        transaction.delete(prompt_speaker_ref)

    transaction.set(
        script_stats_ref,
        {
            "total_records": next_script_total,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    if not has_other_script_record:
        transaction.set(
            script_stats_ref,
            {
                "unique_speakers": next_script_unique,
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        transaction.delete(script_speaker_ref)

    transaction.set(
        scripts_overview_snapshot_ref,
        {
            "scripts_map": scripts_map,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    transaction.set(
        prompts_by_script_snapshot_ref,
        {
            "script_id": script_id,
            "prompts_map": prompts_map,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    transaction.delete(user_record_ref)
    transaction.delete(record_ref)


def has_other_user_record(
    user_records_collection: admin_firestore.CollectionReference,
    *,
    field_name: str,
    field_value: str,
    current_record_id: str,
) -> bool:
    snapshots = (
        user_records_collection.where(field_name, "==", field_value)
        .limit(2)
        .stream()
    )
    for snapshot in snapshots:
        if snapshot.id != current_record_id:
            return True
    return False


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
            avatar_exists=False,
            avatar_path=None,
            avatar_updated_at=None,
        )

    data = snapshot.to_dict() or {}
    display_name = data.get("display_name")
    if not isinstance(display_name, str):
        display_name = ""
    avatar_path = as_optional_str(data.get("avatar_path"))
    avatar_updated_at = format_timestamp(data.get("avatar_updated_at"))

    return ProfileGetResponse(
        ok=True,
        uid=uid,
        display_name=display_name,
        profile_exists=True,
        avatar_exists=bool(avatar_path),
        avatar_path=avatar_path,
        avatar_updated_at=avatar_updated_at,
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


@app.post("/v1/profile/avatar-upload-url", response_model=AvatarUploadUrlResponse)
def post_avatar_upload_url(
    decoded_token: dict = Depends(verify_id_token),
) -> AvatarUploadUrlResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    avatar_id = str(uuid4())
    avatar_path = build_avatar_object_path(uid=uid, avatar_id=avatar_id)

    try:
        upload_url = generate_upload_signed_url(
            bucket_name=STORAGE_BUCKET,
            object_path=avatar_path,
            content_type=ALLOWED_AVATAR_CONTENT_TYPE,
            expires_sec=AVATAR_UPLOAD_URL_EXPIRES_SEC,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to generate avatar upload URL: uid=%s bucket=%s avatar_path=%s error_type=%s error=%s",
            uid,
            STORAGE_BUCKET,
            avatar_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate avatar upload URL",
        ) from exc

    return AvatarUploadUrlResponse(
        ok=True,
        avatar_id=avatar_id,
        avatar_path=avatar_path,
        upload_url=upload_url,
        method="PUT",
        required_headers={"Content-Type": ALLOWED_AVATAR_CONTENT_TYPE},
        expires_in_sec=AVATAR_UPLOAD_URL_EXPIRES_SEC,
    )


@app.post("/v1/profile/avatar", response_model=AvatarSaveResponse)
def post_profile_avatar(
    payload: AvatarSaveRequest,
    decoded_token: dict = Depends(verify_id_token),
) -> AvatarSaveResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    avatar_path = normalize_avatar_path(payload.avatar_path, uid=uid)
    mime_type = payload.mime_type.strip().lower()

    if mime_type != ALLOWED_AVATAR_CONTENT_TYPE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"mime_type must be {ALLOWED_AVATAR_CONTENT_TYPE}",
        )
    if payload.size_bytes <= 0 or payload.size_bytes > MAX_AVATAR_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"size_bytes must be between 1 and {MAX_AVATAR_SIZE_BYTES}",
        )
    if payload.width != AVATAR_EXPORT_SIZE or payload.height != AVATAR_EXPORT_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"width and height must be {AVATAR_EXPORT_SIZE}",
        )

    if not object_exists(STORAGE_BUCKET, avatar_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="avatar object not found",
        )

    user_ref = get_user_doc_ref(uid)
    timestamp_now = datetime.now(timezone.utc)
    old_avatar_path = ""
    try:
        snapshot = user_ref.get()
        if snapshot.exists:
            data = snapshot.to_dict() or {}
            old_avatar_path = as_optional_str(data.get("avatar_path")) or ""
            user_ref.set(
                {
                    "avatar_path": avatar_path,
                    "avatar_mime_type": mime_type,
                    "avatar_size_bytes": payload.size_bytes,
                    "avatar_width": payload.width,
                    "avatar_height": payload.height,
                    "avatar_updated_at": admin_firestore.SERVER_TIMESTAMP,
                    "updated_at": admin_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
        else:
            user_ref.set(
                {
                    "role": "collector",
                    "avatar_path": avatar_path,
                    "avatar_mime_type": mime_type,
                    "avatar_size_bytes": payload.size_bytes,
                    "avatar_width": payload.width,
                    "avatar_height": payload.height,
                    "avatar_updated_at": admin_firestore.SERVER_TIMESTAMP,
                    "created_at": admin_firestore.SERVER_TIMESTAMP,
                    "updated_at": admin_firestore.SERVER_TIMESTAMP,
                }
            )

        if old_avatar_path and old_avatar_path != avatar_path:
            delete_object_if_exists(STORAGE_BUCKET, old_avatar_path)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to save avatar profile: uid=%s avatar_path=%s error_type=%s error=%s",
            uid,
            avatar_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save avatar profile",
        ) from exc

    return AvatarSaveResponse(
        ok=True,
        uid=uid,
        avatar_path=avatar_path,
        avatar_updated_at=format_timestamp(timestamp_now) or "",
    )


@app.get("/v1/profile/avatar-url", response_model=AvatarUrlResponse)
def get_profile_avatar_url(
    decoded_token: dict = Depends(verify_id_token),
) -> AvatarUrlResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    try:
        user_snapshot = get_user_doc_ref(uid).get()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load avatar profile",
        ) from exc

    if not user_snapshot.exists:
        return AvatarUrlResponse(
            ok=True,
            uid=uid,
            avatar_exists=False,
            avatar_url=None,
            expires_in_sec=0,
        )

    user_data = user_snapshot.to_dict() or {}
    avatar_path = as_optional_str(user_data.get("avatar_path"))
    if not avatar_path:
        return AvatarUrlResponse(
            ok=True,
            uid=uid,
            avatar_exists=False,
            avatar_url=None,
            expires_in_sec=0,
        )

    if not object_exists(STORAGE_BUCKET, avatar_path):
        return AvatarUrlResponse(
            ok=True,
            uid=uid,
            avatar_exists=False,
            avatar_url=None,
            expires_in_sec=0,
        )

    try:
        avatar_url = generate_download_signed_url(
            bucket_name=STORAGE_BUCKET,
            object_path=avatar_path,
            expires_sec=AVATAR_VIEW_URL_EXPIRES_SEC,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to generate avatar URL: uid=%s avatar_path=%s error_type=%s error=%s",
            uid,
            avatar_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate avatar URL",
        ) from exc

    return AvatarUrlResponse(
        ok=True,
        uid=uid,
        avatar_exists=True,
        avatar_url=avatar_url,
        expires_in_sec=AVATAR_VIEW_URL_EXPIRES_SEC,
    )


@app.delete("/v1/profile/avatar", response_model=AvatarDeleteResponse)
def delete_profile_avatar(
    decoded_token: dict = Depends(verify_id_token),
) -> AvatarDeleteResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    user_ref = get_user_doc_ref(uid)
    try:
        user_snapshot = user_ref.get()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load avatar profile",
        ) from exc

    if not user_snapshot.exists:
        return AvatarDeleteResponse(ok=True, uid=uid, deleted=False)

    user_data = user_snapshot.to_dict() or {}
    avatar_path = as_optional_str(user_data.get("avatar_path"))
    if not avatar_path:
        return AvatarDeleteResponse(ok=True, uid=uid, deleted=False)

    try:
        delete_object_if_exists(STORAGE_BUCKET, avatar_path)
        user_ref.set(
            {
                "avatar_path": admin_firestore.DELETE_FIELD,
                "avatar_mime_type": admin_firestore.DELETE_FIELD,
                "avatar_size_bytes": admin_firestore.DELETE_FIELD,
                "avatar_width": admin_firestore.DELETE_FIELD,
                "avatar_height": admin_firestore.DELETE_FIELD,
                "avatar_updated_at": admin_firestore.DELETE_FIELD,
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
    except Forbidden as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage delete permission denied",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to delete avatar: uid=%s avatar_path=%s error_type=%s error=%s",
            uid,
            avatar_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete avatar",
        ) from exc

    return AvatarDeleteResponse(ok=True, uid=uid, deleted=True)


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
    script_id = normalize_identifier(payload.script_id, "script_id")
    prompt_id = normalize_identifier(payload.prompt_id, "prompt_id")
    raw_path = normalize_register_raw_path(payload.raw_path, uid=uid, record_id=record_id)
    client_meta = payload.client_meta if isinstance(payload.client_meta, dict) else {}
    recording_meta = normalize_recording_meta(
        payload.recording_meta if isinstance(payload.recording_meta, dict) else {}
    )

    try:
        script_snapshot = get_script_doc_ref(script_id).get()
        if not script_snapshot.exists:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="script_id is invalid",
            )
        script_data = script_snapshot.to_dict() or {}
        if not as_bool(script_data.get("is_active"), True):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="script_id is invalid",
            )

        prompt_snapshot = get_prompt_doc_ref(prompt_id).get()
        if not prompt_snapshot.exists:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="prompt_id is invalid",
            )
        prompt_data = prompt_snapshot.to_dict() or {}
        if not as_bool(prompt_data.get("is_active"), True):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="prompt_id is invalid",
            )
        if as_optional_str(prompt_data.get("script_id")) != script_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="prompt does not belong to script",
            )
        prompt_text = as_optional_str(prompt_data.get("text"))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to validate script/prompt",
        ) from exc

    record_ref = get_record_doc_ref(record_id)
    user_ref = get_user_doc_ref(uid)
    user_record_ref = get_user_record_doc_ref(uid, record_id)
    prompt_stats_ref = get_prompt_stats_doc_ref(prompt_id)
    prompt_speaker_ref = get_prompt_speaker_doc_ref(prompt_id, uid)
    script_stats_ref = get_script_stats_doc_ref(script_id)
    script_speaker_ref = get_script_speaker_doc_ref(script_id, uid)
    scripts_overview_snapshot_ref = get_scripts_overview_snapshot_doc_ref()
    prompts_by_script_snapshot_ref = get_prompts_by_script_snapshot_doc_ref(script_id)
    script_snapshot_base = {
        "script_id": script_id,
        "title": as_optional_str(script_data.get("title")) or script_id,
        "description": as_optional_str(script_data.get("description")) or "",
        "order": as_optional_int(script_data.get("order")) or 0,
        "is_active": as_bool(script_data.get("is_active"), True),
        "prompt_count": max(0, as_optional_int(script_data.get("prompt_count")) or 0),
    }
    prompt_snapshot_base = {
        "prompt_id": prompt_id,
        "text": prompt_text or "",
        "order": as_optional_int(prompt_data.get("order")) or 0,
        "is_active": as_bool(prompt_data.get("is_active"), True),
    }

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
                or script_id
            )
            existing_prompt_id = (
                as_optional_str(existing_data.get("prompt_id"))
                or prompt_id
            )
            existing_recording = existing_data.get("recording")
            if not isinstance(existing_recording, dict):
                existing_recording = {}
            existing_prompt_text = as_optional_str(existing_data.get("prompt_text"))
            resolved_prompt_text = existing_prompt_text or prompt_text

            if existing_script_id != script_id or existing_prompt_id != prompt_id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="record_id already registered with different script/prompt",
                )

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
                    "prompt_text": resolved_prompt_text,
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
                prompt_speaker_added=False,
                script_speaker_added=False,
            )

        record_doc = {
            "record_id": record_id,
            "uid": uid,
            "script_id": script_id,
            "prompt_id": prompt_id,
            "prompt_text": prompt_text,
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
            "script_id": script_id,
            "prompt_id": prompt_id,
            "prompt_text": prompt_text,
            "mime_type": as_optional_str(recording_meta.get("mime_type")),
            "size_bytes": as_optional_int(recording_meta.get("size_bytes")),
            "duration_ms": as_optional_int(recording_meta.get("duration_ms")),
            "created_at": admin_firestore.SERVER_TIMESTAMP,
        }
        transaction = get_firestore_client().transaction()
        prompt_speaker_added, script_speaker_added = create_record_and_update_stats(
            transaction,
            record_ref=record_ref,
            user_record_ref=user_record_ref,
            user_ref=user_ref,
            prompt_stats_ref=prompt_stats_ref,
            prompt_speaker_ref=prompt_speaker_ref,
            script_stats_ref=script_stats_ref,
            script_speaker_ref=script_speaker_ref,
            scripts_overview_snapshot_ref=scripts_overview_snapshot_ref,
            prompts_by_script_snapshot_ref=prompts_by_script_snapshot_ref,
            record_doc=record_doc,
            user_record_doc=user_record_doc,
            script_id=script_id,
            prompt_id=prompt_id,
            uid=uid,
            script_snapshot_base=script_snapshot_base,
            prompt_snapshot_base=prompt_snapshot_base,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to register record: uid=%s record_id=%s script_id=%s prompt_id=%s raw_path=%s error_type=%s error=%s",
            uid,
            record_id,
            script_id,
            prompt_id,
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
        prompt_speaker_added=prompt_speaker_added,
        script_speaker_added=script_speaker_added,
    )


@app.get("/v1/my-records", response_model=MyRecordsResponse)
def get_my_records(
    limit: int = Query(
        default=DEFAULT_MY_RECORDS_LIMIT,
        ge=1,
        le=MAX_MY_RECORDS_LIMIT,
    ),
    cursor: str | None = Query(default=None),
    decoded_token: dict = Depends(verify_id_token),
) -> MyRecordsResponse:
    uid = get_uid_from_token(decoded_token)

    try:
        query = (
            get_user_records_collection(uid)
            .order_by("created_at", direction=admin_firestore.Query.DESCENDING)
            .limit(limit + 1)
        )
        if cursor:
            cursor_snapshot = get_user_record_doc_ref(uid, cursor).get()
            if not cursor_snapshot.exists:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="cursor record not found",
                )
            query = query.start_after(cursor_snapshot)
        snapshots = query.stream()
        snapshot_list = list(snapshots)
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load my records",
        ) from exc

    has_next = len(snapshot_list) > limit
    page_snapshots = snapshot_list[:limit]

    records: list[MyRecordItem] = []
    for snapshot in page_snapshots:
        data = snapshot.to_dict() or {}
        prompt_id = as_optional_str(data.get("prompt_id")) or STEP6_DEFAULT_PROMPT_ID
        records.append(
            MyRecordItem(
                record_id=as_optional_str(data.get("record_id")) or snapshot.id,
                status=as_optional_str(data.get("status")) or "uploaded",
                script_id=as_optional_str(data.get("script_id"))
                or STEP6_DEFAULT_SCRIPT_ID,
                prompt_id=prompt_id,
                prompt_text=as_optional_str(data.get("prompt_text")),
                raw_path=as_optional_str(data.get("raw_path")) or "",
                mime_type=as_optional_str(data.get("mime_type")),
                size_bytes=as_optional_int(data.get("size_bytes")),
                duration_ms=as_optional_int(data.get("duration_ms")),
                created_at=format_timestamp(data.get("created_at")),
            )
        )

    next_cursor = None
    if has_next and records:
        next_cursor = records[-1].record_id

    return MyRecordsResponse(
        ok=True,
        records=records,
        has_next=has_next,
        next_cursor=next_cursor,
    )


@app.get("/v1/leaderboard", response_model=LeaderboardResponse)
def get_leaderboard(
    limit: int = Query(
        default=DEFAULT_LEADERBOARD_LIMIT,
        ge=1,
        le=MAX_LEADERBOARD_LIMIT,
    ),
    decoded_token: dict = Depends(verify_id_token),
) -> LeaderboardResponse:
    _ = get_uid_from_token(decoded_token)

    read_limit = min(500, max(100, limit * 10))
    try:
        user_snapshots = (
            get_users_collection()
            .order_by("contribution_count", direction=admin_firestore.Query.DESCENDING)
            .limit(read_limit)
            .stream()
        )
        snapshot_list = list(user_snapshots)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load leaderboard",
        ) from exc

    candidates: list[LeaderboardItem] = []
    for snapshot in snapshot_list:
        user_data = snapshot.to_dict() or {}
        contribution_count = max(
            0,
            as_optional_int(user_data.get("contribution_count")) or 0,
        )
        if contribution_count <= 0:
            continue
        if as_bool(user_data.get("is_hidden"), False):
            continue

        uid = snapshot.id
        display_name = resolve_leaderboard_display_name(user_data, uid)
        avatar_url: str | None = None
        avatar_expires_in_sec = 0
        avatar_path = as_optional_str(user_data.get("avatar_path"))
        if STORAGE_BUCKET and avatar_path:
            try:
                if object_exists(STORAGE_BUCKET, avatar_path):
                    avatar_url = generate_download_signed_url(
                        bucket_name=STORAGE_BUCKET,
                        object_path=avatar_path,
                        expires_sec=AVATAR_VIEW_URL_EXPIRES_SEC,
                    )
                    avatar_expires_in_sec = AVATAR_VIEW_URL_EXPIRES_SEC
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to generate leaderboard avatar URL: uid=%s avatar_path=%s error=%s",
                    uid,
                    avatar_path,
                    str(exc),
                )

        candidates.append(
            LeaderboardItem(
                rank=0,
                uid=uid,
                display_name=display_name,
                contribution_count=contribution_count,
                avatar_url=avatar_url,
                avatar_expires_in_sec=avatar_expires_in_sec,
            )
        )

    candidates.sort(key=leaderboard_sort_key)
    ranked = [
        LeaderboardItem(
            rank=index + 1,
            uid=item.uid,
            display_name=item.display_name,
            contribution_count=item.contribution_count,
            avatar_url=item.avatar_url,
            avatar_expires_in_sec=item.avatar_expires_in_sec,
        )
        for index, item in enumerate(candidates[:limit])
    ]

    return LeaderboardResponse(
        ok=True,
        period="all",
        leaderboard=ranked,
    )


@app.get(
    "/v1/my-records/{record_id}/playback-url",
    response_model=MyRecordPlaybackUrlResponse,
)
def get_my_record_playback_url(
    record_id: str = Path(...),
    decoded_token: dict = Depends(verify_id_token),
) -> MyRecordPlaybackUrlResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    normalized_record_id = normalize_record_id(record_id)

    try:
        record_snapshot = get_record_doc_ref(normalized_record_id).get()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load record",
        ) from exc

    if not record_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="record not found",
        )

    record_data = record_snapshot.to_dict() or {}
    record_uid = as_optional_str(record_data.get("uid"))
    if not record_uid:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="record metadata is invalid",
        )
    if record_uid != uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="record does not belong to authenticated user",
        )

    raw_path = as_optional_str(record_data.get("raw_path"))
    if not raw_path:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="record metadata is invalid",
        )

    if not object_exists(STORAGE_BUCKET, raw_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="raw object not found",
        )

    recording = record_data.get("recording")
    mime_type = as_optional_str(recording.get("mime_type")) if isinstance(recording, dict) else None

    try:
        playback_url = generate_download_signed_url(
            bucket_name=STORAGE_BUCKET,
            object_path=raw_path,
            expires_sec=PLAYBACK_URL_EXPIRES_SEC,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to generate playback URL: uid=%s record_id=%s raw_path=%s error_type=%s error=%s",
            uid,
            normalized_record_id,
            raw_path,
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate playback URL",
        ) from exc

    return MyRecordPlaybackUrlResponse(
        ok=True,
        record_id=normalized_record_id,
        raw_path=raw_path,
        mime_type=mime_type,
        playback_url=playback_url,
        expires_in_sec=PLAYBACK_URL_EXPIRES_SEC,
    )


@app.delete(
    "/v1/my-records/{record_id}",
    response_model=DeleteMyRecordResponse,
)
def delete_my_record(
    record_id: str = Path(...),
    decoded_token: dict = Depends(verify_id_token),
) -> DeleteMyRecordResponse:
    if not STORAGE_BUCKET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage bucket is not configured",
        )

    uid = get_uid_from_token(decoded_token)
    normalized_record_id = normalize_record_id(record_id)
    record_ref = get_record_doc_ref(normalized_record_id)
    user_ref = get_user_doc_ref(uid)
    user_record_ref = get_user_record_doc_ref(uid, normalized_record_id)

    try:
        record_snapshot = record_ref.get()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load record",
        ) from exc

    if not record_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="record not found",
        )

    record_data = record_snapshot.to_dict() or {}
    record_uid = as_optional_str(record_data.get("uid"))
    if not record_uid:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="record metadata is invalid",
        )
    if record_uid != uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="record does not belong to authenticated user",
        )

    prompt_id = as_optional_str(record_data.get("prompt_id"))
    script_id = as_optional_str(record_data.get("script_id"))
    raw_path = as_optional_str(record_data.get("raw_path"))
    wav_path = as_optional_str(record_data.get("wav_path"))
    if not prompt_id or not script_id or not raw_path:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="record metadata is invalid",
        )

    prompt_stats_ref = get_prompt_stats_doc_ref(prompt_id)
    prompt_speaker_ref = get_prompt_speaker_doc_ref(prompt_id, uid)
    script_stats_ref = get_script_stats_doc_ref(script_id)
    script_speaker_ref = get_script_speaker_doc_ref(script_id, uid)
    scripts_overview_snapshot_ref = get_scripts_overview_snapshot_doc_ref()
    prompts_by_script_snapshot_ref = get_prompts_by_script_snapshot_doc_ref(script_id)
    user_records_collection = get_user_records_collection(uid)

    try:
        resolved_prompt_text = as_optional_str(record_data.get("prompt_text"))
        if not resolved_prompt_text:
            try:
                prompt_snapshot = get_prompt_doc_ref(prompt_id).get()
                if prompt_snapshot.exists:
                    prompt_data = prompt_snapshot.to_dict() or {}
                    resolved_prompt_text = as_optional_str(prompt_data.get("text"))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to resolve prompt text during delete: prompt_id=%s error=%s",
                    prompt_id,
                    str(exc),
                )

        has_other_prompt_record = has_other_user_record(
            user_records_collection,
            field_name="prompt_id",
            field_value=prompt_id,
            current_record_id=normalized_record_id,
        )
        has_other_script_record = has_other_user_record(
            user_records_collection,
            field_name="script_id",
            field_value=script_id,
            current_record_id=normalized_record_id,
        )

        delete_object_if_exists(STORAGE_BUCKET, raw_path)
        if wav_path:
            delete_object_if_exists(STORAGE_BUCKET, wav_path)
        transaction = get_firestore_client().transaction()
        delete_record_and_update_stats(
            transaction,
            user_ref=user_ref,
            user_record_ref=user_record_ref,
            record_ref=record_ref,
            prompt_stats_ref=prompt_stats_ref,
            prompt_speaker_ref=prompt_speaker_ref,
            script_stats_ref=script_stats_ref,
            script_speaker_ref=script_speaker_ref,
            scripts_overview_snapshot_ref=scripts_overview_snapshot_ref,
            prompts_by_script_snapshot_ref=prompts_by_script_snapshot_ref,
            script_id=script_id,
            prompt_id=prompt_id,
            prompt_text=resolved_prompt_text,
            has_other_prompt_record=has_other_prompt_record,
            has_other_script_record=has_other_script_record,
        )
    except Forbidden as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Storage delete permission denied",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to delete record: uid=%s record_id=%s raw_path=%s wav_path=%s error_type=%s error=%s",
            uid,
            normalized_record_id,
            raw_path,
            wav_path or "",
            type(exc).__name__,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete record",
        ) from exc

    return DeleteMyRecordResponse(
        ok=True,
        record_id=normalized_record_id,
        deleted=True,
    )
