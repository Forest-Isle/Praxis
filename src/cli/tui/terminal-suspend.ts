const SUSPEND_NOTICE =
  'Praxis Code has been suspended. Run `fg` to bring Praxis Code back.\n' +
  'Note: ctrl + z now suspends Praxis Code, ctrl + _ undoes input.\n\n'

export function suspendTuiProcess(
  options: {
    write?(message: string): unknown
    stop?(): unknown
  } = {},
): void {
  const write = options.write ?? ((message) => process.stdout.write(message))
  const stop =
    options.stop ?? (() => process.kill(process.pid, 'SIGTSTP'))
  write(SUSPEND_NOTICE)
  stop()
}
