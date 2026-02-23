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
import {
  deleteMyRecord,
  fetchMyRecords,
  registerRecord,
  type MyRecordItem,
} from './records'
import {
  fetchPrompts,
  fetchScripts,
  type PromptItem,
  type ScriptItem,
} from './prompts'
import { requestUploadUrl, uploadRawBlob } from './upload'

const MIN_DISPLAY_NAME_LENGTH = 2
const MAX_DISPLAY_NAME_LENGTH = 20
const MAX_RECORDING_SECONDS = Math.round(MAX_RECORDING_MS / 1000)
const TARGET_DRAW_HZ = 5000
const MIN_DRAW_POINTS = 4000
const MAX_DRAW_POINTS = 30000
const REDIRECT_RECOVERY_SESSION_KEY = 'moracollect.auth.redirect-recovery'
const MY_RECORDS_LIMIT = 10
const SCRIPT_NONE_VALUE = ''

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

      <section class="prompt-block">
        <p class="prompt-heading">Step7: Script and prompt selection</p>
        <label for="script-select" class="prompt-label">Script</label>
        <select id="script-select" class="script-select"></select>
        <p id="script-status" class="script-status">Scripts: waiting for sign-in</p>
        <p id="prompt-status" class="prompt-status">Prompts: waiting for sign-in</p>
        <p id="selected-prompt" class="selected-prompt">Selected prompt: none</p>
        <div id="prompt-grid" class="prompt-grid" role="listbox" aria-label="Prompt selection"></div>
      </section>

      <hr class="divider" />

      <section class="recording-block">
        <p class="recording-heading">Step4-7: Recording, upload, register</p>
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
        <p id="register-status" class="register-status">Register status: waiting for upload</p>
        <div class="register-actions">
          <button id="register-retry" type="button" class="ghost">Retry register</button>
        </div>

        <section class="my-records-block">
          <p id="my-records-status" class="my-records-status">My records: waiting for sign-in</p>
          <ul id="my-records-list" class="my-records-list"></ul>
        </section>
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
const scriptSelectEl = mustGetElement<HTMLSelectElement>('#script-select')
const scriptStatusEl = mustGetElement<HTMLElement>('#script-status')
const promptStatusEl = mustGetElement<HTMLElement>('#prompt-status')
const selectedPromptEl = mustGetElement<HTMLElement>('#selected-prompt')
const promptGridEl = mustGetElement<HTMLDivElement>('#prompt-grid')
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
const registerStatusEl = mustGetElement<HTMLElement>('#register-status')
const registerRetryButton =
  mustGetElement<HTMLButtonElement>('#register-retry')
const myRecordsStatusEl = mustGetElement<HTMLElement>('#my-records-status')
const myRecordsListEl = mustGetElement<HTMLUListElement>('#my-records-list')
const apiStatusEl = mustGetElement<HTMLElement>('#api-status')
const apiResultEl = mustGetElement<HTMLElement>('#api-result')

type RegisterDraft = {
  recordId: string
  rawPath: string
  scriptId: string
  promptId: string
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
}

let currentUser: User | null = null
const recorder = new BrowserRecorder()
let recordingObjectUrl: string | null = null
let recordingCountdownTimer: number | null = null
let lastRecordingBlob: Blob | null = null
let lastRecordingMimeType: string | null = null
let lastRecordingDurationMs: number | null = null
let uploadInProgress = false
let uploadCompletedForCurrentRecording = false
let registerInProgress = false
let registerRetryEnabled = false
let pendingRegisterDraft: RegisterDraft | null = null
let myRecordsItems: MyRecordItem[] = []
const deletingRecordIds = new Set<string>()
let availableScripts: ScriptItem[] = []
let availablePrompts: PromptItem[] = []
let selectedScriptId: string | null = null
let selectedPromptId: string | null = null

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

function formatScriptLabel(script: ScriptItem): string {
  return `${script.title} (${script.total_records} rec / ${script.unique_speakers} spk)`
}

function sortPromptsForDisplay(prompts: PromptItem[]): PromptItem[] {
  return [...prompts].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order
    }
    return a.prompt_id.localeCompare(b.prompt_id)
  })
}

function findSelectedPrompt(): PromptItem | null {
  if (!selectedPromptId) {
    return null
  }
  return availablePrompts.find((item) => item.prompt_id === selectedPromptId) ?? null
}

