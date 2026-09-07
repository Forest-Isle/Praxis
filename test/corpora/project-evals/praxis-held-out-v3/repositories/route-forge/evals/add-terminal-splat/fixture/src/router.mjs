export function matchRoute(routes, pathname) {
  const segments = pathname.split('/').filter(Boolean)
  for (const route of routes) {
    const pattern = route.path.split('/').filter(Boolean)
    if (pattern.length !== segments.length) continue
    const params = {}
    let matches = true
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index]
      const actual = segments[index]
      if (part.startsWith(':')) {
        params[part.slice(1)] = actual
      } else if (part !== actual) {
        matches = false
        break
      }
    }
    if (matches) return { name: route.name, params }
  }
  return null
}
