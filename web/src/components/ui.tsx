/* Shared UI ported from the v2 prototype, with the look of the v3 mockups
. Styles live in styles/app.css. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FusionConfig, Level } from "@shared/types";
import { usingEmulators } from "../firebase";
import { freshness as freshnessOf, shownDataMs, type Freshness } from "../lib/live";
import { LEARNING_TEXT, glueTime, steadyScore, whenPhrase, type Steady } from "../lib/plain";

/* Line icons on a 24 px grid, 2 px stroke: the set of the v3 mockups, plus a few more for the research tools. */
const ICONS: Record<string, ReactNode> = {
  "check-circle": <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  "alert-triangle": <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  "alert-octagon": <><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  paw: <><circle cx="6.5" cy="10" r="2" /><circle cx="10" cy="5.5" r="2" /><circle cx="14" cy="5.5" r="2" /><circle cx="17.5" cy="10" r="2" /><path d="M8 17c0-2.8 1.8-5 4-5s4 2.2 4 5c0 1.7-1.2 2.6-2.6 2.6-.7 0-1-.4-1.4-.4s-.7.4-1.4.4C9.2 19.6 8 18.7 8 17z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></>,
  home: <><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></>,
  stethoscope: <><path d="M5 3v5a5 5 0 0 0 10 0V3" /><path d="M10 13v2a5 5 0 0 0 10 0v-2" /><circle cx="20" cy="11" r="2" /></>,
  flask: <><path d="M9 3h6" /><path d="M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" /><path d="M7 15h10" /></>,
  "log-out": <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  heart: <><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z" /></>,
  thermometer: <><path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z" /></>,
  "chevron-right": <><path d="m9 18 6-6-6-6" /></>,
  "chevron-left": <><path d="m15 18-6-6 6-6" /></>,
  "chevron-down": <><path d="m6 9 6 6 6-6" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  play: <><path d="M7 4l13 8-13 8z" /></>,
  pause: <><path d="M8 4v16" /><path d="M16 4v16" /></>,
  square: <><rect x="5" y="5" width="14" height="14" rx="1" /></>,
  zap: <><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></>,
  upload: <><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  archive: <><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>,
  "bell-off": <><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" /><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="m2 2 20 20" /></>,
  sliders: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></>,
  "wifi-off": <><path d="M2 2l20 20" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M5 12.9a10 10 0 0 1 5.2-2.8" /><path d="M19 12.9a10 10 0 0 0-2.2-1.6" /><path d="M12 20h.01" /></>,
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

/** CSS variables with the colours of a level, for borders, icons and markers that follow it. */
export function levelVars(level: Level | null | undefined): CSSProperties {
  const L = level ? LEVELS[level] : null;
  return { ["--level-color" as string]: L ? L.color : "var(--color-divider)", ["--level-bg" as string]: L ? L.bg : "var(--color-surface)" };
}

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

/** "En vivo": dot and text, never the color alone. Shown only while the dog's state is live. */
function LiveBadge() {
  return <span className="live-badge"><span className="live-dot" aria-hidden="true" />En vivo</span>;
}

type Millis = { toMillis?: () => number } | null | undefined;

/** How current a dog's state is, refreshed every 5 s: live, recent or stale (old data are not its current state), and
 * the time to show the owner. */
export function useFreshness(status: { lastBlockAt?: Millis; updatedAt?: Millis; lastSource?: "simulator" | "csv" } | null | undefined): { freshness: Freshness | null; shownMs: number | null } {
  const now = useNow(5000);
  if (!status) return { freshness: null, shownMs: null };
  const dataMs = status.lastBlockAt?.toMillis?.() ?? null, receivedMs = status.updatedAt?.toMillis?.() ?? null;
  return { freshness: freshnessOf(dataMs, receivedMs, now, status.lastSource), shownMs: shownDataMs(dataMs, receivedMs) };
}

/** Whether the browser is online, kept up to date. The «Sin conexión» banner and the time of each dog's data read the
 * same state. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

/** "Actualizado hace 12 s · En vivo", or, for old data, "Últimos datos: el 1 oct. 2026, 5:43 p. m.". Offline, never
 * «En vivo»: "Sin conexión · último dato hace 28 s", like the banner at the top. */
export function DataTime({ freshness, shownMs }: { freshness: Freshness; shownMs: number | null }) {
  const online = useOnline();
  if (freshness === "stale") return <>Últimos datos: {shownMs != null ? whenPhrase(shownMs) : "sin dato"}</>;
  if (!online) return <>Sin conexión · último dato <Ago t={shownMs != null ? new Date(shownMs) : null} /></>;
  return <>Actualizado <Ago t={shownMs != null ? new Date(shownMs) : null} />{freshness === "live" && <LiveBadge />}</>;
}

/** The Health Score a screen shows, held while the stable score drifts by a point or two
 * (lib/plain.ts, steadyScore). */
export function useSteadyScore(score: number | null, levels: FusionConfig["levels"]): number | null {
  const held = useRef<Steady | null>(null);
  held.current = steadyScore(held.current, score, Date.now(), levels);
  return held.current?.score ?? null;
}

export function fmtAgo(t: Date | null | undefined, now = Date.now()): string {
  if (!t) return "—";
  const s = Math.max(0, Math.round((now - t.getTime()) / 1000));
  if (s < 5) return "hace un momento";
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `el ${glueTime(t.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" }))}`;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Health Score gauge 0–100: a 240° arc with the value in the serif. The cut marks come from config/fusion (levels),
 * never hardcoded. `size` is the widest it gets; it shrinks with its container. */
export function HealthGauge({ score, level, levels, size = 150 }: { score: number | null; level: Level | null; levels: FusionConfig["levels"]; size?: number }) {
  const L = level ? LEVELS[level] : null;
  const A0 = 150, SWEEP = 240, cx = 60, cy = 58, r = 46;
  const cuts = [levels.amber, levels.green];
  const valA = A0 + (SWEEP * Math.max(0, Math.min(100, score ?? 0))) / 100;
  const label = score == null || !L ? "Health Score sin datos" : `Health Score ${score} de 100: ${L.text}`;
  // A three-digit score (100) gets a smaller figure so it stays inside the arc.
  const k = score != null && score >= 100 ? 0.235 : 0.285;
  // The cut numbers are only legible on a large gauge (12 px rendered); smaller ones keep the white cut marks.
  const labelPx = size >= 120 ? (12 * 132) / size : null;
  return (
    <div className="gauge" style={{ width: size, maxWidth: "100%", containerType: "inline-size" }} role="img" aria-label={label}>
      <svg viewBox="-6 -4 132 106">
        <path d={arcPath(cx, cy, r, A0, A0 + SWEEP)} fill="none" stroke={L ? L.bg : "var(--color-surface)"} strokeWidth="11" />
        {score != null && L && <path className="gauge-arc" d={arcPath(cx, cy, r, A0, Math.max(A0 + 0.5, valA))} fill="none" stroke={L.color} strokeWidth="11" />}
        {cuts.map((v) => { const a = A0 + (SWEEP * v) / 100; const [x0, y0] = polar(cx, cy, r - 8, a), [x1, y1] = polar(cx, cy, r + 8, a); return <line key={v} className="gauge-cut" x1={x0} y1={y0} x2={x1} y2={y1} />; })}
        {labelPx != null && cuts.map((v) => {
          const a = A0 + (SWEEP * v) / 100; const [x, y] = polar(cx, cy, r + 13, a);
          return <text key={`t${v}`} className="gauge-label" x={x} y={y + labelPx * 0.35} textAnchor="middle" style={{ fontSize: `${labelPx.toFixed(1)}px` }}>{v}</text>;
        })}
      </svg>
      <div className="gauge-center" aria-hidden="true">
        <div className="gauge-value" style={{ fontSize: `min(${Math.round(size * k)}px, ${(100 * k).toFixed(1)}cqw)` }}>{score ?? "—"}</div>
        <div className="gauge-unit">de 100</div>
      </div>
    </div>
  );
}

/** "Sin conexión": Firestore keeps the last data and syncs when the connection returns. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline" role="status"><div className="offline-inner">
      <Icon name="wifi-off" size={14} />
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

/** A message after an action. Success eases in (it appears because of what the owner did); errors appear at once. */
export function Callout({ kind, children }: { kind: "error" | "ok"; children: ReactNode }) {
  return (
    <div className={`callout callout-${kind}${kind === "ok" ? " appear" : ""}`} role={kind === "error" ? "alert" : "status"}>
      <Icon name={kind === "error" ? "alert-triangle" : "check-circle"} size={16}
        style={{ marginTop: 1, color: kind === "error" ? "var(--color-status-red)" : "var(--color-status-green)" }} /><div>{children}</div>
    </div>
  );
}

/** Level of the Health Score: always color + icon + text, never color alone. `prefix` names which level it is
 *. */
export function LevelTag({ level, iconSize = 14, prefix }: { level: Level | null | undefined; iconSize?: number; prefix?: string }) {
  if (!level) return <span className="tag tag-outline"><Icon name="clock" size={iconSize} />Sin datos</span>;
  return <span className={`tag tag-${level}`}><Icon name={LEVELS[level].icon} size={iconSize} />{prefix ? `${prefix}: ` : ""}{LEVELS[level].text}</span>;
}

/** The state of a dog on Inicio and in its detail: «Sin datos recientes» for old data, the neutral «Aprendiendo su
 * patrón normal» while it has no normal pattern, otherwise its level. */
export function StateTag({ level, learning = false, stale = false, sensorOff = false, iconSize = 14 }: { level: Level | null | undefined; learning?: boolean; stale?: boolean; sensorOff?: boolean; iconSize?: number }) {
  if (stale) return <span className="tag tag-outline"><Icon name="clock" size={iconSize} />Sin datos recientes</span>;
  // The collar seems off the dog: a state of the sensor, not a level of the dog.
  if (sensorOff) return <span className="tag tag-outline tag-sensor"><Icon name="alert-triangle" size={iconSize} />Revisa el collar</span>;
  if (learning) return <span className="tag tag-outline"><Icon name="info" size={iconSize} />{LEARNING_TEXT}</span>;
  return <LevelTag level={level} iconSize={iconSize} />;
}

/** The Health Score as secondary data: the figure, «de 100» and its name, on a quiet well. The `glass`
 * variant is the large one of the protagonist (the dog's state, the featured card of Inicio, the summary band): the
 * figure over a hairline with its explanation under it, on a translucent pane, as in the PO's references 04 and 05. */
export function ScoreTile({ score, variant = "quiet", name = "Health Score", average = null }: { score: number | null; variant?: "quiet" | "glass"; name?: string; average?: number | null }) {
  return (
    <p className={variant === "glass" ? "score-tile score-tile-glass" : "score-tile"}>
      <span className="score-name">{name}</span>
      <span className="score-value">{score ?? "—"}</span>
      <span className="score-of">de 100</span>
      {/* Which number it is, inside the pane: the average of the last minutes (the one the state uses), not the «ahora». */}
      {variant === "glass" && average != null && average > 0 && <span className="score-avg">promedio de {average} min</span>}
    </p>
  );
}

/** The minutes of the stable Health Score (config/fusion.stableTimeConstantS, 300 s by default), for the label of its pane. */
export function averageMinutes(cfg: Pick<FusionConfig, "stableTimeConstantS">): number {
  return Math.round((cfg.stableTimeConstantS ?? 300) / 60);
}

/** Fixed notice required wherever the Health Score appears: a quiet line between two rules. */
export const NOTICE_TEXT = "Detecta cambios respecto al patrón normal de tu perro. No diagnostica ni reemplaza la evaluación veterinaria.";

export function Notice() {
  return (
    <div className="notice" role="note">
      <Icon name="info" size={14} />
      <span>{NOTICE_TEXT}</span>
    </div>
  );
}

/** The head of a page: the title in display type, what the page is about under it (`kicker`: the dog of an alert, the
 * research tools; with its icon) and a line of explanation. Never a label above the title. `hero` is the title
 * of a page whose protagonist is the screen itself (Alertas, Perfil, Cargar datos): the scale of the PO's references. */
export function PageHead({ kicker, kickerIcon, title, sub, actions, hero = false }: { kicker?: string; kickerIcon?: string; title: string; sub?: string; actions?: ReactNode; hero?: boolean }) {
  return (
    <div className={hero ? "page-head page-head-hero" : "page-head"}>
      <div className="page-head-main">
        <h1 className="page-title">{title}</h1>
        {kicker && <p className="page-meta">{kickerIcon && <Icon name={kickerIcon} size={16} />}{kicker}</p>}
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/** Empty state inside a panel: an icon (green when everything is fine), a short title, what to do next. */
export function EmptyState({ icon = "paw", title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty" data-tone={icon === "check-circle" ? "ok" : undefined}>
      <Icon name={icon} size={28} />
      <div className="empty-title">{title}</div>
      {text && <p className="empty-text">{text}</p>}
      {action}
    </div>
  );
}

/** Placeholder blocks while the first snapshot arrives. */
export function Skeleton({ lines = [40, 60, 100], className }: { lines?: number[]; className?: string }) {
  return (
    <div className={className ? `panel stack-sm ${className}` : "panel stack-sm"} aria-hidden="true">
      {lines.map((w, i) => <div key={i} className="skeleton" style={{ height: i === lines.length - 1 ? 56 : i === 1 ? 22 : 14, width: `${w}%` }} />)}
    </div>
  );
}

/** A whole page while its first snapshot arrives: the frame (main, title) with placeholders, not a blank screen. With
 * `shape="detail"` the placeholders have the shape of the dog's page (title, state card, controls, chart), and with
 * `shape="sheet"` that of the Vista para el veterinario (title and a sheet), so the page does not jump when it arrives. */
export function PageLoading({ title, text = "Cargando…", className, shape }: { title?: string; text?: string; className?: string; shape?: "detail" | "sheet" }) {
  return (
    <main className={className ? `page ${className}` : "page"} id="main" aria-busy="true">
      {title && <PageHead title={title} />}
      {shape === "detail" ? (
        <div className="loading-shape">
          <p className="small muted">{text}</p>
          <div className="skeleton skeleton-title" aria-hidden="true" />
          <div className="skeleton skeleton-hero" aria-hidden="true" />
          <div className="skeleton skeleton-tabs" aria-hidden="true" />
          <div className="skeleton skeleton-chart" aria-hidden="true" />
        </div>
      ) : shape === "sheet" ? (
        <div className="loading-shape">
          <p className="small muted">{text}</p>
          <div className="skeleton skeleton-title" aria-hidden="true" />
          <div className="skeleton skeleton-sheet" aria-hidden="true" />
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">{text}</p>
          {!title && <div className="skeleton skeleton-title" aria-hidden="true" />}
          <Skeleton />
          <Skeleton lines={[35, 50, 100]} />
        </div>
      )}
    </main>
  );
}

/** The cold start: from the first frame, before the account is known, the frame of the app
 * (the dark side column or tab bar, a title and placeholder cards), so the screen never reads as broken. The same markup
 * is in web/index.html, shown before any script runs: keep the two in step. The account is unknown here, so it does not
 * say whose page it is; the pages that load after it have their own placeholders (PageLoading). */
export function BootFrame() {
  return (
    <div className="boot" role="status" aria-busy="true">
      <div className="shell">
        <aside className="sidebar" aria-hidden="true">
          <div className="sidebar-brand">
            <span className="brand-title">Detección de anomalías en perros</span>
            <div className="brand-kicker">Proyecto de tesis · UPC</div>
          </div>
          <div className="sidebar-nav"><span className="skeleton boot-pill" /><span className="skeleton boot-pill" /><span className="skeleton boot-pill" /></div>
        </aside>
        <div className="shell-main">
          <header className="masthead" aria-hidden="true">
            <div className="masthead-inner"><div className="brand"><span className="brand-title">Detección de anomalías en perros</span></div></div>
            <div className="nav"><div className="nav-inner"><span className="skeleton boot-pill" /><span className="skeleton boot-pill" /><span className="skeleton boot-pill" /></div></div>
          </header>
          <div className="page-content">
            <div className="page">
              <div className="stack">
                <p className="small muted">Cargando…</p>
                <div className="skeleton skeleton-title" aria-hidden="true" />
                <div className="panel stack-sm" aria-hidden="true"><div className="skeleton" style={{ height: 14, width: "40%" }} /><div className="skeleton" style={{ height: 22, width: "60%" }} /><div className="skeleton" style={{ height: 56, width: "100%" }} /></div>
                <div className="panel stack-sm" aria-hidden="true"><div className="skeleton" style={{ height: 14, width: "35%" }} /><div className="skeleton" style={{ height: 22, width: "50%" }} /><div className="skeleton" style={{ height: 56, width: "100%" }} /></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="tabbar" aria-hidden="true"><span className="skeleton boot-pill" /><span className="skeleton boot-pill" /><span className="skeleton boot-pill" /></div>
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
