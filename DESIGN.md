---
name: Household Budget
description: A quiet, precise instrument for a two-person household's envelope budget and long-range plan.
colors:
  ledger-blue: '#2f78c4'
  ledger-blue-ink: '#ffffff'
  harbor-navy: '#1f2740'
  harbor-navy-hover: '#2b3556'
  harbor-navy-active: '#3a64a8'
  harbor-navy-line: '#333d5e'
  harbor-fg: '#dfe5f3'
  harbor-muted: '#98a3bf'
  mist-page: '#f4f6fa'
  paper-surface: '#ffffff'
  slate-ink: '#1d2433'
  slate-muted: '#636d80'
  hairline: '#e3e7ee'
  row-hover: '#f0f4fb'
  group-band: '#eef1f7'
  funded-bg: '#bfe8b5'
  funded-fg: '#1f4d17'
  settled-bg: '#e4e8ef'
  settled-fg: '#5a6477'
  overspent-bg: '#f6c9c4'
  overspent-fg: '#8a1c12'
  caution-bg: '#fff4d6'
  caution-fg: '#5c4200'
  error-red: '#b3261e'
  cleared-green: '#3d9a5b'
  frame-strong: '#ffffff'
  series-blue: '#2a78d6'
  series-orange: '#eb6834'
  mist-page-dark: '#151a28'
  paper-surface-dark: '#1d2335'
  slate-ink-dark: '#e6eaf4'
  slate-muted-dark: '#96a1ba'
  hairline-dark: '#2c3450'
  ledger-blue-dark: '#5b9be0'
  harbor-navy-dark: '#10162a'
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: '1.5rem'
    fontWeight: 600
    lineHeight: 1.2
    fontFeature: 'tnum'
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: '1.35rem'
    fontWeight: 650
    lineHeight: 1.2
    fontFeature: 'tnum'
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: '1.05rem'
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: '15px'
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: 'tnum'
  small:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: '0.85rem'
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: '0.72rem'
    fontWeight: 600
    letterSpacing: '0.06em'
rounded:
  xs: '0.25rem'
  sm: '0.35rem'
  md: '0.4rem'
  lg: '0.6rem'
  xl: '0.75rem'
  sheet: '0.9rem'
  pill: '999px'
spacing:
  xs: '0.25rem'
  sm: '0.5rem'
  md: '0.75rem'
  lg: '1rem'
  xl: '1.5rem'
  tap: '44px'
components:
  button-primary:
    backgroundColor: '{colors.ledger-blue}'
    textColor: '{colors.ledger-blue-ink}'
    rounded: '{rounded.md}'
    padding: '0 0.9rem'
    height: '2.25rem'
  button-secondary:
    backgroundColor: 'transparent'
    textColor: '{colors.slate-ink}'
    rounded: '{rounded.md}'
    padding: '0 0.9rem'
    height: '2.25rem'
  button-secondary-hover:
    backgroundColor: '{colors.row-hover}'
  input:
    backgroundColor: '{colors.paper-surface}'
    textColor: '{colors.slate-ink}'
    rounded: '{rounded.md}'
    padding: '0 0.55rem'
    height: '2.25rem'
  card:
    backgroundColor: '{colors.paper-surface}'
    rounded: '{rounded.lg}'
    padding: '1rem 1.1rem'
  pill-funded:
    backgroundColor: '{colors.funded-bg}'
    textColor: '{colors.funded-fg}'
    rounded: '{rounded.pill}'
    padding: '0.1rem 0.6rem'
    width: '5.5rem'
  pill-settled:
    backgroundColor: '{colors.settled-bg}'
    textColor: '{colors.settled-fg}'
    rounded: '{rounded.pill}'
    padding: '0.1rem 0.6rem'
    width: '5.5rem'
  pill-overspent:
    backgroundColor: '{colors.overspent-bg}'
    textColor: '{colors.overspent-fg}'
    rounded: '{rounded.pill}'
    padding: '0.1rem 0.6rem'
    width: '5.5rem'
  ready-to-assign:
    rounded: '{rounded.lg}'
    padding: '0.45rem 1.1rem'
    typography: '{typography.headline}'
  topnav:
    backgroundColor: '{colors.paper-surface}'
    textColor: '{colors.slate-ink}'
    height: '2.75rem'
  tabbar:
    backgroundColor: '{colors.harbor-navy}'
    textColor: '{colors.harbor-muted}'
    height: '3.25rem'
  sidebar:
    backgroundColor: '{colors.harbor-navy}'
    textColor: '{colors.harbor-fg}'
    width: '16rem'
  dialog:
    backgroundColor: '{colors.paper-surface}'
    rounded: '{rounded.xl}'
    padding: '1.25rem'
    width: '24rem'
