export type LeaderboardItem = {
  rank: number
  uid: string
  display_name: string
  contribution_count: number
  avatar_url: string | null
  avatar_expires_in_sec: number
}

export type LeaderboardResponse = {
  ok: boolean
  period: string
  leaderboard: LeaderboardItem[]
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
    // Ignore parse errors and keep status fallback.
  }
  return detail
}

export async function fetchLeaderboard(
  idToken: string,
  limit = 10,
): Promise<LeaderboardResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('limit', String(limit))

  const response = await fetch(
    `${getApiBaseUrl()}/v1/leaderboard?${searchParams.toString()}`,
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

  return (await response.json()) as LeaderboardResponse
}
