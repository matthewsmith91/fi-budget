import type { CategoryGroup, Goal } from '@budget-fi/core'

/** One choice in a `Combobox`. */
export interface ComboOption {
  /** What the owner gets back when this is picked. */
  value: string
  /** The text in the list. */
  label: string
  /** The text in the input once picked; defaults to `label`. */
  display?: string
  /** The heading it sits under while the list is unfiltered. */
  group?: string
  /** Drawn indented, like a goal under its category. */
  indent?: boolean
  /** What a search looks through; defaults to the label. */
  text?: string
}

export const GOAL_PREFIX = 'goal:'

/**
 * Every category (and the goals under it) a transaction line can be filed under. Hidden things
 * are left out unless the line already uses them, so an old transaction still shows its category.
 */
export function categoryOptions(
  groups: CategoryGroup[],
  goals: Goal[],
  selected: { categoryId: string; goalId: string },
): ComboOption[] {
  const options: ComboOption[] = []
  for (const group of groups) {
    const keeps = group.categories.some((c) => c.id === selected.categoryId)
    if (group.hidden && !keeps) continue
    for (const category of group.categories) {
      if (category.creditCardAccountId) continue
      if (category.hidden && category.id !== selected.categoryId) continue
      options.push({
        value: category.id,
        label: category.name,
        group: group.name,
        text: `${category.name} ${group.name}`,
      })
      // Spending from a goal is a planned draw-down of that goal's balance.
      for (const goal of goals) {
        if (goal.categoryId !== category.id) continue
        if (goal.archived && goal.id !== selected.goalId) continue
        const name = `${goal.name}${goal.archived ? ' (archived)' : ''}`
        options.push({
          value: `${GOAL_PREFIX}${goal.id}`,
          label: name,
          display: `${category.name}: ${name}`,
          group: group.name,
          indent: true,
          text: `${name} ${category.name} ${group.name}`,
        })
      }
    }
  }
  return options
}

/** The option for a category/goal pair as `categoryOptions` writes it; '' for neither. */
export const pickedValue = (categoryId: string, goalId: string) =>
  goalId ? `${GOAL_PREFIX}${goalId}` : categoryId

/**
 * The options that match what was typed, best first: names starting with it, then names with a
 * word starting with it, then anything that contains every word. Order is otherwise kept.
 */
export function rankOptions(
  options: ComboOption[],
  query: string,
  limit = Infinity,
): ComboOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return options.slice(0, limit)
  const whole = words.join(' ')
  const ranked: { option: ComboOption; score: number; at: number }[] = []
  options.forEach((option, at) => {
    const text = (option.text ?? option.label).toLowerCase()
    if (!words.every((w) => text.includes(w))) return
    const label = option.label.toLowerCase()
    const score = label.startsWith(whole)
      ? 0
      : label.split(/[\s:(]+/).some((w) => w.startsWith(words[0]!))
        ? 1
        : 2
    ranked.push({ option, score, at })
  })
  ranked.sort((a, b) => a.score - b.score || a.at - b.at)
  return ranked.slice(0, limit).map((r) => r.option)
}

/** Payee suggestions: each distinct name once, as first written. */
export function payeeOptions(payees: string[]): ComboOption[] {
  const seen = new Set<string>()
  const options: ComboOption[] = []
  for (const payee of payees) {
    const key = payee.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    options.push({ value: payee, label: payee })
  }
  return options
}
