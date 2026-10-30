import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const sidebar = (page: Page) => page.getByLabel('Budget navigation')
const settingsSidebar = (page: Page) => page.getByLabel('Settings navigation')

async function setUpHousehold(page: Page, name = 'Smith') {
  await page.getByLabel('Household name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(sidebar(page).getByText(name, { exact: true })).toBeVisible()
}

const SETTINGS_SECTIONS = [
  'Household',
  'Connections',
  'Payee rules',
  'Income rules',
  'Imports',
  'Backups',
] as const

/** Opens Settings from the budget sidebar, then one of its pages (the root page when none). */
async function openSettings(page: Page, section?: (typeof SETTINGS_SECTIONS)[number]) {
  await sidebar(page).getByRole('link', { name: 'Settings' }).click()
  if (section) await openSettingsPage(page, section)
  await expect(
    page.getByRole('heading', { name: section ?? 'Settings', exact: true }),
  ).toBeVisible()
}

async function backToBudget(page: Page) {
  await page.getByRole('link', { name: '← Back to budget' }).click()
}

async function openSettingsPage(page: Page, section: (typeof SETTINGS_SECTIONS)[number]) {
  await page
    .getByLabel('Settings navigation')
    .getByRole('link', { name: section, exact: true })
    .click()
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
  await expect(page.getByText('Saved on this device')).toBeVisible()
  await expect(page.getByText('Not saved')).toHaveCount(0)
  await expect(page.getByText(/^Schema version \d+/)).toBeVisible()
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
  // the Offline row shows only until the service worker has cached the app
  await expect(page.getByText('Still getting ready to work without a connection')).toHaveCount(0, {
    timeout: 20_000,
  })
  await backToBudget(page)
  await page.reload()
  await expect(sidebar(page).getByText('Smith', { exact: true })).toBeVisible()
  await expect(sidebar(page).getByText(/^(Matt & Jessica|Jessica & Matt)$/)).toBeVisible()

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
  await openSettings(page, 'Backups')

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
  await page.getByLabel('Import a backup (JSON or SQLite)').setInputFiles(editedPath)
  expect((await safety).suggestedFilename()).toMatch(/^budget-before-import-.*\.sqlite$/)
  await expect(settingsSidebar(page).getByText('Jones', { exact: true })).toBeVisible()

  // import the SQLite image: back to the original
  page.once('dialog', (d) => void d.accept())
  const safety2 = page.waitForEvent('download')
  await page.getByLabel('Import a backup (JSON or SQLite)').setInputFiles(sqlitePath)
  await safety2
  await expect(settingsSidebar(page).getByText(original, { exact: true })).toBeVisible()

  // the swapped-in file is the one that persists
  await page.reload()
  await expect(settingsSidebar(page).getByText(original, { exact: true })).toBeVisible()

  // a bad file is refused and nothing changes
  const junk = testInfo.outputPath('junk.json')
  await writeFile(junk, '{"nope":true}')
  page.once('dialog', (d) => void d.accept())
  await page.getByLabel('Import a backup (JSON or SQLite)').setInputFiles(junk)
  await expect(page.getByRole('alert')).toContainText('Not a Budget-Fi export')
  await expect(settingsSidebar(page).getByText(original, { exact: true })).toBeVisible()
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

  // a group with categories can't be deleted, and the sheet says so instead of offering it
  await page.getByRole('button', { name: 'Bills', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('remove its categories first')
  await expect(page.getByRole('dialog').getByRole('button', { name: /^Delete/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // a category with history is hidden, not deleted: its money goes back to Ready to Assign
  // and its transaction keeps it
  await page.getByRole('button', { name: /^Rent/ }).click()
  await page.getByRole('button', { name: 'Remove…' }).click()
  await expect(page.getByRole('dialog')).toContainText('$350.00 goes back to Ready to Assign')
  await page.getByRole('button', { name: 'Remove Rent' }).click()
  await expect(page.getByRole('row', { name: /^Rent/ })).toHaveCount(0)
  await expect(ready).toContainText('$750.00')
  await page.getByRole('button', { name: 'Show them' }).click()
  await expect(page.getByRole('row', { name: /^Rent/ })).toBeVisible()
  await sidebar(page)
    .getByRole('link', { name: /Ally HYSA/ })
    .click()
  await expect(page.getByRole('row', { name: /Landlord/ })).toContainText('Rent')
})

test('a transaction can be split across categories, on desktop and on a phone', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByLabel('Current balance').fill('1000')
  await dialog.getByRole('button', { name: 'Add account' }).click()

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Home')
  await page.getByRole('button', { name: 'Add group' }).click()
  for (const name of ['Groceries', 'Household']) {
    await page.getByRole('button', { name: 'Add category to Home' }).click()
    await page.getByLabel('New category in Home').fill(name)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible()
  }

  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Target')
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await page.getByLabel('Category 1').selectOption({ label: 'Groceries' })
  await page.getByLabel('Outflow 1').fill('30')
  await page.getByLabel('Category 2').selectOption({ label: 'Household' })
  await page.getByLabel('Outflow 2').fill('12.50')

  // a line without an amount is refused and nothing is saved
  await page.getByRole('button', { name: '+ Add split' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert')).toContainText('Every split needs')
  await page.getByRole('button', { name: 'Remove split 3' }).click()
  await page.getByRole('button', { name: 'Save' }).click()

  const row = page.getByRole('row', { name: /Target/ })
  await expect(row).toContainText('Split (2)')
  await expect(row).toContainText('$42.50')
  await expect(sidebar(page).getByRole('link', { name: /Checking/ })).toContainText('$957.50')

  // editing reopens the lines; drop one and the amount follows
  await row.click()
  await expect(page.getByLabel('Outflow 2')).toHaveValue('12.50')
  await page.getByLabel('Outflow 2').fill('20')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Target/ })).toContainText('$50.00')
  await expect(sidebar(page).getByRole('link', { name: /Checking/ })).toContainText('$950.00')

  // each category is charged only its own part
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(page.getByRole('row', { name: /Groceries/ })).toContainText('-$30.00')
  await expect(page.getByRole('row', { name: /Household/ })).toContainText('-$20.00')

  // on a phone the fields stack, no sideways scrolling needed
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/#/budget')
  await page.getByRole('button', { name: 'Menu' }).click()
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  const inflow = page.getByLabel('Inflow', { exact: true })
  await expect(inflow).toBeInViewport({ ratio: 1 })
  // the fields stack at full width rather than collapsing into a narrow strip
  const payeeBox = await page.getByLabel('Payee').boundingBox()
  expect(payeeBox!.width).toBeGreaterThan(280)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  await page.getByLabel('Payee').fill('Phone purchase')
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
  await page.getByLabel('Outflow', { exact: true }).fill('5')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Phone purchase/ })).toContainText('$5.00')
})

