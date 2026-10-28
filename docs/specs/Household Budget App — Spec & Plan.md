# Household Budget App — Spec & Plan

Oct 26, 2026 · @Matt Smith

## Overview

One household app that replaces the YNAB + Empower split: envelope budgeting with real sinking funds, an emergency fund that is an allocation rather than an account, percentage-based income rules, and investment goals tracked inside shared brokerage accounts. It is local-first, like Actual Budget and openGym: each device holds the whole budget and works on its own, and an optional sync server keeps Matt's and Jessica's phones and the web in step.

**Goals**

- Envelope budgeting at least as good as YNAB, including credit card payment handling and reconciliation
- Multiple goals inside one category, each with its own balance, target and date
- Emergency fund and other savings tracked as allocations of an account, not the whole account
- Income rules that assign a percentage of each paycheck (tithe 10%) before anything else
- Investment goals inside a single brokerage account, with gain and loss per goal
- Retirement, 529 and net-worth planning in the same dashboard
- Works fully on one device with no account or server; sync across two users and three surfaces (two phones, web) is optional

**Non-goals for v1**

- Building bank connections from scratch: import comes from SimpleFIN through our own sync server
- Bill pay or moving money: the app tracks and plans, it never initiates transfers
- Multi-household or public sign-up: one household, two users
- A business API: the server only relays changes and proxies bank sync

## Core concepts

The whole design rests on one rule: where money sits (accounts) is separate from what money is for (envelopes). Every balance is derived from an append-only ledger, never stored and overwritten.

| Concept | What it is | Example |
| --- | --- | --- |
| Account | A real place money sits: checking, credit card, HYSA, brokerage, Roth, 529 | Ally HYSA |
| Category | A budget envelope in a group, funded each month | Jessica Personal |
| Goal | A child of a category with its own balance, target amount and optional date; can say which account holds it | New laptop, $1,200 by March |
| Allocation | A ledger entry that adds or removes money from a category or goal, with who, when and why | +$100 to Emergency Fund |
| Ready to Assign | Income not yet allocated to any envelope |  |
| Income rule | Runs when a transaction is categorized as income; allocates a percent or fixed amount, in priority order | Tithe 10% of gross |
| Unit | A share of an investment account owned by a goal; unit price = account value / total units | House Fund owns 80 units |
| Valuation | A dated market value for an investment account, from sync or manual entry | Brokerage $84,200 on Oct 31 |

**Rules that hold everywhere**

- Category balance = its own allocations + the sum of its goals' balances − spending
- Envelopes held in an account can never add up to more than that account's balance
- Spending from a goal draws it down as planned and is never flagged as overspending
- Investment accounts are tracking accounts: in net worth and goals, not in the monthly budget
- All calculations run on the device and are deterministic; rows a rule creates get deterministic IDs (source row + rule), so two devices running the same rule converge on one row instead of applying it twice

## Functional spec

### Budget

- Monthly view of category groups and categories: assigned, activity, available
- Assign money from Ready to Assign; move money between categories and goals
- Overspending in cash categories rolls into next month's Ready to Assign; overspending on a card becomes card debt
- Credit cards: a purchase moves the amount from its spending category into the card's payment category; payments draw that down
- Reconciliation per account: confirm cleared balance against the bank, lock reconciled transactions, post an adjustment if needed

### Goals and sinking funds

- Any category can hold several goals; unassigned money stays at the category level
- Each goal: target amount, optional target date, optional "held in" account, monthly amount needed, percent funded
- Spending picks a goal, or draws from the category's unassigned money by default
- Completed goals can be archived with their history

### Needs vs wants

- Every category is tagged Need or Want; a split can override it (groceries are a need, the wine on the same receipt is a want)
- Report of needs vs wants spending by month, with trailing 3, 6 and 12-month averages
- The average Need spending is the "bare-bones month" the emergency fund is sized against
- Recurring bills inherit their category's tag

### Emergency fund

- An envelope (category or goal) held in a named savings account
- Target = months of coverage × average monthly Need spending; coverage (default 6) and averaging window (3–12 months) are settings
- Shows months covered today: balance ÷ average monthly needs
- Add or remove money as allocation entries with a note and who made the change
- Warning when the envelopes held in an account exceed its balance

### Income rules

- A rule matches income by payee, account or category
- Action: percent of the deposit (net) or of an entered gross amount, or a fixed amount, to a category or goal
- Rules run in priority order; the remainder goes to Ready to Assign
- Refunds or reversed income reverse their rule allocations
- Amounts round to the cent; rounding remainder falls to Ready to Assign

