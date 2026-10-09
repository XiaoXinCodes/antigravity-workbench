/** One calendar algorithm is used for both the preview and the executor.
 * Missing DST wall times are skipped; repeated wall times run once (earlier instant). */
export interface WakeSchedule { timezone: string; times: string[]; weekdays: number[] }
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) { value = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); if (formatters.size > 100) formatters.clear(); formatters.set(zone, value); }
  return value;
}
function parts(time: number, zone: string): number[] {
  const p = Object.fromEntries(formatter(zone).formatToParts(time).map(x => [x.type, x.value]));
  return ['year', 'month', 'day', 'hour', 'minute'].map(key => Number(p[key]));
}
export function validateWakeSchedule(value: WakeSchedule): WakeSchedule {
  if (!value || typeof value.timezone !== 'string' || value.timezone.length > 100 || !value.timezone) throw Error('WAKE_SCHEDULE_INVALID');
  try { formatter(value.timezone).format(0); } catch { throw Error('WAKE_TIMEZONE_INVALID'); }
  if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 12 || value.times.some(x => typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) || !Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7 || value.weekdays.some(x => !Number.isInteger(x) || x < 0 || x > 6)) throw Error('WAKE_SCHEDULE_INVALID');
  return { timezone: value.timezone, times: [...new Set(value.times)].sort(), weekdays: [...new Set(value.weekdays)].sort() };
}
export function wakeOccurrences(schedule: WakeSchedule, after: number, count = 1): number[] {
  const s = validateWakeSchedule(schedule);
  if (!Number.isFinite(after) || !Number.isInteger(count) || count < 1 || count > 20) throw Error('WAKE_SCHEDULE_INVALID');
  const [y, m, d] = parts(after, s.timezone), start = Date.UTC(y!, m! - 1, d!);
  const result: number[] = [];
  for (let day = 0; day < 32 && result.length < count; day++) {
    const date = new Date(start + day * 86_400_000);
    if (!s.weekdays.includes(date.getUTCDay())) continue;
    for (const time of s.times) {
      const [hour, minute] = time.split(':').map(Number), wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour!, minute!);
      // Collect actual offsets on both sides of the date, including DST changes
      // and half/quarter-hour zones. Validate candidates against wall time.
      const offsets = new Set<number>();
      for (const delta of [-36, -12, 0, 12, 36]) { const t = wall + delta * 3_600_000, p = parts(t, s.timezone); offsets.add(Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!) - t); }
      const candidates = [...offsets].map(offset => wall - offset).filter(t => {
        const p = parts(t, s.timezone); return Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!) === wall;
      }).sort((a, b) => a - b);
      if (candidates[0] !== undefined && candidates[0] > after) result.push(candidates[0]);
    }
  }
  return result.sort((a, b) => a - b).slice(0, count);
}
