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

function shouldUseRedirectSignIn(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }

  const ua = navigator.userAgent
  const isIPhoneOrIPad = /iPhone|iPad|iPod/i.test(ua)
  const isIPadOSDesktopUa =
    /Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1
  const isAndroid = /Android/i.test(ua)

  return isIPhoneOrIPad || isIPadOSDesktopUa || isAndroid
}

export async function completeRedirectSignIn(auth: Auth): Promise<void> {
  await getRedirectResult(auth)
}

export async function signInWithGoogle(auth: Auth): Promise<void> {
  if (shouldUseRedirectSignIn()) {
    await signInWithRedirect(auth, googleProvider)
    return
  }

  await signInWithPopup(auth, googleProvider)
}

export async function signOutFromApp(auth: Auth): Promise<void> {
  await signOut(auth)
}
