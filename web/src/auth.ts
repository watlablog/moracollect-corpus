import {
  GoogleAuthProvider,
  type Auth,
  type Unsubscribe,
  type User,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth'

const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

export function subscribeAuthState(
  auth: Auth,
  callback: (user: User | null) => void,
): Unsubscribe {
  return onAuthStateChanged(auth, callback)
}

export async function signInWithGoogle(auth: Auth): Promise<void> {
  await signInWithPopup(auth, googleProvider)
}

export async function signOutFromApp(auth: Auth): Promise<void> {
  await signOut(auth)
}
