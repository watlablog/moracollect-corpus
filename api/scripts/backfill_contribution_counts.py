#!/usr/bin/env python3
import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from firebase_admin import firestore as admin_firestore

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.auth import initialize_firebase_admin
from app.firestore import get_firestore_client, get_records_collection, get_users_collection


def as_optional_str(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill users/{uid}.contribution_count from records collection."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary only; do not write Firestore.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    initialize_firebase_admin()
    db = get_firestore_client()

    contribution_counts: Counter[str] = Counter()
    for snapshot in get_records_collection().stream():
        data = snapshot.to_dict() or {}
        uid = as_optional_str(data.get("uid"))
        if not uid:
            continue
        contribution_counts[uid] += 1

    existing_user_ids: set[str] = set()
    for snapshot in get_users_collection().stream():
        existing_user_ids.add(snapshot.id)

    all_target_uids = sorted(existing_user_ids | set(contribution_counts.keys()))
    nonzero_user_count = sum(1 for count in contribution_counts.values() if count > 0)

    if args.dry_run:
        print(
            "Dry run summary: "
            f"target_users={len(all_target_uids)}, "
            f"users_with_records={nonzero_user_count}, "
            f"total_records={sum(contribution_counts.values())}, "
            f"project={db.project}"
        )
        return 0

    if not all_target_uids:
        print(f"No users to update. project={db.project}")
        return 0

    batch = db.batch()
    writes_in_batch = 0
    updated_users = 0

    for uid in all_target_uids:
        user_ref = get_users_collection().document(uid)
        batch.set(
            user_ref,
            {
                "contribution_count": int(contribution_counts.get(uid, 0)),
                "updated_at": admin_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        writes_in_batch += 1
        updated_users += 1

        if writes_in_batch >= 400:
            batch.commit()
            batch = db.batch()
            writes_in_batch = 0

    if writes_in_batch > 0:
        batch.commit()

    print(
        "Backfill completed: "
        f"updated_users={updated_users}, "
        f"users_with_records={nonzero_user_count}, "
        f"total_records={sum(contribution_counts.values())}, "
        f"project={db.project}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
