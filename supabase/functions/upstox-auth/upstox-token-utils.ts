/**
 * Upstox access_token expires at 3:30 AM IST (same calendar day if issued before 3:30, else next day).
 * @see https://upstox.com/developer/api-documentation/get-token/
 */
export function computeUpstoxAccessTokenExpiresAt(from: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(from);

  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  let y = get('year');
  let mo = get('month') - 1;
  let d = get('day');
  const h = get('hour');
  const mi = get('minute');

  if (h > 3 || (h === 3 && mi >= 30)) {
    const next = new Date(Date.UTC(y, mo, d + 1));
    y = next.getUTCFullYear();
    mo = next.getUTCMonth();
    d = next.getUTCDate();
  }

  const utcMs = Date.UTC(y, mo, d, 3, 30, 0) - (5 * 60 + 30) * 60 * 1000;
  return new Date(utcMs).toISOString();
}

export function formatUpstoxExpiryIst(expiresAtIso: string): string {
  try {
    return new Date(expiresAtIso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return expiresAtIso;
  }
}

export function hoursUntilExpiry(expiresAtIso: string): number {
  const ms = new Date(expiresAtIso).getTime() - Date.now();
  return Math.max(0, ms / (60 * 60 * 1000));
}
