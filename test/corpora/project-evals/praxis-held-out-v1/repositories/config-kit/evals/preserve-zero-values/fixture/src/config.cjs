/* global module */
function loadConfig(fileValues, envValues) {
  return {
    port: fileValues.port || 3000,
    debug: fileValues.debug || true,
    ...envValues,
  }
}
function parsePort(value) {
  return Number(value)
}
module.exports = { loadConfig, parsePort }
