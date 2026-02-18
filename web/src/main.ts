import type { Auth, User } from 'firebase/auth'
import './style.css'
import { fetchPing } from './api'
import {
  signInWithGoogle,
  signOutFromApp,
  subscribeAuthState,
} from './auth'
import { initializeFirebaseAuth } from './firebase'

function mustGetElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing required element: ${selector}`)
  }
  return element
}

const app = mustGetElement<HTMLDivElement>('#app')

app.innerHTML = `
  <main class="container">
    <h1>MoraCollect</h1>
    <p class="subtitle">Hello MoraCollect</p>

    <section class="card">
      <p id="status" class="status">Initializing Firebase...</p>
      <p id="user-info" class="user-info"></p>
      <p id="error" class="error" role="alert"></p>
      <div class="actions">
        <button id="sign-in" type="button">Sign in with Google</button>
        <button id="logout" type="button" class="ghost">Logout</button>
      </div>

      <hr class="divider" />
      <p id="api-status" class="api-status">API status: waiting for sign-in</p>
      <pre id="api-result" class="api-result"></pre>
    </section>
  </main>
`

const statusEl = mustGetElement<HTMLElement>('#status')
const userInfoEl = mustGetElement<HTMLElement>('#user-info')
const errorEl = mustGetElement<HTMLElement>('#error')
const signInButton = mustGetElement<HTMLButtonElement>('#sign-in')
const logoutButton = mustGetElement<HTMLButtonElement>('#logout')
const apiStatusEl = mustGetElement<HTMLElement>('#api-status')
const apiResultEl = mustGetElement<HTMLElement>('#api-result')

function renderUser(user: User | null): void {
  if (user) {
    statusEl.textContent = 'Signed in'
    userInfoEl.textContent = user.displayName || user.email || user.uid
    signInButton.hidden = true
    logoutButton.hidden = false
    return
  }

  statusEl.textContent = 'Not signed in'
  userInfoEl.textContent = ''
  signInButton.hidden = false
  logoutButton.hidden = true
}

function getAuthErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as { code?: unknown }).code)
    if (code.includes('popup-blocked')) {
      return 'Popup was blocked by your browser. Please allow popups and try again.'
    }
    if (code.includes('popup-closed-by-user')) {
      return 'Sign-in popup was closed before completion.'
    }
    return `Authentication failed: ${code}`
  }

  return 'Authentication failed due to an unexpected error.'
}

function getApiErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown API error'
}

async function runPing(user: User): Promise<void> {
  apiStatusEl.textContent = 'API status: checking /v1/ping ...'
  apiResultEl.textContent = ''

  try {
    const idToken = await user.getIdToken()
    const response = await fetchPing(idToken)
    apiStatusEl.textContent = 'API status: connected'
    apiResultEl.textContent = JSON.stringify(response, null, 2)
  } catch (error) {
    apiStatusEl.textContent = 'API status: failed'
    apiResultEl.textContent = getApiErrorMessage(error)
  }
}

let auth: Auth | null = null
try {
  auth = initializeFirebaseAuth()
} catch (error) {
  statusEl.textContent = 'Firebase is not configured.'
  errorEl.textContent = (error as Error).message
  console.error(error)
  signInButton.disabled = true
  logoutButton.disabled = true
  apiStatusEl.textContent = 'API status: disabled'
  apiResultEl.textContent = 'Firebase init failed. Configure web/.env.local first.'
}

if (auth) {
  subscribeAuthState(auth, (user) => {
    renderUser(user)
    if (user) {
      void runPing(user)
    } else {
      apiStatusEl.textContent = 'API status: waiting for sign-in'
      apiResultEl.textContent = ''
    }
  })

  signInButton.addEventListener('click', async () => {
    errorEl.textContent = ''
    signInButton.disabled = true

    try {
      await signInWithGoogle(auth)
    } catch (error) {
      errorEl.textContent = getAuthErrorMessage(error)
      console.error(error)
    } finally {
      signInButton.disabled = false
    }
  })

  logoutButton.addEventListener('click', async () => {
    errorEl.textContent = ''
    logoutButton.disabled = true

    try {
      await signOutFromApp(auth)
    } catch (error) {
      errorEl.textContent = getAuthErrorMessage(error)
      console.error(error)
    } finally {
      logoutButton.disabled = false
    }
  })
}
