from datetime import timedelta

from google.auth.credentials import Credentials, with_scopes_if_required
from google.auth.transport.requests import Request
from google.cloud import storage

SIGNING_SCOPES = [
    "https://www.googleapis.com/auth/iam",
    "https://www.googleapis.com/auth/cloud-platform",
]


def ensure_signing_scopes(credentials: Credentials) -> Credentials:
    with_scopes = getattr(credentials, "with_scopes", None)
    if callable(with_scopes):
        return with_scopes(SIGNING_SCOPES)
    return with_scopes_if_required(credentials, SIGNING_SCOPES)


def build_raw_object_path(uid: str, record_id: str, ext: str) -> str:
    normalized_ext = ext.lower().lstrip(".")
    return f"raw/{uid}/{record_id}.{normalized_ext}"


def resolve_signing_identity(client: storage.Client) -> tuple[str, str]:
    credentials = ensure_signing_scopes(client._credentials)
    credentials.refresh(Request())

    service_account_email = getattr(credentials, "service_account_email", "")
    access_token = credentials.token or ""
    if not service_account_email:
        raise RuntimeError("Missing service account email for signed URL generation")
    if not access_token:
        raise RuntimeError("Missing access token for signed URL generation")
    return service_account_email, access_token


def generate_upload_signed_url(
    bucket_name: str,
    object_path: str,
    content_type: str,
    expires_sec: int,
) -> str:
    client = storage.Client()
    blob = client.bucket(bucket_name).blob(object_path)
    service_account_email, access_token = resolve_signing_identity(client)
    return str(
        blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=expires_sec),
            method="PUT",
            content_type=content_type,
            service_account_email=service_account_email,
            access_token=access_token,
        )
    )


def object_exists(bucket_name: str, object_path: str) -> bool:
    client = storage.Client()
    blob = client.bucket(bucket_name).blob(object_path)
    return bool(blob.exists())
