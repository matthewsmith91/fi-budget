import type { CategoryGroup, Goal } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import {
  categoryOptions,
  payeeOptions,
  pickedValue,
  rankOptions,
  type ComboOption,
} from './combo-options.ts'

const cat = (id: string, name: string, extra: object = {}) => ({ id, name, ...extra })
const groups = [
  {
    id: 'g1',
    name: 'Bills',
    hidden: false,
    categories: [cat('rent', 'Rent'), cat('pay-1', 'Visa', { creditCardAccountId: 'a1' })],
  },
  {
    id: 'g2',
    name: 'Everyday',
    hidden: false,
    categories: [
      cat('food', 'Groceries'),
      cat('old', 'Old stuff', { hidden: true }),
      cat('gas', 'Gas'),
    ],
  },
  { id: 'g3', name: 'Retired', hidden: true, categories: [cat('gone', 'Gone')] },
] as unknown as CategoryGroup[]
const goals = [
  { id: 'trip', categoryId: 'food', name: 'Trip', archived: false },
  { id: 'dead', categoryId: 'food', name: 'Dead', archived: true },
] as unknown as Goal[]

describe('category options', () => {
  const none = { categoryId: '', goalId: '' }
  const labels = (o: ComboOption[]) => o.map((x) => x.label)

  it('lists ordinary categories with their goals and leaves out the rest', () => {
    expect(labels(categoryOptions(groups, goals, none))).toEqual([
      'Rent',
      'Groceries',
      'Trip',
      'Gas',
    ])
  })

  it('keeps a hidden category, group or archived goal that the line already uses', () => {
    expect(labels(categoryOptions(groups, goals, { categoryId: 'old', goalId: '' }))).toContain(
      'Old stuff',
    )
    expect(labels(categoryOptions(groups, goals, { categoryId: 'gone', goalId: '' }))).toContain(
      'Gone',
    )
    const withDead = categoryOptions(groups, goals, { categoryId: 'food', goalId: 'dead' })
    expect(labels(withDead)).toContain('Dead (archived)')
  })

  it('writes a goal as category plus goal and finds it by either name', () => {
    const trip = categoryOptions(groups, goals, none).find((o) => o.value === 'goal:trip')!
    expect(trip).toMatchObject({ display: 'Groceries: Trip', indent: true })
    expect(rankOptions([trip], 'grocer').length).toBe(1)
    expect(pickedValue('food', 'trip')).toBe('goal:trip')
    expect(pickedValue('food', '')).toBe('food')
  })
})

describe('ranking', () => {
  const options = ['Car repair', 'Scarf', 'Gas', 'Car insurance', 'Cat food'].map((label) => ({
    value: label,
    label,
  }))

  it('puts names that start with the text first, then word starts, then the rest', () => {
    expect(rankOptions(options, 'car').map((o) => o.label)).toEqual([
      'Car repair',
      'Car insurance',
      'Scarf',
    ])
    expect(rankOptions(options, 'ins').map((o) => o.label)).toEqual(['Car insurance'])
    expect(rankOptions(options, 'repair car').map((o) => o.label)).toEqual(['Car repair'])
  })

  it('returns everything for no text and honours the limit', () => {
    expect(rankOptions(options, '  ')).toHaveLength(5)
    expect(rankOptions(options, '', 2)).toHaveLength(2)
    expect(rankOptions(options, 'zzz')).toEqual([])
  })

  it('suggests each payee once, ignoring case and blanks', () => {
    expect(payeeOptions(['Kroger', 'kroger ', '', 'Shell']).map((o) => o.value)).toEqual([
      'Kroger',
      'Shell',
    ])
  })
})
