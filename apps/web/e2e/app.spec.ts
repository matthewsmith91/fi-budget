import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

async function setUpHousehold(page: Page, name = 'Smith') {
  await page.getByLabel('Household name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

async function exportAs(page: Page, button: 'Export JSON' | 'Export SQLite', path: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: button }).click()
  await (await download).saveAs(path)
}

test('boots on durable storage at the latest schema', async ({ page }) => {
  await page.goto('/')
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
  await expect(
    page.getByText('Offline ready').locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('yes', {
    timeout: 20_000,
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Smith' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Jessica' })).toBeVisible()

  await page.evaluate(() => navigator.serviceWorker.ready)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Smith' })).toBeVisible()
  await context.setOffline(false)
})

test('export then import restores a budget, with a safety backup of the replaced one', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await setUpHousehold(page)

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
  await expect(page.getByRole('heading', { name: 'Jones' })).toBeVisible()

  // import the SQLite image: back to the original
  page.once('dialog', (d) => void d.accept())
  const safety2 = page.waitForEvent('download')
  await page.locator('input[type=file]').setInputFiles(sqlitePath)
  await safety2
  await expect(page.getByRole('heading', { name: original })).toBeVisible()

  // the swapped-in file is the one that persists
  await page.reload()
  await expect(page.getByRole('heading', { name: original })).toBeVisible()

  // a bad file is refused and nothing changes
  const junk = testInfo.outputPath('junk.json')
  await writeFile(junk, '{"nope":true}')
  page.once('dialog', (d) => void d.accept())
  await page.locator('input[type=file]').setInputFiles(junk)
  await expect(page.getByRole('alert')).toContainText('Not a Budget-Fi export')
  await expect(page.getByRole('heading', { name: original })).toBeVisible()
})

test('a second tab is told the budget is open elsewhere', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByText('On this device')).toBeVisible()
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByRole('alert')).toContainText('open in another tab')
})
