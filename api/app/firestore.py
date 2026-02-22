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
