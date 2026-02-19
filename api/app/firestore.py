from firebase_admin import firestore as admin_firestore

from app.auth import initialize_firebase_admin


def get_firestore_client() -> admin_firestore.Client:
    initialize_firebase_admin()
    return admin_firestore.client()


def get_user_doc_ref(uid: str) -> admin_firestore.DocumentReference:
    return get_firestore_client().collection("users").document(uid)