function updateSelectedPromptLabel(): void {
  const selectedPrompt = findSelectedPrompt()
  if (!selectedPrompt) {
    selectedPromptEl.textContent = 'Selected prompt: none'
    return
  }
  selectedPromptEl.textContent = `Selected prompt: ${selectedPrompt.text} (${selectedPrompt.total_records} rec / ${selectedPrompt.unique_speakers} spk)`
}

function renderScriptOptions(): void {
  scriptSelectEl.innerHTML = ''

  if (availableScripts.length === 0) {
    const option = document.createElement('option')
    option.value = SCRIPT_NONE_VALUE
    option.textContent = 'No active scripts'
    scriptSelectEl.append(option)
    scriptSelectEl.value = SCRIPT_NONE_VALUE
    scriptSelectEl.disabled = true
    return
  }

  for (const script of availableScripts) {
    const option = document.createElement('option')
    option.value = script.script_id
    option.textContent = formatScriptLabel(script)
    scriptSelectEl.append(option)
  }

  if (!selectedScriptId) {
    selectedScriptId = availableScripts[0]?.script_id ?? null
  }
  scriptSelectEl.value = selectedScriptId ?? availableScripts[0].script_id
  scriptSelectEl.disabled = !currentUser
}

function renderPromptButtons(): void {
  promptGridEl.innerHTML = ''
  const sortedPrompts = sortPromptsForDisplay(availablePrompts)

  if (sortedPrompts.length === 0) {
    const emptyEl = document.createElement('p')
    emptyEl.className = 'prompt-empty'
    emptyEl.textContent = 'No prompts in this script.'
    promptGridEl.append(emptyEl)
    return
  }

  for (const prompt of sortedPrompts) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'prompt-button'
    if (selectedPromptId === prompt.prompt_id) {
      button.classList.add('selected')
    }
    button.disabled = !currentUser

    const title = document.createElement('span')
    title.className = 'prompt-button-text'
    title.textContent = prompt.text

    const meta = document.createElement('span')
    meta.className = 'prompt-button-meta'
    meta.textContent = `${prompt.total_records} rec / ${prompt.unique_speakers} spk`

    button.append(title, meta)
    button.addEventListener('click', () => {
      if (!currentUser) {
        return
      }
      selectedPromptId = prompt.prompt_id
      updateSelectedPromptLabel()
      renderPromptButtons()
      setRecordingButtonsState()
    })
    promptGridEl.append(button)
  }
}

function updatePromptButtonsDisabled(disabled: boolean): void {
  const buttons = promptGridEl.querySelectorAll<HTMLButtonElement>('button.prompt-button')
  for (const button of buttons) {
    button.disabled = disabled
  }
}

async function loadPromptsForScript(
  user: User,
  scriptId: string,
  preserveSelection: boolean,
): Promise<void> {
  promptStatusEl.textContent = 'Prompts: loading ...'
  promptGridEl.innerHTML = ''
  if (!preserveSelection) {
    selectedPromptId = null
    updateSelectedPromptLabel()
  }
  setRecordingButtonsState()

  try {
    const idToken = await user.getIdToken()
    const response = await fetchPrompts(idToken, scriptId)
    availablePrompts = response.prompts
    if (
      preserveSelection &&
      selectedPromptId &&
      availablePrompts.some((item) => item.prompt_id === selectedPromptId)
    ) {
      // Keep selected prompt.
    } else {
      selectedPromptId = null
    }
    renderPromptButtons()
    updateSelectedPromptLabel()
    promptStatusEl.textContent = `Prompts: loaded (${availablePrompts.length})`
  } catch (error) {
    availablePrompts = []
    selectedPromptId = null
    renderPromptButtons()
    updateSelectedPromptLabel()
    promptStatusEl.textContent = `Prompts: failed (${getApiErrorMessage(error)})`
  } finally {
    setRecordingButtonsState()
  }
}

