# AGENTS.md

## What is this

A shared household budgeting app for two users (Matt and Jessica) that replaces the YNAB + Empower split. It combines envelope budgeting with real sinking funds, an emergency fund tracked as an allocation of an account (not the whole account), percentage-based income rules (e.g. tithe 10% before anything else), investment goals inside shared brokerage accounts, and retirement / 529 / net-worth planning. It is local-first: every device holds the whole budget in SQLite and works alone; an optional sync server (Phase 2) keeps both users' devices in step.

The app tracks and plans; it never moves money. One household, two users, no public sign-up.

The full spec and phased roadmap live in `docs/specs/Household Budget App — Spec & Plan.md`. Phase 0 (foundations) and Phase 1 (budget core) are built; Phase 2 (sync and import) is partly built. The spec is authoritative where this file disagrees.

## Project Layout

npm workspaces monorepo orchestrated by Turborepo.

```
budget-fi/
├── package.json       # Workspace root (apps/*, packages/*), turbo + prettier scripts
├── turbo.json         # Task pipeline: build, dev, lint, typecheck, test
├── .github/workflows/ci.yml   # format, lint, typecheck, test, build, e2e
├── Dockerfile, compose.yaml, Caddyfile   # one image (app + server) behind Caddy for HTTPS
├── apps/
│   ├── web/           # React 19 + Vite + TypeScript PWA (oxlint for linting)
│   │   ├── src/       # UI; client.ts is the only handle on the domain layer. App.tsx is the shell (hash routes): Sidebar, BudgetView (categories table), RegisterView (account ledger, with transfer and reconcile dialogs), ActivityView (who changed what), SettingsView; SyncBanner shows synced / offline / N changes not yet synced and auto-syncs (sync-state.ts holds the pure logic)
│   │   │              # Views read with useBudgetQuery and call refresh() (data.ts) after any write
│   │   ├── src/worker/  # budget.worker.ts: opens SQLite in OPFS, runs migrations, serves the RPC API
│   │   └── e2e/       # Playwright tests against the production build (real Chrome)
│   └── api/           # Express 5 + node:sqlite server: serves the built web app, /health, /api/auth (passkey sign-in, sessions, one-time pairing codes), /api/sync (relay of change messages, signed-in only)
└── packages/
    ├── core/          # @budget-fi/core: pure TS domain layer, no DOM
    │   └── src/       # money, storage adapter, SQLite adapter, migrations, export/import, RPC, BudgetApi, change log, transactions (splits, transfers), reconciliation, activity feed, sync (merge, engine, Merkle trie)
    └── ui/            # @budget-fi/ui: shared component library (currently empty)
```

**Where code goes:** domain logic (anything that touches money or the budget file) goes in `packages/core` so it runs unchanged in the browser worker, in Node tests, and later on the sync server and in Capacitor. The UI never touches SQLite: it calls the `BudgetApi` interface in `packages/core/src/api.ts` through `apps/web/src/client.ts`, and every call is a message to the worker. To add a capability, extend `BudgetApi`, implement it in `createBudgetApi`, and test it against an in-memory database (`openMemoryAdapter` in `test-utils.ts`).

**Shared component library:** reusable UI components belong in `packages/` (starting with `packages/ui`), not inside an app. The web interface and the planned mobile apps both consume it, so components there should avoid web-only assumptions where practical. Apps import it as `@budget-fi/ui`.

## Commands

Run from the repo root (uses npm 11 and Turborepo):

```sh
npm install            # install all workspace dependencies
npm run dev            # run all dev servers (web via Vite, api via tsx watch on :3001)
npm run build          # build all apps
npm run lint           # oxlint (apps/web)
npm run typecheck      # tsc in web, core, api
npm test               # unit tests (Vitest) in core and api
npm run test:e2e       # Playwright against a production build; needs Google Chrome installed
npm run format         # prettier --write (format:check is what CI runs)
```

Per-package, via workspaces:

```sh
npm run dev -w web           # Vite dev server
npm test -w @budget-fi/core  # core unit tests
npm run build -w web         # tsc -b && vite build (also generates the service worker)
npx pwa-assets-generator     # in apps/web: regenerate icons from public/icon.svg
```

Self-hosting: `DOMAIN=budget.example.com docker compose up -d` builds one image that serves the static app and the server from the same origin, with Caddy in front for HTTPS. The server's SQLite file lives in the `data` volume (`DATA_DIR`, default `./data` outside Docker). In `npm run dev` Vite proxies `/api` and `/health` to the server so the app sees one origin there too. Passkeys are bound to the origin: set `ORIGIN` (compose derives it from `DOMAIN`; the hostname becomes the RP ID; dev defaults to `http://localhost:5173` and the server port). With no users yet the server logs a one-time setup code at startup; the first person enters it in Settings, then pairs devices or the other person from there (max two people). Server migrations are append-only in `apps/api/src/db.ts`; the server needs Node 22.13+ (`node:sqlite`).

