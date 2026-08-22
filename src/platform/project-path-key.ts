const MAX_SANITIZED_PROJECT_PATH_LENGTH = 200

function stablePathHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash, 31) + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash)
}

export function sanitizeProjectPath(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_PROJECT_PATH_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_PATH_LENGTH)}-${stablePathHash(path).toString(36)}`
}
