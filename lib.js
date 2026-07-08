// Shared date/time/period helpers used by server.js

const PERIOD_BOUNDS = [0, 720, 1020, 1440]; // 00:00, 12:00, 17:00, 24:00 (minutes)
const PERIOD_NAMES = ['เช้า', 'บ่าย', 'ดึก'];

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
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

function periodName(idx) {
  return PERIOD_NAMES[idx];
}

// Splits a [entryDate + startTime, endTime] interval into per-calendar-day,
// per-period (เช้า/บ่าย/ดึก) segments. Handles midnight crossing when
// endTime <= startTime (treated as next day).
function splitEntry(entryDate, startTime, endTime) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const crossesMidnight = endMin < startMin;

  const dayPieces = [];
  if (endMin === startMin) {
    dayPieces.push({ date: entryDate, from: startMin, to: startMin });
  } else if (!crossesMidnight) {
    dayPieces.push({ date: entryDate, from: startMin, to: endMin });
  } else {
    dayPieces.push({ date: entryDate, from: startMin, to: 1440 });
    dayPieces.push({ date: addDays(entryDate, 1), from: 0, to: endMin });
  }

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

function periodOfMinutes(min) {
  if (min < 720) return 'เช้า';
  if (min < 1020) return 'บ่าย';
  return 'ดึก';
}

function periodOfTime(t) {
  return periodOfMinutes(timeToMinutes(t));
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h <= 0) return `${m} นาที`;
  return `${h} ชม. ${m} นาที`;
}

module.exports = {
  timeToMinutes, minutesToTime, addDays, splitEntry,
  periodOfMinutes, periodOfTime, todayStr, fmtMinutes,
  PERIOD_NAMES, PERIOD_BOUNDS,
};
