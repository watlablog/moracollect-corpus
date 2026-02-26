#!/usr/bin/env python3
import argparse
import csv
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.api_core.exceptions import NotFound
from google.cloud import storage

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.auth import initialize_firebase_admin
from app.firestore import get_firestore_client, get_records_collection

ALLOWED_STATUSES = {"uploaded", "processed"}
MANIFEST_HEADERS = [
    "record_id",
    "uid",
    "script_id",
    "prompt_id",
    "prompt_text",
    "phoneme_seq",
    "phoneme_slug",
    "raw_path",
    "wav_path_local",
    "status",
    "error",
    "created_at",
]


@dataclass(frozen=True)
class PromptPhonemeMapping:
    prompt_id: str
    prompt_text: str
    phoneme_seq: str
    phoneme_slug: str


def as_optional_str(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        if normalized:
            return normalized
    return None


def to_datetime_utc(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def to_iso8601_utc(value: Any) -> str:
    dt = to_datetime_utc(value)
    if not dt:
        return ""
    return dt.isoformat().replace("+00:00", "Z")


def parse_iso8601(value: str, flag_name: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"{flag_name} is not valid ISO8601: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_slug(value: str, fallback: str) -> str:
    slug = value.strip().lower()
    slug = slug.replace(" ", "_")
    slug = re.sub(r"[^a-z0-9_-]+", "_", slug)
    slug = re.sub(r"_+", "_", slug).strip("_")
    if slug:
        return slug
    return fallback.strip().lower().replace("-", "_")


def load_prompt_phoneme_map(csv_path: Path) -> dict[str, PromptPhonemeMapping]:
    required_columns = {"prompt_id", "prompt_text", "phoneme_seq"}
    with csv_path.open("r", encoding="utf-8", newline="") as fp:
        reader = csv.DictReader(fp)
        fieldnames = set(reader.fieldnames or [])
        missing_columns = required_columns - fieldnames
        if missing_columns:
            missing = ", ".join(sorted(missing_columns))
            raise ValueError(f"mapping CSV is missing required columns: {missing}")

        mapping_by_prompt_id: dict[str, PromptPhonemeMapping] = {}
        for row_index, row in enumerate(reader, start=2):
            prompt_id = as_optional_str(row.get("prompt_id"))
            prompt_text = as_optional_str(row.get("prompt_text"))
            phoneme_seq = as_optional_str(row.get("phoneme_seq"))
            raw_slug = as_optional_str(row.get("phoneme_slug")) or (phoneme_seq or "")

            if not prompt_id:
                raise ValueError(f"row {row_index}: prompt_id is required")
            if not prompt_text:
                raise ValueError(f"row {row_index}: prompt_text is required")
            if not phoneme_seq:
                raise ValueError(f"row {row_index}: phoneme_seq is required")
            if prompt_id in mapping_by_prompt_id:
                raise ValueError(f"row {row_index}: duplicate prompt_id '{prompt_id}'")

            mapping_by_prompt_id[prompt_id] = PromptPhonemeMapping(
                prompt_id=prompt_id,
                prompt_text=prompt_text,
                phoneme_seq=phoneme_seq,
                phoneme_slug=normalize_slug(raw_slug, fallback=prompt_id),
            )
    return mapping_by_prompt_id


def ensure_ffmpeg_exists() -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is not installed or not in PATH")


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export raw audio from Storage and convert to 16kHz mono wav.",
    )
    parser.add_argument("--bucket", required=True, help="Cloud Storage bucket name")
    parser.add_argument(
        "--mapping-csv",
        required=True,
        type=Path,
        help="CSV path for prompt_id -> phoneme mapping",
    )
    parser.add_argument(
        "--project-id",
        default="moracollect-watlab",
        help="Expected Firebase/GCP project id",
    )
    parser.add_argument(
        "--out-dir",
        default="exports",
        type=Path,
        help="Output directory root (default: exports)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max number of records to process (0 means unlimited)",
    )
    parser.add_argument("--uid", help="Filter by uid")
    parser.add_argument("--script-id", help="Filter by script_id")
    parser.add_argument("--prompt-id", help="Filter by prompt_id")
    parser.add_argument("--since", help="Created_at lower bound (ISO8601)")
    parser.add_argument("--until", help="Created_at upper bound (ISO8601)")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing wav files",
    )
    parser.add_argument(
        "--keep-temp-raw",
        action="store_true",
        help="Keep temporary downloaded raw files for debugging",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show targets only without download/convert",
    )
    return parser


def should_process_record(
    data: dict[str, Any],
    *,
    uid: str | None,
    script_id: str | None,
    prompt_id: str | None,
    since: datetime | None,
    until: datetime | None,
) -> bool:
    status = as_optional_str(data.get("status")) or ""
    raw_path = as_optional_str(data.get("raw_path"))
    if status not in ALLOWED_STATUSES or not raw_path:
        return False

    record_uid = as_optional_str(data.get("uid"))
    record_script_id = as_optional_str(data.get("script_id"))
    record_prompt_id = as_optional_str(data.get("prompt_id"))

    if uid and record_uid != uid:
        return False
    if script_id and record_script_id != script_id:
        return False
    if prompt_id and record_prompt_id != prompt_id:
        return False

    created_at = to_datetime_utc(data.get("created_at"))
    if since and created_at and created_at < since:
        return False
    if until and created_at and created_at > until:
        return False
    return True


def convert_raw_to_wav(raw_file: Path, wav_file: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(raw_file),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        str(wav_file),
    ]
    process = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        stderr = process.stderr.strip()
        stdout = process.stdout.strip()
        detail = stderr or stdout or f"ffmpeg exited with code {process.returncode}"
        raise RuntimeError(detail)


def main() -> int:
    parser = build_argument_parser()
    args = parser.parse_args()

    if args.limit < 0:
        parser.error("--limit must be >= 0")

    since = parse_iso8601(args.since, "--since") if args.since else None
    until = parse_iso8601(args.until, "--until") if args.until else None
    if since and until and since > until:
        parser.error("--since must be <= --until")

    mapping_csv_path = args.mapping_csv.resolve()
    if not mapping_csv_path.exists():
        parser.error(f"--mapping-csv not found: {mapping_csv_path}")

    prompt_mapping = load_prompt_phoneme_map(mapping_csv_path)
    initialize_firebase_admin()
    db = get_firestore_client()
    if args.project_id and db.project != args.project_id:
        print(
            f"[warn] Firestore project mismatch: expected={args.project_id} actual={db.project}",
            file=sys.stderr,
        )

    snapshots = get_records_collection().stream()

    targets: list[tuple[str, dict[str, Any]]] = []
    for snapshot in snapshots:
        data = snapshot.to_dict() or {}
        if not should_process_record(
            data,
            uid=args.uid,
            script_id=args.script_id,
            prompt_id=args.prompt_id,
            since=since,
            until=until,
        ):
            continue
        targets.append((snapshot.id, data))
        if args.limit and len(targets) >= args.limit:
            break

    total_targets = len(targets)
    missing_mapping = 0
    for _, data in targets:
        if not as_optional_str(data.get("prompt_id")) or as_optional_str(data.get("prompt_id")) not in prompt_mapping:
            missing_mapping += 1

    if args.dry_run:
        print(
            "Dry run summary: "
            f"total={total_targets}, "
            f"missing_mapping={missing_mapping}, "
            f"project={db.project}"
        )
        return 0

    ensure_ffmpeg_exists()

    out_dir = args.out_dir.resolve()
    wav_root = out_dir / "wav"
    manifest_root = out_dir / "manifests"
    wav_root.mkdir(parents=True, exist_ok=True)
    manifest_root.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%SZ")
    manifest_path = manifest_root / f"export_{timestamp}.csv"
    storage_client = storage.Client(project=args.project_id)
    bucket = storage_client.bucket(args.bucket)
    temp_root = Path(tempfile.mkdtemp(prefix="moracollect_export_raw_"))

    exported_count = 0
    skipped_count = 0
    failed_count = 0

    try:
        with manifest_path.open("w", encoding="utf-8", newline="") as fp:
            writer = csv.DictWriter(fp, fieldnames=MANIFEST_HEADERS)
            writer.writeheader()

            for record_id, data in targets:
                uid = as_optional_str(data.get("uid")) or ""
                uid_for_filename = uid or "unknown_uid"
                script_id = as_optional_str(data.get("script_id")) or ""
                prompt_id = as_optional_str(data.get("prompt_id")) or ""
                raw_path = as_optional_str(data.get("raw_path")) or ""
                created_at = to_iso8601_utc(data.get("created_at"))

                mapping_entry = prompt_mapping.get(prompt_id)
                if not mapping_entry:
                    failed_count += 1
                    writer.writerow(
                        {
                            "record_id": record_id,
                            "uid": uid,
                            "script_id": script_id,
                            "prompt_id": prompt_id,
                            "prompt_text": "",
                            "phoneme_seq": "",
                            "phoneme_slug": "",
                            "raw_path": raw_path,
                            "wav_path_local": "",
                            "status": "failed",
                            "error": f"prompt_id '{prompt_id}' is not in mapping CSV",
                            "created_at": created_at,
                        }
                    )
                    continue

                prompt_text = (
                    as_optional_str(data.get("prompt_text"))
                    or mapping_entry.prompt_text
                )
                phoneme_seq = mapping_entry.phoneme_seq
                phoneme_slug = mapping_entry.phoneme_slug
                wav_dir = wav_root / phoneme_slug
                wav_dir.mkdir(parents=True, exist_ok=True)
                wav_file = wav_dir / f"{phoneme_slug}__{uid_for_filename}__{record_id}.wav"

                if wav_file.exists() and not args.overwrite:
                    skipped_count += 1
                    writer.writerow(
                        {
                            "record_id": record_id,
                            "uid": uid,
                            "script_id": script_id,
                            "prompt_id": prompt_id,
                            "prompt_text": prompt_text,
                            "phoneme_seq": phoneme_seq,
                            "phoneme_slug": phoneme_slug,
                            "raw_path": raw_path,
                            "wav_path_local": str(wav_file),
                            "status": "skipped",
                            "error": "wav already exists (use --overwrite)",
                            "created_at": created_at,
                        }
                    )
                    continue

                temp_suffix = Path(raw_path).suffix or ".raw"
                temp_raw_file = temp_root / f"{record_id}{temp_suffix}"
                try:
                    blob = bucket.blob(raw_path)
                    blob.download_to_filename(str(temp_raw_file))
                    convert_raw_to_wav(temp_raw_file, wav_file)
                    exported_count += 1
                    writer.writerow(
                        {
                            "record_id": record_id,
                            "uid": uid,
                            "script_id": script_id,
                            "prompt_id": prompt_id,
                            "prompt_text": prompt_text,
                            "phoneme_seq": phoneme_seq,
                            "phoneme_slug": phoneme_slug,
                            "raw_path": raw_path,
                            "wav_path_local": str(wav_file),
                            "status": "exported",
                            "error": "",
                            "created_at": created_at,
                        }
                    )
                except NotFound:
                    failed_count += 1
                    writer.writerow(
                        {
                            "record_id": record_id,
                            "uid": uid,
                            "script_id": script_id,
                            "prompt_id": prompt_id,
                            "prompt_text": prompt_text,
                            "phoneme_seq": phoneme_seq,
                            "phoneme_slug": phoneme_slug,
                            "raw_path": raw_path,
                            "wav_path_local": str(wav_file),
                            "status": "failed",
                            "error": "raw object not found",
                            "created_at": created_at,
                        }
                    )
                except Exception as exc:  # noqa: BLE001
                    failed_count += 1
                    writer.writerow(
                        {
                            "record_id": record_id,
                            "uid": uid,
                            "script_id": script_id,
                            "prompt_id": prompt_id,
                            "prompt_text": prompt_text,
                            "phoneme_seq": phoneme_seq,
                            "phoneme_slug": phoneme_slug,
                            "raw_path": raw_path,
                            "wav_path_local": str(wav_file),
                            "status": "failed",
                            "error": str(exc),
                            "created_at": created_at,
                        }
                    )
                finally:
                    if temp_raw_file.exists() and not args.keep_temp_raw:
                        temp_raw_file.unlink()
    finally:
        if args.keep_temp_raw:
            print(f"Temporary raw files kept at: {temp_root}")
        else:
            shutil.rmtree(temp_root, ignore_errors=True)

    print(
        "Export summary: "
        f"total={total_targets}, exported={exported_count}, skipped={skipped_count}, failed={failed_count}"
    )
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
