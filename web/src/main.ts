import type { Auth, User } from 'firebase/auth'
import './style.css'
import { fetchPing } from './api'
import {
  completeRedirectSignIn,
  signInWithGoogle,
  signOutFromApp,
  subscribeAuthState,
} from './auth'
import { initializeFirebaseAuth } from './firebase'
import { fetchProfile, saveProfile } from './profile'
import {
  BrowserRecorder,
  MAX_RECORDING_MS,
  type RecorderError,
  type RecorderErrorCode,
  type RecordingResult,
} from './recorder'
import {
  clearWaveform,
  decodeAudioBlob,
  drawWaveform,
  toWaveformLine,
} from './waveform'
import { requestUploadUrl, uploadRawBlob } from './upload'

const MIN_DISPLAY_NAME_LENGTH = 2
const MAX_DISPLAY_NAME_LENGTH = 20
const MAX_RECORDING_SECONDS = Math.round(MAX_RECORDING_MS / 1000)
const TARGET_DRAW_HZ = 5000
const MIN_DRAW_POINTS = 4000
const MAX_DRAW_POINTS = 30000
const REDIRECT_RECOVERY_SESSION_KEY = 'moracollect.auth.redirect-recovery'

function mustGetElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing required element: ${selector}`)
  }
  return element
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/i.test(ua)
}

function isIosChrome(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /CriOS/i.test(navigator.userAgent)
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

      <section class="recording-block">
        <p class="recording-heading">Step4-5: Recording and upload</p>
        <p id="recording-status" class="recording-status">Recording status: waiting for sign-in</p>
        <p id="recording-timer" class="recording-timer">Time left: ${MAX_RECORDING_SECONDS}s</p>
        <div class="recording-actions">
          <button id="recording-start" type="button">Start recording</button>
          <button id="recording-stop" type="button" class="ghost">Stop</button>
          <button id="recording-reset" type="button" class="ghost">Record again</button>
        </div>
        <p id="waveform-status" class="waveform-status">Waveform: waiting for recording</p>
        <canvas id="waveform-canvas" class="waveform-canvas" width="640" height="112" hidden></canvas>
        <audio id="recording-preview" class="recording-preview" controls hidden></audio>
        <div class="upload-actions">
          <button id="upload-recording" type="button">Upload</button>
        </div>
        <p id="upload-status" class="upload-status">Upload status: waiting for sign-in</p>
        <p id="upload-path" class="upload-path"></p>
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
const recordingStatusEl = mustGetElement<HTMLElement>('#recording-status')
const recordingTimerEl = mustGetElement<HTMLElement>('#recording-timer')
const recordingStartButton =
  mustGetElement<HTMLButtonElement>('#recording-start')
const recordingStopButton =
  mustGetElement<HTMLButtonElement>('#recording-stop')
const recordingResetButton =
  mustGetElement<HTMLButtonElement>('#recording-reset')
const waveformStatusEl = mustGetElement<HTMLElement>('#waveform-status')
const waveformCanvasEl = mustGetElement<HTMLCanvasElement>('#waveform-canvas')
const recordingPreviewEl = mustGetElement<HTMLAudioElement>('#recording-preview')
const uploadRecordingButton =
  mustGetElement<HTMLButtonElement>('#upload-recording')
const uploadStatusEl = mustGetElement<HTMLElement>('#upload-status')
const uploadPathEl = mustGetElement<HTMLElement>('#upload-path')
const apiStatusEl = mustGetElement<HTMLElement>('#api-status')
const apiResultEl = mustGetElement<HTMLElement>('#api-result')

let currentUser: User | null = null
const recorder = new BrowserRecorder()
let recordingObjectUrl: string | null = null
let recordingCountdownTimer: number | null = null
let lastRecordingBlob: Blob | null = null
let lastRecordingMimeType: string | null = null
let uploadInProgress = false

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
    if (code.includes('missing-initial-state')) {
      return 'Sign-in session expired. Please try again.'
    }
    if (code.includes('redirect-cancelled-by-user')) {
      return 'Sign-in was cancelled before completion.'
    }
    return `Authentication failed: ${code}`
  }

  return 'Authentication failed due to an unexpected error.'
}

function isMissingInitialStateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = String((error as { code?: unknown }).code || '')
  return code.includes('missing-initial-state')
}

function recoverRedirectSessionIfNeeded(error: unknown): boolean {
  if (!isMissingInitialStateError(error)) {
    return false
  }

  try {
    const hasRetried =
      window.sessionStorage.getItem(REDIRECT_RECOVERY_SESSION_KEY) === '1'
    if (hasRetried) {
      window.sessionStorage.removeItem(REDIRECT_RECOVERY_SESSION_KEY)
      return false
    }

    window.sessionStorage.setItem(REDIRECT_RECOVERY_SESSION_KEY, '1')
  } catch {
    return false
  }

  statusEl.textContent = 'Recovering sign-in session...'
  window.location.reload()
  return true
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
    throw new Error(
      `Display name must be at least ${MIN_DISPLAY_NAME_LENGTH} characters.`,
    )
  }
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(
      `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    )
  }
  return normalized
}