async function loadScriptsAndPrompts(
  user: User,
  preserveSelection = false,
): Promise<void> {
  scriptStatusEl.textContent = 'Scripts: loading ...'
  promptStatusEl.textContent = 'Prompts: waiting for script'
  const previousScriptId = selectedScriptId
  const previousPromptId = selectedPromptId
  if (!preserveSelection) {
    selectedPromptId = null
    updateSelectedPromptLabel()
  }
  availablePrompts = []
  renderPromptButtons()

  try {
    const idToken = await user.getIdToken()
    const response = await fetchScripts(idToken)
    availableScripts = response.scripts
    if (availableScripts.length === 0) {
      selectedScriptId = null
      renderScriptOptions()
      scriptStatusEl.textContent = 'Scripts: no active scripts'
      promptStatusEl.textContent = 'Prompts: unavailable'
      setRecordingButtonsState()
      return
    }

    if (
      !selectedScriptId ||
      !availableScripts.some((s) => s.script_id === selectedScriptId)
    ) {
      selectedScriptId = availableScripts[0].script_id
    }

    const keepPromptSelection =
      preserveSelection &&
      Boolean(previousScriptId) &&
      Boolean(previousPromptId) &&
      selectedScriptId === previousScriptId
    if (keepPromptSelection) {
      selectedPromptId = previousPromptId
    } else {
      selectedPromptId = null
      updateSelectedPromptLabel()
    }

    renderScriptOptions()
    scriptStatusEl.textContent = `Scripts: loaded (${availableScripts.length})`
    await loadPromptsForScript(user, selectedScriptId, keepPromptSelection)
  } catch (error) {
    availableScripts = []
    selectedScriptId = null
    renderScriptOptions()
    availablePrompts = []
    selectedPromptId = null
    renderPromptButtons()
    updateSelectedPromptLabel()
    scriptStatusEl.textContent = `Scripts: failed (${getApiErrorMessage(error)})`
    promptStatusEl.textContent = 'Prompts: unavailable'
    setRecordingButtonsState()
  }
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
  const hasPromptSelection = Boolean(selectedScriptId && selectedPromptId)
  uploadRecordingButton.disabled =
    !currentUser ||
    !hasPromptSelection ||
    !lastRecordingBlob ||
    !lastRecordingMimeType ||
    recorder.getState() === 'recording' ||
    uploadInProgress ||
    uploadCompletedForCurrentRecording
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
  lastRecordingDurationMs = null
  uploadCompletedForCurrentRecording = false
  resetUploadState(statusText)
}

function updateRegisterRetryButtonState(): void {
  registerRetryButton.disabled =
    !currentUser ||
    !pendingRegisterDraft ||
    !registerRetryEnabled ||
    registerInProgress ||
    uploadInProgress
}

function resetRegisterState(statusText: string, canRetry = false): void {
  registerStatusEl.textContent = statusText
  registerRetryEnabled = canRetry
  updateRegisterRetryButtonState()
}

function clearRegisterDraft(statusText: string): void {
  pendingRegisterDraft = null
  registerInProgress = false
  resetRegisterState(statusText, false)
}

function formatRecordDate(value: string | null): string {
  if (!value) {
    return '-'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) {
    return value
  }
  return parsed.toLocaleString()
}

function renderMyRecords(items: MyRecordItem[]): void {
  myRecordsListEl.innerHTML = ''
  if (items.length === 0) {
    const li = document.createElement('li')
    li.className = 'my-record-item empty'
    li.textContent = 'No records yet.'
    myRecordsListEl.append(li)
    return
  }

  for (const item of items) {
    const li = document.createElement('li')
    li.className = 'my-record-item'
    const sizeLabel =
      typeof item.size_bytes === 'number'
        ? `${Math.max(0, item.size_bytes)} bytes`
        : 'size: -'
    const durationLabel =
      typeof item.duration_ms === 'number'
        ? `${(item.duration_ms / 1000).toFixed(1)}s`
        : 'duration: -'
    const row = document.createElement('div')
    row.className = 'my-record-row'

    const meta = document.createElement('span')
    meta.className = 'my-record-meta'
    meta.textContent = `${item.record_id} | ${item.status} | ${durationLabel} | ${sizeLabel} | ${formatRecordDate(item.created_at)}`

    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'ghost my-record-delete'
    deleteButton.textContent = deletingRecordIds.has(item.record_id)
      ? 'Deleting...'
      : 'Delete'
    deleteButton.disabled =
      !currentUser ||
      deletingRecordIds.has(item.record_id)
    deleteButton.addEventListener('click', () => {
      void handleDeleteMyRecord(item.record_id)
    })

    row.append(meta, deleteButton)
    li.append(row)
    myRecordsListEl.append(li)
  }
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
    scriptSelectEl.disabled = true
    recordingStartButton.disabled = true
    recordingStopButton.disabled = true
    recordingResetButton.disabled = true
    updatePromptButtonsDisabled(true)
    updateUploadButtonState()
    updateRegisterRetryButtonState()
    return
  }

  scriptSelectEl.disabled = availableScripts.length === 0
  updatePromptButtonsDisabled(false)
  const state = recorder.getState()
  const hasPromptSelection = Boolean(selectedScriptId && selectedPromptId)
  recordingStartButton.disabled = state !== 'idle' || !hasPromptSelection
  recordingStopButton.disabled = state !== 'recording'
  recordingResetButton.disabled =
    !(state === 'recorded' || state === 'error')
  updateUploadButtonState()
  updateRegisterRetryButtonState()
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
  lastRecordingDurationMs = result.durationMs
  uploadCompletedForCurrentRecording = false
  recordingObjectUrl = URL.createObjectURL(result.blob)
  recordingPreviewEl.src = recordingObjectUrl
  recordingPreviewEl.hidden = false

  const durationSec = (result.durationMs / 1000).toFixed(1)
  recordingStatusEl.textContent = `Recording status: recorded (${durationSec}s)`
  recordingTimerEl.textContent = 'Time left: 0s'
  resetUploadState('Upload status: ready')
  clearRegisterDraft('Register status: waiting for upload')
}

