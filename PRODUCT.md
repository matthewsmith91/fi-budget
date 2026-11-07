# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

An installable PWA (React 19 + Vite) used on phones and on the desktop web. Capacitor builds for iPhone and Android are planned as wrappers around the same bundle; they do not make the design language native.

## Users

One household, two people: Matt and Jessica. They are equal co-owners of the budget. Both assign money, set rules, review and plan; there is no primary operator and no lighter "viewer" role. There is no public sign-up and no other audience.

The main use is on a phone, daily and briefly: logging a purchase, approving and categorizing imported transactions in the inbox, checking what a category has left. Longer desk sessions (assigning a month, the monthly review, retirement and net-worth planning) happen too, but the phone check-in is the scene to design for first.

## Product Purpose

Replace the YNAB + Empower split with one app. It combines envelope budgeting (at least as good as YNAB, including credit card payment handling and reconciliation) with real sinking funds, an optional emergency fund tracked as an allocation rather than an account, percentage-based income rules (tithe 10% before anything else), investment goals inside shared brokerage accounts, and retirement, 529 and net-worth planning.

Success is retiring the old tools: Empower once net worth and investment numbers match it for two months, YNAB once import and budgeting run cleanly for two months.

## Positioning

Where money sits (accounts) is kept separate from what money is for (categories, goals). That lets one savings account hold several goals and the emergency fund, lets several goals own units inside one brokerage account with their own gain and loss, and lets income rules split a paycheck before a person touches it. Budgeting and long-range planning share one ledger instead of living in two products.

It is local-first: every device holds the whole budget and works alone, with an optional self-hosted sync server keeping both people's devices in step.

## Operating Context

- Daily: imported bank transactions land in the inbox (SimpleFIN via the household's own server); a person approves and categorizes them, or logs a purchase by hand.
- Monthly: assign Ready to Assign, run the monthly review (overspending, underfunded goals, emergency fund shortfall), reconcile accounts against the bank.
- Occasionally: reports (needs vs wants, net worth, retirement, education, Roth contributions), bills forecast, settings and rules.
- Both people may edit at the same time on different devices; sync converges without merging budgets.
- During the transition YNAB and Empower still run alongside, so numbers are compared against them.

## Capabilities and Constraints

- Tracks and plans; never moves money, pays bills or initiates transfers.
- Works fully offline on one device with no account or server; sync is optional.
- Money is integer cents; balances are derived from an append-only ledger, never stored.
- Investment accounts are tracking accounts: in net worth and goals, not in the monthly budget.
- Domain terms used in the UI: Ready to Assign, Assigned, Activity, Available, category, group, goal, sinking fund, emergency fund, income rule, payee rule, inbox, register, reconcile, need/want, held in.
- Planned but not built: Capacitor native apps, Monte Carlo retirement scenarios.
- Spec and roadmap: `docs/specs/Household Budget App — Spec & Plan.md`; engineering rules: `AGENTS.md`.

## Brand Commitments

- Name: "Household Budget" (PWA short name "Budget"). Repo/package name is budget-fi.
- App icon source: `apps/web/public/icon.svg`.

## Evidence on Hand

- Demo data: `npm run demo` seeds a made-up budget (`packages/core/src/demo.ts`) for screenshots and design work.
- The household's real budget data is private and must not appear in design artifacts.
- No testimonials, users beyond the household, or marketing claims exist; none should be invented.

## Product Principles

1. The phone check-in comes first: the daily job (approve, categorize, check a balance) must be fast and one-handed.
2. Two equal owners: never design as if one person is the admin and the other a guest.
3. Numbers must be trusted: show what money is for and where it sits plainly, and never hide a figure that disagrees.
4. Plan, don't act: the app explains and suggests; people make every move themselves.
5. Works alone: nothing in the experience may depend on the server being reachable.
