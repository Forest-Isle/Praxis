exports.countInWindow = (events, start, end) =>
  events.filter((e) => e.at > start && e.at < end).length
/* global exports */
