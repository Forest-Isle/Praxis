/* global module */
function loadConfig(fileValues, envValues) {
  return { ...{ port: 3000, debug: true }, ...fileValues, ...envValues }
}
function parsePort(value) {
  return Number(value)
}
module.exports = { loadConfig, parsePort }
