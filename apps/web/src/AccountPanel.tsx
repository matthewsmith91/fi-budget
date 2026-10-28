import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { authApi, pairingCodeFromHash, pairingLink, type Invite, type InviteKind } from './auth.ts'
import { messageOf } from './errors.ts'
import { useAsync } from './hooks.ts'
import { SyncPanel } from './SyncPanel.tsx'

/** Household sign-in: passkeys, and pairing a new device or the other person with a one-time code. */
export function AccountPanel() {
  const status = useAsync(() => authApi.status())

  return (
    <section className="card">
      <h2>Household sign-in</h2>
      {status.loading && <p className="muted">Checking the server…</p>}
      {status.error && (
        <p className="muted">
          No sync server is reachable from here. The budget keeps working on this device alone.
        </p>
      )}
      {status.data &&
        (status.data.user ? (
          <SignedIn name={status.data.user.displayName} onChange={status.reload} />
        ) : (
          <SignedOut setupRequired={status.data.setupRequired} onChange={status.reload} />
        ))}
    </section>
  )
}

function useAction() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(fn: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      // Dismissing the passkey prompt is a choice, not a failure worth shouting about.
      if (err instanceof Error && err.name === 'NotAllowedError') setError('Cancelled.')
      else setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

function SignedOut(props: { setupRequired: boolean; onChange: () => void }) {
  const { error, busy, run } = useAction()
  const [code, setCode] = useState(() => pairingCodeFromHash(location.hash) ?? '')
  const [name, setName] = useState('')

  return (
    <>
      {props.setupRequired ? (
        <p className="muted">
          Nobody has signed up yet. Enter the setup code the server printed in its log.
        </p>
      ) : (
        <div className="stack">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await authApi.signIn()
                props.onChange()
              })
            }
          >
            Sign in with passkey
          </button>
          <p className="muted">New device or new person? Enter a code from a signed-in device.</p>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await authApi.pair(code, name.trim() || undefined)
            // Drop a spent code from the address bar, but leave any other address alone:
            // replaceState does not fire hashchange, so rewriting it would desync the route.
            if (pairingCodeFromHash(location.hash)) history.replaceState(null, '', '#/settings')
            props.onChange()
          })
        }}
      >
        <label>
          One-time code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD-EFGH"
          />
        </label>
        <label>
          {props.setupRequired ? 'Your name' : 'Your name (only if you are a new person)'}
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !code.trim()}>
            Create passkey
          </button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function SignedIn(props: { name: string; onChange: () => void }) {
  const { error, busy, run } = useAction()
  const [invite, setInvite] = useState<Invite | null>(null)

  // Drop the old code first so a spent one is never mistaken for the new one.
  const makeInvite = (kind: InviteKind) =>
    run(async () => {
      setInvite(null)
      setInvite(await authApi.createInvite(kind))
    })

  return (
    <>
      <p>
        Signed in as <strong>{props.name}</strong>.
      </p>
      <div className="row">
        <button className="secondary" disabled={busy} onClick={() => void makeInvite('device')}>
          Pair another device
        </button>
        <button className="secondary" disabled={busy} onClick={() => void makeInvite('user')}>
          Invite the other person
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await authApi.signOut()
              setInvite(null)
              props.onChange()
            })
          }
        >
          Sign out
        </button>
      </div>
      {invite && <InviteCard invite={invite} />}
      <SyncPanel />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function InviteCard({ invite }: { invite: Invite }) {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    QRCode.toDataURL(pairingLink(invite.code), { margin: 1, width: 192 }).then(
      (url) => live && setQr(url),
      () => live && setQr(null),
    )
    return () => {
      live = false
    }
  }, [invite.code])

  const what: Record<InviteKind, string> = {
    device: 'Open the app on the new device and enter this code, or scan the QR code.',
    user: 'Give this to the other person. They will choose their own name and passkey.',
  }
  return (
    <div className="invite" role="status">
      <p className="muted">{what[invite.kind]}</p>
      <p className="invite-code">{invite.code}</p>
      {qr && (
        <img src={qr} width={192} height={192} alt={`QR code for pairing code ${invite.code}`} />
      )}
      <p className="muted">
        Works once, until{' '}
        {new Date(invite.expiresAt).toLocaleTimeString([], { timeStyle: 'short' })}.
      </p>
    </div>
  )
}
