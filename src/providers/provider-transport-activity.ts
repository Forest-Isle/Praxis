import type { ModelRequest } from '../core/runtime.js'

export type ProviderTransportActivity =
  'request-started' | 'response-received' | 'response-chunk'

export type ProviderTransportActivityObserver = (
  activity: ProviderTransportActivity,
) => void

const observers = new WeakMap<ModelRequest, ProviderTransportActivityObserver>()

export function observeProviderTransportActivity(
  request: ModelRequest,
  observer: ProviderTransportActivityObserver,
): void {
  observers.set(request, observer)
}

export function reportProviderTransportActivity(
  request: ModelRequest,
  activity: ProviderTransportActivity,
): void {
  observers.get(request)?.(activity)
}

export function detachProviderTransportActivity(request: ModelRequest): void {
  observers.delete(request)
}
