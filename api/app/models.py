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


class ProfilePostRequest(BaseModel):
    display_name: str


class ProfilePostResponse(BaseModel):
    ok: bool
    uid: str
    display_name: str


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
    raw_path: str
    mime_type: str | None = None
    size_bytes: int | None = None
    duration_ms: int | None = None
    created_at: str | None = None


class MyRecordsResponse(BaseModel):
    ok: bool
    records: list[MyRecordItem]
