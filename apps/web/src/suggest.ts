import { request } from './server.ts'

export interface CategoryOption {
  id: string
  name: string
  group: string
}

export interface SuggestStatus {
  enabled: boolean
  /** Saved here in Settings, or the server's environment; null while off. */
  source: 'settings' | 'environment' | null
  model: string
  /** The end of the key, to recognise it by. The key itself never comes back. */
  keyHint: string | null
}

/** Optional: suggestions are on only when the server has an Anthropic key. */
export const suggestApi = {
  status: () => request<SuggestStatus>('/api/suggest/status'),
  enabled: async () => (await suggestApi.status()).enabled,
  /** Checks the key with Anthropic, then saves it on the server. Either field may be left out. */
  save: (input: { apiKey?: string; model?: string }) =>
    request<SuggestStatus>('/api/suggest/settings', input, 'PUT'),
  remove: () => request<SuggestStatus>('/api/suggest/settings', undefined, 'DELETE'),
  /** Payee text → category id, for the payees the model had an answer for. */
  categories: async (payees: string[], categories: CategoryOption[]) =>
    (
      await request<{ suggestions: Record<string, string> }>('/api/suggest/categories', {
        payees,
        categories,
      })
    ).suggestions,
}