test('credit card payments, transfers, reconciliation and the activity feed', async ({ page }) => {
  await page.goto('/')
  await setUpHousehold(page)
  async function addAccount(name: string, type: string, balance: string) {
    await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Account name').fill(name)
    await dialog.getByLabel('Account type').selectOption(type)
    await dialog.getByLabel('Current balance').fill(balance)
    await dialog.getByRole('button', { name: 'Add account' }).click()
    await expect(page.getByRole('heading', { name })).toBeVisible()
  }
  await addAccount('Checking', 'checking', '1000')
  await addAccount('Visa', 'credit', '')

  // the card got a payment category of its own
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Home')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Home' }).click()
  await page.getByLabel('New category in Home').fill('Groceries')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('row', { name: /Groceries/ })).toBeVisible()
  const payment = page.getByRole('row', { name: /^Visa/ })
  await expect(payment).toBeVisible()
  // the app manages it: no rename or delete
  await payment.getByRole('button').click()
  const managed = page.getByRole('dialog')
  await expect(managed.getByRole('button', { name: 'Hide' })).toBeVisible()
  await expect(managed.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await expect(managed.getByRole('button', { name: 'Remove…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByLabel('Assigned for Groceries').fill('100')
  await page.getByLabel('Assigned for Groceries').press('Enter')

  // a card purchase moves its amount into the card's payment category
  await sidebar(page).getByRole('link', { name: /Visa/ }).click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Kroger')
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' })
  await page.getByLabel('Outflow').fill('30')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Kroger/ })).toContainText('$30.00')
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(page.getByRole('row', { name: /Groceries/ })).toContainText('$70.00')
  await expect(page.getByRole('row', { name: /^Visa/ })).toContainText('$30.00')

  // paying the card is a transfer, and it draws the payment category down
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transfer' }).click()
  const transfer = page.getByRole('dialog')
  await transfer.getByLabel('To').selectOption({ label: 'Visa' })
  await transfer.getByLabel('Amount').fill('30')
  await transfer.getByRole('button', { name: 'Add transfer' }).click()
  const row = page.getByRole('row', { name: /Transfer: Visa/ })
  await expect(row).toContainText('$30.00')
  await expect(sidebar(page).getByRole('link', { name: /Checking/ })).toContainText('$970.00')
  await expect(sidebar(page).getByRole('link', { name: /Visa/ })).toContainText('$0.00')
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(page.getByRole('row', { name: /^Visa/ })).not.toContainText('$30.00')

  // editing one leg of a transfer carries the amount to the other; no payee to edit
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('row', { name: /Transfer: Visa/ }).click()
  await expect(page.getByLabel('Payee')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toHaveCount(0)
  await page.getByLabel('Outflow').fill('35')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(sidebar(page).getByRole('link', { name: /Visa/ })).toContainText('$5.00')

  // reconcile: the bank says $990 but the app has $1,000 cleared, so it posts an adjustment
  await page.getByRole('button', { name: 'Reconcile' }).click()
  const reconcile = page.getByRole('dialog')
  await expect(reconcile).toContainText('$1,000.00')
  await reconcile.getByLabel('Balance at your bank').fill('990')
  await expect(reconcile).toContainText('-$10.00')
  await reconcile.getByRole('button', { name: 'Reconcile with adjustment' }).click()
  await expect(reconcile.getByRole('status')).toContainText('adjustment of -$10.00')
  await reconcile.getByRole('button', { name: 'Done' }).click()
  const adjustment = page.getByRole('row', { name: /Reconciliation Balance Adjustment/ })
  await expect(adjustment).toContainText('$10.00')
  await expect(adjustment.getByRole('button', { name: /Cleared/ })).toBeDisabled()
  // reconciled transactions are locked: the Starting Balance can't be deleted
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('row', { name: /Starting Balance/ }).click()
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'reconciled' })).toBeVisible()

  // the activity feed says who did what once the device is named
  await openSettings(page, 'Household')
  await page.getByLabel('Device name').fill('Test laptop')
  await page.getByLabel('Used by').selectOption({ label: 'Matt' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await backToBudget(page)
  await page.getByLabel('Assigned for Groceries').fill('120')
  await page.getByLabel('Assigned for Groceries').press('Enter')
  await sidebar(page).getByRole('link', { name: 'Activity' }).click()
  const feed = page.getByRole('list', { name: 'Activity' })
  await expect(feed.getByRole('listitem').first()).toContainText('Matt')
  await expect(feed).toContainText('Added account “Visa”')
  await expect(feed).toContainText('Transferred $30.00 out of Checking')
  await expect(feed).toContainText('Added “Kroger” for -$30.00 in Visa')
})

