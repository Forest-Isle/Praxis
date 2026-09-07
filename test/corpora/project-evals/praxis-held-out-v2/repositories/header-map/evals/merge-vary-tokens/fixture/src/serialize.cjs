exports.serializeHeaders = (headers) =>
  Object.entries(headers)
    .map(([key, value]) => key + ': ' + value + '\n')
    .join('')
/* global exports */
