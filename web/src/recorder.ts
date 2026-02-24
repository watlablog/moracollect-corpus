export const MIN_RECORDING_MS = 0
export const MAX_RECORDING_MS = 5000

export type RecorderState = 'idle' | 'recording' | 'recorded' | 'error'

export type RecorderErrorCode =
  | 'not-supported'
  | 'permission-denied'
  | 'device-not-found'
  | 'too-short'
  | 'unknown'

export type RecorderError = {
  code: RecorderErrorCode
  message: string
}

export type RecordingResult = {
  blob: Blob
  durationMs: number
  mimeType: string
}

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
]

function supportsRecordingApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

function toRecorderError(
  code: RecorderErrorCode,
  message: string,
): RecorderError {
  return { code, message }
}

function mapUserMediaError(error: unknown): RecorderError {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return toRecorderError('permission-denied', 'Microphone permission was denied.')
    }
    if (error.name === 'NotFoundError') {
      return toRecorderError('device-not-found', 'No microphone device was found.')
    }
    if (error.name === 'NotSupportedError') {
      return toRecorderError('not-supported', 'Audio recording is not supported in this browser.')
    }
  }
  return toRecorderError('unknown', 'Failed to access microphone.')
}

function chooseMimeType(): string | undefined {
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType
    }
  }
  return undefined
}

export class BrowserRecorder {
  private state: RecorderState = 'idle'
  private stream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private startedAt = 0
  private autoStopTimer: number | null = null
  private chunks: BlobPart[] = []
  private stopPromise: Promise<RecordingResult> | null = null
  private resolveStop: ((result: RecordingResult) => void) | null = null
  private rejectStop: ((error: RecorderError) => void) | null = null
  private lastError: RecorderError | null = null

  getState(): RecorderState {
    return this.state
  }

  getLastError(): RecorderError | null {
    return this.lastError
  }

  getRemainingMs(): number {
    if (this.state !== 'recording') {
      return 0
    }
    const elapsed = Date.now() - this.startedAt
    return Math.max(0, MAX_RECORDING_MS - elapsed)
  }

  async start(): Promise<void> {
    if (this.state === 'recording') {
      return
    }

    if (!supportsRecordingApi()) {
      this.state = 'error'
      this.lastError = toRecorderError(
        'not-supported',
        'Audio recording is not supported in this browser.',
      )
      throw this.lastError
    }

    this.lastError = null
    this.chunks = []

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      const mapped = mapUserMediaError(error)
      this.state = 'error'
      this.lastError = mapped
      throw mapped
    }

    const mimeType = chooseMimeType()
    let mediaRecorder: MediaRecorder
    try {
      mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      const mapped = toRecorderError(
        'not-supported',
        'Audio recording is not supported in this browser.',
      )
      this.state = 'error'
      this.lastError = mapped
      throw mapped
    }

    this.stream = stream
    this.mediaRecorder = mediaRecorder
    this.startedAt = Date.now()
    this.state = 'recording'

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data)
      }
    })

    mediaRecorder.addEventListener('error', () => {
      this.finishWithError(
        toRecorderError('unknown', 'Recording failed due to a recorder error.'),
      )
    })

    mediaRecorder.addEventListener('stop', () => {
      this.finalizeRecording()
    })

    this.stopPromise = new Promise<RecordingResult>((resolve, reject) => {
      this.resolveStop = resolve
      this.rejectStop = reject
    })

    mediaRecorder.start()
    this.autoStopTimer = window.setTimeout(() => {
      void this.stop()
    }, MAX_RECORDING_MS)
  }

  async stop(): Promise<RecordingResult> {
    if (this.state !== 'recording' || !this.mediaRecorder) {
      if (this.stopPromise) {
        return this.stopPromise
      }
      const mapped = toRecorderError('unknown', 'Recording is not active.')
      this.state = 'error'
      this.lastError = mapped
      throw mapped
    }

    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }

    if (!this.stopPromise) {
      const mapped = toRecorderError('unknown', 'Failed to stop recording.')
      this.state = 'error'
      this.lastError = mapped
      throw mapped
    }

    return this.stopPromise
  }

  async waitForStop(): Promise<RecordingResult> {
    if (!this.stopPromise) {
      const mapped = toRecorderError('unknown', 'Recording is not active.')
      this.state = 'error'
      this.lastError = mapped
      throw mapped
    }
    return this.stopPromise
  }

  reset(): void {
    if (this.state === 'recording') {
      return
    }
    this.clearTimer()
    this.chunks = []
    this.lastError = null
    this.state = 'idle'
    this.cleanupMediaResources()
    this.stopPromise = null
    this.resolveStop = null
    this.rejectStop = null
    this.startedAt = 0
  }

  private finalizeRecording(): void {
    this.clearTimer()

    const mediaRecorder = this.mediaRecorder
    if (!mediaRecorder) {
      this.finishWithError(
        toRecorderError('unknown', 'Recorder stopped unexpectedly.'),
      )
      return
    }

    const durationMs = Date.now() - this.startedAt
    const mimeType =
      mediaRecorder.mimeType || chooseMimeType() || 'audio/webm'
    const blob = new Blob(this.chunks, { type: mimeType })

    this.cleanupMediaResources()

    if (blob.size === 0) {
      this.finishWithError(
        toRecorderError('unknown', 'Recorded audio is empty.'),
      )
      return
    }

    this.state = 'recorded'
    const resolve = this.resolveStop
    this.stopPromise = null
    this.resolveStop = null
    this.rejectStop = null
    this.chunks = []
    this.lastError = null

    resolve?.({
      blob,
      durationMs,
      mimeType,
    })
  }

  private finishWithError(error: RecorderError): void {
    this.clearTimer()
    this.cleanupMediaResources()
    this.state = 'error'
    this.lastError = error
    this.chunks = []
    this.startedAt = 0

    const reject = this.rejectStop
    this.stopPromise = null
    this.resolveStop = null
    this.rejectStop = null
    reject?.(error)
  }

  private cleanupMediaResources(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
    }
    this.stream = null
    this.mediaRecorder = null
  }

  private clearTimer(): void {
    if (this.autoStopTimer !== null) {
      window.clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
  }
}