function setProfileControlsDisabled(disabled: boolean): void {
  displayNameInput.disabled = disabled
  saveProfileButton.disabled = disabled
}

function getUploadTargetFromMimeType(
  mimeType: string,
): { ext: 'webm' | 'mp4'; contentType: 'audio/webm' | 'audio/mp4' } {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('webm')) {
    return { ext: 'webm', contentType: 'audio/webm' }
  }
  if (normalized.includes('mp4')) {
    return { ext: 'mp4', contentType: 'audio/mp4' }
  }
  throw new Error(`Unsupported recording format: ${mimeType}`)
}

function updateUploadButtonState(): void {
  uploadRecordingButton.disabled =
    !currentUser ||
    !lastRecordingBlob ||
    !lastRecordingMimeType ||
    recorder.getState() === 'recording' ||
    uploadInProgress
}

function resetUploadState(statusText: string): void {
  uploadInProgress = false
  uploadStatusEl.textContent = statusText
  uploadPathEl.textContent = ''
  updateUploadButtonState()
}

function clearRecordedUploadSource(statusText: string): void {
  lastRecordingBlob = null
  lastRecordingMimeType = null
  resetUploadState(statusText)
}

function stopRecordingCountdown(): void {
  if (recordingCountdownTimer !== null) {
    window.clearInterval(recordingCountdownTimer)
    recordingCountdownTimer = null
  }
}

function updateRecordingTimer(): void {
  const state = recorder.getState()
  if (state === 'recording') {
    const leftSec = Math.max(0, Math.ceil(recorder.getRemainingMs() / 1000))
    recordingTimerEl.textContent = `Time left: ${leftSec}s`
    return
  }
  if (state === 'recorded') {
    recordingTimerEl.textContent = 'Time left: 0s'
    return
  }
  recordingTimerEl.textContent = `Time left: ${MAX_RECORDING_SECONDS}s`
}

function startRecordingCountdown(): void {
  stopRecordingCountdown()
  updateRecordingTimer()
  recordingCountdownTimer = window.setInterval(() => {
    updateRecordingTimer()
  }, 100)
}

function releaseRecordingObjectUrl(): void {
  if (recordingObjectUrl) {
    URL.revokeObjectURL(recordingObjectUrl)
    recordingObjectUrl = null
  }
  recordingPreviewEl.pause()
  recordingPreviewEl.removeAttribute('src')
  recordingPreviewEl.load()
  recordingPreviewEl.hidden = true
}

function clearWaveformView(statusText: string): void {
  clearWaveform(waveformCanvasEl)
  waveformCanvasEl.hidden = true
  waveformStatusEl.textContent = statusText
}

async function renderWaveformFromBlob(blob: Blob): Promise<void> {
  const decoded = await decodeAudioBlob(blob)
  const pointsRaw = Math.round(decoded.durationSec * TARGET_DRAW_HZ)
  const pointsByDuration = clamp(pointsRaw, MIN_DRAW_POINTS, MAX_DRAW_POINTS)
  const points = Math.min(pointsByDuration, decoded.samples.length)
  const line = toWaveformLine(decoded.samples, points)
  drawWaveform(waveformCanvasEl, line, decoded.durationSec, 1)
  waveformCanvasEl.hidden = false
  waveformStatusEl.textContent = 'Waveform: raw waveform with 1s time axis'
}