### Transactions and import

- Imported transactions arrive uncategorized for approval; manual entry on any device
- Split transactions across categories and goals
- Payee rules auto-categorize; an LLM suggests a category for unknown payees
- De-duplication between imported and manually entered transactions
- Comments on a transaction so either person can ask "what was this?"

### Investments

- Investment accounts carry a tax type: Roth, traditional, taxable, 529
- Budget categories fund post-tax contributions; the cleared transfer buys units for the target goal at the current unit price
- Account valuations update from sync or manual entry; every goal's value updates as units × unit price
- Per goal: cost basis, current value, gain/loss, realized gains on withdrawal
- Per account mode: proportional units by default, or holding-level when goals hold different investments
- Roth contributions tracked per person against the annual limit

### Planning and dashboard

- Net worth over time across all accounts
- Retirement projection with contribution rates, return assumptions and target age; Monte Carlo as a later option
- 529 projection per child against a target and date
- Recurring bills calendar and a 30–60 day cash-flow forecast
- Monthly review screen: what went over, what is underfunded, suggested moves

### Retirement spending model

- Each category gets a retirement status: **Continues**, **Ends** (529 contributions, retirement contributions, a mortgage you expect to pay off), or **Changes** with a multiplier or replacement amount (travel ×1.5)
- Baseline = trailing 12-month average of Continues and Changes categories, adjusted by their multipliers, in today's dollars
- Fixed additions for costs that don't exist today, such as health insurance before Medicare or extra home maintenance, each with optional start and end ages
- Annual retirement spend = baseline + fixed additions, recalculated automatically as real spending changes
- Success check: required portfolio = annual spend ÷ withdrawal rate, compared with the projected portfolio at the target age; Monte Carlo probability of success later
- Shows which categories drive the number and how much a $100/month change moves the required portfolio

### Storage, sync and household

- Two modes, chosen per device: **On this device only** (no login, no server) or **Sync with our server** (passkey sign-in, one shared budget file)
- Switching a local-only device to sync uploads its budget; a new device downloads the full file, then syncs changes
- Two users in one household, each with their own passkey; new devices pair with a one-time code or QR
- Changes reach the other devices within seconds when online; offline edits queue and sync later
- Status banner: synced, offline, or changes not yet synced
- Activity feed of every allocation and edit, with who made it
- Optional end-to-end encryption: the server stores only ciphertext
- Full export at any time (JSON and SQLite file) and import of that export; local-only devices get a backup reminder
- Installable from the web as a PWA; Capacitor builds for iPhone and Android later

## Architecture and stack

The app is one static web bundle with all logic and a SQLite database inside it. There is no business API: the optional server only signs people in, relays changes and proxies bank sync. This follows Actual Budget (SQLite in the client, CRDT sync through a small server) and openGym (works alone on a phone or connected to a self-hosted server).

&#91;embedded content: architecture · local-first, optional sync server\]

- **Frontend:** React + Vite + TypeScript; domain logic runs in a web worker and the UI talks to it through one message API
- **Local storage:** SQLite on every device: WASM SQLite persisted in the browser, native SQLite in the Capacitor app; same schema and queries in both modes, behind one storage adapter
- **Sync:** optional. Every write becomes a change message (table, row, column, value, hybrid logical clock timestamp). Devices push their messages and pull everyone else's since their last sync; the newest timestamp wins per field, and a Merkle trie of timestamps finds where two devices diverged
- **Server:** one small Node + SQLite service in Docker on the same origin as the app (required for passkeys): serves the static app, passkey sign-in, sync push/pull, full-file download for a new device, and the bank-sync proxy
- **Bank sync:** the server holds the SimpleFIN token and fetches on request; the device inserts the transactions and syncs them like any other change. A daily server pull queues raw imports for the next device that opens
- **Encryption:** optional end-to-end; messages are encrypted on the device before upload
- **Schema changes:** versioned migrations that run on each device at startup
- **Money:** integer cents everywhere

## Data model

**On every device** (the budget file). Every row has a UUID minted on the device, plus `created_by` and `created_at`; rows created by rules use deterministic IDs. Balances are computed from `allocations`, `transactions` and `unit_events`; nothing stores a running balance.

