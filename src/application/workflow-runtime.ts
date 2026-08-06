import { getQuickJS, type QuickJSContext } from 'quickjs-emscripten'
import type { QuickJSDeferredPromise } from 'quickjs-emscripten-core'

const MAX_COLLECTION = 4096
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000

export interface WorkflowAgentOptions {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  model?: string
  effort?: string
  isolation?: 'worktree'
  agentType?: string
}

export interface WorkflowRuntimeHost {
  agent(prompt: string, options: WorkflowAgentOptions): Promise<unknown>
  workflow(
    reference: string | { scriptPath: string },
    args: unknown,
  ): Promise<unknown>
  log(message: string): void
  phase(title: string): void
  spent(): number
  total: number | null
}

export interface WorkflowRuntimeOptions {
  body: string
  args: unknown
  host: WorkflowRuntimeHost
  signal?: AbortSignal
  memoryLimitBytes?: number
  deadlineMs?: number
}

function errorMessage(
  vm: QuickJSContext,
  handle: Parameters<QuickJSContext['dump']>[0],
): string {
  const value = vm.dump(handle)
  if (value && typeof value === 'object' && typeof value.message === 'string') {
    const stack = typeof value.stack === 'string' ? `\n${value.stack}` : ''
    return `${value.message}${stack}`
  }
  return String(value)
}

function installAsyncHostFunction(
  vm: QuickJSContext,
  name: string,
  operation: (...args: unknown[]) => Promise<unknown> | unknown,
  pending: Set<QuickJSDeferredPromise>,
): void {
  const fn = vm.newFunction(name, (...handles) => {
    const args = handles.map((handle) => vm.dump(handle))
    const promise = vm.newPromise()
    pending.add(promise)
    void Promise.resolve()
      .then(() => operation(...args))
      .then(
        (value) => {
          const encoded = vm.newString(JSON.stringify({ value }))
          try {
            promise.resolve(encoded)
          } finally {
            encoded.dispose()
          }
        },
        (error: unknown) => {
          const failure = vm.newError(
            error instanceof Error ? error.message : String(error),
          )
          try {
            promise.reject(failure)
          } finally {
            failure.dispose()
          }
        },
      )
    void promise.settled.then(() => {
      vm.runtime.executePendingJobs()
    })
    return promise.handle
  })
  vm.setProp(vm.global, name, fn)
  fn.dispose()
}

function installSyncHostFunction(
  vm: QuickJSContext,
  name: string,
  operation: (...args: unknown[]) => unknown,
): void {
  const fn = vm.newFunction(name, (...handles) => {
    const value = operation(...handles.map((handle) => vm.dump(handle)))
    if (typeof value === 'number') return vm.newNumber(value)
    if (typeof value === 'string') return vm.newString(value)
    if (typeof value === 'boolean') return value ? vm.true : vm.false
    return vm.undefined
  })
  vm.setProp(vm.global, name, fn)
  fn.dispose()
}

