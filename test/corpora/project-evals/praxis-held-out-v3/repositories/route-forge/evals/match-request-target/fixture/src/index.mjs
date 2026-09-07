import { matchRoute } from './router.mjs'

export function matchRequest(routes, requestTarget) {
  return matchRoute(routes, requestTarget)
}
