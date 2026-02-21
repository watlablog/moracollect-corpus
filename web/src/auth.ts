import {
  GoogleAuthProvider,
  type Auth,
  type Unsubscribe,
  type User,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
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

function canFallbackToRedirect(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = String((error as { code?: unknown }).code || '')
  return (
    code.includes('popup-blocked') ||
    code.includes('operation-not-supported-in-this-environment')
  )
}

export async function completeRedirectSignIn(auth: Auth): Promise<void> {
  await getRedirectResult(auth)
}

export async function signInWithGoogle(auth: Auth): Promise<void> {
  try {
    await signInWithPopup(auth, googleProvider)
    return
  } catch (error) {
    if (!canFallbackToRedirect(error)) {
      throw error
    }

    // Fallback for environments where popup cannot be used.
    await signInWithRedirect(auth, googleProvider)
  }
}

export async function signOutFromApp(auth: Auth): Promise<void> {
  await signOut(auth)
}
