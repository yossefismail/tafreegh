import { net } from 'electron'

/**
 * Optional Hugging Face token.
 *
 * Anonymous requests to the Hub are rate limited and the client prints a
 * warning on every download; a token raises the limit and removes the warning.
 * The token is never sent anywhere except huggingface.co.
 */

export interface HfTokenCheck {
  /** `invalid` means the Hub rejected the token; `unknown` means we could not ask. */
  status: 'ok' | 'invalid' | 'unknown'
  user?: string
  error?: string
}

export async function verifyHfToken(token: string): Promise<HfTokenCheck> {
  try {
    const res = await net.fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (res.status === 401 || res.status === 403) return { status: 'invalid' }
    if (!res.ok) return { status: 'unknown', error: `HTTP ${res.status}` }
    const json = (await res.json()) as { name?: string; fullname?: string }
    return { status: 'ok', user: json.name || json.fullname }
  } catch (error) {
    // Offline or blocked: never reject a token we could not test.
    return { status: 'unknown', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Environment for the Python worker. `HF_TOKEN` is what huggingface_hub reads;
 * the older name is kept for tools that still look for it.
 */
export function hfTokenEnv(token: string | undefined): NodeJS.ProcessEnv {
  const trimmed = token?.trim()
  if (!trimmed) return {}
  return { HF_TOKEN: trimmed, HUGGING_FACE_HUB_TOKEN: trimmed }
}
