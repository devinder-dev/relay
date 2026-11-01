// How times are written on screen. One place, because the log and the detail
// screen have to agree: the same moment must read the same way on both.

const LOCALE = 'en-GB' // 24-hour clock, English month names to match the rest of the UI

function isToday(d: Date) {
  return d.toDateString() === new Date().toDateString()
}

/**
 * A timestamp as the clock time, with the date in front whenever it is not today.
 *
 * The clock alone is what you scan the log for, and most rows are from today, so
 * the date would be noise. But an attempt log can run over days, and then a bare
 * clock lies about the order: try 7 at 03:36 looks earlier than try 6 at 22:36.
 */
export function clock(iso: string, withSeconds = false) {
  const d = new Date(iso)

  const time = d.toLocaleTimeString(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })

  if (isToday(d)) return time

  return `${d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })} ${time}`
}
