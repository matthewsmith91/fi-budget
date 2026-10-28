export class DatabaseLockedError extends Error {
  constructor() {
    super('The budget is open in another tab or window. Close it and reload this one.')
    this.name = 'DatabaseLockedError'
  }
}
