exports.getHeader = (headers, name) => headers[name]
exports.mergeVary = (existing, values) => existing + ',' + values.join(',')
exports.setHeader = (headers, name, value) => ((headers[name] = value), headers)
/* global exports */
