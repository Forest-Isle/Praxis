/* global module */
function renderConfig(config) {
  return (
    Object.entries(config)
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n'
  )
}
module.exports = { renderConfig }
