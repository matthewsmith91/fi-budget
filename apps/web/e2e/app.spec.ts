import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const sidebar = (page: Page) => page.getByLabel('Budget navigation')
const settingsSidebar = (page: Page) => page.getByLabel('Settings navigation')

async function setUpHousehold(page: Page, name = 'Smith') {
  await page.getByLabel('Household name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(sidebar(page).getByText(name, { exact: true })).toBeVisible()
}

const SETTINGS_SECTIONS = ['Household', 'Connections', 'Payee rules', 'Imports', 'Backups'] as const

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
  await expect(page.getByText('On this device', { exact: true })).toBeVisible()
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

  // a group with categories can't be deleted
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Options for Bills' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'categories first' })).toBeVisible()
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
  await page.getByRole('button', { name: 'Options for Visa' }).click()
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
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
  await page.getByRole('button', { name: 'Options for Household' }).click()
  await page.getByRole('menuitem', { name: 'Add goal' }).click()
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
