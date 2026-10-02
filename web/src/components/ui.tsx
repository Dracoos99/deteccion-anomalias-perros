/* Shared UI ported from the v2 prototype. Styles live in styles/app.css. */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Behavior, FusionConfig, Level } from "@shared/types";
import { usingEmulators } from "../firebase";

const ICONS: Record<string, ReactNode> = {
  "check-circle": <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  "alert-triangle": <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  "alert-octagon": <><path d="M12 16h.01" /><path d="M12 8v4" /><path d="M15.31 2a2 2 0 0 1 1.42.59l4.68 4.68A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.42l-4.68 4.68a2 2 0 0 1-1.42.59H8.69a2 2 0 0 1-1.42-.59l-4.68-4.68A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.42l4.68-4.68A2 2 0 0 1 8.69 2z" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  paw: <><circle cx="11" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="20" cy="16" r="2" /><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.05Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" /></>,
  lock: <><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
  bell: <><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></>,
  user: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  home: <><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  stethoscope: <><path d="M11 2v2" /><path d="M5 2v2" /><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" /><path d="M8 15a6 6 0 0 0 12 0v-3" /><circle cx="20" cy="10" r="2" /></>,
  flask: <><path d="M10 2v7.53a2 2 0 0 1-.21.9L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.07-10.13A2 2 0 0 1 14 9.53V2" /><path d="M8.5 2h7" /><path d="M7 16h10" /></>,
  "log-out": <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" /></>,
  database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" /></>,
  heart: <><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" /><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" /></>,
  thermometer: <><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  "chevron-right": <><path d="m9 18 6-6-6-6" /></>,
  "chevron-left": <><path d="m15 18-6-6 6-6" /></>,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  menu: <><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  play: <><polygon points="6 3 20 12 6 21 6 3" /></>,
  pause: <><rect x="14" y="4" width="4" height="16" rx="1" /><rect x="6" y="4" width="4" height="16" rx="1" /></>,
  square: <><rect width="16" height="16" x="4" y="4" rx="2" /></>,
  zap: <><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></>,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  "bell-off": <><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" /><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="m2 2 20 20" /></>,
  sliders: <><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></>,
};

export function Icon({ name, size = 16, title, style }: { name: string; size?: number; title?: string; style?: CSSProperties }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title}>
      {ICONS[name] ?? null}
    </svg>
  );
}

export const LEVELS: Record<Level, { text: string; icon: string; color: string; bg: string }> = {
  green: { text: "Todo normal", icon: "check-circle", color: "var(--color-status-green)", bg: "var(--color-status-green-bg)" },
  amber: { text: "Atención", icon: "alert-triangle", color: "var(--color-status-amber)", bg: "var(--color-status-amber-bg)" },
  red: { text: "Revisar", icon: "alert-octagon", color: "var(--color-status-red)", bg: "var(--color-status-red-bg)" },
};

export const BEHAVIOR_NOW: Record<Behavior, string> = {
  sit: "Sentado", stand: "Parado", lie: "Echado", trot: "Trotando", walk: "Caminando", play: "Jugando", sniff: "Olfateando",
};

export function fmtNum(x: number | null | undefined, d = 0): string {
  return x == null || Number.isNaN(x) ? "—" : x.toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });
}

const APP_TITLE = "Detección de anomalías en perros";
/** Title of the browser tab (and of the PDF saved from the print dialog): "<page> · Detección de anomalías en perros". */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => { document.title = title ? `${title} · ${APP_TITLE}` : APP_TITLE; }, [title]);
}

/** The current time, refreshed every `intervalMs`, so "hace 12 s" keeps counting between snapshots. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "hace 12 s", counting. */
export function Ago({ t }: { t: Date | null | undefined }) {
  const now = useNow();
  return <>{fmtAgo(t, now)}</>;
}

/** "En vivo" while the latest data are less than maxAgeS old: dot and text, never the color alone. */
export function LiveBadge({ t, maxAgeS = 30 }: { t: Date | null | undefined; maxAgeS?: number }) {
  const now = useNow();
  if (!t || now - t.getTime() > maxAgeS * 1000) return null;
  return <span className="live-badge"><span className="live-dot" aria-hidden="true" />En vivo</span>;
}

