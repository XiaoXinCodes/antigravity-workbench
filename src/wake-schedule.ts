/** Shared preview/execution calendar. DST gaps are skipped and repeated wall
 * times use only the earlier instant. Intervals measure elapsed time. */
export interface WakeSchedule { timezone: string; times: string[]; weekdays: number[]; mode?: 'calendar' | 'interval' | 'cron' | 'quota-recovery'; intervalMinutes?: number; anchor?: string; cron?: string; pollMinutes?: number }
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) { value = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); if (formatters.size > 100) formatters.clear(); formatters.set(zone, value); }
  return value;
}
function parts(time: number, zone: string): number[] { const p = Object.fromEntries(formatter(zone).formatToParts(time).map(x => [x.type, x.value])); return ['year', 'month', 'day', 'hour', 'minute'].map(key => Number(p[key])); }
const invalid = (): never => { throw Error('WAKE_SCHEDULE_INVALID'); };
const bounded = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : invalid();
const names: Readonly<Record<string, number>> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12, SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
function cronField(raw: string, min: number, max: number, family?: 'month' | 'weekday'): number[] {
  const out = new Set<number>();
  const numeric = (s: string) => { const named = names[s.toUpperCase()]; if (named !== undefined) { if (family === 'month' && named > 0 && s.length === 3 && !['SUN','MON','TUE','WED','THU','FRI','SAT'].includes(s.toUpperCase()) || family === 'weekday' && ['SUN','MON','TUE','WED','THU','FRI','SAT'].includes(s.toUpperCase())) return named; invalid(); } return /^\d{1,2}$/.test(s) ? bounded(Number(s), min, max) : invalid(); };
  for (const item of raw.split(',')) {
    const pair = item.split('/'); if (pair.length > 2 || !pair[0]) invalid();
    const step = pair[1] === undefined ? 1 : /^\d{1,2}$/.test(pair[1]) ? bounded(Number(pair[1]), 1, max - min + 1) : invalid();
    const range = pair[0]!.split('-'); if (range.length > 2) invalid();
    const start = range[0] === '*' ? min : numeric(range[0]!), end = range[0] === '*' ? max : range[1] !== undefined ? numeric(range[1]) : pair[1] !== undefined ? max : start;
    if (start > end || range[0] === '*' && range.length > 1) invalid();
    for (let n = start; n <= end; n += step) out.add(family === 'weekday' && n === 7 ? 0 : n);
  }
  return [...out].sort((a,b) => a-b);
}
export function parseWakeCron(expression: string) {
  if (typeof expression !== 'string' || expression.length > 200) invalid();
  const fields = expression.trim().split(/\s+/); if (fields.length !== 5) invalid();
  return { minute: cronField(fields[0]!,0,59), hour: cronField(fields[1]!,0,23), day: cronField(fields[2]!,1,31), month: cronField(fields[3]!,1,12,'month'), weekday: cronField(fields[4]!,0,7,'weekday'), anyDay: fields[2] === '*', anyWeekday: fields[4] === '*' };
}
export function validateWakeSchedule(value: WakeSchedule): WakeSchedule {
  if (!value || typeof value.timezone !== 'string' || value.timezone.length > 100 || !value.timezone) invalid();
  try { formatter(value.timezone).format(0); } catch { throw Error('WAKE_TIMEZONE_INVALID'); }
  if (value.mode === 'interval') {
    if (typeof value.anchor !== 'string' || value.anchor.length > 64 || !Number.isFinite(Date.parse(value.anchor))) invalid();
    return { mode: 'interval', timezone: value.timezone, times: [], weekdays: [], intervalMinutes: bounded(value.intervalMinutes,1,1440), anchor: new Date(value.anchor!).toISOString() };
  }
  if (value.mode === 'quota-recovery') return { mode: value.mode, timezone: value.timezone, times: [], weekdays: [], pollMinutes: bounded(value.pollMinutes,15,1440) };
  if (value.mode === 'cron') { parseWakeCron(value.cron!); return { mode: value.mode, timezone: value.timezone, times: [], weekdays: [], cron: value.cron!.trim().replace(/\s+/g,' ') }; }
  if (value.mode !== undefined && value.mode !== 'calendar') invalid();
  if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 12 || value.times.some(x => typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) || !Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7 || value.weekdays.some(x => !Number.isInteger(x) || x < 0 || x > 6)) invalid();
  return { timezone: value.timezone, times: [...new Set(value.times)].sort(), weekdays: [...new Set(value.weekdays)].sort() };
}
function wallInstant(wall: number, zone: string): number | undefined {
  const offsets = new Set<number>();
  for (const delta of [-36,-12,0,12,36]) { const t=wall+delta*3_600_000,p=parts(t,zone);offsets.add(Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!)-t); }
  return [...offsets].map(offset=>wall-offset).filter(t=>{const p=parts(t,zone);return Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!)===wall;}).sort((a,b)=>a-b)[0];
}
export function wakeOccurrences(schedule: WakeSchedule, after: number, count=1): number[] {
  const s=validateWakeSchedule(schedule);
  if (!Number.isFinite(after) || !Number.isInteger(count) || count<1 || count>20) invalid();
  if (s.mode === 'quota-recovery') return Array.from({length:count},(_,i)=>after+(i+1)*s.pollMinutes!*60_000);
  if (s.mode === 'interval') { const anchor=Date.parse(s.anchor!),step=s.intervalMinutes!*60_000,first=anchor+Math.max(0,Math.floor((after-anchor)/step)+1)*step;return Array.from({length:count},(_,i)=>first+i*step); }
  const [y,m,d]=parts(after,s.timezone),start=Date.UTC(y!,m!-1,d!),result:number[]=[],cron=s.mode === 'cron'?parseWakeCron(s.cron!):undefined;
  // Annual cron expressions can need several years to provide a useful preview.
  for(let day=0;day<(cron?366*25:32)&&result.length<count;day++) {
    const date=new Date(start+day*86_400_000),weekday=date.getUTCDay();
    if(cron) { if(!cron.month.includes(date.getUTCMonth()+1))continue;const dom=cron.day.includes(date.getUTCDate()),dow=cron.weekday.includes(weekday);if(!(cron.anyDay?dow:cron.anyWeekday?dom:dom||dow))continue; }
    else if(!s.weekdays.includes(weekday))continue;
    const times=cron?cron.hour.flatMap(h=>cron.minute.map(m=>[h,m])):s.times.map(t=>t.split(':').map(Number));
    for(const [hour,minute] of times) { const wall=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour!,minute!);if(wall<after-36*3_600_000)continue;const instant=wallInstant(wall,s.timezone);if(instant!==undefined&&instant>after)result.push(instant);if(result.length>=count)break; }
  }
  const next=result.sort((a,b)=>a-b).slice(0,count);if(!next.length)throw Error('WAKE_CRON_NO_OCCURRENCE');return next;
}
