exports.addRange = (ranges, range) =>
  [...ranges, range].sort((a, b) => a[0] - b[0])
/* global exports */