function setRecordingButtonsState(): void {
  if (!currentUser) {
    recordingStartButton.disabled = true
    recordingStopButton.disabled = true
    recordingResetButton.disabled = true
    updateUploadButtonState()
    return
  }

  const state = recorder.getState()
  recordingStartButton.disabled = state !== 'idle'
  recordingStopButton.disabled = state !== 'recording'
  recordingResetButton.disabled =
    !(state === 'recorded' || state === 'error')
  updateUploadButtonState()
}

function isRecorderError(error: unknown): error is RecorderError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error
  )
}

function getRecorderErrorMessageByCode(code: RecorderErrorCode): string {
  if (code === 'not-supported') {
    return 'This browser does not support audio recording.'
  }
  if (code === 'permission-denied') {
    if (isIosChrome()) {
      return 'Microphone permission was denied in iPhone Chrome. Open iPhone Settings > Chrome > Microphone and enable it, then reload this page.'
    }
    if (isIos()) {
      return 'Microphone permission was denied. Open iPhone browser settings and allow microphone access, then reload this page.'
    }
    return 'Microphone permission was denied. Please allow microphone access and try again.'
  }
  if (code === 'device-not-found') {
    return 'No microphone device was found.'
  }
  if (code === 'too-short') {
    return 'Recording is too short. Please record for at least 1 second.'
  }
  return 'Failed to record audio.'
}

function showRecordedAudio(result: RecordingResult): void {
  releaseRecordingObjectUrl()
  lastRecordingBlob = result.blob
  lastRecordingMimeType = result.mimeType
  recordingObjectUrl = URL.createObjectURL(result.blob)
  recordingPreviewEl.src = recordingObjectUrl
  recordingPreviewEl.hidden = false

  const durationSec = (result.durationMs / 1000).toFixed(1)
  recordingStatusEl.textContent = `Recording status: recorded (${durationSec}s)`
  recordingTimerEl.textContent = 'Time left: 0s'
  resetUploadState('Upload status: ready')
}

function setRecordingIdleState(): void {
  recorder.reset()
  releaseRecordingObjectUrl()
  clearRecordedUploadSource('Upload status: waiting for recording')
  clearWaveformView('Waveform: waiting for recording')
  stopRecordingCountdown()
  recordingStatusEl.textContent = 'Recording status: idle'
  updateRecordingTimer()
  setRecordingButtonsState()
}

