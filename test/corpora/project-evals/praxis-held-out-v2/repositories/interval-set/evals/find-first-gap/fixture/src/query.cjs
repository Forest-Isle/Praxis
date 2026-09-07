exports.containsPoint = (ranges, point) =>
  ranges.some(([a, b]) => point > a && point < b)
exports.firstGap = (ranges, start) => start
/* global exports */
