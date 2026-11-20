import { expect, test, type Locator, type Page } from '@playwright/test'

// The Bills & forecast page (#/bills): recurring items, the calendar and the cash-flow forecast.
// Dates are relative to the day the suite runs, so every expectation is worked out from today.

const sidebar = (page: Page) => page.getByLabel('Budget navigation')
const mainNav = (page: Page) => page.getByLabel('Main navigation')

async function setUpHousehold(page: Page) {
  await page.goto('/')
  await page.getByLabel('Household name').fill('Smith')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(sidebar(page).getByText('Smith', { exact: true })).toBeVisible()
}

async function addAccount(page: Page, name: string, balance: string, type = 'checking') {
  await sidebar(page).getByRole('button', { name: 'Add Account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Account name').fill(name)
  await dialog.getByLabel('Account type').selectOption(type)
  await dialog.getByLabel('Current balance').fill(balance)
  await dialog.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function openBills(page: Page) {
  await mainNav(page).getByRole('button', { name: 'Plan' }).click()
  await mainNav(page).getByRole('link', { name: 'Bills', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bills & forecast' })).toBeVisible()
}

const forecastCard = (page: Page) => page.getByRole('region', { name: 'Cash-flow forecast' })
const calendarCard = (page: Page) => page.getByRole('region', { name: 'Bills calendar' })
const itemsCard = (page: Page) => page.getByRole('region', { name: 'Recurring bills and income' })

/** The figure beside a label in the forecast's summary (Cash today, Bills due, ...). */
const figure = (forecast: Locator, label: string) =>
  forecast.locator(`xpath=.//dt[normalize-space()="${label}"]/following-sibling::dd[1]`)

interface Item {
  payee: string
  amount: string
  date: string
  cadence?: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'
  kind?: 'bill' | 'income'
  account?: string
}

async function addItem(page: Page, item: Item) {
  const items = itemsCard(page)
  await items.getByLabel('Recurring payee').fill(item.payee)
  await items.getByLabel('Recurring kind').selectOption(item.kind ?? 'bill')
  await items.getByLabel('Recurring amount').fill(item.amount)
  await items.getByLabel('Recurring cadence').selectOption(item.cadence ?? 'yearly')
  await items.getByLabel('Recurring next due').fill(item.date)
  if (item.account) {
    await items.getByLabel('Recurring account').selectOption({ label: item.account })
  }
  await items.getByRole('button', { name: 'Add item' }).click()
  await expect(itemRow(page, item.payee)).toBeVisible()
}

const itemRow = (page: Page, payee: string) =>
  itemsCard(page).getByRole('row', { name: new RegExp(`^${payee}\\b`) })

function localDate(days: number, from = new Date()) {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return d
}

/** `YYYY-MM-DD` in the browser's local time, like the app. */
function iso(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const isoIn = (days: number) => iso(localDate(days))

/** `MM/DD/YYYY`, as the items table shows a next due date. */
const shortDate = (date: string) => {
  const [y, m, d] = date.split('-')
  return `${m}/${d}/${y}`
}

/** `Fri, Nov 20`, as the forecast names a day. */
const dayLabel = (d: Date) =>
  `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`

/** The forecast table's row for a day (anchored, so `Tue, Dec 1` is not `Tue, Dec 15`). */
const dayRow = (table: Locator, d: Date) =>
  table.getByRole('row', { name: new RegExp(`^${dayLabel(d)} `) })

test('a past-due bill counts once, and marking it paid steps it on one occurrence at a time', async ({
  page,
}) => {
  await setUpHousehold(page)
  await addAccount(page, 'Checking', '1000')
  await openBills(page)

  const forecast = forecastCard(page)
  await forecast.getByLabel('Forecast length').selectOption('30')
  await expect(figure(forecast, 'Cash today')).toHaveText('$1,000.00')
  await expect(figure(forecast, 'Bills due')).toHaveText('$0.00')

  // a weekly bill ten days behind missed two weeks, but the forecast counts it once, today,
  // then carries on from its first date inside the window: today, +4, +11, +18 and +25 days
  await addItem(page, { payee: 'Gym', amount: '100', date: isoIn(-10), cadence: 'weekly' })
  const gym = itemRow(page, 'Gym')
  await expect(gym).toContainText('Every week')
  await expect(gym).toContainText(shortDate(isoIn(-10)))
  await expect(gym).toContainText('past due')
  await expect(figure(forecast, 'Bills due')).toHaveText('$500.00')
  await expect(figure(forecast, 'In 30 days')).toHaveText('$500.00')

  // the day-by-day list marks the one that was missed
  await forecast.getByText('Show the days with something due').click()
  const days = forecast.getByRole('table')
  await expect(dayRow(days, new Date())).toContainText('Gym (past due)')
  await expect(dayRow(days, new Date())).toContainText('$900.00')
  await expect(dayRow(days, localDate(4))).toContainText('-$100.00')
  await expect(dayRow(days, localDate(4))).toContainText('$800.00')
  await expect(days.getByRole('row')).toHaveCount(6) // header + five days

  // Mark paid moves one week, which is still behind, so it is still due today
  await gym.getByRole('button', { name: 'Mark Gym paid' }).click()
  await expect(gym).toContainText(shortDate(isoIn(-3)))
  await expect(gym).toContainText('past due')
  await expect(figure(forecast, 'Bills due')).toHaveText('$500.00')

  // once more and it is caught up: nothing today, the next one in four days
  await gym.getByRole('button', { name: 'Mark Gym paid' }).click()
  await expect(gym).toContainText(shortDate(isoIn(4)))
  await expect(gym).not.toContainText('past due')
  await expect(figure(forecast, 'Bills due')).toHaveText('$400.00')
  await expect(dayRow(days, new Date())).toHaveCount(0)
  await expect(days.getByRole('row')).toHaveCount(5)
})

test('editing an item updates the list and the forecast; income and tracking accounts are handled', async ({
  page,
}) => {
  await setUpHousehold(page)
  await addAccount(page, 'Checking', '1000')
  await addAccount(page, 'Brokerage', '5000', 'investment')

  // a category, so the item can carry one
  await mainNav(page).getByRole('link', { name: 'Budget', exact: true }).click()
  await page.getByRole('button', { name: '+ Category Group' }).click()
  await page.getByLabel('Group name').fill('Home')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('button', { name: 'Add category to Home' }).click()
  await page.getByLabel('New category in Home').fill('Rent')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await openBills(page)
  const forecast = forecastCard(page)
  const items = itemsCard(page)
  // only the budget's checking and savings are cash; the brokerage is not
  await expect(figure(forecast, 'Cash today')).toHaveText('$1,000.00')
  await expect(forecast).toContainText('Starts from Checking ($1,000.00)')

  await addItem(page, { payee: 'Landlord', amount: '1500', date: isoIn(2) })
  await expect(itemRow(page, 'Landlord')).toContainText('-$1,500.00')
  await expect(forecast.getByRole('status')).toContainText('Cash runs out')

  // Edit fills the form with the item; Cancel leaves the item as it was
  await items.getByRole('button', { name: 'Edit Landlord' }).click()
  const editForm = items.getByRole('form', { name: 'Edit recurring item' })
  await expect(editForm.getByLabel('Recurring payee')).toHaveValue('Landlord')
  await expect(editForm.getByLabel('Recurring kind')).toHaveValue('bill')
  await expect(editForm.getByLabel('Recurring amount')).toHaveValue('1500.00')
  await expect(editForm.getByLabel('Recurring cadence')).toHaveValue('yearly')
  await expect(editForm.getByLabel('Recurring next due')).toHaveValue(isoIn(2))
  await editForm.getByLabel('Recurring amount').fill('1')
  await editForm.getByRole('button', { name: 'Cancel' }).click()
  const addForm = items.getByRole('form', { name: 'Add a recurring item' })
  await expect(addForm.getByLabel('Recurring payee')).toHaveValue('')
  await expect(addForm.getByLabel('Recurring amount')).toHaveValue('')
  await expect(itemRow(page, 'Landlord')).toContainText('-$1,500.00')

  // Save item changes it in place, with a category and account shown beside the payee
  await items.getByRole('button', { name: 'Edit Landlord' }).click()
  await editForm.getByLabel('Recurring amount').fill('800')
  // quarterly, so the one after it falls outside any 30-day window
  await editForm.getByLabel('Recurring cadence').selectOption('quarterly')
  await editForm.getByLabel('Recurring category').selectOption({ label: 'Rent' })
  await editForm.getByLabel('Recurring account').selectOption({ label: 'Checking' })
  await editForm.getByRole('button', { name: 'Save item' }).click()
  await expect(addForm).toBeVisible()
  await expect(items.getByRole('row', { name: /Landlord/ })).toHaveCount(1)
  const landlord = itemRow(page, 'Landlord')
  await expect(landlord).toContainText('-$800.00')
  await expect(landlord).toContainText('Every 3 months')
  await expect(landlord).toContainText('Rent · Checking')

  // income is money expected, and lifts the forecast
  await forecast.getByLabel('Forecast length').selectOption('30')
  await expect(figure(forecast, 'Bills due')).toHaveText('$800.00')
  await expect(figure(forecast, 'Money expected')).toHaveText('$0.00')
  await addItem(page, { payee: 'Paycheck', amount: '2000', date: isoIn(1), kind: 'income' })
  await expect(itemRow(page, 'Paycheck')).toContainText('$2,000.00')
  await expect(figure(forecast, 'Money expected')).toHaveText('$2,000.00')
  await expect(figure(forecast, 'In 30 days')).toHaveText('$2,200.00')
  await expect(forecast.getByRole('status')).toContainText('Cash stays above zero')

  // a bill paid from a tracking account never touches the budget's cash
  await addItem(page, { payee: 'Advisor', amount: '300', date: isoIn(3), account: 'Brokerage' })
  await expect(itemRow(page, 'Advisor')).toContainText('Brokerage')
  await expect(figure(forecast, 'Bills due')).toHaveText('$800.00')

  // and deleting the paycheck takes it back out
  await items.getByRole('button', { name: 'Delete Paycheck' }).click()
  await expect(itemRow(page, 'Paycheck')).toHaveCount(0)
  await expect(figure(forecast, 'Money expected')).toHaveText('$0.00')
})

test('the calendar steps through months, and the forecast only counts what falls inside its window', async ({
  page,
}) => {
  await setUpHousehold(page)
  await openBills(page)

  // with no checking or savings there is nothing to forecast from, and the page says so
  const forecast = forecastCard(page)
  await expect(forecast).toContainText('There is no checking or savings account')
  await expect(figure(forecast, 'Cash today')).toHaveText('$0.00')

  const calendar = calendarCard(page)
  await expect(calendar).toContainText('Nothing is due this month.')

  // the 15th of the month after next: always 46 to 75 days away
  const now = new Date()
  const due = new Date(now.getFullYear(), now.getMonth() + 2, 15)
  const monthName = (d: Date) =>
    `${d.toLocaleDateString('en-US', { month: 'long' })} ${d.getFullYear()}`
  await addItem(page, { payee: 'Insurance', amount: '1000', date: iso(due) })

  // not this month, nor next, but there two months on, on its day
  await expect(calendar.getByRole('grid', { name: monthName(now) })).toBeVisible()
  await expect(calendar).toContainText('Nothing is due this month.')
  await calendar.getByRole('button', { name: 'Next month' }).click()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  await expect(calendar.getByRole('grid', { name: monthName(next) })).toBeVisible()
  await expect(calendar).toContainText('Nothing is due this month.')
  await calendar.getByRole('button', { name: 'Next month' }).click()
  const grid = calendar.getByRole('grid', { name: monthName(due) })
  await expect(grid).toBeVisible()
  await expect(calendar).toContainText('$1,000.00 in bills due.')
  const day = grid.getByRole('gridcell').filter({ hasText: 'Insurance' })
  await expect(day).toHaveCount(1)
  await expect(day).toContainText(/^15Insurance -\$1,000\.00$/)
  await expect(day).not.toContainText('past due')

  // and back again
  await calendar.getByRole('button', { name: 'Previous month' }).click()
  await calendar.getByRole('button', { name: 'Previous month' }).click()
  await expect(calendar.getByRole('grid', { name: monthName(now) })).toBeVisible()

  // a 30-day look ahead stops short of it; 90 days reaches it and the cash runs out
  await forecast.getByLabel('Forecast length').selectOption('30')
  await expect(figure(forecast, 'Bills due')).toHaveText('$0.00')
  await expect(forecast.getByRole('status').first()).toContainText(
    'Cash stays above zero for the next 30 days',
  )
  await forecast.getByLabel('Forecast length').selectOption('90')
  await expect(figure(forecast, 'Bills due')).toHaveText('$1,000.00')
  await expect(figure(forecast, 'In 90 days')).toHaveText('-$1,000.00')
  await expect(forecast.getByRole('status').first()).toContainText('Cash runs out')
  await expect(forecast.getByRole('img', { name: /Projected cash/ })).toBeVisible()
})
