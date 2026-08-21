export type TransportFailureKind = 'cancelled' | 'timeout' | 'transport_error'

export function transportFailureKind(
  error: unknown,
  signal?: AbortSignal,
): TransportFailureKind {
  const reason = signal?.reason
  if (
    (error instanceof Error && error.name === 'TimeoutError') ||
    (reason instanceof Error && reason.name === 'TimeoutError')
  ) {
    return 'timeout'
  }
  return signal?.aborted ? 'cancelled' : 'transport_error'
}
