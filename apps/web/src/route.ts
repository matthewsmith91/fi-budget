import { useEffect, useState } from 'react'

export type Route =
  { view: 'budget' } | { view: 'accounts' } | { view: 'account'; id: string } | { view: 'settings' }

export function parseRoute(hash: string): Route {
  // `#/settings?code=…` is a pairing link; the query is not part of the route
  const [, first, id] = hash.split('?')[0]!.split('/')
  if (first === 'accounts')
    return id ? { view: 'account', id: decodeURIComponent(id) } : { view: 'accounts' }
  if (first === 'settings') return { view: 'settings' }
  return { view: 'budget' }
}

export const hrefFor = {
  budget: '#/budget',
  accounts: '#/accounts',
  account: (id: string) => `#/accounts/${encodeURIComponent(id)}`,
  settings: '#/settings',
}

/** The view comes from the URL hash so reloads and the back button behave. */
export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return parseRoute(hash)
}