function setRecordingIdleState(): void {
  recorder.reset()
  releaseRecordingObjectUrl()
  clearRecordedUploadSource('Upload status: waiting for recording')
  clearRegisterDraft('Register status: waiting for recording')
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
  clearRegisterDraft('Register status: waiting for sign-in')
  clearWaveformView('Waveform: waiting for sign-in')
  recordingStatusEl.textContent = 'Recording status: waiting for sign-in'
  updateRecordingTimer()
  setRecordingButtonsState()
}

function setPromptSignedOutState(): void {
  availableScripts = []
  availablePrompts = []
  selectedScriptId = null
  selectedPromptId = null
  renderScriptOptions()
  renderPromptButtons()
  updateSelectedPromptLabel()
  scriptStatusEl.textContent = 'Scripts: waiting for sign-in'
  promptStatusEl.textContent = 'Prompts: waiting for sign-in'
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

async function loadMyRecords(user: User): Promise<void> {
  myRecordsStatusEl.textContent = 'My records: loading ...'
  try {
    const idToken = await user.getIdToken()
    const response = await fetchMyRecords(idToken, MY_RECORDS_LIMIT)
    myRecordsItems = response.records
    renderMyRecords(myRecordsItems)
    myRecordsStatusEl.textContent = `My records: loaded (${myRecordsItems.length})`
  } catch (error) {
    myRecordsItems = []
    renderMyRecords(myRecordsItems)
    myRecordsStatusEl.textContent = `My records: failed (${getApiErrorMessage(error)})`
  }
}

async function handleDeleteMyRecord(recordId: string): Promise<void> {
  if (!currentUser) {
    myRecordsStatusEl.textContent = 'My records: sign in first'
    return
  }
  if (deletingRecordIds.has(recordId)) {
    return
  }

  const shouldDelete = window.confirm(
    'Delete this record permanently from Firestore and Storage?',
  )
  if (!shouldDelete) {
    return
  }

  deletingRecordIds.add(recordId)
  renderMyRecords(myRecordsItems)
  myRecordsStatusEl.textContent = 'My records: deleting ...'

  try {
    const idToken = await currentUser.getIdToken()
    await deleteMyRecord(idToken, recordId)
    if (pendingRegisterDraft?.recordId === recordId) {
      clearRegisterDraft('Register status: waiting for upload')
    }
    await loadMyRecords(currentUser)
    await loadScriptsAndPrompts(currentUser, true)
  } catch (error) {
    myRecordsStatusEl.textContent = `My records: delete failed (${getApiErrorMessage(error)})`
  } finally {
    deletingRecordIds.delete(recordId)
    renderMyRecords(myRecordsItems)
  }
}

function buildClientMeta(): Record<string, unknown> {
  return {
    user_agent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    platform: typeof navigator === 'undefined' ? '' : navigator.platform,
    language: typeof navigator === 'undefined' ? '' : navigator.language,
  }
}

async function runRegisterForDraft(user: User, draft: RegisterDraft): Promise<void> {
  registerInProgress = true
  resetRegisterState('Register status: registering ...')

  try {
    const idToken = await user.getIdToken()
    const response = await registerRecord(idToken, {
      record_id: draft.recordId,
      raw_path: draft.rawPath,
      script_id: draft.scriptId,
      prompt_id: draft.promptId,
      client_meta: buildClientMeta(),
      recording_meta: {
        ...(draft.mimeType ? { mime_type: draft.mimeType } : {}),
        ...(typeof draft.sizeBytes === 'number'
          ? { size_bytes: draft.sizeBytes }
          : {}),
        ...(typeof draft.durationMs === 'number'
          ? { duration_ms: draft.durationMs }
          : {}),
      },
    })
    registerRetryEnabled = false
    registerStatusEl.textContent = response.already_registered
      ? 'Register status: already registered'
      : 'Register status: registered'
    updateRegisterRetryButtonState()
    void loadMyRecords(user)
    void loadScriptsAndPrompts(user, true)
  } catch (error) {
    registerRetryEnabled = true
    registerStatusEl.textContent = `Register status: failed (${getApiErrorMessage(error)})`
    updateRegisterRetryButtonState()
  } finally {
    registerInProgress = false
    updateRegisterRetryButtonState()
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
  if (!selectedScriptId || !selectedPromptId) {
    recordingStatusEl.textContent = 'Recording status: select a prompt first'
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
    clearRegisterDraft('Register status: waiting for recording')
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
  if (!selectedScriptId || !selectedPromptId) {
    uploadStatusEl.textContent = 'Upload status: select a prompt first'
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
    uploadCompletedForCurrentRecording = true

    pendingRegisterDraft = {
      recordId: uploadPlan.record_id,
      rawPath: uploadPlan.raw_path,
      scriptId: selectedScriptId,
      promptId: selectedPromptId,
      mimeType: lastRecordingMimeType,
      sizeBytes: lastRecordingBlob.size,
      durationMs: lastRecordingDurationMs,
    }
    registerRetryEnabled = false
    updateRegisterRetryButtonState()

    if (!currentUser) {
      resetRegisterState('Register status: sign in first')
      return
    }
    await runRegisterForDraft(currentUser, pendingRegisterDraft)
  } catch (error) {
    uploadStatusEl.textContent = `Upload status: failed (${getApiErrorMessage(error)})`
  } finally {
    uploadInProgress = false
    updateUploadButtonState()
    updateRegisterRetryButtonState()
  }
}

async function handleRetryRegister(): Promise<void> {
  if (!currentUser) {
    resetRegisterState('Register status: sign in first')
    return
  }
  if (!pendingRegisterDraft) {
    resetRegisterState('Register status: waiting for upload')
    return
  }
  await runRegisterForDraft(currentUser, pendingRegisterDraft)
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
  scriptSelectEl.disabled = true
  scriptStatusEl.textContent = 'Scripts: disabled (Firebase init failed)'
  promptStatusEl.textContent = 'Prompts: disabled (Firebase init failed)'
  selectedPromptEl.textContent = 'Selected prompt: none'
  promptGridEl.innerHTML = ''
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
  registerRetryButton.disabled = true
  registerStatusEl.textContent = 'Register status: disabled (Firebase init failed)'
  myRecordsStatusEl.textContent = 'My records: disabled (Firebase init failed)'
  myRecordsListEl.innerHTML = ''
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
      void loadScriptsAndPrompts(user)
      void loadProfile(user)
      void runPing(user)
      void loadMyRecords(user)
    } else {
      deletingRecordIds.clear()
      setProfileControlsDisabled(true)
      displayNameInput.value = ''
      profileStatusEl.textContent = 'Profile status: waiting for sign-in'
      setPromptSignedOutState()
      apiStatusEl.textContent = 'API status: waiting for sign-in'
      apiResultEl.textContent = ''
      resetRegisterState('Register status: waiting for sign-in')
      myRecordsStatusEl.textContent = 'My records: waiting for sign-in'
      myRecordsItems = []
      myRecordsListEl.innerHTML = ''
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

  scriptSelectEl.addEventListener('change', async () => {
    if (!currentUser) {
      return
    }
    const nextScriptId = scriptSelectEl.value
    if (!nextScriptId || nextScriptId === SCRIPT_NONE_VALUE) {
      selectedScriptId = null
      selectedPromptId = null
      availablePrompts = []
      renderPromptButtons()
      updateSelectedPromptLabel()
      setRecordingButtonsState()
      return
    }
    selectedScriptId = nextScriptId
    selectedPromptId = null
    updateSelectedPromptLabel()
    await loadPromptsForScript(currentUser, nextScriptId, false)
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

  registerRetryButton.addEventListener('click', async () => {
    await handleRetryRegister()
  })
}
