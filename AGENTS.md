# AGENTS.md

## What is this

A shared household budgeting app for two users (Matt and Jessica) that replaces the YNAB + Empower split. It combines envelope budgeting with real sinking funds, an emergency fund tracked as an allocation of an account (not the whole account), percentage-based income rules (e.g. tithe 10% before anything else), investment goals inside shared brokerage accounts, and retirement / 529 / net-worth planning. It runs on phones and the web, and manual changes sync between both users.

The app tracks and plans; it never moves money. One household, two users, no public sign-up.

The full spec and phased roadmap live in `Household Budget App — Spec & Plan.md` (not in this repo). The project is at Phase 0 (foundations); most of the spec is not yet built.

## Project Layout

npm workspaces monorepo orchestrated by Turborepo.

```
budget-fi/
├── package.json       # Workspace root (apps/*), turbo scripts
├── turbo.json         # Task pipeline: build, dev, lint, typecheck
├── apps/
│   ├── web/           # React 19 + Vite + TypeScript frontend (oxlint for linting)
│   │   └── src/       # main.tsx, App.tsx (currently the Vite starter template)
│   └── api/           # Express 5 + TypeScript server
│       └── src/       # index.ts (currently only GET /health)
```

## Commands

Run from the repo root (uses npm 11 and Turborepo):

```sh
npm install            # install all workspace dependencies
npm run dev            # run all dev servers (web via Vite, api via tsx watch on :3001)
npm run build          # build all apps
npm run lint           # lint (currently only apps/web defines a lint task)
npm run typecheck      # typecheck (currently only apps/api defines a typecheck task)
```

Per-app, via workspaces:

```sh
npm run dev -w web           # Vite dev server
npm run dev -w api           # API with tsx watch (PORT env, default 3001)
npm run build -w web         # tsc -b && vite build
npm run build -w api         # tsc -> dist/
npm run start -w api         # node dist/index.js
```

There is no test runner configured yet.

## Architecture

**Core design rule:** where money sits (accounts) is separate from what money is for (envelopes/categories/goals). Every balance is derived from an append-only ledger (`allocations`, `transactions`, `unit_events`); nothing stores a running balance. Edits add rows instead of overwriting, which also makes concurrent edits by two people safe.

**Key invariants**
- Category balance = its own allocations + the sum of its goals' balances − spending.
- Envelopes held in an account can never add up to more than that account's balance.
- Spending from a goal is a planned draw-down, never flagged as overspending.
- Investment accounts are tracking accounts: in net worth and goals, not in the monthly budget.
- Money is **integer cents** in the database and the client. Never use floats for amounts; rounding remainders fall to Ready to Assign.

**Planned stack (per spec)**
- Frontend: React + Vite + TypeScript, installable as a PWA, TanStack Query for server state.
- Backend: Supabase (Postgres, Auth, Realtime, Edge Functions). Every table carries `household_id` (enforced by row-level security), `created_by` and `created_at`.
- Sync: realtime subscriptions on ledger tables; a local-first layer (PowerSync or similar) is planned for offline edits in Phase 6.
- Import: YNAB API during the transition, SimpleFIN for banks and brokerages. Aggregator tokens live only in server-side functions, never in the client.
- Shared logic (income rules, unit purchases, month rollovers) runs server-side so both devices get identical results.

**Current state vs. spec:** `apps/api` is an Express server, but the spec calls for Supabase Postgres/Edge Functions for the backend. Which of the two owns server logic is not settled; confirm before building significant server-side features in either place.

**Testing approach:** credit card and rollover logic is subtle, so build it test-first using real YNAB months as fixtures.
