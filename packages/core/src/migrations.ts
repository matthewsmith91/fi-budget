import type { SqlRunner, StorageAdapter } from './storage.ts'

export interface Migration {
  version: number
  name: string
  up: readonly string[]
}

/** Append-only: a released migration must never be edited. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'identity',
    up: [
      `CREATE TABLE households (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        encryption_key_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE members (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES households(id),
        display_name TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        member_id TEXT REFERENCES members(id),
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('local', 'sync')),
        last_sync_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'accounts-and-categories',
    // No UNIQUE on names: two devices may add the same name offline, and sync must
    // be able to merge both rows. The API rejects duplicates it can see.
    up: [
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('checking', 'credit', 'savings', 'investment')),
        on_budget INTEGER NOT NULL CHECK (on_budget IN (0, 1)),
        closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL,
        CHECK (type <> 'investment' OR on_budget = 0)
      )`,
      `CREATE TABLE category_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES category_groups(id),
        name TEXT NOT NULL,
        need_or_want TEXT NOT NULL DEFAULT 'want' CHECK (need_or_want IN ('need', 'want')),
        sort INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX categories_group ON categories(group_id, sort)`,
    ],
  },
  {
    version: 3,
    name: 'messages',
    // The change log: one row per field change, written in the same transaction as the
    // change itself. `value` has no declared type so numbers and text keep their type.
    // A delete is column '_deleted' with value 1.
    up: [
      `CREATE TABLE messages (
        timestamp TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        column_name TEXT NOT NULL,
        value,
        device_id TEXT NOT NULL
      )`,
      `CREATE INDEX messages_row ON messages(table_name, row_id, column_name)`,
    ],
  },
  {
    version: 4,
    name: 'allocations-and-transactions',
    // Amounts are integer cents; spending is negative. month is YYYY-MM and a transaction
    // date is YYYY-MM-DD. goal_id has no foreign key until goals exist (Phase 3).
    up: [
      `CREATE TABLE allocations (
        id TEXT PRIMARY KEY,
        month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
        category_id TEXT NOT NULL REFERENCES categories(id),
        goal_id TEXT,
        amount INTEGER NOT NULL CHECK (amount <> 0),
        source TEXT NOT NULL CHECK (source IN ('manual', 'rule', 'move', 'contribution')),
        note TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX allocations_category ON allocations(category_id, month)`,
      `CREATE INDEX allocations_month ON allocations(month)`,
      `CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
        payee TEXT,
        amount INTEGER NOT NULL,
        cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
        reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
        import_id TEXT,
        transfer_pair_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX transactions_account ON transactions(account_id, date)`,
      `CREATE TABLE transaction_splits (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        category_id TEXT REFERENCES categories(id),
        goal_id TEXT,
        amount INTEGER NOT NULL,
        need_or_want_override TEXT CHECK (need_or_want_override IN ('need', 'want')),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX transaction_splits_transaction ON transaction_splits(transaction_id)`,
      `CREATE INDEX transaction_splits_category ON transaction_splits(category_id)`,
    ],
  },
  {
    version: 5,
    name: 'sync-state',
    // `synced` is 1 once the server has a message (sent by this device or received from
    // it). Messages that predate sync stay 0 and go up with the first push. sync_state
    // holds the server cursor and the time of the last completed sync.
    up: [
      `ALTER TABLE messages ADD COLUMN synced INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX messages_unsynced ON messages(timestamp) WHERE synced = 0`,
      `CREATE TABLE sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 6,
    name: 'credit-card-payment-categories',
    // A credit card's payment category points at its account. Cards that already exist get
    // theirs here, with the same deterministic ids the app uses for new cards, so devices
    // that each run this migration agree on the rows (it writes no change messages).
    up: [
      `ALTER TABLE categories ADD COLUMN credit_card_account_id TEXT`,
      `CREATE UNIQUE INDEX categories_credit_card ON categories(credit_card_account_id)
         WHERE credit_card_account_id IS NOT NULL`,
      `INSERT INTO category_groups (id, name, sort, hidden, created_at)
         SELECT 'credit-card-payments', 'Credit Card Payments',
           COALESCE((SELECT MAX(sort) + 1 FROM category_groups), 0), 0,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE EXISTS (SELECT 1 FROM accounts WHERE type = 'credit' AND on_budget = 1)`,
      `INSERT INTO categories (id, group_id, name, need_or_want, sort, hidden, credit_card_account_id, created_at)
         SELECT 'payment-' || a.id, 'credit-card-payments', a.name, 'need',
           ROW_NUMBER() OVER (ORDER BY a.created_at, a.rowid) - 1, 0, a.id,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM accounts a WHERE a.type = 'credit' AND a.on_budget = 1`,
    ],
  },
  {
    version: 7,
    name: 'bank-import',
    // approved = 0 puts a transaction in the inbox: imported from the bank, not yet looked
    // at. external_accounts maps a bank account (its SimpleFIN id) to an app account, and
    // dismissed_imports remembers bank transactions that were thrown away so the next
    // fetch does not bring them back. Both are keyed by deterministic ids so two devices
    // that do the same thing converge on one row. Existing rows count as approved.
    up: [
      `ALTER TABLE transactions ADD COLUMN approved INTEGER NOT NULL DEFAULT 1 CHECK (approved IN (0, 1))`,
      `CREATE INDEX transactions_import ON transactions(import_id) WHERE import_id IS NOT NULL`,
      `CREATE INDEX transactions_unapproved ON transactions(date) WHERE approved = 0`,
      `CREATE TABLE external_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        org TEXT NOT NULL DEFAULT '',
        account_id TEXT REFERENCES accounts(id),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE dismissed_imports (
        id TEXT PRIMARY KEY,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 8,
    name: 'payee-rules',
    // A payee containing `match` (whole words, any case) is put in `category_id` when it is
    // imported. No UNIQUE on match: two devices may add the same rule offline, and the API
    // rejects the duplicates it can see.
    up: [
      `CREATE TABLE payee_rules (
        id TEXT PRIMARY KEY,
        match TEXT NOT NULL,
        category_id TEXT NOT NULL REFERENCES categories(id),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX payee_rules_category ON payee_rules(category_id)`,
    ],
  },
  {
    version: 9,
    name: 'investment-accounts',
    // An investment account's settings row has the account's id as its id, so two devices
    // that set an account up offline write the same row. A valuation's id is the account
    // and the day, so one day has one value however many devices or fetches report it.
    // `source` records whether a person typed it or the bank reported it.
    up: [
      `CREATE TABLE investment_accounts (
        id TEXT PRIMARY KEY REFERENCES accounts(id),
        tax_type TEXT NOT NULL CHECK (tax_type IN ('roth', 'traditional', 'taxable', '529')),
        owner_member_id TEXT REFERENCES members(id),
        mode TEXT NOT NULL DEFAULT 'units' CHECK (mode IN ('units', 'holdings')),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE account_valuations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
        market_value INTEGER NOT NULL CHECK (market_value >= 0),
        source TEXT NOT NULL CHECK (source IN ('manual', 'sync')),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX account_valuations_account ON account_valuations(account_id, date)`,
    ],
  },
  {
    version: 10,
    name: 'investment-kinds',
    // What sort of account it is (IRA, 401(k), brokerage...), beside its tax treatment.
    // Accounts that already have settings get the kind their tax type implies, or 'other'
    // when it does not say (a Roth or traditional account could be any retirement kind).
    up: [
      `ALTER TABLE investment_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'
         CHECK (kind IN ('brokerage', 'ira', '401k', '403b', '457', '401a', 'sep-ira', 'simple-ira', '529', 'other'))`,
      `UPDATE investment_accounts SET kind = CASE tax_type
         WHEN 'taxable' THEN 'brokerage' WHEN '529' THEN '529' ELSE 'other' END`,
    ],
  },
  {
    version: 11,
    name: 'goals',
    // A goal is a sinking fund inside a category. Money reaches it through allocations and
    // leaves it through splits that carry its id (allocations.goal_id and
    // transaction_splits.goal_id already exist). No UNIQUE on name: two devices may add the
    // same goal offline, and the API rejects the duplicates it can see.
    up: [
      `CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL REFERENCES categories(id),
        name TEXT NOT NULL,
        target_amount INTEGER NOT NULL CHECK (target_amount > 0),
        target_date TEXT CHECK (target_date IS NULL
          OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX goals_category ON goals(category_id)`,
      `CREATE INDEX allocations_goal ON allocations(goal_id) WHERE goal_id IS NOT NULL`,
      `CREATE INDEX transaction_splits_goal ON transaction_splits(goal_id) WHERE goal_id IS NOT NULL`,
    ],
  },
  {
    version: 12,
    name: 'goal-held-in',
    // The account a goal's money sits in; null means it isn't tied to one. Nothing enforces
    // it: the budget only warns when the goals held in an account add up to more than it has.
    up: [`ALTER TABLE goals ADD COLUMN held_in_account_id TEXT REFERENCES accounts(id)`],
  },
  {
    version: 13,
    name: 'emergency-fund-settings',
    // The household's emergency fund: which goal it is, how many months of Need spending it
    // should cover, and how many trailing months that spending is averaged over. They sit on
    // the household row so they sync like any other field; the defaults apply on every device.
    up: [
      `ALTER TABLE households ADD COLUMN emergency_fund_goal_id TEXT REFERENCES goals(id)`,
      `ALTER TABLE households ADD COLUMN emergency_fund_months INTEGER NOT NULL DEFAULT 6`,
      `ALTER TABLE households ADD COLUMN emergency_fund_window INTEGER NOT NULL DEFAULT 12`,
    ],
  },
  {
    version: 14,
    name: 'emergency-fund-category',
    // The emergency fund is a category, not a goal: it appears in the budget like any other.
    up: [
      `ALTER TABLE households ADD COLUMN emergency_fund_category_id TEXT REFERENCES categories(id)`,
      `ALTER TABLE households DROP COLUMN emergency_fund_goal_id`,
    ],
  },
  {
    version: 15,
    name: 'income-rules',
    // A rule matches income (a payee's words and/or an account) and assigns a percent of it,
    // or a fixed amount, to a category or goal, lowest priority first. `percent` may have up
    // to three decimals. No check ties percent and fixed_amount together: two devices editing
    // a rule offline could each win one column, and the engine skips a rule that has both or
    // neither. An allocation a rule makes names the transaction and the rule behind it, so a
    // refund or a deleted deposit can find and reverse it. `gross_amount` is the pre-tax pay
    // typed on a deposit, for rules on a gross basis. `reverses_id` ties an outflow to the
    // deposit it takes back.
    up: [
      `CREATE TABLE income_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        match TEXT,
        account_id TEXT REFERENCES accounts(id),
        basis TEXT NOT NULL DEFAULT 'net' CHECK (basis IN ('net', 'gross')),
        percent REAL CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
        fixed_amount INTEGER CHECK (fixed_amount IS NULL OR fixed_amount > 0),
        category_id TEXT NOT NULL REFERENCES categories(id),
        goal_id TEXT REFERENCES goals(id),
        priority INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX income_rules_category ON income_rules(category_id)`,
      `ALTER TABLE allocations ADD COLUMN source_transaction_id TEXT`,
      `ALTER TABLE allocations ADD COLUMN income_rule_id TEXT`,
      `CREATE INDEX allocations_source_transaction ON allocations(source_transaction_id)
         WHERE source_transaction_id IS NOT NULL`,
      `ALTER TABLE transactions ADD COLUMN gross_amount INTEGER
         CHECK (gross_amount IS NULL OR gross_amount > 0)`,
      `ALTER TABLE transactions ADD COLUMN reverses_id TEXT`,
      `CREATE INDEX transactions_reverses ON transactions(reverses_id) WHERE reverses_id IS NOT NULL`,
    ],
  },
  {
    version: 16,
    name: 'unit-ledger',
    // What goals own inside an investment account. `unit_events` is the ledger: `units` is in
    // millionths of a unit so sums are exact, `unit_price` is cents per whole unit as it was
    // when the row was written, `amount` the cash value in cents and `basis` the cost of the
    // units (for a sell, the cost taken out, so realized gain is amount - basis). A null
    // goal_id is the account's Unassigned part. A row made by a transaction has a
    // deterministic id built from `transaction_id`, so two devices converge on one row; it is
    // voided rather than deleted when the transaction stops qualifying, because a delete is
    // permanent. `batch_id` ties the rows of one manual entry (both sides of a move).
    // A holding is one investment (a fund, a stock) that a goal owns in a holdings-mode
    // account; its price is the latest one entered, in cents per share. Events on a holding
    // carry holding_id and no goal_id, so moving a holding to another goal is one update.
    // `contribution_limits` holds a household's own annual IRA limit for a person and year;
    // a null amount means the built-in default applies (rows are never deleted).
    up: [
      `CREATE TABLE holdings (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        goal_id TEXT REFERENCES goals(id),
        name TEXT NOT NULL,
        price REAL CHECK (price IS NULL OR price > 0),
        price_date TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX holdings_account ON holdings(account_id)`,
      `CREATE TABLE unit_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        goal_id TEXT REFERENCES goals(id),
        holding_id TEXT REFERENCES holdings(id),
        transaction_id TEXT,
        batch_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('buy', 'sell', 'dividend', 'move_in', 'move_out')),
        units INTEGER NOT NULL CHECK (units >= 0),
        unit_price REAL NOT NULL CHECK (unit_price > 0),
        amount INTEGER NOT NULL CHECK (amount >= 0),
        basis INTEGER NOT NULL CHECK (basis >= 0),
        date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
        voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX unit_events_account ON unit_events(account_id, date)`,
      `CREATE INDEX unit_events_goal ON unit_events(goal_id) WHERE goal_id IS NOT NULL`,
      `CREATE INDEX unit_events_holding ON unit_events(holding_id) WHERE holding_id IS NOT NULL`,
      `CREATE INDEX unit_events_transaction ON unit_events(transaction_id)
         WHERE transaction_id IS NOT NULL`,
      `CREATE TABLE contribution_limits (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id),
        year INTEGER NOT NULL,
        amount INTEGER CHECK (amount IS NULL OR amount >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 17,
    name: 'retirement-planning',
    // What a category does once paychecks stop: it continues, ends (529 contributions, a
    // mortgage that gets paid off) or changes by a multiplier (travel x1.5). The multiplier
    // only means something for 'changes'; the API clears it otherwise, and a 'changes'
    // category with none reads as x1, because two devices editing offline may each win one
    // column. `retirement_assumptions` is one row per household (the API gives it the id
    // 'retirement', so two devices that save first converge on one row): `birth_month` is
    // the month of the person the projection follows, `monthly_contribution` is cents a month
    // into retirement accounts, and both rates are percent per year. Nothing but the birth
    // month is nullable; the API writes every value when it creates the row.
    up: [
      `ALTER TABLE categories ADD COLUMN retirement_status TEXT NOT NULL DEFAULT 'continues'
         CHECK (retirement_status IN ('continues', 'ends', 'changes'))`,
      `ALTER TABLE categories ADD COLUMN retirement_multiplier REAL
         CHECK (retirement_multiplier IS NULL OR retirement_multiplier > 0)`,
      `CREATE TABLE retirement_assumptions (
        id TEXT PRIMARY KEY,
        birth_month TEXT CHECK (birth_month IS NULL
          OR birth_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
        target_age INTEGER NOT NULL,
        monthly_contribution INTEGER NOT NULL CHECK (monthly_contribution >= 0),
        return_rate REAL NOT NULL,
        inflation_rate REAL NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 18,
    name: 'planning',
    // The retirement spending model, 529 plans and recurring bills. The two new assumptions
    // have defaults, so a row an older device wrote (without them) still rebuilds on sync.
    // A fixed item's age window is `start_age <= age < end_age`; either end may be missing.
    // An education plan may name a 529 (or other investment) account and, inside it, the goal
    // that holds one child's share; both links are cleared when the account or goal goes.
    // A recurring item's `amount` is signed (a bill is negative, a paycheck positive) and its
    // `next_date` is the next occurrence nobody has dealt with yet; `anchor_day` keeps a
    // monthly bill on the 31st from drifting to the 28th after a short month.
    up: [
      `ALTER TABLE retirement_assumptions ADD COLUMN withdrawal_rate REAL NOT NULL DEFAULT 4`,
      `ALTER TABLE retirement_assumptions ADD COLUMN lookback_months INTEGER NOT NULL DEFAULT 12`,
      `CREATE TABLE retirement_fixed_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        annual_amount INTEGER NOT NULL CHECK (annual_amount > 0),
        start_age INTEGER CHECK (start_age IS NULL OR start_age BETWEEN 0 AND 120),
        end_age INTEGER CHECK (end_age IS NULL OR end_age BETWEEN 0 AND 120),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE education_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        account_id TEXT REFERENCES accounts(id),
        goal_id TEXT REFERENCES goals(id),
        target_amount INTEGER NOT NULL CHECK (target_amount > 0),
        target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
        monthly_contribution INTEGER NOT NULL CHECK (monthly_contribution >= 0),
        return_rate REAL NOT NULL,
        inflation_rate REAL NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE recurring (
        id TEXT PRIMARY KEY,
        payee TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount <> 0),
        cadence TEXT NOT NULL
          CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
        next_date TEXT NOT NULL CHECK (next_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
        anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
        category_id TEXT REFERENCES categories(id),
        account_id TEXT REFERENCES accounts(id),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 19,
    name: 'transfer-pair-index',
    // Listing transactions looks up each transfer's other leg by `transfer_pair_id`. With no
    // index that was a full scan per row, so a register of ~13k imported transactions took
    // over 10 seconds to list.
    up: [
      `CREATE INDEX transactions_transfer_pair ON transactions(transfer_pair_id)
         WHERE transfer_pair_id IS NOT NULL`,
    ],
  },
  {
    version: 20,
    name: 'emergency-draws',
    // A transaction marked as an emergency is paid for from the emergency fund: money moves
    // from the fund's category into the transaction's own, so its category keeps the real
    // spending. The moves are ordinary 'move' allocations that name the transaction
    // (`source_transaction_id`) and the fund they came out of (`fund_category_id`, on both rows
    // of the pair), so an edit or an unmark can find and reverse them and the report can total them.
    up: [
      `ALTER TABLE transactions ADD COLUMN emergency INTEGER NOT NULL DEFAULT 0
         CHECK (emergency IN (0, 1))`,
      `ALTER TABLE allocations ADD COLUMN fund_category_id TEXT`,
      `CREATE INDEX transactions_emergency ON transactions(date) WHERE emergency = 1`,
    ],
  },
  {
    version: 21,
    name: 'profiles',
    // A member is a profile: the personal facts the retirement plan needs, one set per person
    // instead of one set for the household. Money is integer cents in today's dollars, rates are
    // percent a year. `income_growth` is a nominal yearly raise; with `contribution_follows_raises`
    // the monthly contribution grows by that raise after inflation, otherwise it stays flat.
    // Social Security and a pension are monthly cents from the age named.
    //
    // `member_links` says how two members relate. A link is one row per pair under the id
    // `link-<lower id>:<higher id>` so two devices linking the same pair converge on one row;
    // `relationship` is null once unlinked, never deleted, because a delete is permanent and the
    // pair may be linked again. Spouses and partners share finances in the retirement plan;
    // `relative` is a record only.
    //
    // The household's old retirement row followed one unnamed person. Their birth month, target
    // age and contribution move to the first member (the same one on every device), and the
    // columns stay in `retirement_assumptions` unread, because older devices still write them.
    up: [
      `ALTER TABLE members ADD COLUMN birth_month TEXT
         CHECK (birth_month IS NULL OR birth_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')`,
      `ALTER TABLE members ADD COLUMN retirement_age INTEGER NOT NULL DEFAULT 65
         CHECK (retirement_age BETWEEN 40 AND 90)`,
      `ALTER TABLE members ADD COLUMN monthly_contribution INTEGER NOT NULL DEFAULT 0
         CHECK (monthly_contribution >= 0)`,
      `ALTER TABLE members ADD COLUMN annual_income INTEGER NOT NULL DEFAULT 0
         CHECK (annual_income >= 0)`,
      `ALTER TABLE members ADD COLUMN income_growth REAL NOT NULL DEFAULT 3`,
      `ALTER TABLE members ADD COLUMN contribution_follows_raises INTEGER NOT NULL DEFAULT 0
         CHECK (contribution_follows_raises IN (0, 1))`,
      `ALTER TABLE members ADD COLUMN social_security_monthly INTEGER NOT NULL DEFAULT 0
         CHECK (social_security_monthly >= 0)`,
      `ALTER TABLE members ADD COLUMN social_security_age INTEGER NOT NULL DEFAULT 67
         CHECK (social_security_age BETWEEN 62 AND 70)`,
      `ALTER TABLE members ADD COLUMN pension_monthly INTEGER NOT NULL DEFAULT 0
         CHECK (pension_monthly >= 0)`,
      `ALTER TABLE members ADD COLUMN pension_age INTEGER NOT NULL DEFAULT 65
         CHECK (pension_age BETWEEN 40 AND 90)`,
      `CREATE TABLE member_links (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id),
        related_member_id TEXT NOT NULL REFERENCES members(id),
        relationship TEXT CHECK (relationship IS NULL
          OR relationship IN ('spouse', 'partner', 'relative')),
        created_by TEXT,
        created_at TEXT NOT NULL,
        CHECK (member_id <> related_member_id)
      )`,
      `UPDATE members SET
         birth_month = (SELECT birth_month FROM retirement_assumptions ORDER BY created_at, id LIMIT 1),
         retirement_age = (SELECT target_age FROM retirement_assumptions ORDER BY created_at, id LIMIT 1),
         monthly_contribution = (SELECT monthly_contribution FROM retirement_assumptions
                                 ORDER BY created_at, id LIMIT 1)
       WHERE id = (SELECT id FROM members ORDER BY created_at, id LIMIT 1)
         AND EXISTS (SELECT 1 FROM retirement_assumptions)`,
    ],
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

export class SchemaTooNewError extends Error {
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(
      `This budget file is schema version ${found}, but this app only understands up to ${supported}. Update the app and try again.`,
    )
    this.found = found
    this.supported = supported
    this.name = 'SchemaTooNewError'
  }
}

const CREATE_SCHEMA_VERSION = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)`

export async function currentVersion(db: SqlRunner): Promise<number> {
  await db.exec(CREATE_SCHEMA_VERSION)
  const [row] = await db.query<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_version')
  return row?.v ?? 0
}

/** Applies pending migrations inside whatever transaction the caller holds. */
export async function applyMigrations(
  db: SqlRunner,
  opts: { target?: number; now?: () => string; migrations?: readonly Migration[] } = {},
): Promise<number[]> {
  const migrations = opts.migrations ?? MIGRATIONS
  const latest = migrations[migrations.length - 1]!.version
  const target = opts.target ?? latest
  const now = opts.now ?? (() => new Date().toISOString())
  const from = await currentVersion(db)
  if (from > latest) throw new SchemaTooNewError(from, latest)
  const applied: number[] = []
  for (const m of migrations) {
    if (m.version <= from || m.version > target) continue
    for (const stmt of m.up) await db.exec(stmt)
    await db.exec('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
      m.version,
      now(),
    ])
    applied.push(m.version)
  }
  return applied
}

/** Brings a device's file to the latest schema, one atomic step per migration. */
export async function migrate(
  adapter: StorageAdapter,
  opts: { now?: () => string; migrations?: readonly Migration[] } = {},
): Promise<number[]> {
  const migrations = opts.migrations ?? MIGRATIONS
  const latest = migrations[migrations.length - 1]!.version
  const from = await adapter.transaction((tx) => currentVersion(tx))
  if (from > latest) throw new SchemaTooNewError(from, latest)
  const applied: number[] = []
  for (const m of migrations) {
    if (m.version <= from) continue
    await adapter.transaction(async (tx) => {
      applied.push(...(await applyMigrations(tx, { target: m.version, ...opts })))
    })
  }
  return applied
}
