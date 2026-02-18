export type PingResponse = {
  ok: boolean
  uid: string
  email: string | null
  project_id: string
}

function getApiBaseUrl(): string {
  const baseUrl = import.meta.env.VITE_API_BASE_URL
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('Missing required environment variable: VITE_API_BASE_URL')
  }
  return baseUrl.replace(/\/$/, '')
}

export async function fetchPing(idToken: string): Promise<PingResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/ping`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') {
        detail = body.detail
      }
    } catch {
      // Ignore JSON parse errors and use status fallback.
    }
    throw new Error(detail)
  }

  return (await response.json()) as PingResponse
}