test('imported transactions wait in the inbox until they are categorized and approved', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await setUpHousehold(page)
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByLabel('Current balance').fill('500')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Food')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Food' }).click()
  await page.getByLabel('New category in Food').fill('Groceries')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('row', { name: /Groceries/ })).toBeVisible()

  // The bank fetch needs a real SimpleFIN account, so stand in for it: add what an import
  // writes (an unapproved, cleared transaction with the bank's id) to an exported budget.
  await openSettings(page, 'Backups')
  const jsonPath = testInfo.outputPath('budget.json')
  await exportAs(page, 'Export JSON', jsonPath)
  const exported = JSON.parse(await readFile(jsonPath, 'utf8'))
  const start = exported.tables.transactions[0]
  const startSplit = exported.tables.transaction_splits[0]
  exported.tables.transactions.push({
    ...start,
    id: 'import-ACT-1:T1',
    date: '2026-10-20',
    payee: 'KROGER #123',
    amount: -4250,
    cleared: 1,
    approved: 0,
    import_id: 'ACT-1:T1',
  })
  exported.tables.transaction_splits.push({
    ...startSplit,
    id: 'import-ACT-1:T1:split',
    transaction_id: 'import-ACT-1:T1',
    category_id: null,
    amount: -4250,
  })
  const withImport = testInfo.outputPath('with-import.json')
  await writeFile(withImport, JSON.stringify(exported))
  page.once('dialog', (d) => void d.accept())
  const safety = page.waitForEvent('download')
  await page.getByLabel('Import a backup (JSON or SQLite)').setInputFiles(withImport)
  await safety

  await backToBudget(page)
  await expect(sidebar(page).getByRole('link', { name: /Inbox/ })).toContainText('1')
  await sidebar(page).getByRole('link', { name: /Inbox/ }).click()
  const row = page.getByRole('row', { name: /KROGER #123/ })
  await expect(row).toContainText('$42.50')

  // the register flags it as new until it is approved
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await expect(page.getByRole('row', { name: /KROGER #123/ })).toContainText('New')
  await sidebar(page).getByRole('link', { name: /Inbox/ }).click()

  await page.getByLabel('Category for KROGER #123').selectOption({ label: 'Groceries' })
  await page.getByRole('button', { name: 'Approve KROGER #123' }).click()
  await expect(page.getByText('Nothing to review')).toBeVisible()
  await expect(sidebar(page).getByRole('link', { name: /Inbox/ })).not.toContainText('1')

  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  const approved = page.getByRole('row', { name: /KROGER #123/ })
  await expect(approved).toContainText('Groceries')
  await expect(approved).not.toContainText('New')
})

test('YNAB history comes in from its export, and payee rules can use the new categories', async ({
  page,
}) => {
  const register = [
    'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
    'Checking,,10/01/2026,Starting Balance,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,"$3,000.00",Reconciled',
    'Checking,,10/15/2026,Kroger,Food: Groceries,Food,Groceries,,$120.50,$0.00,Cleared',
    'Checking,,10/16/2026,Transfer : Savings,,,,,$500.00,$0.00,Cleared',
    'Savings,,10/16/2026,Transfer : Checking,,,,,$0.00,$500.00,Cleared',
  ].join('\n')
  const budget = [
    'Month,Category Group/Category,Category Group,Category,Budgeted,Activity,Available',
    'October 2026,Food: Groceries,Food,Groceries,$400.00,-$120.50,$279.50',
  ].join('\n')

  await page.goto('/')
  await setUpHousehold(page)
  await openSettings(page, 'Imports')

  await page.getByLabel('Register.csv').setInputFiles({
    name: 'Register.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(register),
  })
  await page.getByLabel('Budget.csv (optional)').setInputFiles({
    name: 'Budget.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(budget),
  })
  await page.getByRole('button', { name: 'Read files' }).click()
  await expect(page.getByText(/2 transactions.*1 transfer between/)).toBeVisible()
  await expect(page.getByLabel('Type of the new Savings account')).toHaveValue('savings')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByText('Imported 2 transactions')).toBeVisible()
  await expect(page.getByText(/matches YNAB’s Budget\.csv/)).toBeVisible()

  // the history is in the ledger: balances, the category and its assignment
  await backToBudget(page)
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(page.getByRole('row', { name: /Groceries/ })).toBeVisible()
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await expect(page.getByRole('row', { name: /Kroger/ })).toContainText('$120.50')
  await expect(sidebar(page)).toContainText('$2,379.50')

  // a second import is refused
  await openSettings(page, 'Imports')
  await page.getByLabel('Register.csv').setInputFiles({
    name: 'Register.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(register),
  })
  await page.getByRole('button', { name: 'Read files' }).click()
  await page.getByLabel('Where Checking goes').selectOption({ label: 'Checking' })
  await page.getByLabel('Where Savings goes').selectOption({ label: 'Savings' })
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('already been imported')

  // a payee rule onto an imported category
  await openSettingsPage(page, 'Payee rules')
  await page.getByLabel('Payee contains').fill('Kroger')
  await page.getByLabel('Category for the new rule').selectOption({ label: 'Groceries' })
  await page.getByRole('button', { name: 'Add rule' }).click()
  await expect(page.getByText('Kroger', { exact: true })).toBeVisible()
  await expect(page.getByText('Food: Groceries')).toBeVisible()
  await page.getByRole('button', { name: 'Delete the rule for Kroger' }).click()
  await expect(page.getByText('No rules yet')).toBeVisible()
})

test('an investment account is set up in the add-account dialog and keeps a value history', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)

  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Fidelity')
  // the investment settings only appear for an investment account
  await expect(dialog.getByLabel('Tax type')).toHaveCount(0)
  await dialog.getByLabel('Account type').selectOption('investment')
  await expect(dialog.getByLabel('Investment type')).toHaveValue('brokerage')
  await expect(dialog.getByLabel('Tax type').getByRole('option')).toHaveText(['Taxable'])
  await dialog.getByLabel('Investment type').selectOption({ label: '401(k)' })
  await expect(dialog.getByLabel('Tax type')).toHaveValue('traditional')
  await expect(dialog.getByLabel('Tax type').getByRole('option')).toHaveText([
    'Traditional',
    'Roth',
  ])
  await dialog.getByLabel('Tax type').selectOption({ label: 'Roth' })
  await dialog.getByLabel('Owner').selectOption({ label: 'Jessica' })
  await dialog.getByLabel('Mode').selectOption('holdings')
  await dialog.getByRole('button', { name: 'Add account' }).click()

  await expect(page.getByRole('heading', { name: 'Fidelity' })).toBeVisible()
  // the details stay closed until the gear is pressed
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Investment settings and values for Fidelity' }).click()
  const card = page.getByRole('dialog')
  await expect(card.getByLabel('Investment type')).toHaveValue('401k')
  await expect(card.getByLabel('Tax type')).toHaveValue('roth')
  await expect(card.getByLabel('Owner')).toContainText('Jessica')
  await expect(card.getByLabel('Mode')).toHaveValue('holdings')
  await expect(card).toContainText('No value recorded yet')

  await card.getByLabel('Date').fill('2026-10-31')
  await card.getByLabel('Market value').fill('84200')
  await card.getByRole('button', { name: 'Save value' }).click()
  await expect(card).toContainText('$84,200.00')
  await expect(card).toContainText('on 10/31/2026, entered')

  // recording the day again replaces it
  await card.getByLabel('Market value').fill('84250')
  await card.getByRole('button', { name: 'Save value' }).click()
  await expect(card.getByRole('listitem')).toHaveCount(1)
  await expect(card).toContainText('$84,250.00')

  // the settings can still be changed, and everything survives a reload
  await card.getByLabel('Tax type').selectOption({ label: 'Traditional' })
  // changing to a kind that doesn't allow the tax type moves it to that kind's usual one
  await card.getByLabel('Investment type').selectOption({ label: '529 plan' })
  await expect(card.getByLabel('Tax type')).toHaveValue('529')
  await card.getByLabel('Investment type').selectOption({ label: 'IRA' })
  await card.getByLabel('Tax type').selectOption({ label: 'Traditional' })
  await card.getByRole('button', { name: 'Done' }).click()
  await expect(card).toBeHidden()
  await page.reload()
  await page.getByRole('button', { name: 'Investment settings and values for Fidelity' }).click()
  await expect(card.getByLabel('Investment type')).toHaveValue('ira')
  await expect(card.getByLabel('Tax type')).toHaveValue('traditional')
  await expect(card.getByLabel('Mode')).toHaveValue('holdings')
  await expect(card).toContainText('$84,250.00')

  await card.getByRole('button', { name: /Delete the value from 10\/31\/2026/ }).click()
  await expect(card).toContainText('No value recorded yet')
  await card.getByRole('button', { name: 'Done' }).click()

  // a checking account has none of this
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Checking' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Investment settings and values/ })).toHaveCount(0)
})

test('goals: create, fund, spend from, and archive', async ({ page }) => {
  await page.goto('/')
  await setUpHousehold(page)
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByLabel('Current balance').fill('1000')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Checking' })).toBeVisible()

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Savings')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Savings' }).click()
  await page.getByLabel('New category in Savings').fill('Household')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // a goal with a target and a date far enough out that only the label is stable
  await page.getByRole('button', { name: new RegExp('^Household (Need|Want)') }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add goal' }).click()
  await page.getByLabel('Goal name').fill('Laptop')
  await page.getByLabel('Target amount').fill('1200')
  await page.getByLabel('Target date (optional)').fill('2099-12-31')
  await page.getByRole('button', { name: 'Add goal' }).click()
  const goal = page.getByRole('row', { name: /Laptop/ })
  await expect(goal).toContainText('0% of $1,200.00')
  await expect(goal).toContainText(/\/mo for Dec 2099/)

  // funding the goal counts in its category and takes the money from Ready to Assign
  await page.getByLabel('Assigned for goal Laptop').fill('300')
  await page.getByLabel('Assigned for goal Laptop').press('Enter')
  await expect(goal).toContainText('25% of $1,200.00')
  await expect(page.getByRole('row', { name: /^Household/ })).toContainText('$300.00')
  await expect(page.getByRole('status').filter({ hasText: 'Ready to Assign' })).toContainText(
    '$700.00',
  )

  // spending picks the goal; it is a draw-down, not overspending
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Apple')
  await page.getByLabel('Category', { exact: true }).selectOption({ label: '  ↳ Laptop' })
  await page.getByLabel('Outflow').fill('100')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Apple/ })).toContainText('Household: Laptop')

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(goal).toContainText('16% of $1,200.00')
  await expect(goal).toContainText('$200.00')
  await expect(page.getByRole('row', { name: /^Household/ })).toContainText('$200.00')

  // archiving hands what is left back to the category and tucks the goal away
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Options for goal Laptop' }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(page.getByRole('row', { name: /Laptop/ })).toHaveCount(0)
  await expect(page.getByRole('row', { name: /^Household/ })).toContainText('$200.00')
  await page.getByRole('button', { name: 'Show them' }).click()
  await expect(page.getByRole('row', { name: /Laptop/ })).toContainText('Archived')

  // the goal survives a reload
  await page.reload()
  await page.getByRole('button', { name: 'Show them' }).click()
  await expect(page.getByRole('row', { name: /Laptop/ })).toContainText('Archived')
})

