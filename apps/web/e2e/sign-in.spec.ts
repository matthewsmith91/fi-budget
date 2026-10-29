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
async function blankDevice(browser: Browser): Promise<Page> {
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
  return page
}

async function newDevice(browser: Browser, path = '#/settings/household'): Promise<Page> {
  const page = await blankDevice(browser)
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

test('signs in and pairs devices and people, then syncs a new device from the server', async ({
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
  const phone = await newDevice(browser, `#/settings/household?code=${deviceCode}`)
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

  // The laptop turns on sync, which uploads its budget to the server
  await laptop.getByRole('button', { name: 'Turn on sync' }).click()
  await expect(
    laptop.getByRole('status').filter({ hasText: 'full copy for new devices' }),
  ).toBeVisible()
  await expect(laptop.getByRole('button', { name: 'Sync now' })).toBeVisible()

  // The status banner reports the device as synced; a change makes it unsynced until it is sent
  const banner = laptop.locator('[data-sync]')
  await expect(banner).toHaveAttribute('data-sync', 'synced')
  await laptop.getByRole('link', { name: '← Back to budget' }).click()
  await laptop.context().setOffline(true)
  await laptop
    .getByLabel('Budget navigation')
    .getByRole('button', { name: '+ Add Account' })
    .click()
  const dialog = laptop.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Offline account')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(banner).toHaveAttribute('data-sync', 'offline')
  await expect(banner).toContainText('will sync when you’re back online')
  await laptop.context().setOffline(false)
  await expect(banner).toHaveAttribute('data-sync', 'synced')
  await laptop.getByLabel('Budget navigation').getByRole('link', { name: 'Settings' }).click()
  await laptop.getByLabel('Settings navigation').getByRole('link', { name: 'Household' }).click()

  // Connections reaches the real /api/bank; nothing is linked, and no token is sent anywhere.
  await laptop.getByLabel('Settings navigation').getByRole('link', { name: 'Connections' }).click()
  await expect(laptop.getByText('No bank is connected yet.')).toBeVisible()
  await expect(laptop.getByRole('button', { name: 'Connect bank' })).toBeDisabled()
  await expect(laptop.getByRole('heading', { name: 'Category suggestions' })).toBeVisible()
  await laptop.getByLabel('Settings navigation').getByRole('link', { name: 'Household' }).click()

  // A brand-new device with no budget pairs, then downloads the household from the server
  const newCode = await invite(laptop, 'Pair another device')
  const second = await blankDevice(browser)
  await second.goto(`${ORIGIN}/`)
  await second.getByText('Already have a household on your server?').click()
  await pair(second, newCode)
  await expect(second.getByText('The household already has a budget on the server')).toBeVisible()
  await second.getByRole('button', { name: 'Set up this device from the server' }).click()
  await expect(
    second.getByLabel('Budget navigation').getByText('Smith', { exact: true }),
  ).toBeVisible()
  await second.getByLabel('Budget navigation').getByRole('link', { name: 'Settings' }).click()
  await second.getByLabel('Settings navigation').getByRole('link', { name: 'Household' }).click()
  await expect(second.getByRole('button', { name: 'Sync now' })).toBeVisible()

  // A device with a different budget of its own is not merged into the household's
  const stranger2 = await newDevice(browser)
  const clash = await invite(laptop, 'Pair another device')
  await pair(stranger2, clash)
  await expect(stranger2.getByRole('alert')).toContainText('can’t be merged')
  await expect(stranger2.getByRole('button', { name: 'Turn on sync' })).toHaveCount(0)
})
