from typing import Any

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool


class PingResponse(BaseModel):
    ok: bool
    uid: str
    email: str | None = None
    project_id: str


class ProfileGetResponse(BaseModel):
    ok: bool
    uid: str
    display_name: str
    profile_exists: bool
    avatar_exists: bool = False
    avatar_path: str | None = None
    avatar_updated_at: str | None = None


class ProfilePostRequest(BaseModel):
    display_name: str


class ProfilePostResponse(BaseModel):
    ok: bool
    uid: str
    display_name: str


class AvatarUploadUrlResponse(BaseModel):
    ok: bool
    avatar_id: str
    avatar_path: str
    upload_url: str
    method: str
    required_headers: dict[str, str]
    expires_in_sec: int


class AvatarSaveRequest(BaseModel):
    avatar_path: str
    mime_type: str
    size_bytes: int
    width: int
    height: int


class AvatarSaveResponse(BaseModel):
    ok: bool
    uid: str
    avatar_path: str
    avatar_updated_at: str


class AvatarUrlResponse(BaseModel):
    ok: bool
    uid: str
    avatar_exists: bool
    avatar_url: str | None = None
    expires_in_sec: int


class AvatarDeleteResponse(BaseModel):
    ok: bool
    uid: str
    deleted: bool


class UploadUrlRequest(BaseModel):
    ext: str
    content_type: str


class UploadUrlResponse(BaseModel):
    ok: bool
    record_id: str
    raw_path: str
    upload_url: str
    method: str
    required_headers: dict[str, str]
    expires_in_sec: int


class RegisterRequest(BaseModel):
    record_id: str
    raw_path: str
    script_id: str
    prompt_id: str
    client_meta: dict[str, Any] = Field(default_factory=dict)
    recording_meta: dict[str, Any] = Field(default_factory=dict)


class RegisterResponse(BaseModel):
    ok: bool
    record_id: str
    status: str
    already_registered: bool


class MyRecordItem(BaseModel):
    record_id: str
    status: str
    script_id: str
    prompt_id: str
    prompt_text: str | None = None
    raw_path: str
    mime_type: str | None = None
    size_bytes: int | None = None
    duration_ms: int | None = None
    created_at: str | None = None


class MyRecordsResponse(BaseModel):
    ok: bool
    records: list[MyRecordItem]


class DeleteMyRecordResponse(BaseModel):
    ok: bool
    record_id: str
    deleted: bool


class MyRecordPlaybackUrlResponse(BaseModel):
    ok: bool
    record_id: str
    raw_path: str
    mime_type: str | None = None
    playback_url: str
    expires_in_sec: int


class ScriptItem(BaseModel):
    script_id: str
    title: str
    description: str
    order: int
    is_active: bool
    prompt_count: int
    total_records: int
    unique_speakers: int


class ScriptsResponse(BaseModel):
    ok: bool
    scripts: list[ScriptItem]


class PromptItem(BaseModel):
    prompt_id: str
    text: str
    order: int
    is_active: bool
    total_records: int
    unique_speakers: int


class PromptsResponse(BaseModel):
    ok: bool
    script_id: str
    prompts: list[PromptItem]
