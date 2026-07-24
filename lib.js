// Shared date/time/period helpers used by server.js

const PERIOD_BOUNDS = [0, 720, 1020, 1440]; // 00:00, 12:00, 17:00, 24:00 (minutes)
const PERIOD_NAMES = ['เช้า', 'บ่าย', 'ดึก'];
const TZ = 'Asia/Bangkok';

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  if (Number(min) === 1440) return '24:00';
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Number of whole days from startDate to endDate (endDate - startDate), both 'YYYY-MM-DD'.
function daysBetween(startDate, endDate) {
  const a = new Date(startDate + 'T00:00:00');
  const b = new Date(endDate + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function periodName(idx) {
  return PERIOD_NAMES[idx];
}

function splitByPeriods(dayPieces) {
  const segments = [];
  for (const piece of dayPieces) {
    for (let i = 0; i < 3; i++) {
      const lo = Math.max(piece.from, PERIOD_BOUNDS[i]);
      const hi = Math.min(piece.to, PERIOD_BOUNDS[i + 1]);
      if (hi > lo) {
        segments.push({
          date: piece.date,
          startTime: minutesToTime(lo),
          endTime: minutesToTime(hi),
          minutes: hi - lo,
          period: periodName(i),
        });
      }
    }
  }
  return segments;
}

// Splits a [startDate+startTime, endDate+endTime] interval into per-calendar-day,
// per-period (เช้า/บ่าย/ดึก) segments. Handles any number of days in between
// (e.g. a Start Line left open for several days before Stop Line is logged).
function splitRange(startDate, startTime, endDate, endTime) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const spanDays = daysBetween(startDate, endDate);

  const dayPieces = [];
  if (spanDays <= 0) {
    dayPieces.push({ date: startDate, from: startMin, to: Math.max(startMin, endMin) });
  } else {
    dayPieces.push({ date: startDate, from: startMin, to: 1440 });
    for (let i = 1; i < spanDays; i++) {
      dayPieces.push({ date: addDays(startDate, i), from: 0, to: 1440 });
    }
    dayPieces.push({ date: endDate, from: 0, to: endMin });
  }
  return splitByPeriods(dayPieces);
}

// Splits a [entryDate + startTime, endTime] interval into per-calendar-day,
// per-period segments. Handles midnight crossing when endTime <= startTime
// (treated as the next day). For downtime entries, which are always a single
// incident reported same-day.
function splitEntry(entryDate, startTime, endTime) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const crossesMidnight = endMin < startMin;
  const endDate = crossesMidnight ? addDays(entryDate, 1) : entryDate;
  return splitRange(entryDate, startTime, endDate, endTime);
}

function periodOfMinutes(min) {
  if (min < 720) return 'เช้า';
  if (min < 1020) return 'บ่าย';
  return 'ดึก';
}

function periodOfTime(t) {
  return periodOfMinutes(timeToMinutes(t));
}

// Current date/time in Thailand's timezone, regardless of the server's own
// local timezone (e.g. a host running in UTC).
function nowInBangkok() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
}

function todayStr() {
  return nowInBangkok().date;
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h <= 0) return `${m} นาที`;
  return `${h} ชม. ${m} นาที`;
}

module.exports = {
  timeToMinutes, minutesToTime, addDays, daysBetween, splitRange, splitEntry,
  periodOfMinutes, periodOfTime, todayStr, nowInBangkok, fmtMinutes,
  PERIOD_NAMES, PERIOD_BOUNDS,
};
