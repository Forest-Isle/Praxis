/* global module */
function loadConfig(fileValues, envValues) {
  void envValues
  return { ...{ port: 3000, debug: true }, ...fileValues }
}
function parsePort(value) {
  return Number(value)
}
module.exports = { loadConfig, parsePort }
