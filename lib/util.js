// lib/util.js
export function personalize(template, vars) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => {
    const v = vars[key.toLowerCase()];
    return v != null && v !== '' ? v : defaultFor(key);
  });
}

function defaultFor(key) {
  if (key.toLowerCase() === 'firstname') return 'there';
  return '';
}

/** True if current time is inside the allowed send window (default 8am–6pm, America/New_York). */
export function inSendWindow() {
  const tz = process.env.SEND_TZ || 'America/New_York';
  const startHour = parseInt(process.env.SEND_START_HOUR || '8', 10);
  const endHour = parseInt(process.env.SEND_END_HOUR || '18', 10);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()),
    10
  );
  return hour >= startHour && hour < endHour;
}

export function daysFromNow(days) {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}
