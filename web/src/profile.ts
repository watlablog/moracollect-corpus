export type ProfileGetResponse = {
  ok: boolean
  uid: string
  display_name: string
  profile_exists: boolean
  avatar_exists: boolean
  avatar_path: string | null
  avatar_updated_at: string | null
}

export type ProfilePostResponse = {
  ok: boolean
  uid: string
  display_name: string
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
    // Ignore JSON parse errors and keep status-based error.
  }
  return detail
}

export async function fetchProfile(idToken: string): Promise<ProfileGetResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/profile`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as ProfileGetResponse
}

export async function saveProfile(
  idToken: string,
  displayName: string,
): Promise<ProfilePostResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/profile`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ display_name: displayName }),
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as ProfilePostResponse
}
