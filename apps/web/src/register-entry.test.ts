import { describe, expect, it } from 'vitest'
import { amountOf, emptyLine, plain, typeAmount, unsplitLoss, type Line } from './register-entry.ts'

const line = (patch: Partial<Line>): Line => ({ ...emptyLine(), ...patch })

describe('register entry', () => {
  it('reads a line as signed cents', () => {
    expect(amountOf(line({ outflow: '12.50' }))).toBe(-1250)
    expect(amountOf(line({ inflow: '1,000' }))).toBe(100000)
    expect(amountOf(line({}))).toBe(0)
    expect(amountOf(line({ outflow: 'abc' }))).toMatch(/dollars/)
    expect(amountOf(line({ outflow: '-5' }))).toMatch(/positive/)
    expect(plain(123456)).toBe('1,234.56')
  })

  it('empties the other box when one is typed in, but not when one is cleared', () => {
    const typed = typeAmount(line({ inflow: '5.00' }), 'outflow', '3')
    expect(typed).toMatchObject({ outflow: '3', inflow: '' })
    const cleared = typeAmount(line({ outflow: '3', inflow: '' }), 'outflow', '')
    expect(cleared).toMatchObject({ outflow: '', inflow: '' })
    expect(typeAmount(line({ outflow: '3', inflow: '5' }), 'outflow', ' ')).toMatchObject({
      inflow: '5',
    })
  })

  it('reports only the categories an unsplit would drop', () => {
    const food = line({ categoryId: 'food', outflow: '5' })
    expect(unsplitLoss([food, line({ categoryId: 'food', outflow: '1' })])).toEqual([])
    expect(unsplitLoss([food, line({ outflow: '1' })])).toEqual([])
    const gas = line({ categoryId: 'gas', outflow: '2' })
    expect(unsplitLoss([food, gas, line({})])).toEqual([gas])
    // the same category but another goal is a difference too
    const goal = line({ categoryId: 'food', goalId: 'trip', outflow: '2' })
    expect(unsplitLoss([food, goal])).toEqual([goal])
    expect(unsplitLoss([])).toEqual([])
  })
})
