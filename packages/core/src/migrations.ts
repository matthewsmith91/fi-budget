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
    // change itself. \`value\` has no declared type so numbers and text keep their type.
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
