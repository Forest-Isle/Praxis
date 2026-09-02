export const DIRECT_PROCESS_SIGINT = Symbol('praxis.direct-process-sigint')

export function isDirectProcessSigint(
  signal: AbortSignal | undefined,
): boolean {
  return signal?.aborted === true && signal.reason === DIRECT_PROCESS_SIGINT
}
