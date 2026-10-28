import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const sidebar = (page: Page) => page.getByLabel('Budget navigation')

async function setUpHousehold(page: Page, name = 'Smith') {
  await page.getByLabel('Household name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(sidebar(page).getByText(name, { exact: true })).toBeVisible()
}

async function openSettings(page: Page) {
  await sidebar(page).getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
}

async function exportAs(page: Page, button: 'Export JSON' | 'Export SQLite', path: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: button }).click()
  await (await download).saveAs(path)
}

test('boots on durable storage at the latest schema', async ({ page }) => {
  await page.goto('/')
  await setUpHousehold(page)
  await openSettings(page)
  await expect(page.getByText('On this device')).toBeVisible()
  await expect(page.getByText('Memory only')).toHaveCount(0)
  await expect(page.getByText('$1,234.56')).toBeVisible()
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toContain('512x512')
})

test('meets Chrome’s installability criteria', async ({ page, context }) => {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload() // let the service worker take control of the page
  const cdp = await context.newCDPSession(page)
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
  // Playwright contexts are incognito-like, which Chrome always reports; anything else
  // (manifest, icons, service worker, HTTPS) would be a real installability failure.
  expect(installabilityErrors.filter((e) => e.errorId !== 'in-incognito')).toEqual([])
})

test('data survives a reload and works offline from the service worker', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await setUpHousehold(page)
  await openSettings(page)
  await expect(
    page.getByText('Offline ready').locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('yes', {
    timeout: 20_000,
  })
  await page.reload()
  await expect(sidebar(page).getByText('Smith', { exact: true })).toBeVisible()
  await expect(sidebar(page).getByText('Matt & Jessica')).toBeVisible()

  await page.evaluate(() => navigator.serviceWorker.ready)
  await context.setOffline(true)
  await page.reload()
  await expect(sidebar(page).getByText('Smith', { exact: true })).toBeVisible()
  await context.setOffline(false)
})

test('export then import restores a budget, with a safety backup of the replaced one', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await setUpHousehold(page)
  await openSettings(page)

  const jsonPath = testInfo.outputPath('budget.json')
  const sqlitePath = testInfo.outputPath('budget.sqlite')
  await exportAs(page, 'Export JSON', jsonPath)
  await exportAs(page, 'Export SQLite', sqlitePath)

  const exported = JSON.parse(await readFile(jsonPath, 'utf8'))
  expect(exported.format).toBe('budget-fi-export')
  expect(exported.tables.households).toHaveLength(1)
  const original = exported.tables.households[0].name as string

  // import an edited JSON export: replaces the household
  exported.tables.households[0].name = 'Jones'
  const editedPath = testInfo.outputPath('edited.json')
  await writeFile(editedPath, JSON.stringify(exported))
  page.once('dialog', (d) => void d.accept())
  const safety = page.waitForEvent('download')
  await page.locator('input[type=file]').setInputFiles(editedPath)
  expect((await safety).suggestedFilename()).toMatch(/^budget-before-import-.*\.sqlite$/)
  await expect(sidebar(page).getByText('Jones', { exact: true })).toBeVisible()

  // import the SQLite image: back to the original
  page.once('dialog', (d) => void d.accept())
  const safety2 = page.waitForEvent('download')
  await page.locator('input[type=file]').setInputFiles(sqlitePath)
  await safety2
  await expect(sidebar(page).getByText(original, { exact: true })).toBeVisible()

  // the swapped-in file is the one that persists
  await page.reload()
  await expect(sidebar(page).getByText(original, { exact: true })).toBeVisible()

  // a bad file is refused and nothing changes
  const junk = testInfo.outputPath('junk.json')
  await writeFile(junk, '{"nope":true}')
  page.once('dialog', (d) => void d.accept())
  await page.locator('input[type=file]').setInputFiles(junk)
  await expect(page.getByRole('alert')).toContainText('Not a Budget-Fi export')
  await expect(sidebar(page).getByText(original, { exact: true })).toBeVisible()
})

test('a second tab is told the budget is open elsewhere', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByLabel('Household name')).toBeVisible()
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByRole('alert')).toContainText('open in another tab')
})

test('budget, accounts and the ledger work together and persist', async ({ page }) => {
  await page.goto('/')
  await setUpHousehold(page)

  // add an account with a starting balance; it opens on its register
  async function addAccount(name: string, type: string, balance: string) {
    await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Account name').fill(name)
    await dialog.getByLabel('Account type').selectOption(type)
    await dialog.getByLabel('Current balance').fill(balance)
    await dialog.getByRole('button', { name: 'Add account' }).click()
  }
  await addAccount('Ally HYSA', 'savings', '1000')
  await expect(page.getByRole('heading', { name: 'Ally HYSA' })).toBeVisible()
  await expect(sidebar(page).getByRole('link', { name: /Ally HYSA/ })).toContainText('$1,000.00')
  await expect(page.getByRole('row', { name: /Starting Balance/ })).toContainText(
    'Inflow: Ready to Assign',
  )

  // a duplicate name is refused with a message and nothing is added
  await addAccount('ally hysa', 'checking', '')
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('already exists')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  // the starting balance is money to assign
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  const ready = page.getByRole('status').filter({ hasText: 'Ready to Assign' })
  await expect(ready).toContainText('$1,000.00')

  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Bills')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Bills' }).click()
  await page.getByLabel('New category in Bills').fill('Rent')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('row', { name: /Rent/ })).toBeVisible()

  await page.getByLabel('Assigned for Rent').fill('600')
  await page.getByLabel('Assigned for Rent').press('Enter')
  await expect(ready).toContainText('$400.00')
  await expect(page.getByRole('row', { name: /Rent/ })).toContainText('$600.00')

  // spending from the ledger lowers the envelope, not Ready to Assign
  await sidebar(page)
    .getByRole('link', { name: /Ally HYSA/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Landlord')
  await page.getByLabel('Category').selectOption({ label: 'Rent' })
  await page.getByLabel('Outflow').fill('250')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Landlord/ })).toContainText('$250.00')
  await expect(sidebar(page).getByRole('link', { name: /Ally HYSA/ })).toContainText('$750.00')

  // a transaction without a date is refused inline
  await page.getByLabel('Date').fill('13/45/2026')
  await page.getByLabel('Payee').fill('Bad date')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Enter the date' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(page.getByRole('row', { name: /Rent/ })).toContainText('$350.00')
  await expect(ready).toContainText('$400.00')

  // it all survives a reload
  await page.reload()
  await expect(sidebar(page).getByRole('link', { name: /Ally HYSA/ })).toContainText('$750.00')
  await expect(page.getByRole('row', { name: /Rent/ })).toContainText('$350.00')

  // a group with categories can't be deleted
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Options for Bills' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'categories first' })).toBeVisible()
})
