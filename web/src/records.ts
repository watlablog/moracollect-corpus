export type RegisterRecordRequest = {
  record_id: string
  raw_path: string
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
