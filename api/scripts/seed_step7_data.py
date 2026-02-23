#!/usr/bin/env python3
import json
import sys
from pathlib import Path
from typing import Any

API_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = API_ROOT.parent
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.auth import initialize_firebase_admin
from app.firestore import get_firestore_client

SCRIPTS_PATH = REPO_ROOT / "infra" / "seeds" / "scripts.json"
PROMPTS_PATH = REPO_ROOT / "infra" / "seeds" / "prompts.json"


def load_json_array(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fp:
        payload = json.load(fp)
    if not isinstance(payload, list):
        raise ValueError(f"Expected list in {path}")
    normalized: list[dict[str, Any]] = []
    for item in payload:
        if isinstance(item, dict):
            normalized.append(item)
    return normalized


def as_str(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be string")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} must not be empty")
    return normalized


def as_text(value: Any, field_name: str, default: str = "") -> str:
    if value is None:
        return default
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be string")
    return value.strip()


def as_int(value: Any, field_name: str, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be number")
    return int(value)


def as_bool(value: Any, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    return default


def main() -> int:
    scripts_seed = load_json_array(SCRIPTS_PATH)
    prompts_seed = load_json_array(PROMPTS_PATH)

    initialize_firebase_admin()
    db = get_firestore_client()

    batch = db.batch()
    known_script_ids: set[str] = set()
    known_prompt_ids: set[str] = set()

    for script in scripts_seed:
        script_id = as_str(script.get("script_id"), "script_id")
        known_script_ids.add(script_id)
        doc = {
            "script_id": script_id,
            "title": as_str(script.get("title"), "title"),
            "description": as_text(script.get("description"), "description"),
            "order": as_int(script.get("order"), "order", default=0),
            "is_active": as_bool(script.get("is_active"), default=True),
        }
        batch.set(db.collection("scripts").document(script_id), doc, merge=True)

    for prompt in prompts_seed:
        prompt_id = as_str(prompt.get("prompt_id"), "prompt_id")
        known_prompt_ids.add(prompt_id)
        script_id = as_str(prompt.get("script_id"), "script_id")
        if script_id not in known_script_ids:
            raise ValueError(
                f"prompt {prompt_id} references unknown script_id {script_id}"
            )
        doc = {
            "prompt_id": prompt_id,
            "script_id": script_id,
            "text": as_str(prompt.get("text"), "text"),
            "type": as_str(prompt.get("type", "mora"), "type"),
            "order": as_int(prompt.get("order"), "order", default=0),
            "is_active": as_bool(prompt.get("is_active"), default=True),
        }
        batch.set(db.collection("prompts").document(prompt_id), doc, merge=True)

    batch.commit()
    deleted_scripts = 0
    deleted_prompts = 0
    for snapshot in db.collection("scripts").stream():
        if snapshot.id not in known_script_ids:
            snapshot.reference.delete()
            deleted_scripts += 1
    for snapshot in db.collection("prompts").stream():
        if snapshot.id not in known_prompt_ids:
            snapshot.reference.delete()
            deleted_prompts += 1

    print(
        "Seed completed: "
        f"scripts={len(scripts_seed)}, prompts={len(prompts_seed)}, "
        f"deleted_scripts={deleted_scripts}, deleted_prompts={deleted_prompts}, "
        f"project={db.project}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
