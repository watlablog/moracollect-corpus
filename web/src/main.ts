import type { Auth, User } from 'firebase/auth'
import './style.css'
import { fetchPing } from './api'
import {
  signInWithGoogle,
  signOutFromApp,
  subscribeAuthState,
} from './auth'
import { initializeFirebaseAuth } from './firebase'
import { fetchProfile, saveProfile } from './profile'

const MIN_DISPLAY_NAME_LENGTH = 2
const MAX_DISPLAY_NAME_LENGTH = 20

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

      <section class="profile-block">
        <label for="display-name" class="profile-label">Display name (2-20 chars)</label>
        <div class="profile-form">
          <input id="display-name" class="profile-input" type="text" maxlength="20" placeholder="e.g. Taro" />
          <button id="save-profile" type="button">Save</button>
        </div>
        <p id="profile-status" class="profile-status">Profile status: waiting for sign-in</p>
      </section>

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
const displayNameInput = mustGetElement<HTMLInputElement>('#display-name')
const saveProfileButton = mustGetElement<HTMLButtonElement>('#save-profile')
const profileStatusEl = mustGetElement<HTMLElement>('#profile-status')
const apiStatusEl = mustGetElement<HTMLElement>('#api-status')
const apiResultEl = mustGetElement<HTMLElement>('#api-result')

let currentUser: User | null = null

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

function validateDisplayName(rawValue: string): string {
  const normalized = rawValue.trim()
  if (normalized.length < MIN_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be at least ${MIN_DISPLAY_NAME_LENGTH} characters.`)
  }
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`)
  }
  return normalized
}

function setProfileControlsDisabled(disabled: boolean): void {
  displayNameInput.disabled = disabled
  saveProfileButton.disabled = disabled
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

async function loadProfile(user: User): Promise<void> {
  profileStatusEl.textContent = 'Profile status: loading ...'
  setProfileControlsDisabled(true)

  try {
    const idToken = await user.getIdToken()
    const profile = await fetchProfile(idToken)
    displayNameInput.value = profile.display_name
    profileStatusEl.textContent = profile.profile_exists
      ? 'Profile status: loaded'
      : 'Profile status: not set yet'
  } catch (error) {
    profileStatusEl.textContent = `Profile status: failed (${getApiErrorMessage(error)})`
  } finally {
    setProfileControlsDisabled(false)
  }
}

async function handleSaveProfile(): Promise<void> {
  if (!currentUser) {
    profileStatusEl.textContent = 'Profile status: sign in first'
    return
  }

  let displayName = ''
  try {
    displayName = validateDisplayName(displayNameInput.value)
  } catch (error) {
    profileStatusEl.textContent = `Profile status: ${(error as Error).message}`
    return
  }

  setProfileControlsDisabled(true)
  profileStatusEl.textContent = 'Profile status: saving ...'

  try {
    const idToken = await currentUser.getIdToken()
    const saved = await saveProfile(idToken, displayName)
    displayNameInput.value = saved.display_name
    profileStatusEl.textContent = 'Profile status: Saved'
  } catch (error) {
    profileStatusEl.textContent = `Profile status: failed (${getApiErrorMessage(error)})`
  } finally {
    setProfileControlsDisabled(false)
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
  setProfileControlsDisabled(true)
  profileStatusEl.textContent = 'Profile status: disabled (Firebase init failed)'
  apiStatusEl.textContent = 'API status: disabled'
  apiResultEl.textContent = 'Firebase init failed. Configure web/.env.local first.'
}

if (auth) {
  subscribeAuthState(auth, (user) => {
    currentUser = user
    renderUser(user)

    if (user) {
      void loadProfile(user)
      void runPing(user)
    } else {
      setProfileControlsDisabled(true)
      displayNameInput.value = ''
      profileStatusEl.textContent = 'Profile status: waiting for sign-in'
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

  saveProfileButton.addEventListener('click', async () => {
    await handleSaveProfile()
  })
}
