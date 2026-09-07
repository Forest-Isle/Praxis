exports.dedupeLatest = (events) => {
  const m = new Map()
  events.forEach((e, i) => m.set(e.id, { e, i }))
  return [...m.values()].sort((a, b) => a.i - b.i).map((x) => x.e)
}
exports.sortEvents = (events) =>
  [...events].sort(
    (a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)),
  )
/* global exports */
