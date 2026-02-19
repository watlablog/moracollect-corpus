from pydantic import BaseModel


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
