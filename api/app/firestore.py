from firebase_admin import firestore as admin_firestore

from app.auth import initialize_firebase_admin


def get_firestore_client() -> admin_firestore.Client:
    initialize_firebase_admin()
    return admin_firestore.client()


def get_user_doc_ref(uid: str) -> admin_firestore.DocumentReference:
    return get_firestore_client().collection("users").document(uid)


def get_records_collection() -> admin_firestore.CollectionReference:
    return get_firestore_client().collection("records")


def get_record_doc_ref(record_id: str) -> admin_firestore.DocumentReference:
    return get_records_collection().document(record_id)


def get_user_records_collection(uid: str) -> admin_firestore.CollectionReference:
    return get_user_doc_ref(uid).collection("records")


def get_user_record_doc_ref(
    uid: str,
    record_id: str,
) -> admin_firestore.DocumentReference:
    return get_user_records_collection(uid).document(record_id)


def get_scripts_collection() -> admin_firestore.CollectionReference:
    return get_firestore_client().collection("scripts")


def get_script_doc_ref(script_id: str) -> admin_firestore.DocumentReference:
    return get_scripts_collection().document(script_id)


def get_prompts_collection() -> admin_firestore.CollectionReference:
    return get_firestore_client().collection("prompts")


def get_prompt_doc_ref(prompt_id: str) -> admin_firestore.DocumentReference:
    return get_prompts_collection().document(prompt_id)


def get_prompt_stats_collection() -> admin_firestore.CollectionReference:
    return get_firestore_client().collection("stats_prompts")


def get_prompt_stats_doc_ref(prompt_id: str) -> admin_firestore.DocumentReference:
    return get_prompt_stats_collection().document(prompt_id)


def get_prompt_speakers_collection(
    prompt_id: str,
) -> admin_firestore.CollectionReference:
    return get_prompt_stats_doc_ref(prompt_id).collection("speakers")


def get_prompt_speaker_doc_ref(
    prompt_id: str,
    uid: str,
) -> admin_firestore.DocumentReference:
    return get_prompt_speakers_collection(prompt_id).document(uid)


def get_script_stats_collection() -> admin_firestore.CollectionReference:
    return get_firestore_client().collection("stats_scripts")


def get_script_stats_doc_ref(script_id: str) -> admin_firestore.DocumentReference:
    return get_script_stats_collection().document(script_id)


def get_script_speakers_collection(
    script_id: str,
) -> admin_firestore.CollectionReference:
    return get_script_stats_doc_ref(script_id).collection("speakers")


def get_script_speaker_doc_ref(
    script_id: str,
    uid: str,
) -> admin_firestore.DocumentReference:
    return get_script_speakers_collection(script_id).document(uid)
