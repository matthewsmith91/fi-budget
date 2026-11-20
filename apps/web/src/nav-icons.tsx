/** Line icons for the phone's tab bar, drawn on a 24px grid in the current text colour. */

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="tab-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Envelopes: a wallet. */
function BudgetIcon() {
  return (
    <Icon>
      <path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6" />
      <path d="M16 14h.01" />
    </Icon>
  )
}

/** An inbox tray. */
function InboxIcon() {
  return (
    <Icon>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Icon>
  )
}

/** Lines of a ledger. */
function RegisterIcon() {
  return (
    <Icon>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </Icon>
  )
}

/** A bar chart. */
function ReportsIcon() {
  return (
    <Icon>
      <path d="M3 3v18h18" />
      <path d="M8 17v-5M13 17V8M18 17v-8" />
    </Icon>
  )
}

/** Three dots. */
function MoreIcon() {
  return (
    <Icon>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </Icon>
  )
}

const ICONS: Record<string, () => React.ReactElement> = {
  budget: BudgetIcon,
  inbox: InboxIcon,
  accounts: RegisterIcon,
  reports: ReportsIcon,
  more: MoreIcon,
}

/** The icon for a tab, by its nav item id ('more' for the More tab); nothing for an unknown id. */
export function TabIcon({ id }: { id: string }) {
  const Drawn = ICONS[id]
  return Drawn ? <Drawn /> : null
}
