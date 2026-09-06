/* global module */
function truncate(value, maxLength) {
  if (value.length > maxLength) return value.slice(0, maxLength)
  return value
}
module.exports = { truncate }
