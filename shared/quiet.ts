/**
 * Quiet hours of the notifications: between `from` and `to`, in the owner's time zone, only the pushes of
 * «Revisar» (red) are sent; the «Atención» ones stay in the app and in the alert count. The app writes the window with
 * the browser's time zone; the Function checks it when it sends. Pure, shared by both.
 */

export interface QuietHours {
  /** "HH:MM", 24-hour clock. */
  from: string;
  to: string;
  /** IANA time zone of the browser that set it (e.g. "America/Lima"). */
  tz: string;
}

export const DEFAULT_QUIET: Omit<QuietHours, "tz"> = { from: "22:00", to: "07:00" };
export const DEFAULT_TZ = "America/Lima";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const validTime = (s: unknown): s is string => typeof s === "string" && HHMM.test(s);

const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Minutes after midnight of `nowMs` in `tz` (UTC if the zone is unknown). */
export function localMinutes(nowMs: number, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** True inside the window; a window that crosses midnight (22:00–07:00) works too. Equal ends mean no quiet hours. */
export function inQuietHours(nowMs: number, quiet: QuietHours | null | undefined): boolean {
  if (!quiet || !validTime(quiet.from) || !validTime(quiet.to)) return false;
  const from = minutes(quiet.from), to = minutes(quiet.to);
  if (from === to) return false;
  const now = localMinutes(nowMs, quiet.tz || DEFAULT_TZ);
  return from < to ? now >= from && now < to : now >= from || now < to;
}
