import { connect, type BudgetApi, type RpcMethods } from '@budget-fi/core'

/** The UI's only handle on the domain layer; every call is a message to the worker. */
export const budget = connect<BudgetApi & RpcMethods>(
  new Worker(new URL('./worker/budget.worker.ts', import.meta.url), { type: 'module' }),
)