| Table | Key columns | Purpose |
| --- | --- | --- |
| households | id, name, encryption\_key\_id? | The budget file's identity |
| members | household\_id, display\_name | Matt and Jessica |
| devices | id, member\_id, name, mode (local, sync), last\_sync\_at | Each phone or browser |
| accounts | type (checking, credit, savings, investment), on\_budget, external\_id, closed | Where money sits |
| category\_groups | name, sort | Budget sections |
| categories | group\_id, name, need\_or\_want, retirement\_status (continues, ends, changes), retirement\_multiplier?, credit\_card\_account\_id? | Envelopes; card payment categories link to their card |
| goals | category\_id, name, target\_amount, target\_date?, held\_in\_account\_id?, archived | Sinking funds, emergency fund, personal goals |
| allocations | month, category\_id, goal\_id?, amount, source (manual, rule, move, contribution), note | The budgeting ledger and audit trail |
| transactions | account\_id, date, payee, amount, cleared, reconciled, import\_id?, transfer\_pair\_id? | Money in and out |
| transaction\_splits | transaction\_id, category\_id?, goal\_id?, amount, need\_or\_want\_override? | A transaction across envelopes |
| payee\_rules | match, category\_id, goal\_id? | Auto-categorization |
| income\_rules | match, basis (net, gross), percent?, fixed\_amount?, target category or goal, priority | Tithe and other paycheck rules |
| investment\_accounts | account\_id, tax\_type (roth, traditional, taxable, 529), owner\_member\_id?, mode (units, holdings) | Investment settings per account |
| account\_valuations | account\_id, date, market\_value | Market value history |
| goal\_units | goal\_id, account\_id, units, cost\_basis | Current units per goal (derived, cacheable) |
| unit\_events | goal\_id, account\_id, type (buy, sell, dividend), units, unit\_price, date | Unit ledger and realized gains |
| retirement\_fixed\_items | name, annual\_amount, start\_age?, end\_age? | Retirement costs that don't exist today |
| retirement\_assumptions | target\_age, inflation, return, withdrawal\_rate, lookback\_months | Inputs for the success check |
| recurring | payee, amount, cadence, next\_date, category\_id | Bills calendar and forecast |
| comments | transaction\_id, member\_id, body | Household conversation on spending |
| messages | timestamp (HLC), table, row\_id, column, value, device\_id | Local change log; the source of sync and of rollback |
| schema\_version | version, applied\_at | Device-side migrations |

**On the sync server** (none of this exists in local-only mode)

| Table | Key columns | Purpose |
| --- | --- | --- |
| users | id, display\_name, passkey credentials | Sign-in for Matt and Jessica |
| files | household\_id, latest\_snapshot, created\_at | Full budget file for new devices |
| server\_messages | household\_id, timestamp, device\_id, payload (encrypted when enabled) | Relayed change log |
| bank\_links | household\_id, provider, access\_token (encrypted at rest) | SimpleFIN connection |
| import\_queue | household\_id, account\_external\_id, raw\_transaction, fetched\_at, applied\_at? | Daily pulls waiting for a device |
| sync\_cursors | provider, account\_external\_id, cursor, last\_run | Bank-sync state |

## Roadmap

Phases are ordered by dependency, not dated. YNAB and Empower stay live until their gate is met, so nothing is lost while the app matures.

&#91;embedded content: roadmap · 7 phases, 3 gates\]

- **Daily use beside YNAB:** after Phase 2, both of you budget in the app every day while YNAB still runs
- **Retire Empower:** after Phase 5, once net worth and investment numbers match Empower for two months
- **Retire YNAB:** after Phase 6, once import and budgeting run cleanly for two months

## Task list

### Phase 0 — Foundations

- [x] Vite + React + TypeScript repo, lint, formatting, test runner
- [x] WASM SQLite in the browser, persisted, behind a storage adapter
- [x] Domain logic in a web worker; the UI talks to it through one message API
- [x] Versioned schema migrations that run on each device at startup
- [ ] PWA shell: manifest, service worker, installable on both phones
- [x] Request persistent storage; backup reminder for local-only devices
- [x] Full export and import (JSON and SQLite file)
- [x] Money as integer cents everywhere; shared formatting helpers
- [ ] CI that builds the static app and runs the logic tests

### Phase 1 — Budget core

- [x] Accounts, category groups and categories CRUD
- [x] Change-message layer: every write produces a message with an HLC timestamp (ready for sync, works without it)
- [x] Allocations ledger and balance queries (assigned, activity, available)
- [ ] Ready to Assign and month rollover logic, with tests
- [ ] Transactions and splits, manual entry on mobile and web
- [ ] Transfers between accounts (paired transactions)
- [ ] Credit card payment categories: purchase moves funds to the card's category
- [ ] Reconciliation flow with adjustment transaction
- [ ] Activity feed from the message log