const PRELUDE = String.raw`
const __decode = async value => (JSON.parse(await value)).value
const agent = (prompt, options = {}) => {
  if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('agent prompt must be a non-empty string')
  return __decode(__workflowAgent(prompt, options))
}
const workflow = (reference, workflowArgs) => {
  const validName = typeof reference === 'string' && reference.length > 0
  const validPath = reference && typeof reference === 'object' && typeof reference.scriptPath === 'string' && reference.scriptPath.length > 0
  if (!validName && !validPath) throw new Error('workflow reference must be a name or {scriptPath}')
  return __decode(__workflowNested(reference, workflowArgs))
}
const log = message => __workflowLog(String(message))
const phase = title => __workflowPhase(String(title))
const parallel = async thunks => {
  if (!Array.isArray(thunks)) throw new Error('parallel input must be an array')
  if (thunks.length > ${MAX_COLLECTION}) throw new Error('parallel input exceeded ${MAX_COLLECTION}')
  return Promise.all(thunks.map(async thunk => {
    try {
      if (typeof thunk !== 'function') throw new Error('parallel items must be functions')
      return await thunk()
    } catch { return null }
  }))
}
const pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new Error('pipeline items must be an array')
  if (items.length > ${MAX_COLLECTION}) throw new Error('pipeline input exceeded ${MAX_COLLECTION}')
  if (stages.some(stage => typeof stage !== 'function')) throw new Error('pipeline stages must be functions')
  return Promise.all(items.map(async (item, index) => {
    let value = item
    try {
      for (const stage of stages) value = await stage(value, item, index)
      return value
    } catch { return null }
  }))
}
const budget = Object.freeze({
  total: __workflowBudgetTotal,
  spent: () => __workflowBudgetSpent(),
  remaining: () => __workflowBudgetTotal === null ? Infinity : Math.max(0, __workflowBudgetTotal - __workflowBudgetSpent()),
})
Date.now = () => { throw new Error('Date.now() is not available in workflows') }
Math.random = () => { throw new Error('Math.random() is not available in workflows') }
const __NativeDate = Date
Date = class WorkflowDate extends __NativeDate {
  constructor(...values) {
    if (values.length === 0) throw new Error('new Date() without arguments is not available in workflows')
    super(...values)
  }
  static now() { throw new Error('Date.now() is not available in workflows') }
}
Object.freeze(budget)
`

export async function executeWorkflowScript(
  options: WorkflowRuntimeOptions,
): Promise<unknown> {
  if (Buffer.byteLength(options.body) > 524_288) {
    throw new Error('Workflow script exceeded 524288 bytes')
  }
  if (
    options.host.total !== null &&
    (options.host.total < 0 || !Number.isFinite(options.host.total))
  ) {
    throw new Error('Workflow budget total must be finite and non-negative')
  }
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_BYTES)
  runtime.setMaxStackSize(1024 * 1024)
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS)
  runtime.setInterruptHandler(
    () => options.signal?.aborted === true || Date.now() > deadline,
  )
  const vm = runtime.newContext()
  const pending = new Set<QuickJSDeferredPromise>()
  try {
    installAsyncHostFunction(
      vm,
      '__workflowAgent',
      (prompt, agentOptions) =>
        options.host.agent(
          String(prompt),
          (agentOptions ?? {}) as WorkflowAgentOptions,
        ),
      pending,
    )
    installAsyncHostFunction(
      vm,
      '__workflowNested',
      (reference, args) =>
        options.host.workflow(
          reference as string | { scriptPath: string },
          args,
        ),
      pending,
    )
    installSyncHostFunction(vm, '__workflowLog', (message) => {
      options.host.log(String(message))
    })
    installSyncHostFunction(vm, '__workflowPhase', (title) => {
      options.host.phase(String(title))
    })
    installSyncHostFunction(vm, '__workflowBudgetSpent', () =>
      options.host.spent(),
    )
    const total =
      options.host.total === null ? vm.null : vm.newNumber(options.host.total)
    vm.setProp(vm.global, '__workflowBudgetTotal', total)
    if (options.host.total !== null) total.dispose()
    const args = vm.newString(JSON.stringify({ value: options.args }))
    vm.setProp(vm.global, '__workflowArgsJson', args)
    args.dispose()
    const source = `${PRELUDE}\nconst args = JSON.parse(__workflowArgsJson).value\n;(async () => {\n${options.body}\n})()`
    const evaluated = vm.evalCode(source, 'workflow.js')
    if (evaluated.error) {
      const message = errorMessage(vm, evaluated.error)
      evaluated.error.dispose()
      throw new Error(message)
    }
    const promise = evaluated.value
    const settling = vm.resolvePromise(promise)
    runtime.executePendingJobs()
    const settled = await settling
    promise.dispose()
    if (settled.error) {
      const message = errorMessage(vm, settled.error)
      settled.error.dispose()
      if (options.signal?.aborted) throw new Error('Workflow aborted')
      throw new Error(message)
    }
    const result = vm.dump(settled.value)
    settled.value.dispose()
    return result
  } finally {
    await Promise.allSettled([...pending].map((promise) => promise.settled))
    for (const promise of pending) promise.dispose()
    vm.dispose()
    runtime.dispose()
  }
}
