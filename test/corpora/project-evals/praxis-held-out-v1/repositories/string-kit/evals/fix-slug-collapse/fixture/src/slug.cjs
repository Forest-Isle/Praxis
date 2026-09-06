/* global module */
function slugify(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}
module.exports = { slugify }