The service worker only exists in production builds, so test PWA behavior with `npm run test:e2e` or `npm run build -w web && npx vite preview`.

## Architecture

**Core design rule:** where money sits (accounts) is separate from what money is for (envelopes/categories/goals). Every balance is derived from an append-only ledger (`allocations`, `transactions`, `unit_events`); nothing stores a running balance. Edits add rows instead of overwriting, which also makes concurrent edits by two people safe.

**Key invariants**

- Category balance = its own allocations + the sum of its goals' balances − spending.
- Envelopes held in an account can never add up to more than that account's balance.
- Spending from a goal is a planned draw-down, never flagged as overspending.
- Months roll over: a category opens a month with last month's available if positive; cash overspending does not carry, it comes out of the next month's Ready to Assign (`rollCategories` in `allocations.ts`).
- Investment accounts are tracking accounts: in net worth and goals, not in the monthly budget.
- A transfer is two transactions sharing `transfer_pair_id`; the amount is mirrored, date and cleared are per leg. Between budget accounts it moves nothing in the budget; across the budget edge the budget leg is spending or income and may carry a category.
- Each on-budget credit card has a payment category (`categories.credit_card_account_id`, id `payment-<accountId>`, in the `credit-card-payments` group). Its activity is derived in `rollCategories`: card purchases add to it, refunds and payments (transfers into the card) draw it down. It is managed by the card: no rename, delete or transaction use. Purchases move in full, even past the spending category's balance; that shortfall is cash overspending and comes out of the next month's Ready to Assign.
- Reconciling locks every cleared transaction in an account and posts an uncategorized cleared adjustment if the bank balance differs; locked transactions can't be edited or deleted.
- The activity feed is derived from the `messages` log, not stored. Messages carry no write id, so `activity.ts` splits a row's messages into actions at a delete, at `created_at` (the last column of every insert) and at a repeated column. Who made a change comes from the `devices` row (synced) that ties a device id to a member.
- Money is **integer cents** in the database and the client. Never use floats for amounts; rounding remainders fall to Ready to Assign.

**Stack (per spec)**

- Local-first: the whole app is a static bundle with SQLite (WASM) inside it. Domain logic runs in a web worker; the UI talks to it through one typed message API (`connect`/`serve` in `packages/core/src/rpc.ts`). There is no business API.
- Storage: SQLite in OPFS (`opfs-sahpool` VFS) behind the `StorageAdapter` interface. Only one tab can own the database at a time (guarded by a Web Lock). If OPFS is unavailable the worker falls back to memory and the UI warns loudly.
- Schema changes: append-only versioned migrations in `packages/core/src/migrations.ts`. Never edit a released migration; add a new one. The app refuses to open a file from a newer schema.
- Per-device settings (last backup time) live in `localStorage`, outside the budget file, so they never sync.
- Sync (Phase 2, push/pull, full-file setup and the status banner built; bank import not yet): optional. Every write becomes a change message with a hybrid logical clock timestamp; newest-wins per field: a row is rebuilt from the newest message per column, so arrival order never matters, and a delete is permanent. A sync is one `POST /api/sync` (push unsynced, pull after the server cursor); if the Merkle roots still differ, the device diffs the tries and re-exchanges everything from the earliest differing minute. A device that syncs with the server holding no file (or one 1000+ messages behind) uploads its SQLite image with the log position it contains (`PUT /api/sync/file?cursor=`); a new device downloads it (`GET /api/sync/file`), then syncs from that position. A device with its own budget that has never synced is refused (409) if the server already holds one: budgets are never merged, and the UI offers to replace the device's budget with the server's instead. The server keeps its own copy of the trie hashing (`apps/api/src/merkle.ts`) because it cannot import core; both test suites assert the same root hash. The server is a small Node + SQLite service on the same origin as the app (required for passkeys); it relays changes, signs people in and proxies SimpleFIN. `apps/api` is its placeholder.
- Import: SimpleFIN via the server, YNAB history import once. Aggregator tokens live only on the server, never in the client.
- Rules that create rows (income rules, unit purchases) use deterministic IDs so two devices converge on one row.
- Not yet decided: TanStack Query (the worker calls are already async; add it only if caching becomes necessary).

**Testing approach:** credit card and rollover logic is subtle, so build it test-first using real YNAB months as fixtures. Core tests run the real SQLite engine in memory under Node, so SQL is exercised exactly as in the browser. Property tests (fast-check) cover money arithmetic. Browser-only behavior (OPFS persistence, service worker, tab locking, file import/export) is covered by the Playwright suite in `apps/web/e2e`.
