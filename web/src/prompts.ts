export type ScriptItem = {
  script_id: string
  title: string
  description: string
  order: number
  is_active: boolean
  prompt_count: number
  total_records: number
  unique_speakers: number
}

export type ScriptsResponse = {
  ok: boolean
  scripts: ScriptItem[]
}

export type PromptItem = {
  prompt_id: string
  text: string
  order: number
  is_active: boolean
  total_records: number
  unique_speakers: number
}

export type PromptsResponse = {
  ok: boolean
  script_id: string
  prompts: PromptItem[]
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
    // Ignore JSON parse errors and keep status-based fallback.
  }
  return detail
}

export async function fetchScripts(idToken: string): Promise<ScriptsResponse> {
  const response = await fetch(`${getApiBaseUrl()}/v1/scripts`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return (await response.json()) as ScriptsResponse
}

export async function fetchPrompts(
  idToken: string,
  scriptId: string,
): Promise<PromptsResponse> {
  const response = await fetch(
    `${getApiBaseUrl()}/v1/prompts?script_id=${encodeURIComponent(scriptId)}`,
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

  return (await response.json()) as PromptsResponse
}