async function setRecordingSignedOutState(): Promise<void> {
  stopRecordingCountdown()
  if (recorder.getState() === 'recording') {
    try {
      await recorder.stop()
    } catch {
      // Ignore stop errors while resetting state.
    }
  }

  recorder.reset()
  releaseRecordingObjectUrl()
  clearRecordedUploadSource('Upload status: waiting for sign-in')
  clearWaveformView('Waveform: waiting for sign-in')
  recordingStatusEl.textContent = 'Recording status: waiting for sign-in'
  updateRecordingTimer()
  setRecordingButtonsState()
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

async function handleStartRecording(): Promise<void> {
  if (!currentUser) {
    recordingStatusEl.textContent = 'Recording status: sign in first'
    setRecordingButtonsState()
    return
  }
  if (recorder.getState() !== 'idle') {
    return
  }

  errorEl.textContent = ''
  recordingStatusEl.textContent = 'Recording status: requesting microphone ...'
  setRecordingButtonsState()
  recordingStartButton.disabled = true

  try {
    await recorder.start()
    recordingStatusEl.textContent = 'Recording status: recording'
    setRecordingButtonsState()
    startRecordingCountdown()

    const result = await recorder.waitForStop()
    stopRecordingCountdown()
    showRecordedAudio(result)
    try {
      await renderWaveformFromBlob(result.blob)
    } catch {
      clearWaveformView('Waveform: unavailable')
    }
  } catch (error) {
    stopRecordingCountdown()
    const message = isRecorderError(error)
      ? getRecorderErrorMessageByCode(error.code)
      : 'Failed to record audio.'
    recordingStatusEl.textContent = `Recording status: error (${message})`
    releaseRecordingObjectUrl()
    clearRecordedUploadSource('Upload status: waiting for recording')
    clearWaveformView('Waveform: waiting for recording')
  } finally {
    updateRecordingTimer()
    setRecordingButtonsState()
  }
}

async function handleStopRecording(): Promise<void> {
  if (recorder.getState() !== 'recording') {
    return
  }
  recordingStatusEl.textContent = 'Recording status: stopping ...'
  recordingStopButton.disabled = true
  try {
    await recorder.stop()
  } catch (error) {
    const message = isRecorderError(error)
      ? getRecorderErrorMessageByCode(error.code)
      : 'Failed to stop recording.'
    recordingStatusEl.textContent = `Recording status: error (${message})`
    stopRecordingCountdown()
    setRecordingButtonsState()
  }
}

function handleResetRecording(): void {
  if (!currentUser) {
    return
  }
  if (recorder.getState() === 'recording') {
    return
  }
  setRecordingIdleState()
}

async function handleUploadRecording(): Promise<void> {
  if (!currentUser) {
    uploadStatusEl.textContent = 'Upload status: sign in first'
    updateUploadButtonState()
    return
  }
  if (!lastRecordingBlob || !lastRecordingMimeType) {
    uploadStatusEl.textContent = 'Upload status: record audio first'
    updateUploadButtonState()
    return
  }

  uploadInProgress = true
  uploadStatusEl.textContent = 'Upload status: requesting signed URL ...'
  uploadPathEl.textContent = ''
  updateUploadButtonState()

  try {
    const { ext, contentType } = getUploadTargetFromMimeType(lastRecordingMimeType)
    const idToken = await currentUser.getIdToken()
    const uploadPlan = await requestUploadUrl(idToken, ext, contentType)
    if (uploadPlan.method !== 'PUT') {
      throw new Error(`Unexpected upload method: ${uploadPlan.method}`)
    }

    uploadStatusEl.textContent = 'Upload status: uploading ...'
    await uploadRawBlob(
      uploadPlan.upload_url,
      lastRecordingBlob,
      uploadPlan.required_headers,
    )
    uploadStatusEl.textContent = 'Upload status: uploaded'
    uploadPathEl.textContent = `Saved to: ${uploadPlan.raw_path}`
  } catch (error) {
    uploadStatusEl.textContent = `Upload status: failed (${getApiErrorMessage(error)})`
  } finally {
    uploadInProgress = false
    updateUploadButtonState()
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
  recordingStatusEl.textContent = 'Recording status: disabled (Firebase init failed)'
  recordingTimerEl.textContent = 'Time left: --'
  clearWaveformView('Waveform: disabled')
  recordingStartButton.disabled = true
  recordingStopButton.disabled = true
  recordingResetButton.disabled = true
  uploadRecordingButton.disabled = true
  uploadStatusEl.textContent = 'Upload status: disabled (Firebase init failed)'
  uploadPathEl.textContent = ''
  apiStatusEl.textContent = 'API status: disabled'
  apiResultEl.textContent = 'Firebase init failed. Configure web/.env.local first.'
}

if (auth) {
  void completeRedirectSignIn(auth).catch((error) => {
    if (recoverRedirectSessionIfNeeded(error)) {
      return
    }
    errorEl.textContent = getAuthErrorMessage(error)
    console.error(error)
  })

  subscribeAuthState(auth, (user) => {
    try {
      window.sessionStorage.removeItem(REDIRECT_RECOVERY_SESSION_KEY)
    } catch {
      // Ignore if sessionStorage is unavailable.
    }

    currentUser = user
    renderUser(user)

    if (user) {
      setRecordingIdleState()
      void loadProfile(user)
      void runPing(user)
    } else {
      setProfileControlsDisabled(true)
      displayNameInput.value = ''
      profileStatusEl.textContent = 'Profile status: waiting for sign-in'
      apiStatusEl.textContent = 'API status: waiting for sign-in'
      apiResultEl.textContent = ''
      void setRecordingSignedOutState()
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

  recordingStartButton.addEventListener('click', async () => {
    await handleStartRecording()
  })

  recordingStopButton.addEventListener('click', async () => {
    await handleStopRecording()
  })

  recordingResetButton.addEventListener('click', () => {
    handleResetRecording()
  })

  uploadRecordingButton.addEventListener('click', async () => {
    await handleUploadRecording()
  })
}
