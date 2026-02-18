from pydantic import BaseModel


class HealthResponse(BaseModel):
    ok: bool


class PingResponse(BaseModel):
    ok: bool
    uid: str
    email: str | None = None
    project_id: str