test('goals held in an account warn when they add up to more than the account has', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)
  for (const [name, type, balance] of [
    ['Checking', 'checking', '1000'],
    ['Ally HYSA', 'savings', '100'],
  ]) {
    await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Account name').fill(name!)
    await dialog.getByLabel('Account type').selectOption(type!)
    await dialog.getByLabel('Current balance').fill(balance!)
    await dialog.getByRole('button', { name: 'Add account' }).click()
    await expect(page.getByRole('heading', { name: name! })).toBeVisible()
  }

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Savings')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Savings' }).click()
  await page.getByLabel('New category in Savings').fill('Emergency')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await page.getByRole('button', { name: new RegExp('^Emergency (Need|Want)') }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add goal' }).click()
  await page.getByLabel('Goal name').fill('Six months')
  await page.getByLabel('Target amount').fill('5000')
  await page.getByLabel('Held in account (optional)').selectOption({ label: 'Held in Ally HYSA' })
  await page.getByRole('button', { name: 'Add goal' }).click()
  const goal = page.getByRole('row', { name: /Six months/ })
  await expect(goal).toContainText('Held in Ally HYSA')

  // within what the account has: no warning
  await page.getByLabel('Assigned for goal Six months').fill('80')
  await page.getByLabel('Assigned for goal Six months').press('Enter')
  await expect(goal).toContainText('1% of $5,000.00')
  await expect(page.getByText(/isn’t there/)).toHaveCount(0)

  // past it: the budget says how much of the money isn't in the account
  await page.getByLabel('Assigned for goal Six months').fill('300')
  await page.getByLabel('Assigned for goal Six months').press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'isn’t there' })).toContainText(
    'Ally HYSA has $100.00, but the goals held in it add up to $300.00. $200.00 of that money isn’t there.',
  )

  // the account can be changed, and it survives a reload
  await page.getByRole('button', { name: 'Options for goal Six months' }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  await page.getByLabel('Held in account (optional)').selectOption({ label: 'Held in Checking' })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/isn’t there/)).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('row', { name: /Six months/ })).toContainText('Held in Checking')
})

