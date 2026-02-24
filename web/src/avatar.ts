export type AvatarUploadUrlResponse = {
  ok: boolean
  avatar_id: string
  avatar_path: string
  upload_url: string
  method: 'PUT'
  required_headers: Record<string, string>
  expires_in_sec: number
}

export type SaveAvatarRequest = {
  avatar_path: string
  mime_type: 'image/webp'
  size_bytes: number
  width: number
  height: number
}

export type SaveAvatarResponse = {
  ok: boolean
  uid: string
  avatar_path: string
  avatar_updated_at: string
}

export type AvatarUrlResponse = {
  ok: boolean
  uid: string
  avatar_exists: boolean
  avatar_url: string | null
  expires_in_sec: number
}

export type AvatarDeleteResponse = {
  ok: boolean
  uid: string
  deleted: boolean
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
    // Keep status fallback.
  }
  return detail
}

export async function requestAvatarUploadUrl(
  idToken: string,
): Promise<AvatarUploadUrlResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/profile/avatar-upload-url`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }
  return (await response.json()) as AvatarUploadUrlResponse
}

export async function saveAvatarProfile(
  idToken: string,
  payload: SaveAvatarRequest,
): Promise<SaveAvatarResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/profile/avatar`, {
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
  return (await response.json()) as SaveAvatarResponse
}

export async function fetchMyAvatarUrl(idToken: string): Promise<AvatarUrlResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/profile/avatar-url`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }
  return (await response.json()) as AvatarUrlResponse
}

export async function deleteMyAvatar(idToken: string): Promise<AvatarDeleteResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/profile/avatar`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }
  return (await response.json()) as AvatarDeleteResponse
}
