/* global module */
function byPriority(tasks) {
  return [...tasks].sort(
    (a, b) => b.priority - a.priority || b.id.localeCompare(a.id),
  )
}
module.exports = { byPriority }
