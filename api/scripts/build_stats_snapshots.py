#!/usr/bin/env python3
import sys
from pathlib import Path
from typing import Any

from firebase_admin import firestore as admin_firestore

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.auth import initialize_firebase_admin
from app.firestore import (
    get_firestore_client,
    get_prompt_stats_collection,
    get_prompts_by_script_snapshots_collection,
    get_prompts_collection,
    get_script_stats_collection,
    get_scripts_collection,
    get_scripts_overview_snapshot_doc_ref,
)


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


def main() -> int:
    initialize_firebase_admin()
    db = get_firestore_client()

    script_stats_by_id: dict[str, dict[str, Any]] = {}
    for snapshot in get_script_stats_collection().stream():
        script_stats_by_id[snapshot.id] = snapshot.to_dict() or {}

    prompt_stats_by_id: dict[str, dict[str, Any]] = {}
    for snapshot in get_prompt_stats_collection().stream():
        prompt_stats_by_id[snapshot.id] = snapshot.to_dict() or {}

    prompts_map_by_script: dict[str, dict[str, dict[str, Any]]] = {}
    prompt_count_by_script: dict[str, int] = {}
    for prompt_snapshot in get_prompts_collection().stream():
        prompt_data = prompt_snapshot.to_dict() or {}
        prompt_id = as_optional_str(prompt_data.get("prompt_id")) or prompt_snapshot.id
        script_id = as_optional_str(prompt_data.get("script_id"))
        if not script_id:
            continue
        stats_data = prompt_stats_by_id.get(prompt_id, {})
        is_active = as_bool(prompt_data.get("is_active"), True)

        prompt_entry = {
            "prompt_id": prompt_id,
            "text": as_optional_str(prompt_data.get("text")) or "",
            "order": as_optional_int(prompt_data.get("order")) or 0,
            "is_active": is_active,
            "total_records": max(
                0,
                as_optional_int(stats_data.get("total_records")) or 0,
            ),
            "unique_speakers": max(
                0,
                as_optional_int(stats_data.get("unique_speakers")) or 0,
            ),
        }
        prompts_map_by_script.setdefault(script_id, {})[prompt_id] = prompt_entry
        if is_active:
            prompt_count_by_script[script_id] = prompt_count_by_script.get(script_id, 0) + 1

    scripts_map: dict[str, dict[str, Any]] = {}
    for script_snapshot in get_scripts_collection().stream():
        script_data = script_snapshot.to_dict() or {}
        script_id = as_optional_str(script_data.get("script_id")) or script_snapshot.id
        stats_data = script_stats_by_id.get(script_id, {})
        scripts_map[script_id] = {
            "script_id": script_id,
            "title": as_optional_str(script_data.get("title")) or script_id,
            "description": as_optional_str(script_data.get("description")) or "",
            "order": as_optional_int(script_data.get("order")) or 0,
            "is_active": as_bool(script_data.get("is_active"), True),
            "prompt_count": prompt_count_by_script.get(script_id, 0),
            "total_records": max(0, as_optional_int(stats_data.get("total_records")) or 0),
            "unique_speakers": max(
                0,
                as_optional_int(stats_data.get("unique_speakers")) or 0,
            ),
        }
        prompts_map_by_script.setdefault(script_id, {})

    get_scripts_overview_snapshot_doc_ref().set(
        {
            "scripts_map": scripts_map,
            "updated_at": admin_firestore.SERVER_TIMESTAMP,
        },
        merge=False,
    )

    prompts_snapshots_collection = get_prompts_by_script_snapshots_collection()
    for script_id, prompts_map in prompts_map_by_script.items():
        prompts_snapshots_collection.document(script_id).set(
            {
                "script_id": script_id,
                "prompts_map": prompts_map,
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=False,
        )

    known_script_ids = set(prompts_map_by_script.keys())
    deleted_snapshot_docs = 0
    for snapshot in prompts_snapshots_collection.stream():
        if snapshot.id not in known_script_ids:
            snapshot.reference.delete()
            deleted_snapshot_docs += 1

    print(
        "Snapshot build completed: "
        f"scripts={len(scripts_map)}, "
        f"prompt_snapshot_docs={len(prompts_map_by_script)}, "
        f"deleted_prompt_snapshot_docs={deleted_snapshot_docs}, "
        f"project={db.project}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