test('needs vs wants: category tags, split overrides, and the report', async ({ page }) => {
  await page.goto('/')
  await setUpHousehold(page)
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByLabel('Current balance').fill('1000')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Checking' })).toBeVisible()

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Everyday')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Everyday' }).click()
  await page.getByLabel('New category in Everyday').fill('Groceries')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // a new category is a want until it is marked
  const category = page.getByRole('row', { name: /^Groceries/ })
  await expect(category).toContainText('Want')
  await page.getByRole('button', { name: new RegExp('^Groceries (Need|Want)') }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mark as need' }).click()
  await expect(category).toContainText('Need')
  await page.keyboard.press('Escape')

  // groceries are a need, the wine on the same receipt is a want
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Market')
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await page.getByLabel('Category 1').selectOption({ label: 'Groceries' })
  await page.getByLabel('Outflow 1').fill('80')
  await page.getByLabel('Category 2').selectOption({ label: 'Groceries' })
  await page.getByLabel('Outflow 2').fill('20')
  await expect(page.getByLabel('Need or want 1')).toHaveValue('')
  await page.getByLabel('Need or want 2').selectOption({ label: 'Want' })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Market/ })).toContainText('Split (2)')

  // the override is kept when the transaction is opened again
  await page.getByRole('row', { name: /Market/ }).click()
  await expect(page.getByLabel('Need or want 2')).toHaveValue('want')
  await expect(page.getByLabel('Need or want 1')).toHaveValue('')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // the report opens on the last complete month; this month's spending is one step on
  await sidebar(page).getByRole('link', { name: 'Reports' }).click()
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Average month' })).toContainText('3 months')
  await page.getByRole('button', { name: 'Next month' }).click()
  const thisMonth = page.getByRole('region', { name: 'By month' }).getByRole('row').nth(1)
  await expect(thisMonth).toContainText('$80.00')
  await expect(thisMonth).toContainText('$20.00')
  await expect(thisMonth).toContainText('$100.00')
  await expect(thisMonth).toContainText('80%')
  // a month's spending is the whole average while it is the only month with any
  const averages = page.getByRole('region', { name: 'Average month' })
  await expect(averages.getByRole('row', { name: /3 months/ })).toContainText('only 1 of history')
  await expect(averages.getByRole('row', { name: /3 months/ })).toContainText('$80.00')

  // the emergency fund is a category sized against the average Need month ($80 here)
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: 'Add category to Everyday' }).click()
  await page.getByLabel('New category in Everyday').fill('Emergency Fund')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByLabel('Assigned for Emergency Fund').fill('160')
  await page.getByLabel('Assigned for Emergency Fund').press('Enter')
  await expect(page.getByRole('row', { name: /^Emergency Fund/ })).toContainText('$160.00')

  await sidebar(page).getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('button', { name: 'Next month' }).click()
  const fund = page.getByRole('region', { name: 'Emergency fund' })
  await expect(fund).toContainText('Pick the category that is your emergency fund')
  await fund.getByLabel('Emergency fund category').selectOption({ label: 'Emergency Fund' })
  await fund.getByLabel('Months of coverage').selectOption('6')
  await fund.getByRole('button', { name: 'Save' }).click()
  await expect(fund).toContainText('$160.00')
  await expect(fund).toContainText('$480.00')
  await expect(fund.getByText('2.0', { exact: true })).toBeVisible()

  // the choice survives a reload
  await page.reload()
  await expect(page.getByRole('region', { name: 'Emergency fund' })).toContainText('Emergency Fund')
})

