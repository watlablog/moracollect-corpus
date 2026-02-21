export type UploadUrlResponse = {
  ok: boolean
  record_id: string
  raw_path: string
  upload_url: string
  method: string
  required_headers: Record<string, string>
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
    // Ignore JSON parse errors and use status-based message.
  }
  return detail
}

export async function requestUploadUrl(
  idToken: string,
  ext: string,
  contentType: string,
): Promise<UploadUrlResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/upload-url`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ext,
      content_type: contentType,
    }),
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as UploadUrlResponse
}

export async function uploadRawBlob(
  uploadUrl: string,
  blob: Blob,
  requiredHeaders: Record<string, string>,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: requiredHeaders,
    body: blob,
  })

  if (!response.ok) {
    const bodyText = (await response.text()).slice(0, 200).trim()
    const suffix = bodyText ? ` (${bodyText})` : ''
    throw new Error(`Upload failed: HTTP ${response.status}${suffix}`)
  }
}
