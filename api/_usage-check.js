/**
 * Daily check on how many commands the booking database is using, run from
 * the 08:30 IST reconcile job.
 *
 * Why: on 27-Nov-26 the database reached Upstash's free limit of 500,000
 * commands a month and refused everything for about three hours, so no
 * visitor could get an OTP. It is on Pay As You Go now, so it will not stop
 * again for that reason, but the site was built to fit inside 500,000 and
 * going past it means paying. WARN_AT is 80% of that.
 *
 * The figures come from the site's own sampled count (see _redis.js), not
 * from Upstash, so they read a few percent low.
 */
import { getRedis, readRedisUsage, SAMPLE_EVERY } from './_redis.js';
import { sendAlert, alertDatabaseDown } from './_alert.js';

export const MONTHLY_REFERENCE = 500000; // Upstash's free allowance, the level the site is built to stay under
export const WARN_AT = 400000;           // 80% of it

/**
 * Pure: [{ date, commands }] newest first -> the month so far and where it is
 * heading. Uses the last up-to-7 COMPLETE days for the daily rate, so today's
 * half-day doesn't drag it down.
 */
export function assessUsage(days, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();

  const inMonth = days.filter(d => d.date.slice(0, 7) === month);
  const monthToDate = inMonth.reduce((a, d) => a + d.commands, 0);

  const complete = days.filter(d => d.date < today).slice(0, 7);
  const dailyRate = complete.length ? Math.round(complete.reduce((a, d) => a + d.commands, 0) / complete.length) : null;

  // Counting started 27-Nov-26, so early in a month (or in that first month)
  // the days before counting began are filled in at the daily rate.
  const countedDaysInMonth = inMonth.length;
  const uncountedPastDays = Math.max(0, dayOfMonth - countedDaysInMonth);
  const projected = dailyRate === null
    ? null
    : Math.round(monthToDate + dailyRate * (uncountedPastDays + (daysInMonth - dayOfMonth)));

  const warn = (projected !== null && projected >= WARN_AT) || monthToDate >= WARN_AT;
  return { month, month_to_date: monthToDate, daily_rate: dailyRate, projected, warn, days_counted: countedDaysInMonth };
}

/** Read, assess, and alert at most once a month. Never throws. */
export async function checkRedisUsage() {
  let usage;
  try {
    usage = assessUsage(await readRedisUsage(35));
  } catch (err) {
    await alertDatabaseDown('daily usage check', err);
    return { ok: false, error: err.message };
  }

  if (usage.warn) {
    try {
      // Once a month: SET NX only succeeds the first time.
      const first = await getRedis().set(`usage:redis:warned:${usage.month}`, '1', { nx: true, ex: 40 * 86400 });
      if (first) {
        await sendAlert('Booking database usage is high this month', {
          month_so_far: usage.month_to_date.toLocaleString('en-IN'),
          heading_for: usage.projected === null ? 'not enough days yet' : usage.projected.toLocaleString('en-IN'),
          per_day: usage.daily_rate === null ? '' : usage.daily_rate.toLocaleString('en-IN'),
          reference: `${MONTHLY_REFERENCE.toLocaleString('en-IN')} a month (Upstash free allowance; above it is billed at about $0.20 per 100,000)`,
          note: `Site's own count, sampled 1 in ${SAMPLE_EVERY}, reads a few percent low. Plan is Pay As You Go, so the site keeps working. Sent once a month.`
        });
        usage.alerted = true;
      }
    } catch (err) {
      console.warn('[usage-check] could not send warning:', err.message);
    }
  }
  return { ok: true, ...usage };
}
