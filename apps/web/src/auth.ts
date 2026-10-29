import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { request } from './server.ts'

export interface Person {
  id: string
  displayName: string
}

export interface AuthStatus {
  /** True until the first person has registered with the server's setup code. */
  setupRequired: boolean
  user: Person | null
}

export type InviteKind = 'device' | 'user'

export interface Invite {
  kind: InviteKind
  code: string
  expiresAt: string
}

const call = <T>(path: string, body?: unknown) => request<T>(`/api/auth/${path}`, body)

export const authApi = {
  status: () => call<AuthStatus>('status'),

  async signIn(): Promise<Person> {
    const { ceremonyId, options } = await call<{ ceremonyId: string; options: never }>(
      'login/options',
      {},
    )
    const response = await startAuthentication({ optionsJSON: options })
    return (await call<{ user: Person }>('login/verify', { ceremonyId, response })).user
  },

  /** Trades a one-time code for a passkey on this device. `displayName` is for a new person only. */
  async pair(code: string, displayName?: string): Promise<Person> {
    const { ceremonyId, options } = await call<{ ceremonyId: string; options: never }>(
      'register/options',
      { code, displayName },
    )
    const response = await startRegistration({ optionsJSON: options })
    return (await call<{ user: Person }>('register/verify', { ceremonyId, response })).user
  },

  async signOut() {
    await call<null>('logout', {}).catch(() => {})
  },

  createInvite: (kind: InviteKind) => call<Invite>('invites', { kind }),
}

/** The one-time code in a pairing link (`#/settings/household?code=ABCD-EFGH`), if the page was opened from one. */
export function pairingCodeFromHash(hash: string): string | null {
  return new URLSearchParams(hash.split('?')[1] ?? '').get('code')
}

export function pairingLink(code: string): string {
  return `${location.origin}/#/settings/household?code=${encodeURIComponent(code)}`
}
