/**
 * True when the app was started with `npm run demo`: the budget lives in memory, is filled with
 * made-up data on every load and never touches the real database or a server.
 */
export const DEMO = import.meta.env.VITE_DEMO === 'true'