test('income rules: a paycheck feeds the tithe, and taking it back reverses that', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Checking' })).toBeVisible()

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Giving')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Giving' }).click()
  await page.getByLabel('New category in Giving').fill('Tithe')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // 10% of gross pay, before anything else
  await openSettings(page, 'Income rules')
  await page.getByLabel('Name', { exact: true }).fill('Tithe')
  await page.getByLabel('Payee contains').fill('Acme Payroll')
  await page.getByLabel('Percent', { exact: true }).fill('10')
  await page.getByLabel('Net or gross').selectOption('gross')
  await page.getByLabel('Envelope for the new rule').selectOption({ label: 'Tithe' })
  await page.getByRole('button', { name: 'Add rule' }).click()
  await expect(page.getByText('“Acme Payroll” → 10% of gross pay → Tithe')).toBeVisible()
  await backToBudget(page)

  // the paycheck, with its gross pay typed on it
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Acme Payroll')
  await page.getByLabel('Inflow').fill('2411.37')
  await page.getByLabel('Gross pay').fill('3100')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Acme Payroll/ })).toContainText('$2,411.37')

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  const ready = page.getByRole('status').filter({ hasText: 'Ready to Assign' })
  await expect(page.getByRole('row', { name: /^Tithe/ })).toContainText('$310.00')
  await expect(ready).toContainText('$2,101.37')

  // the month check agrees with the ledger
  await openSettings(page, 'Income rules')
  const check = page.getByRole('region', { name: 'Check a month' })
  await expect(check).toContainText('Acme Payroll')
  await expect(check.getByRole('button', { name: /Apply the rules/ })).toHaveCount(0)
  await backToBudget(page)

  // the paycheck is reversed: an outflow that takes the deposit back
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Acme Payroll reversal')
  await page.getByLabel('Outflow').fill('2411.37')
  await page.getByLabel('Takes back the deposit').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /reversal/ })).toContainText('$2,411.37')

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await expect(page.getByRole('row', { name: /^Tithe/ })).toContainText('$0.00')
  await expect(page.getByRole('status').filter({ hasText: 'All money assigned' })).toBeVisible()

  // the rule and its work survive a reload
  await page.reload()
  await expect(page.getByRole('row', { name: /^Tithe/ })).toContainText('$0.00')
})

test('investment goals own units of an account, and Roth contributions count against the limit', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)
  const dialog = page.getByRole('dialog')
  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Account type').selectOption('checking')
  await dialog.getByLabel('Current balance').fill('5000')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Checking' })).toBeVisible()

  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  await dialog.getByLabel('Account name').fill('Brokerage')
  await dialog.getByLabel('Account type').selectOption('investment')
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Brokerage' })).toBeVisible()

  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  await dialog.getByLabel('Account name').fill('Jessica Roth')
  await dialog.getByLabel('Account type').selectOption('investment')
  await dialog.getByLabel('Investment type').selectOption({ label: 'IRA' })
  await dialog.getByLabel('Tax type').selectOption({ label: 'Roth' })
  await dialog.getByLabel('Owner').selectOption({ label: 'Jessica' })
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Jessica Roth' })).toBeVisible()

  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Savings')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Savings' }).click()
  await page.getByLabel('New category in Savings').fill('Investing')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: new RegExp('^Investing (Need|Want)') }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add goal' }).click()
  await page.getByLabel('Goal name').fill('House')
  await page.getByLabel('Target amount').fill('50000')
  await page.getByRole('button', { name: 'Add goal' }).click()

  // a cleared transfer for the goal buys units of the brokerage for it
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transfer' }).click()
  await dialog.getByLabel('To').selectOption({ label: 'Brokerage' })
  await dialog.getByLabel('Amount').fill('500')
  await dialog.getByLabel('Category').selectOption({ label: 'Investing' })
  await dialog.getByLabel('Goal').selectOption({ label: 'House' })
  await expect(dialog).toContainText('buys units of Brokerage for the goal')
  await dialog.getByLabel('Already cleared at the bank').check()
  await dialog.getByRole('button', { name: 'Add transfer' }).click()
  await expect(page.getByRole('row', { name: /Transfer: Brokerage/ })).toContainText(
    'Investing: House',
  )

  await sidebar(page)
    .getByRole('link', { name: /^Brokerage/ })
    .click()
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  const goals = page.getByRole('dialog')
  const house = goals.getByRole('row', { name: /^House/ })
  await expect(house).toContainText('500 units')
  await expect(house).toContainText('$500.00')
  await expect(house).toContainText('$0.00')
  await goals.getByRole('button', { name: 'Done' }).click()

  // the account is now worth more: the goal's gain follows, and its cost basis stays
  await page.getByRole('button', { name: 'Investment settings and values for Brokerage' }).click()
  await dialog.getByLabel('Market value').fill('600')
  await dialog.getByRole('button', { name: 'Save value' }).click()
  await expect(dialog).toContainText('$600.00')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(house).toContainText('$600.00')
  await expect(house).toContainText('+$100.00')
  await expect(goals.getByRole('row', { name: /^Total/ })).toContainText('$500.00')

  // what the goal owns can be moved to another bucket without a gain or loss
  await goals.getByLabel('To').selectOption({ label: 'Unassigned' })
  await goals.getByLabel('From').selectOption({ label: 'House' })
  await goals.getByLabel('Amount').fill('120')
  await goals.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(goals.getByRole('row', { name: /^Unassigned/ })).toContainText('$120.00')
  await expect(house).toContainText('$480.00')
  await goals.getByRole('button', { name: 'Done' }).click()

  // a contribution to a Roth IRA counts against its owner's limit
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transfer' }).click()
  await dialog.getByLabel('To').selectOption({ label: 'Jessica Roth' })
  await dialog.getByLabel('Amount').fill('1000')
  await dialog.getByRole('button', { name: 'Add transfer' }).click()
  await expect(page.getByRole('row', { name: /Transfer: Jessica Roth/ })).toBeVisible()
  await sidebar(page).getByRole('link', { name: 'Reports' }).click()
  const roth = page.getByRole('region', { name: 'Roth IRA contributions' })
  await expect(roth).toContainText('Jessica')
  await expect(roth).toContainText('$1,000.00 of $7,500.00')
  await roth.getByRole('button', { name: /Change Jessica’s limit/ }).click()
  await roth.getByLabel(/Jessica’s limit for/).fill('8600')
  await roth.getByRole('button', { name: 'Save limit' }).click()
  await expect(roth).toContainText('$1,000.00 of $8,600.00')
  await expect(roth).toContainText('your limit')
})

