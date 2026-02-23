export type RegisterRecordRequest = {
  record_id: string
  raw_path: string
  script_id: string
  prompt_id: string
  client_meta: Record<string, unknown>
  recording_meta: Record<string, unknown>
}

export type RegisterRecordResponse = {
  ok: boolean
  record_id: string
  status: string
  already_registered: boolean
}

export type MyRecordItem = {
  record_id: string
  status: string
  script_id: string
  prompt_id: string
  prompt_text?: string | null
  raw_path: string
  mime_type: string | null
  size_bytes: number | null
  duration_ms: number | null
  created_at: string | null
}

export type MyRecordsResponse = {
  ok: boolean
  records: MyRecordItem[]
}

export type DeleteMyRecordResponse = {
  ok: boolean
  record_id: string
  deleted: boolean
}

export type MyRecordPlaybackUrlResponse = {
  ok: boolean
  record_id: string
  raw_path: string
  mime_type: string | null
  playback_url: string
  expires_in_sec: number
}

function getApiBaseUrl(): string {
  const baseUrl = import.meta.env.VITE_API_BASE_URL
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('Missing required environment variable: VITE_API_BASE_URL')
  }
  return baseUrl.replace(/\/$/, '')
}

async function parseError(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') {
      detail = body.detail
    }
  } catch {
    // Ignore parse errors and use status code fallback.
  }
  return detail
}

export async function registerRecord(
  idToken: string,
  payload: RegisterRecordRequest,
): Promise<RegisterRecordResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as RegisterRecordResponse
}

export async function fetchMyRecords(
  idToken: string,
  limit = 10,
): Promise<MyRecordsResponse> {
  const response = await fetch(
    `${getApiBaseUrl()}/v1/my-records?limit=${encodeURIComponent(String(limit))}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as MyRecordsResponse
}

export async function deleteMyRecord(
  idToken: string,
  recordId: string,
): Promise<DeleteMyRecordResponse> {
  const response = await fetch(
    `${getApiBaseUrl()}/v1/my-records/${encodeURIComponent(recordId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as DeleteMyRecordResponse
}

export async function fetchMyRecordPlaybackUrl(
  idToken: string,
  recordId: string,
): Promise<MyRecordPlaybackUrlResponse> {
  const response = await fetch(
    `${getApiBaseUrl()}/v1/my-records/${encodeURIComponent(recordId)}/playback-url`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as MyRecordPlaybackUrlResponse
}

type SignedUrlFetchError = Error & {
  retryableExpired?: boolean
}

function isRetryableSignedUrlError(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
      error !== null &&
      'retryableExpired' in error &&
      (error as SignedUrlFetchError).retryableExpired,
  )
}

async function fetchBlobFromSignedPlaybackUrl(url: string): Promise<Blob> {
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const bodyText = (await response.text()).slice(0, 400).trim()
    const lowerBody = bodyText.toLowerCase()
    const retryableExpired =
      (response.status === 401 || response.status === 403) &&
      (lowerBody.includes('expired') ||
        lowerBody.includes('request has expired') ||
        lowerBody.includes('signature'))

    const suffix = bodyText ? ` (${bodyText})` : ''
    const error = new Error(
      `Failed to load audio: HTTP ${response.status}${suffix}`,
    ) as SignedUrlFetchError
    error.retryableExpired = retryableExpired
    throw error
  }
  return await response.blob()
}

export async function fetchRecordPlaybackBlobWithAutoRetry(
  idToken: string,
  recordId: string,
  onRetry?: () => void,
): Promise<Blob> {
  const firstPlan = await fetchMyRecordPlaybackUrl(idToken, recordId)
  try {
    return await fetchBlobFromSignedPlaybackUrl(firstPlan.playback_url)
  } catch (error) {
    if (!isRetryableSignedUrlError(error)) {
      throw error
    }

    onRetry?.()
    const secondPlan = await fetchMyRecordPlaybackUrl(idToken, recordId)
    return await fetchBlobFromSignedPlaybackUrl(secondPlan.playback_url)
  }
}