### Phase 2 — Sync and import

- [x] Sync server: Node + SQLite in Docker, same origin as the app, behind HTTPS
- [x] Passkey sign-in for Matt and Jessica; device pairing by one-time code or QR
- [x] Push and pull of change messages; newest-wins per field; Merkle trie to find divergence
- [ ] Full-file download to set up a new device; upload when a local-only device turns on sync
- [ ] Sync status banner and unsynced-changes indicator
- [ ] Two-device test suite: same edits offline on both, converge after sync
- [ ] Bank-sync proxy: SimpleFIN token on the server, fetch on request
- [ ] Daily server pull into the import queue, applied by the next device
- [ ] Map external accounts to app accounts
- [ ] De-duplicate imported against manual transactions
- [ ] Approval inbox for new transactions
- [ ] Payee rules, then LLM category suggestions for unknown payees
- [ ] One-time history import from YNAB

### Phase 3 — Goals and rules

- [ ] Goals under categories: create, fund, spend from, archive
- [ ] Monthly amount needed and percent funded per goal
- [ ] "Held in" account and the over-allocation warning
- [ ] Need/want tag on categories, with override on splits
- [ ] Needs vs wants report with trailing averages
- [ ] Emergency fund target from average Need spending; months covered today
- [ ] Income rules engine: match, priority, percent or fixed, net or gross basis
- [ ] Rule reversal on refunded or reversed income
- [ ] Tithe rule set up and verified against a real month

### Phase 4 — Investments

- [ ] Investment account settings: tax type, owner, mode
- [ ] Valuations from sync or manual entry
- [ ] Unit ledger: buys on cleared contribution transfers, sells on withdrawals, dividends to Unassigned
- [ ] Per-goal value, cost basis, gain/loss and realized gains
- [ ] Holding-level mode for accounts with different investments per goal
- [ ] Roth contribution tracking per person against the annual limit

### Phase 5 — Planning dashboard

- [ ] Net worth over time
- [ ] Retirement projection: contributions, returns, target age
- [ ] Retirement status and multiplier on each category
- [ ] Fixed retirement additions with start and end ages
- [ ] Retirement spend estimate and success check (withdrawal rate vs projected portfolio)
- [ ] 529 projection per child
- [ ] Recurring bills calendar and 30–60 day cash-flow forecast
- [ ] Monthly review screen
- [ ] Retire Empower once numbers match for two months

### Phase 6 — Polish

- [ ] Optional end-to-end encryption of synced data
- [ ] Capacitor builds for iPhone and Android with native SQLite
- [ ] Transaction comments and notifications between the two of you
- [ ] Monte Carlo retirement scenarios
- [ ] CSV export of transactions
- [ ] Retire YNAB once import and budgeting run cleanly for two months

## Open questions and risks

**Open questions**

- [ ] Tithe basis: net deposit or gross pay? Gross needs the gross amount entered or imported per paycheck.
- [ ] Importer: keep YNAB as the import engine during the transition, or go straight to SimpleFIN?
- [ ] Which brokerages and 529 plans does SimpleFIN cover for us? If not, manual monthly valuations.
- [ ] Are any brokerage goals invested differently from the rest? That decides units vs holdings mode per account.
- [ ] Where does the sync server run: a home box, a VPS, or a host like Railway or Fly?
- [ ] End-to-end encryption from day one, or added in Phase 6?
- [ ] Which categories are needs and which are wants? Which continue, end or change in retirement?
- [ ] Withdrawal rate, inflation and return assumptions for the retirement success check

**Risks**

| Risk | Mitigation |
| --- | --- |
| Credit card and rollover logic is subtle and gets money wrong | Build it test-first with real months from YNAB as fixtures |
| Import gaps or duplicates erode trust | Approval inbox, de-dup by amount/date/payee, reconcile weekly |
| Two people editing the same envelope at once | Append-only ledger plus newest-wins per field; most changes are inserts that never conflict |
| Both devices run the same income rule | Deterministic IDs for rule-created rows, so sync collapses them into one |
| Browser clears a local-only device's data | Request persistent storage, prefer the Capacitor app on phones, backup reminders |
| A buggy release syncs bad data to the other device | Keep the full message log; roll back to a timestamp; test migrations on a copy first |
| Financial data exposure | Passkeys, HTTPS, optional end-to-end encryption, SimpleFIN token only on the server |
| Side project stalls before it replaces YNAB | Run in parallel with YNAB; ship Phases 1 and 2 before anything else |