test('reports show net worth, a retirement projection and each category’s retirement status', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)

  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Current balance').fill('1000')
  await dialog.getByRole('button', { name: 'Add account' }).click()

  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  await dialog.getByLabel('Account name').fill('Work 401k')
  await dialog.getByLabel('Account type').selectOption('investment')
  await dialog.getByLabel('Investment type').selectOption({ label: '401(k)' })
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await page.getByRole('button', { name: 'Investment settings and values for Work 401k' }).click()
  await dialog.getByLabel('Market value').fill('50000')
  await dialog.getByRole('button', { name: 'Save value' }).click()
  await expect(dialog).toContainText('$50,000.00')
  await dialog.getByRole('button', { name: 'Done' }).click()

  await sidebar(page).getByRole('link', { name: 'Reports' }).click()
  const netWorth = page.getByRole('region', { name: 'Net worth' })
  await expect(netWorth).toContainText('$51,000.00')
  await expect(netWorth.getByRole('img', { name: /Net worth by month/ })).toBeVisible()
  await expect(netWorth).toContainText('Work 401k')

  // no birth month, no projection
  const retirement = page.getByRole('region', { name: 'Retirement projection' })
  await expect(retirement).toContainText('Enter a birth month')
  await expect(retirement).toContainText('Work 401k ($50,000.00)')
  await retirement.getByLabel('Birth month').fill('1996-01')
  await retirement.getByLabel('Target age').fill('40')
  await retirement.getByLabel('Monthly contribution').fill('1000')
  await retirement.getByLabel('Yearly return').fill('3')
  await retirement.getByLabel('Yearly inflation').fill('3')
  await retirement.getByRole('button', { name: 'Save' }).click()
  // no growth after inflation, so only the contributions add up
  await expect(
    retirement.getByRole('img', { name: /Projected retirement portfolio/ }),
  ).toBeVisible()
  await expect(retirement.locator('.hero-figure')).toContainText('$')
  await expect(retirement).toContainText('Still to contribute')

  // a bad value is refused inline and keeps what was saved
  await retirement.getByLabel('Target age').fill('20')
  await retirement.getByRole('button', { name: 'Save' }).click()
  await expect(retirement.getByRole('alert')).toContainText('target age')

  // a category's status in retirement is set from its menu and survives a reload
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Bills')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Bills' }).click()
  await page.getByLabel('New category in Bills').fill('Travel')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: new RegExp('^Travel (Need|Want)') }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'In retirement…' }).click()
  const status = page.getByRole('dialog')
  await status.getByLabel(/^Changes/).check()
  await status.getByLabel('Multiplier').fill('1.5')
  await status.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Travel/ })).toContainText('×1.5')
  await page.reload()
  await expect(page.getByRole('row', { name: /Travel/ })).toContainText('×1.5')

  await page.getByRole('button', { name: new RegExp('^Travel (Need|Want)') }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'In retirement…' }).click()
  await status.getByLabel(/^Ends/).check()
  await status.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Travel/ })).toContainText('Ends')
})

/** `YYYY-MM-DD` for today plus `days`, in the browser's local time like the app. */
function isoIn(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

test('bills feed a cash-flow forecast, and the monthly review fixes an overspent category', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)

  await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill('Checking')
  await dialog.getByLabel('Current balance').fill('2000')
  await dialog.getByRole('button', { name: 'Add account' }).click()

  // a bill that fits is fine; one that does not is called out with the day it happens
  await sidebar(page).getByRole('link', { name: 'Bills', exact: true }).click()
  const forecast = page.getByRole('region', { name: 'Cash-flow forecast' })
  await expect(forecast).toContainText('Cash stays above zero')
  const items = page.getByRole('region', { name: 'Recurring bills and income' })
  const add = async (payee: string, amount: string, date: string) => {
    await items.getByLabel('Recurring payee').fill(payee)
    await items.getByLabel('Recurring amount').fill(amount)
    await items.getByLabel('Recurring next due').fill(date)
    // yearly, so exactly one occurrence falls in the forecast whatever day this runs
    await items.getByLabel('Recurring cadence').selectOption('yearly')
    await items.getByRole('button', { name: 'Add item' }).click()
    await expect(items.getByRole('row', { name: new RegExp(payee) })).toBeVisible()
  }
  await add('Landlord', '1500', isoIn(1))
  await expect(forecast).toContainText('Cash stays above zero')
  await add('Insurance', '1000', isoIn(3))
  await expect(forecast).toContainText('Cash runs out')
  await expect(forecast.getByRole('img', { name: /Projected cash/ })).toBeVisible()
  await expect(forecast).toContainText('-$500.00')

  // the calendar shows what is due, and a bad form is refused inline
  const calendar = page.getByRole('region', { name: 'Bills calendar' })
  await expect(calendar).toContainText('Landlord')
  await items.getByRole('button', { name: 'Add item' }).click()
  await expect(items.getByRole('alert')).toContainText('paid to')

  // marking a bill paid moves it a year on, so the forecast no longer counts it
  await items.getByRole('button', { name: 'Mark Insurance paid' }).click()
  await expect(forecast).toContainText('Cash stays above zero')
  await items.getByRole('button', { name: 'Delete Landlord' }).click()
  await expect(items.getByRole('row', { name: /Landlord/ })).toHaveCount(0)

  // an overspent category shows up in the review with a move that covers it
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Everyday')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Everyday' }).click()
  await page.getByLabel('New category in Everyday').fill('Groceries')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByLabel('Assigned for Groceries').fill('100')
  await page.getByLabel('Assigned for Groceries').press('Enter')
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Market')
  await page.getByLabel('Category').selectOption({ label: 'Groceries' })
  await page.getByLabel('Outflow').fill('150')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Market/ })).toContainText('$150.00')

  await sidebar(page).getByRole('link', { name: 'Review', exact: true }).click()
  const went = page.getByRole('region', { name: 'Went over' })
  await expect(went).toContainText('Groceries')
  await expect(went).toContainText('$50.00 over')
  const moves = page.getByRole('region', { name: 'Suggested moves' })
  await expect(moves).toContainText('Move $50.00 from Ready to Assign to Groceries')
  await moves.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('region', { name: 'Went over' })).toHaveCount(0)
  await expect(page.getByText('Nothing needs fixing.')).toBeVisible()
})

