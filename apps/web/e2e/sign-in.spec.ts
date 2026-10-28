import { expect, test, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The real server (built by the webServer command) serving the built app from one origin,
// with a throwaway database. Passkeys are bound to the origin, so this cannot use `vite preview`.
const PORT = 3101
const ORIGIN = `http://localhost:${PORT}`

let server: ChildProcess
let dataDir: string
let setupCode: string

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'budget-fi-e2e-'))
  const root = resolve(import.meta.dirname, '../../..')
  server = spawn('node', ['apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ORIGIN,
      STATIC_DIR: join(root, 'apps/web/dist'),
    },
  })
  setupCode = await new Promise<string>((resolveCode, reject) => {
    let output = ''
    server.stdout!.on('data', (chunk: Buffer) => {
      output += chunk
      const match = /setup code ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(output)
      if (match) resolveCode(match[1]!)
    })
    server.once('exit', (code) => reject(new Error(`server exited early (${code}): ${output}`)))
    setTimeout(() => reject(new Error(`no setup code in server output: ${output}`)), 15_000)
  })
})

test.afterAll(async () => {
  server.removeAllListeners('exit')
  server.kill()
  await rm(dataDir, { recursive: true, force: true })
})

/** A fresh browser profile with its own software passkey store (a "device"). */
async function newDevice(browser: Browser, path = '#/settings'): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto(`${ORIGIN}/${path}`)
  // The budget file must exist before the shell shows Settings; the household is local to the device.
  await page.getByLabel('Household name').fill('Smith')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.goto(`${ORIGIN}/${path}`)
  await expect(page.getByRole('heading', { name: 'Household sign-in' })).toBeVisible()
  return page
}

async function pair(page: Page, code: string, name?: string) {
  await page.getByLabel('One-time code').fill(code)
  if (name) await page.getByLabel(/Your name/).fill(name)
  await page.getByRole('button', { name: 'Create passkey' }).click()
}

async function invite(page: Page, button: 'Pair another device' | 'Invite the other person') {
  await page.getByRole('button', { name: button }).click()
  const shown = page.locator('.invite-code')
  await expect(shown).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  return (await shown.textContent())!
}

test('sets up the household, signs in again, and pairs a second device and person', async ({
  browser,
}) => {
  // First person, with the setup code from the server log
  const laptop = await newDevice(browser)
  await expect(laptop.getByText('Nobody has signed up yet')).toBeVisible()
  await pair(laptop, setupCode, 'Matt')
  await expect(laptop.getByText('Signed in as')).toContainText('Matt')

  // The session survives a reload, and the passkey signs back in after signing out
  await laptop.reload()
  await expect(laptop.getByText('Signed in as')).toContainText('Matt')
  await laptop.getByRole('button', { name: 'Sign out' }).click()
  await laptop.getByRole('button', { name: 'Sign in with passkey' }).click()
  await expect(laptop.getByText('Signed in as')).toContainText('Matt')

  // A new device pairs with a one-time code and becomes the same person
  const deviceCode = await invite(laptop, 'Pair another device')
  const phone = await newDevice(browser, `#/settings?code=${deviceCode}`)
  await expect(phone.getByLabel('One-time code')).toHaveValue(deviceCode)
  await pair(phone, deviceCode)
  await expect(phone.getByText('Signed in as')).toContainText('Matt')

  // ...and the code is spent
  const stranger = await newDevice(browser)
  await pair(stranger, deviceCode, 'Mallory')
  await expect(stranger.getByRole('alert')).toContainText('not valid or has expired')

  // The other person joins with their own code and name
  const personCode = await invite(laptop, 'Invite the other person')
  const tablet = await newDevice(browser)
  await pair(tablet, personCode, 'Jessica')
  await expect(tablet.getByText('Signed in as')).toContainText('Jessica')

  // The household is full
  await laptop.getByRole('button', { name: 'Invite the other person' }).click()
  await expect(laptop.getByRole('alert')).toContainText('already has two people')
})