---

# Design System: Household Budget

## Overview

**Creative North Star: "The Quiet Instrument"**

The app is a precise tool that stays out of the way until a number needs attention. Most of every screen is quiet: a cool off-white page, white bordered surfaces, slate text, system type set with tabular figures so columns of money line up to the cent. Against that calm, the only things that carry color are the state of money (funded, settled, overspent, needs a look) and the one place to act. When something turns red, it is because a category is overspent, never because a designer wanted energy.

Density is that of a working ledger, not a dashboard. Tables are compact (0.4rem by 0.75rem cells, hairline rules), headers are small uppercase labels, and figures sit right-aligned. On a phone the same content opens up to 44px targets, a navy tab bar under the thumb and bottom sheets for anything that used to be a menu, because the daily check-in happens one-handed. A deep navy frame (the desk sidebar, the phone's top and tab bars) holds the household's accounts and the way around; the white working surface sits inside it.

Light and dark follow the system setting with the same roles: the dark theme deepens the navy frame and lifts the blue accent rather than inverting the design.

**Key Characteristics:**

- Calm neutral working surface, navy frame, one blue for action.
- Color means money state, nothing else.
- Tabular figures everywhere money appears.
- Flat surfaces separated by hairlines; shadow only on what floats.
- Phone-first touch sizes (44px) and bottom sheets below 800px.

## Colors

A cool, low-chroma slate and navy palette whose only saturated colors report the state of money.

### Primary

- **Ledger Blue** (#2f78c4; dark #5b9be0): the single action and selection color. Primary buttons, links, the focus ring, the active top-nav underline, goal progress bars, the inbox badge. It never fills large areas.

### Secondary

- **Harbor Navy** (#1f2740; dark #10162a): the frame. Desk sidebar (accounts, household header), phone top bar and tab bar. Its own ramp handles hover (#2b3556), the active item (#3a64a8) and dividers (#333d5e), with pale text (#dfe5f3) and muted text (#98a3bf).

### Tertiary

- **Status pairs**, always used as a background with its matching ink, never alone:
  - **Funded** (#bfe8b5 / #1f4d17): available money, positive Ready to Assign.
  - **Settled** (#e4e8ef / #5a6477): exactly zero.
  - **Overspent** (#f6c9c4 / #8a1c12): negative available, money assigned that you don't have.
  - **Caution** (#fff4d6 / #5c4200): warning banners, the emergency tag, held-in over-allocation.
  - **Error Red** (#b3261e; dark #ff8a80): error text and destructive buttons.
  - **Cleared Green** (#3d9a5b with white tick, `--cleared`/`--cleared-fg`): the filled cleared toggle in the register.
- **Frame Strong** (#ffffff, `--side-strong`): text and marks on the navy frame's active items (current account, active tab, inbox badge).
- **Chart series**: Series Blue (#2a78d6) and Series Orange (#eb6834) for the two lines of `LineChart`.

### Neutral

- **Mist Page** (#f4f6fa; dark #151a28): the page background behind everything.
- **Paper Surface** (#ffffff; dark #1d2335): cards, tables, dialogs, the top nav, inputs.
- **Slate Ink** (#1d2433; dark #e6eaf4): body text and figures.
- **Slate Muted** (#636d80; dark #96a1ba): labels, captions, column headers, secondary figures.
- **Hairline** (#e3e7ee; dark #2c3450): every border and table rule.
- **Row Hover** (#f0f4fb) and **Group Band** (#eef1f7): hover rows and category-group header rows in the budget table.

### Named Rules

**The Color Means Status Rule.** Saturated color appears only to report money state (funded, settled, overspent, caution, error) or to mark the one action or current place (Ledger Blue). No decorative color, no colored section headers, no tinted cards for variety.

**The Paired Ink Rule.** A status background always carries its own ink color (funded-bg with funded-fg, and so on). Never put status color on text alone over white.

## Typography

**Display Font:** system-ui (with -apple-system, Segoe UI, sans-serif)
**Body Font:** the same system stack
**Label/Mono Font:** ui-monospace only for invite and setup codes

**Character:** One native system face at every level, so the app reads like part of the device. Hierarchy comes from weight (400, 500, 600, 650) and size, not from a second family.

### Hierarchy

- **Display** (600, 1.5rem, 1.2): page titles and the budget's month name (1.1rem on phones).
- **Headline** (650, 1.35rem, 1.2, tabular): the Ready to Assign amount; hero figures on report cards.
- **Title** (700, 1.05rem): card and dialog headings, the household name.
- **Body** (400, 15px, 1.45, tabular): everything else, including table rows. Inputs drop to 16px on phones so iOS doesn't zoom.
- **Small** (400, 0.85rem): sidebar meta, totals rows, notes and hints (0.78-0.9rem in places).
- **Label** (600, 0.72rem, 0.06em, uppercase): table column headers only.

### Named Rules

**The Tabular Figures Rule.** Every number that is money is set with `font-variant-numeric: tabular-nums` and right-aligned in its column. A figure that jiggles as it changes, or doesn't line up with the one above it, is a bug.

## Layout

Desk (above 800px): a two-column grid, a 16rem navy sidebar fixed to the left and the working column beside it. The working column has a sticky white top nav (2.75rem) with Plan and Insights dropdowns, then the page, centered at 64rem max (`page-wide` lets the budget grow to show peek months; `narrow` is 28rem for setup). Main padding is 0 1.5rem 2rem. Page headers sit in 1.25rem 0 1rem with title left and key figures right.

Phone (800px and below): the sidebar becomes a drawer behind the ☰ in a navy top bar that respects the safe area; a fixed navy tab bar (Budget, Inbox, Register, Reports, More) sits at the bottom above the home indicator. Table cell padding tightens to 0.4rem inline, and the budget's sticky header sits right under the top bar. Every tap target is at least 44px.

Spacing uses rem steps around 0.25, 0.5, 0.75, 1 and 1.5rem; components pick within that range rather than from a strict scale.

## Elevation & Depth

The system is flat. Surfaces are separated by 1px hairlines and by the step from Mist Page to Paper Surface, never by shadow. Shadow is reserved for things that float over the page: the top-nav dropdown lists and menus. Dialogs float on a dark scrim (rgb(8 12 24 / 0.55)) instead of a shadow. Active states use inset bars, not lift: a 3px underline in the top nav, a 3px top bar on the active phone tab, a left border in the sidebar.

### Shadow Vocabulary

- **Float** (`--float-shadow`: `0 8px 24px rgb(0 0 0 / 0.18)`): dropdown lists, menus and comboboxes that overlay content.
- **Scrim** (`--scrim`: `rgb(8 12 24 / 0.55)`): behind dialogs, sheets and the phone's account drawer.

### Named Rules

**The Only Floats Cast Shadows Rule.** A surface that sits in the page flow (card, table, banner) has a border and no shadow. Only an element that hovers over other content gets the Float shadow.

## Shapes

Gently rounded and consistent. Controls (buttons, inputs) are 0.4rem; small icon buttons and menu items 0.35rem; cards, tables and the Ready to Assign block 0.6rem; dialogs 0.75rem; a phone bottom sheet rounds only its top corners (0.9rem). Status pills and badges are fully round (999px), which is how a figure reads as a state at a glance. Tags are small outlined rectangles (0.3rem) in currentColor. Nav bars and tabs are square.

## Components

### Buttons

Plain and direct.

- **Shape:** gently rounded (0.4rem), 2.25rem tall (44px on phones), 0 0.9rem padding, inheriting the body font.
- **Primary:** Ledger Blue fill, white text. There is normally one per view or form.
- **Secondary:** transparent with a hairline border and Slate Ink text; hover fills with Row Hover.
- **Danger:** secondary shape with Error Red text.
- **Link:** no box, underlined Ledger Blue text.
- **Icon button:** transparent 1.75rem square (44px on phones), Row Hover on hover.
- **Disabled:** 45% opacity.
- **Focus:** a 2px Ledger Blue outline, 1px offset, on every focusable element.

### Chips (Status Pills)

- **Style:** fully round, 600 weight, centered, at least 5.5rem wide so a column of them aligns; status background with its paired ink.
- **State:** funded, settled or overspent only. A pill that is a link (Activity to the register) keeps the look and gains a hover.

### Cards / Containers

- **Corner Style:** 0.6rem.
- **Background:** Paper Surface on Mist Page.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px Hairline.
- **Internal Padding:** 1rem 1.1rem; stacked with 1rem between cards. Tables live in the same bordered wrapper and scroll sideways inside it rather than widening the page.

### Inputs / Fields

- **Style:** 1px Hairline, Paper Surface, 0.4rem, 2.25rem tall; labels sit above in a 0.25rem grid.
- **In-table amount (Assigned):** borderless until hovered (hairline) and focused (Ledger Blue border, white fill), so the budget reads as figures, not a form.
- **Error:** inline error text in Error Red under the field; invalid inputs are marked with `aria-invalid`. The row stays open with what was typed.

### Navigation

- **Desk top nav:** white bar with a hairline bottom, 500-weight links; the current page gets a 3px Ledger Blue underline and 650 weight; dropdowns are Float-shadowed lists of 0.35rem items.
- **Desk sidebar:** Harbor Navy; account rows with right-aligned balances, the active one in Harbor Navy Active with a white left edge; negative balances flagged.
- **Phone:** navy top bar and five-tab navy tab bar, 0.75rem labels in Harbor Muted, the active tab white with a 3px top bar; the inbox count is a round badge on its tab.

### Ready to Assign Block

The budget's signature figure: a 0.6rem rounded block, right-aligned, holding the amount in Headline type over a small caption, filled with the funded, settled or overspent pair. Income this month sits beside it as a plain figure, so the one colored block is the one that asks for action.

### Phone Lists (Inbox and Register)

Below 800px the inbox and register stop being wide tables and become lists that never scroll sideways. A register line is two rows: payee (with its tags) and the amount on top, then date · account · category in Small muted type, with the cleared tick in a 2.75rem column on the right. Inflows carry a "+"; uncategorized reads in Caution ink. An inbox item is a card: payee and amount, date · account, a full-width category picker, then Approve (two thirds) and Remove (one third), all 44px tall; a possible duplicate sits inside the same card. The budget table clips rather than scrolls, so on phones the group's + moves into the group sheet and every figure column must fit at 360px.

### Bottom Sheet

On phones, dialogs marked as sheets rise from the bottom edge (full width, max 90dvh, top corners 0.9rem, safe-area padding) with a short 0.18s slide when motion is allowed. They hold what a desk shows in menus: rename, need/want, hide, reorder, add goal, remove.

## Do's and Don'ts

### Do:

- **Do** use Ledger Blue (#2f78c4) only for actions, links, focus and the current place.
- **Do** show money state with the paired pills (funded #bfe8b5/#1f4d17, settled #e4e8ef/#5a6477, overspent #f6c9c4/#8a1c12).
- **Do** set every amount in tabular figures, right-aligned.
- **Do** separate surfaces with 1px Hairline (#e3e7ee) and the Mist Page to Paper Surface step.
- **Do** give every phone target at least 44px (28px only where width is scarcer than reach, like a goal's menu) and phone inputs 16px text.
- **Do** make phone views fit the width: a list or card, never a table that scrolls or clips its figures.
- **Do** define both themes through the CSS custom properties on `:root`, never with hard-coded colors in components.
- **Do** respect `prefers-reduced-motion`: motion is a short ease-out (0.15-0.18s) or nothing.

### Don't:

- **Don't** use color for decoration, variety or emphasis that isn't money state or action.
- **Don't** put a shadow on cards, tables or banners; only floating menus and lists get the Float shadow.
- **Don't** add a second typeface or display font; hierarchy comes from weight and size.
- **Don't** show a status color as text alone; always use the background with its paired ink.
- **Don't** add native `prompt()`/`confirm()` in new UI; use the in-app confirm dialog or a sheet.
- **Don't** hard-code a colour in a component rule; add a `:root` token (the QR code's white backing is the one exception).