test('reports estimate retirement spending, check it against the portfolio and plan a 529', async ({
  page,
}) => {
  await page.goto('/')
  await setUpHousehold(page)

  async function addAccount(name: string, type: string, balance: string, kind?: string) {
    await sidebar(page).getByRole('button', { name: '+ Add Account' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Account name').fill(name)
    await dialog.getByLabel('Account type').selectOption(type)
    if (kind) await dialog.getByLabel('Investment type').selectOption({ label: kind })
    if (!kind) await dialog.getByLabel('Current balance').fill(balance)
    await dialog.getByRole('button', { name: 'Add account' }).click()
  }
  await addAccount('Checking', 'checking', '5000')
  await addAccount('College 529', 'investment', '', '529 plan')

  // a category with spending that continues
  await sidebar(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Everyday')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Everyday' }).click()
  await page.getByLabel('New category in Everyday').fill('Rent')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await sidebar(page)
    .getByRole('link', { name: /Checking/ })
    .click()
  await page.getByRole('button', { name: '+ Add Transaction' }).click()
  await page.getByLabel('Payee').fill('Landlord')
  await page.getByLabel('Category').selectOption({ label: 'Rent' })
  await page.getByLabel('Outflow').fill('2000')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('row', { name: /Landlord/ })).toContainText('$2,000.00')

  await sidebar(page).getByRole('link', { name: 'Reports' }).click()
  // the report opens on the last complete month; step forward to the one with the spending
  await page.getByRole('button', { name: 'Next month' }).click()
  const spend = page.getByRole('region', { name: 'Retirement spending' })
  // $2,000 a month at a 4% withdrawal rate needs $600,000
  await expect(spend.locator('.hero-figure')).toContainText('$600,000.00')
  await expect(spend).toContainText('$24,000.00 a year')
  await expect(spend.getByRole('row', { name: /Rent/ })).toContainText('$2,000.00')

  // a cost that doesn't exist today is added on, and can be edited and removed
  await spend.getByLabel('Cost name').fill('Health insurance')
  await spend.getByLabel('Cost per year').fill('12000')
  await spend.getByRole('button', { name: 'Add cost' }).click()
  await expect(spend).toContainText('Health insurance')
  await expect(spend).toContainText('all of retirement')
  await expect(spend.locator('.hero-figure')).toContainText('$900,000.00')
  await spend.getByRole('button', { name: 'Edit Health insurance' }).click()
  await spend.getByLabel('Cost end age').fill('60')
  await spend.getByRole('button', { name: 'Save cost' }).click()
  await expect(spend).toContainText('until 60')
  await expect(spend).toContainText('not at 65')
  await expect(spend.locator('.hero-figure')).toContainText('$600,000.00')

  // a bad value is refused inline
  await spend.getByLabel('Withdrawal rate').fill('0')
  await spend.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(spend.getByRole('alert')).toContainText('withdrawal rate')
  await spend.getByLabel('Withdrawal rate').fill('5')
  await spend.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(spend.locator('.hero-figure')).toContainText('$480,000.00')

  // with no portfolio the check says why; a birth month brings the comparison
  await expect(spend).toContainText('Enter a birth month')
  const retirement = page.getByRole('region', { name: 'Retirement projection' })
  await retirement.getByLabel('Birth month').fill('1996-01')
  await retirement.getByRole('button', { name: 'Save' }).click()
  await expect(spend.getByRole('status').filter({ hasText: 'Short by' })).toBeVisible()
  // saving the projection's form kept the spending assumptions
  await expect(spend.getByLabel('Withdrawal rate')).toHaveValue('5')

  // a 529 plan
  const education = page.getByRole('region', { name: 'Education savings' })
  await education.getByLabel('Plan name').fill('Emma')
  await education.getByLabel('Plan account').selectOption({ label: 'College 529' })
  await education.getByLabel('Education cost').fill('80000')
  await education.getByLabel('Plan month').fill('2040-08')
  await education.getByLabel('Plan contribution').fill('200')
  await education.getByRole('button', { name: 'Add plan' }).click()
  await expect(education).toContainText('Emma')
  await expect(education).toContainText('short by')
  await expect(education).toContainText('a month would close it')
  // saving more a month gets there; the plan is edited in place, not duplicated
  await education.getByRole('button', { name: 'Edit Emma’s plan' }).click()
  await education.getByLabel('Plan contribution').fill('5000')
  await education.getByRole('button', { name: 'Save plan' }).click()
  await expect(education).toContainText('on track')
  await expect(education.getByLabel('Emma’s education savings')).toHaveCount(1)

  // it all survives a reload
  await page.reload()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByRole('region', { name: 'Retirement spending' })).toContainText(
    'Health insurance',
  )
  await expect(page.getByRole('region', { name: 'Education savings' })).toContainText('Emma')

  await page.getByRole('button', { name: 'Delete Emma’s plan' }).click()
  await expect(page.getByRole('region', { name: 'Education savings' })).toContainText(
    'Add a plan for each child',
  )
})
