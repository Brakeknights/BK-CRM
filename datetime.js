// Shared date/time helper for Eastern Time (America/New_York).
//
// Converts a stored date (YYYY-MM-DD) plus a time label ("9:00 AM", "Anytime",
// or null) into an RFC 3339 timestamp carrying the correct Eastern offset,
// accounting for US daylight saving time. Returns null if the date is missing
// or the time can't be parsed.
//
// "Anytime"/null default to 9:00 AM (the first appointment window).
function toEasternRfc3339(date, time) {
  if (!date) return null;
  var t = (time && time !== 'Anytime') ? time : '9:00 AM';
  var m = /^(\d+):(\d+)\s*(AM|PM)$/i.exec(t);
  if (!m) return null;
  var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (/PM/i.test(m[3]) && h !== 12) h += 12;
  if (/AM/i.test(m[3]) && h === 12) h = 0;
  var parts = date.split('-').map(Number);
  var yr = parts[0], mo = parts[1], dy = parts[2];
  function nthSun(y, mth, n) { var d = new Date(y, mth - 1, 1).getDay(); return (d === 0 ? 1 : 8 - d) + (n - 1) * 7; }
  var dstOn  = new Date(yr, 2,  nthSun(yr, 3,  2), 2);
  var dstOff = new Date(yr, 10, nthSun(yr, 11, 1), 2);
  var target = new Date(yr, mo - 1, dy, h, min);
  var off = (target >= dstOn && target < dstOff) ? '-04:00' : '-05:00';
  return date + 'T' + String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00' + off;
}

module.exports = { toEasternRfc3339 };