export function fmtAgo(t: Date | null | undefined, now = Date.now()): string {
  if (!t) return "—";
  const s = Math.max(0, Math.round((now - t.getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return t.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Health Score gauge 0–100. The cut marks come from config/fusion (levels), never hardcoded. */
export function HealthGauge({ score, level, levels, size = 150 }: { score: number | null; level: Level | null; levels: FusionConfig["levels"]; size?: number }) {
  const L = level ? LEVELS[level] : null;
  const A0 = 150, SWEEP = 240, cx = 60, cy = 58, r = 46;
  const cuts = [levels.amber, levels.green];
  const valA = A0 + (SWEEP * Math.max(0, Math.min(100, score ?? 0))) / 100;
  const label = score == null || !L ? "Health Score sin datos" : `Health Score ${score} de 100: ${L.text}`;
  return (
    <div className="gauge" style={{ width: size, maxWidth: "100%", containerType: "inline-size" }} role="img" aria-label={label}>
      <svg viewBox="0 0 120 100">
        <path d={arcPath(cx, cy, r, A0, A0 + SWEEP)} fill="none" stroke={L ? L.bg : "var(--color-surface)"} strokeWidth="11" />
        {score != null && L && <path d={arcPath(cx, cy, r, A0, Math.max(A0 + 0.5, valA))} fill="none" stroke={L.color} strokeWidth="11" />}
        {cuts.map((v) => { const a = A0 + (SWEEP * v) / 100; const [x0, y0] = polar(cx, cy, r - 8, a), [x1, y1] = polar(cx, cy, r + 8, a); return <line key={v} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--color-sheet)" strokeWidth="2" />; })}
        {cuts.map((v) => { const a = A0 + (SWEEP * v) / 100; const [x, y] = polar(cx, cy, r + 13, a); return <text key={`t${v}`} x={x} y={y + 3} textAnchor="middle" className="chart-axis" style={{ fontSize: 8 }}>{v}</text>; })}
      </svg>
      <div className="gauge-center" aria-hidden="true">
        <div className="gauge-value" style={{ fontSize: `min(${Math.round(size * 0.27)}px, 27cqw)` }}>{score ?? "—"}</div>
        <div className="gauge-unit">de 100</div>
      </div>
    </div>
  );
}

/** "Sin conexión": Firestore keeps the last data and syncs when the connection returns. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  if (online) return null;
  return (
    <div className="offline" role="status"><div className="offline-inner">
      <Icon name="alert-triangle" size={16} />
      <span>Sin conexión. Ves los últimos datos que recibimos; se actualizarán cuando vuelvas a conectarte.</span>
    </div></div>
  );
}

export function EmulatorBanner() {
  if (!usingEmulators) return null;
  return (
    <div className="proto"><div className="proto-inner">
      <span className="proto-label">Emuladores locales</span>
      <span>Proyecto de demostración: los datos no salen de este equipo.</span>
    </div></div>
  );
}

export function Callout({ kind, children }: { kind: "error" | "ok"; children: ReactNode }) {
  return (
    <div className={`callout callout-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon name={kind === "error" ? "alert-triangle" : "check-circle"} size={18} style={{ marginTop: 2 }} /><div>{children}</div>
    </div>
  );
}

/** Level of the Health Score: always color + icon + text, never color alone. */
export function LevelTag({ level }: { level: Level | null | undefined }) {
  if (!level) return <span className="tag tag-outline"><Icon name="clock" size={14} />Sin datos</span>;
  return <span className={`tag tag-${level}`}><Icon name={LEVELS[level].icon} size={14} />{LEVELS[level].text}</span>;
}

/** Fixed notice required wherever the Health Score appears. */
export const NOTICE_TEXT = "Detecta cambios respecto al patrón normal de tu perro. No diagnostica ni reemplaza la evaluación veterinaria.";

export function Notice() {
  return (
    <div className="notice" role="note">
      <Icon name="info" size={18} style={{ marginTop: 2 }} />
      <div><strong>{NOTICE_TEXT}</strong></div>
    </div>
  );
}

export function PageHead({ kicker, title, sub, actions }: { kicker?: string; title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {kicker && <div className="kicker">{kicker}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon = "paw", title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} />
      <div className="empty-title">{title}</div>
      {text && <p className="empty-text">{text}</p>}
      {action}
    </div>
  );
}

/** Segmented control (prototype ui.jsx). */
export function Seg<T extends string | number>({ options, value, onChange, label }: {
  options: { value: T; label: string; icon?: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}
