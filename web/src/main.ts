import type { Auth, User } from 'firebase/auth'
import './style.css'
import { fetchPing } from './api'
import {
  deleteMyAvatar,
  fetchMyAvatarUrl,
  requestAvatarUploadUrl,
  saveAvatarProfile,
} from './avatar'
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
  clearWaveform as clearWaveformCanvas,
  decodeAudioBlob,
  drawWaveform,
  toWaveformLine,
} from './waveform'
import {
  deleteMyRecord,
  fetchRecordPlaybackBlobWithAutoRetry,
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
const MY_RECORDS_LIMIT = 50
const AVATAR_CROP_CANVAS_SIZE = 320
const AVATAR_EXPORT_SIZE = 512
const AVATAR_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
const AVATAR_MIME_TYPE = 'image/webp'

type AppView = 'auth' | 'menu' | 'prompt' | 'recording' | 'manage' | 'account'

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
    <section id="auth-view" class="view auth-view">
      <h1>MoraCollect</h1>
      <section class="card auth-card">
        <div class="actions auth-actions">
          <button id="sign-in" type="button">Sign in with Google</button>
        </div>
        <p id="status" class="status auth-status">Initializing Firebase...</p>
        <p id="error" class="error auth-error" role="alert"></p>
      </section>
    </section>

    <section id="app-shell" class="app-shell" hidden>
      <header class="top-bar">
        <div class="top-bar-left">
          <h1>MoraCollect</h1>
          <div class="user-header">
            <div id="user-avatar" class="user-avatar">
              <img id="user-avatar-image" class="user-avatar-image" alt="User avatar" hidden />
              <span id="user-avatar-fallback" class="user-avatar-fallback">?</span>
            </div>
            <p id="user-info" class="user-info"></p>
          </div>
        </div>
      </header>
      <p id="shell-error" class="error" role="alert"></p>

      <section id="menu-view" class="view card">
        <h2 class="view-title">メニュー</h2>

        <section class="menu-block">
          <p class="menu-block-heading">ジャンル</p>
          <p id="genre-status" class="genre-status" hidden>ジャンル: 読み込み待ち</p>
          <div id="genre-grid" class="genre-grid" role="listbox" aria-label="ジャンル選択"></div>
        </section>

        <section class="menu-block">
          <p class="menu-block-heading">管理</p>
          <div class="menu-management-actions">
            <button id="open-manage" type="button">保存音声の管理</button>
            <button id="open-account" type="button">アカウント</button>
          </div>
        </section>

        <p id="api-status" class="api-status" hidden>API status: waiting for sign-in</p>
        <pre id="api-result" class="api-result" hidden></pre>
      </section>

      <section id="prompt-view" class="view card" hidden>
        <div class="view-actions">
          <button id="prompt-back" type="button" class="ghost">戻る</button>
        </div>

        <h2 class="view-title">収録する音声</h2>
        <p id="selected-genre" class="selected-genre">選択ジャンル: なし</p>
        <p class="prompt-note">rec: 録音されたファイル数 / spk: 発話者数</p>
        <p id="prompt-status" class="prompt-status">Prompts: waiting for genre</p>
        <p id="selected-prompt" class="selected-prompt">Selected prompt: none</p>
        <div class="prompt-grid-scroll">
          <div id="prompt-grid" class="prompt-grid" role="listbox" aria-label="Prompt selection"></div>
        </div>
        <div class="prompt-bottom-actions">
          <button id="refresh-script-prompts" type="button" class="ghost">Refresh counts</button>
        </div>
      </section>

      <section id="recording-view" class="view card" hidden>
        <div class="view-actions">
          <button id="recording-back" type="button" class="ghost">戻る</button>
        </div>

        <h2 class="view-title">音声録音</h2>
        <p id="recording-selected-prompt" class="recording-selected-prompt">選択音声: なし</p>
        <p id="recording-status" class="recording-status">Recording status: waiting for sign-in</p>
        <p id="recording-timer" class="recording-timer">Time left: ${MAX_RECORDING_SECONDS}s</p>

        <div class="recording-actions">
          <button id="recording-start" type="button">録音開始</button>
          <button id="recording-stop" type="button">停止</button>
        </div>

        <p id="recording-waveform-status" class="waveform-status">Waveform: waiting for recording</p>
        <canvas id="recording-waveform-canvas" class="waveform-canvas" width="640" height="112"></canvas>
        <audio id="recording-preview" class="recording-preview" controls hidden></audio>

        <div class="upload-actions">
          <button id="upload-recording" type="button">アップロード</button>
        </div>
        <p id="upload-status" class="upload-status">Upload status: waiting for sign-in</p>
        <p id="upload-path" class="upload-path"></p>
        <p id="register-status" class="register-status">Register status: waiting for upload</p>
      </section>

      <section id="manage-view" class="view card" hidden>
        <div class="view-actions">
          <button id="manage-back" type="button" class="ghost">戻る</button>
        </div>

        <h2 class="view-title">保存音声の管理</h2>
        <p id="my-records-status" class="my-records-status">My records: waiting for sign-in</p>
        <ul id="my-records-list" class="my-records-list"></ul>

        <div class="manage-preview-block">
          <p id="manage-playback-status" class="manage-playback-status">読み込んだ音声: なし</p>
          <p id="manage-waveform-status" class="waveform-status">Waveform: waiting for load</p>
          <canvas id="manage-waveform-canvas" class="waveform-canvas" width="640" height="112"></canvas>
          <audio id="manage-preview" class="recording-preview" controls hidden></audio>
        </div>
      </section>

      <section id="account-view" class="view card" hidden>
        <div class="view-actions">
          <button id="account-back" type="button" class="ghost">戻る</button>
        </div>

        <h2 class="view-title">アカウント</h2>
        <section class="profile-block">
          <label for="display-name" class="profile-label">表示名 (2-20文字)</label>
          <div class="profile-form">
            <input id="display-name" class="profile-input" type="text" maxlength="20" placeholder="例: たろう" />
            <button id="save-profile" type="button">保存</button>
          </div>
          <p id="profile-status" class="profile-status">Profile status: waiting for sign-in</p>
        </section>

        <section class="avatar-block">
          <p class="avatar-heading">アイコン画像</p>
          <p class="avatar-help">画像を選択後、円の中に収まるようにドラッグ・拡大して調整します。</p>
          <input id="avatar-file-input" type="file" accept="image/*" />
          <div class="avatar-editor">
            <canvas
              id="avatar-crop-canvas"
              class="avatar-crop-canvas"
              width="${AVATAR_CROP_CANVAS_SIZE}"
              height="${AVATAR_CROP_CANVAS_SIZE}"
            ></canvas>
          </div>
          <div class="avatar-zoom-row">
            <label for="avatar-zoom-range">拡大率</label>
            <input id="avatar-zoom-range" type="range" min="100" max="300" step="1" value="100" />
          </div>
          <div class="avatar-actions">
            <button id="save-avatar" type="button">アイコン保存</button>
            <button id="delete-avatar" type="button" class="ghost">アイコン削除</button>
          </div>
          <p id="avatar-status" class="profile-status">Avatar status: waiting for selection</p>
        </section>
      </section>

      <footer class="shell-footer">
        <button id="logout" type="button" class="logout-button">ログオフ</button>
      </footer>
    </section>

    <div id="logout-modal" class="modal-overlay" hidden>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="logout-modal-title">
        <p id="logout-modal-title" class="modal-title">ログオフしますか？</p>
        <div class="modal-actions">
          <button id="logout-confirm" type="button">はい</button>
          <button id="logout-cancel" type="button" class="ghost">いいえ</button>
        </div>
      </div>
    </div>
  </main>
`

const authViewEl = mustGetElement<HTMLElement>('#auth-view')
const appShellEl = mustGetElement<HTMLElement>('#app-shell')
const menuViewEl = mustGetElement<HTMLElement>('#menu-view')
const promptViewEl = mustGetElement<HTMLElement>('#prompt-view')
const recordingViewEl = mustGetElement<HTMLElement>('#recording-view')
const manageViewEl = mustGetElement<HTMLElement>('#manage-view')
const accountViewEl = mustGetElement<HTMLElement>('#account-view')

const statusEl = mustGetElement<HTMLElement>('#status')
const errorEl = mustGetElement<HTMLElement>('#error')
const shellErrorEl = mustGetElement<HTMLElement>('#shell-error')
const userInfoEl = mustGetElement<HTMLElement>('#user-info')
const userAvatarImageEl = mustGetElement<HTMLImageElement>('#user-avatar-image')
const userAvatarFallbackEl = mustGetElement<HTMLElement>('#user-avatar-fallback')
const signInButton = mustGetElement<HTMLButtonElement>('#sign-in')
const logoutButton = mustGetElement<HTMLButtonElement>('#logout')

const displayNameInput = mustGetElement<HTMLInputElement>('#display-name')
const saveProfileButton = mustGetElement<HTMLButtonElement>('#save-profile')
const profileStatusEl = mustGetElement<HTMLElement>('#profile-status')

const genreStatusEl = mustGetElement<HTMLElement>('#genre-status')
const genreGridEl = mustGetElement<HTMLDivElement>('#genre-grid')
const openManageButton = mustGetElement<HTMLButtonElement>('#open-manage')
const openAccountButton = mustGetElement<HTMLButtonElement>('#open-account')

const promptBackButton = mustGetElement<HTMLButtonElement>('#prompt-back')
const refreshScriptPromptsButton =
  mustGetElement<HTMLButtonElement>('#refresh-script-prompts')
const selectedGenreEl = mustGetElement<HTMLElement>('#selected-genre')
const promptStatusEl = mustGetElement<HTMLElement>('#prompt-status')
const selectedPromptEl = mustGetElement<HTMLElement>('#selected-prompt')
const promptGridEl = mustGetElement<HTMLDivElement>('#prompt-grid')

const recordingBackButton = mustGetElement<HTMLButtonElement>('#recording-back')
const recordingSelectedPromptEl = mustGetElement<HTMLElement>('#recording-selected-prompt')
const recordingStatusEl = mustGetElement<HTMLElement>('#recording-status')
const recordingTimerEl = mustGetElement<HTMLElement>('#recording-timer')
const recordingStartButton =
  mustGetElement<HTMLButtonElement>('#recording-start')
const recordingStopButton =
  mustGetElement<HTMLButtonElement>('#recording-stop')
const recordingWaveformStatusEl =
  mustGetElement<HTMLElement>('#recording-waveform-status')
const recordingWaveformCanvasEl =
  mustGetElement<HTMLCanvasElement>('#recording-waveform-canvas')
const recordingPreviewEl = mustGetElement<HTMLAudioElement>('#recording-preview')
const uploadRecordingButton =
  mustGetElement<HTMLButtonElement>('#upload-recording')
const uploadStatusEl = mustGetElement<HTMLElement>('#upload-status')
const uploadPathEl = mustGetElement<HTMLElement>('#upload-path')
const registerStatusEl = mustGetElement<HTMLElement>('#register-status')

const manageBackButton = mustGetElement<HTMLButtonElement>('#manage-back')
const myRecordsStatusEl = mustGetElement<HTMLElement>('#my-records-status')
const myRecordsListEl = mustGetElement<HTMLUListElement>('#my-records-list')
const managePlaybackStatusEl = mustGetElement<HTMLElement>('#manage-playback-status')
const manageWaveformStatusEl = mustGetElement<HTMLElement>('#manage-waveform-status')
const manageWaveformCanvasEl = mustGetElement<HTMLCanvasElement>('#manage-waveform-canvas')
const managePreviewEl = mustGetElement<HTMLAudioElement>('#manage-preview')
const accountBackButton = mustGetElement<HTMLButtonElement>('#account-back')
const avatarFileInputEl = mustGetElement<HTMLInputElement>('#avatar-file-input')
const avatarCropCanvasEl = mustGetElement<HTMLCanvasElement>('#avatar-crop-canvas')
const avatarZoomRangeEl = mustGetElement<HTMLInputElement>('#avatar-zoom-range')
const saveAvatarButton = mustGetElement<HTMLButtonElement>('#save-avatar')
const deleteAvatarButton = mustGetElement<HTMLButtonElement>('#delete-avatar')
const avatarStatusEl = mustGetElement<HTMLElement>('#avatar-status')

const apiStatusEl = mustGetElement<HTMLElement>('#api-status')
const apiResultEl = mustGetElement<HTMLElement>('#api-result')

const logoutModalEl = mustGetElement<HTMLElement>('#logout-modal')
const logoutConfirmButton = mustGetElement<HTMLButtonElement>('#logout-confirm')
const logoutCancelButton = mustGetElement<HTMLButtonElement>('#logout-cancel')

type RegisterDraft = {
  recordId: string
  rawPath: string
  scriptId: string
  promptId: string
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
}

type AvatarEditorState = {
  image: HTMLImageElement
  scale: number
  minScale: number
  offsetX: number
  offsetY: number
}

let currentUser: User | null = null
let currentView: AppView = 'auth'
let authForActions: Auth | null = null

const recorder = new BrowserRecorder()
let recordingPreviewObjectUrl: string | null = null
let managePreviewObjectUrl: string | null = null
let recordingCountdownTimer: number | null = null
let lastRecordingBlob: Blob | null = null
let lastRecordingMimeType: string | null = null
let lastRecordingDurationMs: number | null = null
let loadedRecordId: string | null = null
let uploadInProgress = false
let uploadCompletedForCurrentRecording = false
let pendingRegisterDraft: RegisterDraft | null = null
let myRecordsItems: MyRecordItem[] = []
const deletingRecordIds = new Set<string>()
const loadingRecordIds = new Set<string>()
let availableScripts: ScriptItem[] = []
let availablePrompts: PromptItem[] = []
let selectedScriptId: string | null = null
let selectedPromptId: string | null = null
let logoutInProgress = false
let currentProfileDisplayName = ''
let currentAvatarPath: string | null = null
let currentAvatarUrl: string | null = null
let avatarEditorState: AvatarEditorState | null = null
let avatarDragActive = false
let avatarDragLastX = 0
let avatarDragLastY = 0
let avatarSaveInProgress = false
let avatarDeleteInProgress = false
let avatarUrlRetryInProgress = false

function setView(nextView: AppView): void {
  const previousView = currentView
  if (!currentUser) {
    currentView = 'auth'
  } else {
    currentView = nextView
  }

  const signedIn = Boolean(currentUser)
  authViewEl.hidden = signedIn
  appShellEl.hidden = !signedIn

  menuViewEl.hidden = currentView !== 'menu'
  promptViewEl.hidden = currentView !== 'prompt'
  recordingViewEl.hidden = currentView !== 'recording'
  manageViewEl.hidden = currentView !== 'manage'
  accountViewEl.hidden = currentView !== 'account'

  if (currentUser && previousView !== currentView) {
    clearTransientMediaViewsOnNavigation()
  }

  setRecordingButtonsState()
}

function resolveCurrentUserName(user: User): string {
  return (
    currentProfileDisplayName.trim() ||
    user.displayName ||
    user.email ||
    user.uid
  )
}

function getAvatarFallbackChar(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return '?'
  }
  return Array.from(normalized)[0] ?? '?'
}

function setUserAvatarDisplay(user: User | null, avatarUrl: string | null): void {
  if (!user) {
    userAvatarImageEl.hidden = true
    userAvatarImageEl.removeAttribute('src')
    userAvatarFallbackEl.textContent = '?'
    userAvatarFallbackEl.hidden = false
    return
  }

  if (avatarUrl) {
    userAvatarImageEl.src = avatarUrl
    userAvatarImageEl.hidden = false
    userAvatarFallbackEl.hidden = true
    return
  }

  userAvatarImageEl.hidden = true
  userAvatarImageEl.removeAttribute('src')
  userAvatarFallbackEl.textContent = getAvatarFallbackChar(resolveCurrentUserName(user))
  userAvatarFallbackEl.hidden = false
}

function renderUser(user: User | null): void {
  if (user) {
    statusEl.textContent = 'Signed in'
    userInfoEl.textContent = `User Name: ${resolveCurrentUserName(user)}`
    signInButton.hidden = true
    setUserAvatarDisplay(user, currentAvatarUrl)
    return
  }

  statusEl.textContent = 'Not signed in'
  userInfoEl.textContent = ''
  signInButton.hidden = false
  setUserAvatarDisplay(null, null)
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

function setAvatarControlsDisabled(disabled: boolean): void {
  const blocked = disabled || avatarSaveInProgress || avatarDeleteInProgress
  avatarFileInputEl.disabled = blocked
  avatarZoomRangeEl.disabled = blocked || !avatarEditorState
  saveAvatarButton.disabled = blocked || !avatarEditorState
  deleteAvatarButton.disabled = blocked || !currentAvatarPath
}

function getAvatarCanvasContext(): CanvasRenderingContext2D {
  const ctx = avatarCropCanvasEl.getContext('2d')
  if (!ctx) {
    throw new Error('Avatar crop canvas is unavailable')
  }
  return ctx
}

function clampAvatarOffsets(state: AvatarEditorState): void {
  const drawW = state.image.width * state.scale
  const drawH = state.image.height * state.scale
  const maxX = Math.max(0, (drawW - AVATAR_CROP_CANVAS_SIZE) / 2)
  const maxY = Math.max(0, (drawH - AVATAR_CROP_CANVAS_SIZE) / 2)
  state.offsetX = clamp(state.offsetX, -maxX, maxX)
  state.offsetY = clamp(state.offsetY, -maxY, maxY)
}

function drawAvatarEditorCanvas(): void {
  const ctx = getAvatarCanvasContext()
  const size = AVATAR_CROP_CANVAS_SIZE
  ctx.clearRect(0, 0, size, size)

  if (!avatarEditorState) {
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
    ctx.stroke()
    return
  }

  const state = avatarEditorState
  clampAvatarOffsets(state)

  const drawW = state.image.width * state.scale
  const drawH = state.image.height * state.scale
  const drawX = size / 2 - drawW / 2 + state.offsetX
  const drawY = size / 2 - drawH / 2 + state.offsetY
  ctx.drawImage(state.image, drawX, drawY, drawW, drawH)

  ctx.save()
  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
  ctx.stroke()
}

function resetAvatarEditor(statusText: string): void {
  avatarEditorState = null
  avatarDragActive = false
  avatarDragLastX = 0
  avatarDragLastY = 0
  avatarZoomRangeEl.value = '100'
  avatarStatusEl.textContent = statusText
  drawAvatarEditorCanvas()
  setAvatarControlsDisabled(false)
}

function getAvatarExportBlob(state: AvatarEditorState): Promise<Blob> {
  const exportCanvas = document.createElement('canvas')
  exportCanvas.width = AVATAR_EXPORT_SIZE
  exportCanvas.height = AVATAR_EXPORT_SIZE
  const ctx = exportCanvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to prepare avatar export canvas')
  }

  const scaleRatio = AVATAR_EXPORT_SIZE / AVATAR_CROP_CANVAS_SIZE
  const exportScale = state.scale * scaleRatio
  const drawW = state.image.width * exportScale
  const drawH = state.image.height * exportScale
  const drawX =
    AVATAR_EXPORT_SIZE / 2 - drawW / 2 + state.offsetX * scaleRatio
  const drawY =
    AVATAR_EXPORT_SIZE / 2 - drawH / 2 + state.offsetY * scaleRatio

  ctx.clearRect(0, 0, AVATAR_EXPORT_SIZE, AVATAR_EXPORT_SIZE)
  ctx.save()
  ctx.beginPath()
  ctx.arc(
    AVATAR_EXPORT_SIZE / 2,
    AVATAR_EXPORT_SIZE / 2,
    AVATAR_EXPORT_SIZE / 2,
    0,
    Math.PI * 2,
  )
  ctx.clip()
  ctx.drawImage(state.image, drawX, drawY, drawW, drawH)
  ctx.restore()

  return new Promise<Blob>((resolve, reject) => {
    exportCanvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to render avatar image'))
          return
        }
        resolve(blob)
      },
      AVATAR_MIME_TYPE,
      0.92,
    )
  })
}

async function loadAvatarImageFile(file: File): Promise<void> {
  if (file.size > AVATAR_MAX_FILE_SIZE_BYTES) {
    avatarStatusEl.textContent = `Avatar status: file is too large (max ${Math.floor(
      AVATAR_MAX_FILE_SIZE_BYTES / (1024 * 1024),
    )}MB)`
    return
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Failed to load selected image'))
      image.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }

  const minScale = Math.max(
    AVATAR_CROP_CANVAS_SIZE / image.width,
    AVATAR_CROP_CANVAS_SIZE / image.height,
  )
  avatarEditorState = {
    image,
    scale: minScale,
    minScale,
    offsetX: 0,
    offsetY: 0,
  }
  avatarZoomRangeEl.value = '100'
  avatarStatusEl.textContent = 'Avatar status: image loaded. Drag and zoom to adjust.'
  drawAvatarEditorCanvas()
  setAvatarControlsDisabled(false)
}

function handleAvatarZoomInput(): void {
  if (!avatarEditorState) {
    return
  }
  const zoomPercent = Number(avatarZoomRangeEl.value)
  if (!Number.isFinite(zoomPercent)) {
    return
  }

  avatarEditorState.scale = avatarEditorState.minScale * (zoomPercent / 100)
  clampAvatarOffsets(avatarEditorState)
  drawAvatarEditorCanvas()
}

async function loadSignedAvatarUrl(user: User): Promise<void> {
  try {
    const idToken = await user.getIdToken()
    const avatar = await fetchMyAvatarUrl(idToken)
    if (avatar.avatar_exists && avatar.avatar_url) {
      currentAvatarUrl = avatar.avatar_url
      setUserAvatarDisplay(user, currentAvatarUrl)
      return
    }
    currentAvatarUrl = null
    setUserAvatarDisplay(user, null)
  } catch {
    currentAvatarUrl = null
    setUserAvatarDisplay(user, null)
  }
}

function sortScriptsForDisplay(scripts: ScriptItem[]): ScriptItem[] {
  return [...scripts].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order
    }
    return a.script_id.localeCompare(b.script_id)
  })
}

function sortPromptsForDisplay(prompts: PromptItem[]): PromptItem[] {
  return [...prompts].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order
    }
    return a.prompt_id.localeCompare(b.prompt_id)
  })
}

function findSelectedScript(): ScriptItem | null {
  if (!selectedScriptId) {
    return null
  }
  return availableScripts.find((item) => item.script_id === selectedScriptId) ?? null
}

function findSelectedPrompt(): PromptItem | null {
  if (!selectedPromptId) {
    return null
  }
  return availablePrompts.find((item) => item.prompt_id === selectedPromptId) ?? null
}

function updateSelectedGenreLabel(): void {
  const selectedScript = findSelectedScript()
  if (!selectedScript) {
    selectedGenreEl.textContent = '選択ジャンル: なし'
    return
  }
  selectedGenreEl.textContent = `選択ジャンル: ${selectedScript.title} (${selectedScript.total_records} rec / ${selectedScript.unique_speakers} spk)`
}

function updateSelectedPromptLabel(): void {
  const selectedPrompt = findSelectedPrompt()
  if (!selectedPrompt) {
    selectedPromptEl.textContent = 'Selected prompt: none'
    recordingSelectedPromptEl.textContent = '選択音声: なし'
    return
  }
  selectedPromptEl.textContent = `Selected prompt: ${selectedPrompt.text} (${selectedPrompt.total_records} rec / ${selectedPrompt.unique_speakers} spk)`
  recordingSelectedPromptEl.textContent = `選択音声: ${selectedPrompt.text} (${selectedPrompt.total_records} rec / ${selectedPrompt.unique_speakers} spk)`
}

function renderGenreButtons(): void {
  genreGridEl.innerHTML = ''
  const sorted = sortScriptsForDisplay(availableScripts)

  if (sorted.length === 0) {
    const emptyEl = document.createElement('p')
    emptyEl.className = 'genre-empty'
    emptyEl.textContent = '利用可能なジャンルがありません。'
    genreGridEl.append(emptyEl)
    return
  }

  for (const script of sorted) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'genre-button'
    if (selectedScriptId === script.script_id) {
      button.classList.add('selected')
    }

    const titleEl = document.createElement('span')
    titleEl.className = 'genre-button-title'
    titleEl.textContent = script.title

    const metaEl = document.createElement('span')
    metaEl.className = 'genre-button-meta'
    metaEl.textContent = `${script.total_records} rec / ${script.unique_speakers} spk`

    button.append(titleEl, metaEl)
    button.addEventListener('click', () => {
      void handleSelectGenre(script.script_id)
    })
    genreGridEl.append(button)
  }
}

function renderPromptButtons(): void {
  promptGridEl.innerHTML = ''
  const sortedPrompts = sortPromptsForDisplay(availablePrompts)

  if (sortedPrompts.length === 0) {
    const emptyEl = document.createElement('p')
    emptyEl.className = 'prompt-empty'
    emptyEl.textContent = 'このジャンルには収録音声がありません。'
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
      setView('recording')
      setRecordingButtonsState()
    })
    promptGridEl.append(button)
  }
}

function updateGenreButtonsDisabled(disabled: boolean): void {
  const buttons = genreGridEl.querySelectorAll<HTMLButtonElement>('button.genre-button')
  for (const button of buttons) {
    button.disabled = disabled
  }
}

function updatePromptButtonsDisabled(disabled: boolean): void {
  const buttons = promptGridEl.querySelectorAll<HTMLButtonElement>('button.prompt-button')
  for (const button of buttons) {
    button.disabled = disabled
  }
}

async function loadGenres(user: User, preserveSelection = true): Promise<void> {
  genreStatusEl.textContent = 'ジャンル: 読み込み中 ...'

  try {
    const idToken = await user.getIdToken()
    const response = await fetchScripts(idToken)
    availableScripts = response.scripts

    if (availableScripts.length === 0) {
      selectedScriptId = null
      selectedPromptId = null
      availablePrompts = []
      renderGenreButtons()
      renderPromptButtons()
      updateSelectedGenreLabel()
      updateSelectedPromptLabel()
      genreStatusEl.textContent = 'ジャンル: なし'
      promptStatusEl.textContent = 'Prompts: unavailable'
      setRecordingButtonsState()
      return
    }

    if (
      !preserveSelection ||
      !selectedScriptId ||
      !availableScripts.some((script) => script.script_id === selectedScriptId)
    ) {
      selectedScriptId = availableScripts[0].script_id
      selectedPromptId = null
      availablePrompts = []
    }

    renderGenreButtons()
    updateSelectedGenreLabel()
    updateSelectedPromptLabel()
    genreStatusEl.textContent = `ジャンル: loaded (${availableScripts.length})`
  } catch (error) {
    availableScripts = []
    selectedScriptId = null
    selectedPromptId = null
    availablePrompts = []
    renderGenreButtons()
    renderPromptButtons()
    updateSelectedGenreLabel()
    updateSelectedPromptLabel()
    genreStatusEl.textContent = `ジャンル: failed (${getApiErrorMessage(error)})`
    promptStatusEl.textContent = 'Prompts: unavailable'
  } finally {
    setRecordingButtonsState()
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
    renderMyRecords(myRecordsItems)
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

async function handleSelectGenre(scriptId: string): Promise<void> {
  if (!currentUser) {
    return
  }
  selectedScriptId = scriptId
  selectedPromptId = null
  availablePrompts = []
  renderGenreButtons()
  updateSelectedGenreLabel()
  updateSelectedPromptLabel()
  await loadPromptsForScript(currentUser, scriptId, false)
  setView('prompt')
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

function resetRegisterState(statusText: string): void {
  registerStatusEl.textContent = statusText
}

function clearRegisterDraft(statusText: string): void {
  pendingRegisterDraft = null
  resetRegisterState(statusText)
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

function getPromptLabel(item: MyRecordItem): string {
  if (typeof item.prompt_text === 'string' && item.prompt_text.trim()) {
    return item.prompt_text.trim()
  }
  const matched = availablePrompts.find((prompt) => prompt.prompt_id === item.prompt_id)
  return matched?.text ?? item.prompt_id
}

function applyLocalPromptStatsDelta(
  promptId: string,
  totalDelta: number,
  uniqueDelta: number,
): void {
  availablePrompts = availablePrompts.map((item) => {
    if (item.prompt_id !== promptId) {
      return item
    }
    return {
      ...item,
      total_records: Math.max(0, item.total_records + totalDelta),
      unique_speakers: Math.max(0, item.unique_speakers + uniqueDelta),
    }
  })
}

function applyLocalScriptStatsDelta(
  scriptId: string,
  totalDelta: number,
  uniqueDelta: number,
): void {
  availableScripts = availableScripts.map((item) => {
    if (item.script_id !== scriptId) {
      return item
    }
    return {
      ...item,
      total_records: Math.max(0, item.total_records + totalDelta),
      unique_speakers: Math.max(0, item.unique_speakers + uniqueDelta),
    }
  })
}

function refreshLocalStatsViews(): void {
  renderGenreButtons()
  renderPromptButtons()
  updateSelectedGenreLabel()
  updateSelectedPromptLabel()
}

function renderMyRecords(items: MyRecordItem[]): void {
  myRecordsListEl.innerHTML = ''
  if (items.length === 0) {
    const li = document.createElement('li')
    li.className = 'my-record-item empty'
    li.textContent = 'まだ音声がありません。'
    myRecordsListEl.append(li)
    return
  }

  for (const item of items) {
    const li = document.createElement('li')
    li.className = 'my-record-item'
    const row = document.createElement('div')
    row.className = 'my-record-row'

    const meta = document.createElement('span')
    meta.className = 'my-record-meta'
    meta.textContent = `${getPromptLabel(item)} | ${formatRecordDate(item.created_at)}`

    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'ghost my-record-delete'
    deleteButton.textContent = deletingRecordIds.has(item.record_id)
      ? '削除中...'
      : '削除'
    deleteButton.disabled =
      !currentUser ||
      deletingRecordIds.has(item.record_id)
    deleteButton.addEventListener('click', () => {
      void handleDeleteMyRecord(item.record_id)
    })

    const loadButton = document.createElement('button')
    loadButton.type = 'button'
    loadButton.className = 'ghost my-record-load'
    loadButton.textContent = loadingRecordIds.has(item.record_id)
      ? '読み込み中...'
      : '読み込む'
    loadButton.disabled =
      !currentUser ||
      loadingRecordIds.has(item.record_id) ||
      deletingRecordIds.has(item.record_id) ||
      recorder.getState() === 'recording'
    loadButton.addEventListener('click', () => {
      void handleLoadMyRecord(item)
    })

    const actions = document.createElement('div')
    actions.className = 'my-record-actions'
    actions.append(loadButton, deleteButton)

    row.append(meta, actions)
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

function releaseRecordingPreviewObjectUrl(): void {
  if (recordingPreviewObjectUrl) {
    URL.revokeObjectURL(recordingPreviewObjectUrl)
    recordingPreviewObjectUrl = null
  }
  recordingPreviewEl.pause()
  recordingPreviewEl.removeAttribute('src')
  recordingPreviewEl.load()
  recordingPreviewEl.hidden = true
}

function releaseManagePreviewObjectUrl(): void {
  if (managePreviewObjectUrl) {
    URL.revokeObjectURL(managePreviewObjectUrl)
    managePreviewObjectUrl = null
  }
  managePreviewEl.pause()
  managePreviewEl.removeAttribute('src')
  managePreviewEl.load()
  managePreviewEl.hidden = true
}

function clearRecordingWaveformView(statusText: string): void {
  clearWaveformCanvas(recordingWaveformCanvasEl)
  recordingWaveformCanvasEl.hidden = false
  recordingWaveformStatusEl.textContent = statusText
}

function clearManageWaveformView(statusText: string): void {
  clearWaveformCanvas(manageWaveformCanvasEl)
  manageWaveformCanvasEl.hidden = false
  manageWaveformStatusEl.textContent = statusText
}

async function renderWaveformFromBlob(
  blob: Blob,
  canvas: HTMLCanvasElement,
  statusElToUse: HTMLElement,
  successStatusText: string,
): Promise<void> {
  canvas.hidden = false
  const decoded = await decodeAudioBlob(blob)
  const pointsRaw = Math.round(decoded.durationSec * TARGET_DRAW_HZ)
  const pointsByDuration = clamp(pointsRaw, MIN_DRAW_POINTS, MAX_DRAW_POINTS)
  const points = Math.min(pointsByDuration, decoded.samples.length)
  const line = toWaveformLine(decoded.samples, points)
  drawWaveform(canvas, line, decoded.durationSec, 1)
  statusElToUse.textContent = successStatusText
}

function clearManagePlaybackState(): void {
  loadedRecordId = null
  releaseManagePreviewObjectUrl()
  clearManageWaveformView('Waveform: waiting for load')
  managePlaybackStatusEl.textContent = '読み込んだ音声: なし'
}

function clearTransientMediaViewsOnNavigation(): void {
  if (recorder.getState() !== 'recording') {
    recorder.reset()
    releaseRecordingPreviewObjectUrl()
    clearRecordedUploadSource('Upload status: waiting for recording')
    clearRegisterDraft('Register status: waiting for recording')
    clearRecordingWaveformView('Waveform: waiting for recording')
    recordingStatusEl.textContent = 'Recording status: idle'
    updateRecordingTimer()
  }

  clearManagePlaybackState()
}

function setRecordingButtonsState(): void {
  const state = recorder.getState()

  if (state === 'recording') {
    recordingStartButton.textContent = '録音中'
    recordingStartButton.classList.add('is-recording')
  } else {
    recordingStartButton.textContent = '録音開始'
    recordingStartButton.classList.remove('is-recording')
  }

  if (!currentUser) {
    updateGenreButtonsDisabled(true)
    updatePromptButtonsDisabled(true)
    refreshScriptPromptsButton.disabled = true
    openManageButton.disabled = true
    openAccountButton.disabled = true
    promptBackButton.disabled = true
    recordingBackButton.disabled = true
    manageBackButton.disabled = true
    accountBackButton.disabled = true
    recordingStartButton.disabled = true
    recordingStopButton.disabled = true
    setAvatarControlsDisabled(true)
    updateUploadButtonState()
    renderMyRecords(myRecordsItems)
    return
  }

  updateGenreButtonsDisabled(false)
  updatePromptButtonsDisabled(false)
  refreshScriptPromptsButton.disabled = !selectedScriptId
  openManageButton.disabled = state === 'recording'
  openAccountButton.disabled = state === 'recording'
  promptBackButton.disabled = state === 'recording'
  recordingBackButton.disabled = state === 'recording'
  manageBackButton.disabled = state === 'recording'
  accountBackButton.disabled = state === 'recording'

  const hasPromptSelection = Boolean(selectedScriptId && selectedPromptId)
  recordingStartButton.disabled =
    !hasPromptSelection || state === 'recording' || uploadInProgress
  recordingStopButton.disabled = state !== 'recording'

  setAvatarControlsDisabled(state === 'recording')
  updateUploadButtonState()
  renderMyRecords(myRecordsItems)
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
  releaseRecordingPreviewObjectUrl()
  lastRecordingBlob = result.blob
  lastRecordingMimeType = result.mimeType
  lastRecordingDurationMs = result.durationMs
  uploadCompletedForCurrentRecording = false

  recordingPreviewObjectUrl = URL.createObjectURL(result.blob)
  recordingPreviewEl.src = recordingPreviewObjectUrl
  recordingPreviewEl.hidden = false

  const durationSec = (result.durationMs / 1000).toFixed(1)
  recordingStatusEl.textContent = `Recording status: recorded (${durationSec}s)`
  recordingTimerEl.textContent = 'Time left: 0s'
  resetUploadState('Upload status: ready')
  clearRegisterDraft('Register status: waiting for upload')
}

function setRecordingIdleState(): void {
  if (recorder.getState() === 'recording') {
    return
  }
  recorder.reset()
  releaseRecordingPreviewObjectUrl()
  clearRecordedUploadSource('Upload status: waiting for recording')
  clearRegisterDraft('Register status: waiting for recording')
  clearRecordingWaveformView('Waveform: waiting for recording')
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
  releaseRecordingPreviewObjectUrl()
  clearManagePlaybackState()
  clearRecordedUploadSource('Upload status: waiting for sign-in')
  clearRegisterDraft('Register status: waiting for sign-in')
  clearRecordingWaveformView('Waveform: waiting for sign-in')
  recordingStatusEl.textContent = 'Recording status: waiting for sign-in'
  updateRecordingTimer()
  setRecordingButtonsState()
}

function setPromptSignedOutState(): void {
  availableScripts = []
  availablePrompts = []
  selectedScriptId = null
  selectedPromptId = null
  renderGenreButtons()
  renderPromptButtons()
  updateSelectedGenreLabel()
  updateSelectedPromptLabel()
  genreStatusEl.textContent = 'ジャンル: サインイン待ち'
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

async function handleLoadMyRecord(item: MyRecordItem): Promise<void> {
  if (!currentUser) {
    myRecordsStatusEl.textContent = 'My records: sign in first'
    return
  }
  if (loadingRecordIds.has(item.record_id)) {
    return
  }
  if (recorder.getState() === 'recording') {
    myRecordsStatusEl.textContent = 'My records: stop recording first'
    return
  }

  loadingRecordIds.add(item.record_id)
  renderMyRecords(myRecordsItems)
  myRecordsStatusEl.textContent = 'My records: loading audio ...'

  try {
    const idToken = await currentUser.getIdToken()
    const blob = await fetchRecordPlaybackBlobWithAutoRetry(
      idToken,
      item.record_id,
      () => {
        myRecordsStatusEl.textContent = 'My records: URL expired, retrying ...'
      },
    )

    releaseManagePreviewObjectUrl()
    managePreviewObjectUrl = URL.createObjectURL(blob)
    managePreviewEl.src = managePreviewObjectUrl
    managePreviewEl.hidden = false

    loadedRecordId = item.record_id
    clearRecordedUploadSource('Upload status: disabled (loaded record cannot be uploaded)')
    clearRegisterDraft('Register status: waiting for upload')

    try {
      await renderWaveformFromBlob(
        blob,
        manageWaveformCanvasEl,
        manageWaveformStatusEl,
        'Waveform: loaded from my record',
      )
    } catch {
      clearManageWaveformView('Waveform: unavailable')
    }

    managePlaybackStatusEl.textContent = `読み込んだ音声: ${getPromptLabel(item)} | ${formatRecordDate(item.created_at)}`
    myRecordsStatusEl.textContent = 'My records: loaded audio'
    setView('manage')
    setRecordingButtonsState()
  } catch (error) {
    myRecordsStatusEl.textContent = `My records: load failed (${getApiErrorMessage(error)})`
  } finally {
    loadingRecordIds.delete(item.record_id)
    renderMyRecords(myRecordsItems)
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
    'この音声をFirestoreとStorageから完全に削除します。よろしいですか？',
  )
  if (!shouldDelete) {
    return
  }

  deletingRecordIds.add(recordId)
  renderMyRecords(myRecordsItems)
  myRecordsStatusEl.textContent = 'My records: deleting ...'
  const targetItem = myRecordsItems.find((item) => item.record_id === recordId) ?? null

  try {
    const idToken = await currentUser.getIdToken()
    await deleteMyRecord(idToken, recordId)
    if (targetItem) {
      const hasOtherPromptRecords = myRecordsItems.some(
        (item) =>
          item.record_id !== recordId && item.prompt_id === targetItem.prompt_id,
      )
      const hasOtherScriptRecords = myRecordsItems.some(
        (item) =>
          item.record_id !== recordId && item.script_id === targetItem.script_id,
      )
      applyLocalPromptStatsDelta(
        targetItem.prompt_id,
        -1,
        hasOtherPromptRecords ? 0 : -1,
      )
      applyLocalScriptStatsDelta(
        targetItem.script_id,
        -1,
        hasOtherScriptRecords ? 0 : -1,
      )
      refreshLocalStatsViews()
    }
    if (pendingRegisterDraft?.recordId === recordId) {
      clearRegisterDraft('Register status: waiting for upload')
    }
    if (loadedRecordId === recordId) {
      clearManagePlaybackState()
    }
    await loadMyRecords(currentUser)
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
  resetRegisterState('Register status: registering ...')

  try {
    const hadPromptRecordBefore = myRecordsItems.some(
      (item) => item.prompt_id === draft.promptId,
    )
    const hadScriptRecordBefore = myRecordsItems.some(
      (item) => item.script_id === draft.scriptId,
    )
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

    if (!response.already_registered) {
      applyLocalPromptStatsDelta(
        draft.promptId,
        1,
        hadPromptRecordBefore ? 0 : 1,
      )
      applyLocalScriptStatsDelta(
        draft.scriptId,
        1,
        hadScriptRecordBefore ? 0 : 1,
      )
      refreshLocalStatsViews()
    }

    registerStatusEl.textContent = response.already_registered
      ? 'Register status: already registered'
      : 'Register status: registered'
    void loadMyRecords(user)
  } catch (error) {
    uploadCompletedForCurrentRecording = false
    updateUploadButtonState()
    registerStatusEl.textContent = `Register status: failed (${getApiErrorMessage(error)})`
  } finally {
    updateUploadButtonState()
  }
}

async function loadProfile(user: User): Promise<void> {
  profileStatusEl.textContent = 'Profile status: loading ...'
  setProfileControlsDisabled(true)

  try {
    const idToken = await user.getIdToken()
    const profile = await fetchProfile(idToken)
    displayNameInput.value = profile.display_name
    currentProfileDisplayName = profile.display_name.trim()
    currentAvatarPath = profile.avatar_path
    renderUser(user)

    if (profile.avatar_exists && profile.avatar_path) {
      await loadSignedAvatarUrl(user)
    } else {
      currentAvatarUrl = null
      setUserAvatarDisplay(user, null)
    }

    profileStatusEl.textContent = profile.profile_exists
      ? 'Profile status: loaded'
      : 'Profile status: not set yet'
  } catch (error) {
    currentProfileDisplayName = ''
    currentAvatarPath = null
    currentAvatarUrl = null
    renderUser(user)
    profileStatusEl.textContent = `Profile status: failed (${getApiErrorMessage(error)})`
  } finally {
    setProfileControlsDisabled(false)
    setRecordingButtonsState()
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
    currentProfileDisplayName = saved.display_name.trim()
    renderUser(currentUser)
    profileStatusEl.textContent = 'Profile status: Saved'
  } catch (error) {
    profileStatusEl.textContent = `Profile status: failed (${getApiErrorMessage(error)})`
  } finally {
    setProfileControlsDisabled(false)
  }
}

async function handleSaveAvatar(): Promise<void> {
  if (!currentUser) {
    avatarStatusEl.textContent = 'Avatar status: sign in first'
    return
  }
  if (!avatarEditorState) {
    avatarStatusEl.textContent = 'Avatar status: select an image first'
    return
  }

  avatarSaveInProgress = true
  setAvatarControlsDisabled(true)
  avatarStatusEl.textContent = 'Avatar status: preparing image ...'

  try {
    const blob = await getAvatarExportBlob(avatarEditorState)
    const idToken = await currentUser.getIdToken()
    const uploadPlan = await requestAvatarUploadUrl(idToken)
    if (uploadPlan.method !== 'PUT') {
      throw new Error(`Unexpected upload method: ${uploadPlan.method}`)
    }

    avatarStatusEl.textContent = 'Avatar status: uploading ...'
    await uploadRawBlob(uploadPlan.upload_url, blob, uploadPlan.required_headers)

    avatarStatusEl.textContent = 'Avatar status: saving profile ...'
    const saved = await saveAvatarProfile(idToken, {
      avatar_path: uploadPlan.avatar_path,
      mime_type: 'image/webp',
      size_bytes: blob.size,
      width: AVATAR_EXPORT_SIZE,
      height: AVATAR_EXPORT_SIZE,
    })
    currentAvatarPath = saved.avatar_path
    await loadSignedAvatarUrl(currentUser)
    avatarStatusEl.textContent = 'Avatar status: saved'
  } catch (error) {
    avatarStatusEl.textContent = `Avatar status: failed (${getApiErrorMessage(error)})`
  } finally {
    avatarSaveInProgress = false
    setAvatarControlsDisabled(false)
  }
}

async function handleDeleteAvatar(): Promise<void> {
  if (!currentUser) {
    avatarStatusEl.textContent = 'Avatar status: sign in first'
    return
  }
  if (!currentAvatarPath) {
    avatarStatusEl.textContent = 'Avatar status: no saved avatar'
    return
  }

  const shouldDelete = window.confirm('アイコン画像を削除します。よろしいですか？')
  if (!shouldDelete) {
    return
  }

  avatarDeleteInProgress = true
  setAvatarControlsDisabled(true)
  avatarStatusEl.textContent = 'Avatar status: deleting ...'

  try {
    const idToken = await currentUser.getIdToken()
    await deleteMyAvatar(idToken)
    currentAvatarPath = null
    currentAvatarUrl = null
    setUserAvatarDisplay(currentUser, null)
    avatarFileInputEl.value = ''
    resetAvatarEditor('Avatar status: deleted')
  } catch (error) {
    avatarStatusEl.textContent = `Avatar status: failed (${getApiErrorMessage(error)})`
  } finally {
    avatarDeleteInProgress = false
    setAvatarControlsDisabled(false)
  }
}

function handleAvatarPointerDown(event: PointerEvent): void {
  if (!avatarEditorState || avatarSaveInProgress) {
    return
  }
  if (event.button !== 0) {
    return
  }

  avatarDragActive = true
  avatarDragLastX = event.clientX
  avatarDragLastY = event.clientY
  avatarCropCanvasEl.setPointerCapture(event.pointerId)
}

function handleAvatarPointerMove(event: PointerEvent): void {
  if (!avatarEditorState || !avatarDragActive) {
    return
  }

  const deltaX = event.clientX - avatarDragLastX
  const deltaY = event.clientY - avatarDragLastY
  avatarDragLastX = event.clientX
  avatarDragLastY = event.clientY

  avatarEditorState.offsetX += deltaX
  avatarEditorState.offsetY += deltaY
  clampAvatarOffsets(avatarEditorState)
  drawAvatarEditorCanvas()
}

function stopAvatarDrag(event: PointerEvent): void {
  if (!avatarDragActive) {
    return
  }
  avatarDragActive = false
  if (avatarCropCanvasEl.hasPointerCapture(event.pointerId)) {
    avatarCropCanvasEl.releasePointerCapture(event.pointerId)
  }
}

function prepareForNewRecording(): void {
  if (recorder.getState() !== 'idle') {
    recorder.reset()
  }
  releaseRecordingPreviewObjectUrl()
  clearRecordedUploadSource('Upload status: waiting for recording')
  clearRegisterDraft('Register status: waiting for recording')
  clearRecordingWaveformView('Waveform: waiting for recording')
  stopRecordingCountdown()
  loadedRecordId = null
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
  if (recorder.getState() === 'recording') {
    return
  }

  shellErrorEl.textContent = ''
  prepareForNewRecording()
  recordingStatusEl.textContent = 'Recording status: requesting microphone ...'
  setRecordingButtonsState()

  try {
    await recorder.start()
    recordingStatusEl.textContent = 'Recording status: recording'
    setRecordingButtonsState()
    startRecordingCountdown()

    const result = await recorder.waitForStop()
    stopRecordingCountdown()
    showRecordedAudio(result)
    try {
      await renderWaveformFromBlob(
        result.blob,
        recordingWaveformCanvasEl,
        recordingWaveformStatusEl,
        'Waveform: raw waveform with 1s time axis',
      )
    } catch {
      clearRecordingWaveformView('Waveform: unavailable')
    }
  } catch (error) {
    stopRecordingCountdown()
    const message = isRecorderError(error)
      ? getRecorderErrorMessageByCode(error.code)
      : 'Failed to record audio.'
    recordingStatusEl.textContent = `Recording status: error (${message})`
    releaseRecordingPreviewObjectUrl()
    clearRecordedUploadSource('Upload status: waiting for recording')
    clearRegisterDraft('Register status: waiting for recording')
    clearRecordingWaveformView('Waveform: waiting for recording')
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
  }
}

async function handleRefreshScriptPromptStats(): Promise<void> {
  if (!currentUser) {
    genreStatusEl.textContent = 'ジャンル: sign in first'
    promptStatusEl.textContent = 'Prompts: sign in first'
    return
  }

  refreshScriptPromptsButton.disabled = true
  try {
    const previousScriptId = selectedScriptId
    const previousPromptId = selectedPromptId

    await loadGenres(currentUser, true)

    if (previousScriptId && selectedScriptId === previousScriptId) {
      selectedPromptId = previousPromptId
      await loadPromptsForScript(currentUser, previousScriptId, true)
    } else if (selectedScriptId) {
      await loadPromptsForScript(currentUser, selectedScriptId, false)
    }
  } finally {
    setRecordingButtonsState()
  }
}

function openLogoutModal(): void {
  if (!currentUser || logoutInProgress) {
    return
  }
  logoutModalEl.hidden = false
}

function closeLogoutModal(): void {
  if (logoutInProgress) {
    return
  }
  logoutModalEl.hidden = true
}

async function confirmLogout(): Promise<void> {
  if (!authForActions || !currentUser || logoutInProgress) {
    return
  }

  logoutInProgress = true
  logoutButton.disabled = true
  logoutConfirmButton.disabled = true
  logoutCancelButton.disabled = true
  shellErrorEl.textContent = ''

  try {
    await signOutFromApp(authForActions)
    logoutModalEl.hidden = true
  } catch (error) {
    shellErrorEl.textContent = getAuthErrorMessage(error)
    console.error(error)
  } finally {
    logoutInProgress = false
    logoutButton.disabled = false
    logoutConfirmButton.disabled = false
    logoutCancelButton.disabled = false
  }
}

clearRecordingWaveformView('Waveform: waiting for recording')
clearManageWaveformView('Waveform: waiting for load')
resetAvatarEditor('Avatar status: waiting for selection')

let auth: Auth | null = null
try {
  auth = initializeFirebaseAuth()
  authForActions = auth
} catch (error) {
  statusEl.textContent = 'Firebase is not configured.'
  errorEl.textContent = (error as Error).message
  console.error(error)
  signInButton.disabled = true
  logoutButton.disabled = true
  setProfileControlsDisabled(true)
  setAvatarControlsDisabled(true)
  genreStatusEl.textContent = 'ジャンル: disabled (Firebase init failed)'
  promptStatusEl.textContent = 'Prompts: disabled (Firebase init failed)'
  selectedGenreEl.textContent = '選択ジャンル: なし'
  selectedPromptEl.textContent = 'Selected prompt: none'
  recordingSelectedPromptEl.textContent = '選択音声: なし'
  clearManagePlaybackState()
  clearRecordingWaveformView('Waveform: disabled')
  clearManageWaveformView('Waveform: disabled')
  managePlaybackStatusEl.textContent = '読み込んだ音声: disabled'
  recordingStatusEl.textContent = 'Recording status: disabled (Firebase init failed)'
  recordingTimerEl.textContent = 'Time left: --'
  recordingStartButton.disabled = true
  recordingStopButton.disabled = true
  uploadRecordingButton.disabled = true
  resetUploadState('Upload status: disabled (Firebase init failed)')
  registerStatusEl.textContent = 'Register status: disabled (Firebase init failed)'
  avatarStatusEl.textContent = 'Avatar status: disabled (Firebase init failed)'
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
      errorEl.textContent = ''
      shellErrorEl.textContent = ''
      setView('menu')
      setRecordingIdleState()
      void loadGenres(user)
      void loadProfile(user)
      void runPing(user)
      void loadMyRecords(user)
    } else {
      deletingRecordIds.clear()
      loadingRecordIds.clear()
      avatarSaveInProgress = false
      avatarDeleteInProgress = false
      currentProfileDisplayName = ''
      currentAvatarPath = null
      currentAvatarUrl = null
      avatarFileInputEl.value = ''
      resetAvatarEditor('Avatar status: waiting for sign-in')
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
      closeLogoutModal()
      setView('auth')
    }
  })

  signInButton.addEventListener('click', async () => {
    errorEl.textContent = ''
    shellErrorEl.textContent = ''
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

  logoutButton.addEventListener('click', () => {
    openLogoutModal()
  })

  logoutConfirmButton.addEventListener('click', async () => {
    await confirmLogout()
  })

  logoutCancelButton.addEventListener('click', () => {
    closeLogoutModal()
  })

  logoutModalEl.addEventListener('click', (event) => {
    if (event.target === logoutModalEl) {
      closeLogoutModal()
    }
  })

  saveProfileButton.addEventListener('click', async () => {
    await handleSaveProfile()
  })

  avatarFileInputEl.addEventListener('change', async () => {
    const file = avatarFileInputEl.files?.[0] ?? null
    if (!file) {
      resetAvatarEditor('Avatar status: waiting for selection')
      return
    }
    try {
      await loadAvatarImageFile(file)
    } catch (error) {
      resetAvatarEditor(`Avatar status: failed (${getApiErrorMessage(error)})`)
    }
  })

  avatarZoomRangeEl.addEventListener('input', () => {
    handleAvatarZoomInput()
  })

  avatarCropCanvasEl.addEventListener('pointerdown', (event) => {
    handleAvatarPointerDown(event)
  })
  avatarCropCanvasEl.addEventListener('pointermove', (event) => {
    handleAvatarPointerMove(event)
  })
  avatarCropCanvasEl.addEventListener('pointerup', (event) => {
    stopAvatarDrag(event)
  })
  avatarCropCanvasEl.addEventListener('pointercancel', (event) => {
    stopAvatarDrag(event)
  })
  avatarCropCanvasEl.addEventListener('pointerleave', (event) => {
    stopAvatarDrag(event)
  })

  saveAvatarButton.addEventListener('click', async () => {
    await handleSaveAvatar()
  })

  deleteAvatarButton.addEventListener('click', async () => {
    await handleDeleteAvatar()
  })

  userAvatarImageEl.addEventListener('error', async () => {
    if (!currentUser || !currentAvatarPath || avatarUrlRetryInProgress) {
      setUserAvatarDisplay(currentUser, null)
      return
    }

    avatarUrlRetryInProgress = true
    try {
      await loadSignedAvatarUrl(currentUser)
    } finally {
      avatarUrlRetryInProgress = false
    }
  })

  openManageButton.addEventListener('click', () => {
    if (!currentUser) {
      return
    }
    setView('manage')
    void loadMyRecords(currentUser)
  })

  openAccountButton.addEventListener('click', () => {
    if (!currentUser) {
      return
    }
    setView('account')
  })

  promptBackButton.addEventListener('click', () => {
    setView('menu')
  })

  recordingBackButton.addEventListener('click', () => {
    setView('prompt')
  })

  manageBackButton.addEventListener('click', () => {
    setView('menu')
  })

  accountBackButton.addEventListener('click', () => {
    setView('menu')
  })

  refreshScriptPromptsButton.addEventListener('click', async () => {
    await handleRefreshScriptPromptStats()
  })

  recordingStartButton.addEventListener('click', async () => {
    await handleStartRecording()
  })

  recordingStopButton.addEventListener('click', async () => {
    await handleStopRecording()
  })

  uploadRecordingButton.addEventListener('click', async () => {
    await handleUploadRecording()
  })
}
