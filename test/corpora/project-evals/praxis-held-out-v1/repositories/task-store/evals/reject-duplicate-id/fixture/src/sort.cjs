/* global module */
function byPriority(tasks) {
  return [...tasks].sort((a, b) => b.priority - a.priority)
}
module.exports = { byPriority }
