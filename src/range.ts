export type DateRange = {start: string; end: string}
export type RangeRequest = {preset?: 'today' | '7' | '30' | 'all'; start?: string; end?: string}
export function dateString(d: Date) {return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function valid(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T12:00:00')
  return Number.isFinite(d.getTime()) && dateString(d) === s
}
export function resolveRange(request: RangeRequest | undefined, bounds: DateRange, today = dateString(new Date())): DateRange {
  let range = {...bounds}
  if (request?.preset && request.preset !== 'all') {
    const n = request.preset === 'today' ? 1 : request.preset === '7' ? 7 : request.preset === '30' ? 30 : 0
    if (!n) throw Error('Unknown date preset')
    const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - n + 1)
    range = {start: dateString(d), end: today}
  } else if (request && !request.preset) range = {start: request.start || '', end: request.end || ''}
  if (!valid(range.start) || !valid(range.end) || range.start > range.end || range.start < bounds.start || range.end > bounds.end) throw Error('This period is unavailable. Choose dates within the local history.')
  return range
}
