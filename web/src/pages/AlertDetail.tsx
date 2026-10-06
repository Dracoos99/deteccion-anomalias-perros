/* Screen 4 · Detalle de la alerta: what happened in plain language, when and for how long, how the dog is now,
   which variable caused it with its value and normal range, a mini chart of the episode, what the owner can do, and
   "Marcar como revisada". */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { MINUTE_TIER, collectSlots, collectTierSlots, dayKey, movingShare, tierDocStart, toPoint, windowAlpha, withMovingShare } from "@shared/trends";
import type { AlertReason, FusionConfig } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { RangeBar, TrendChart, type ChartPoint } from "../components/charts";
import { Callout, DataTime, EmptyState, Icon, LEVELS, LevelTag, Notice, PageHead, PageLoading, fmtAgo, fmtNum, levelVars, useFreshness, usePageTitle } from "../components/ui";
import { db } from "../firebase";
import { useAlert, useDog, useFusionConfig, useTierDocs, useTrendDocs, type Alert, type Viewer } from "../data/hooks";
import { COMPONENT_LABEL, alertStartMs, alertTitle, describeDog, durationText, endSentence, primaryReason, reasonUnit, whatToDo, whenPhrase } from "../lib/plain";
import { ReviewTag } from "../components/AlertItem";

const MARGIN_MS = 30 * 60_000;

/** One cause of the alert: the variable with an icon in the colour of the alert level, its value (serif), the dog's
 * normal range, the value against that range and the explanation. */
function ReasonRow({ r, color }: { r: AlertReason; color: string }) {
  const { unit, decimals: d0 } = reasonUnit(r);
  const [lo, hi] = r.normalRange;
  // An out-of-range value that rounds to its bound ("55 lpm, normal 55–68") gets one more decimal.
  const out = r.value < lo || r.value > hi;
  const decimals = out && (fmtNum(r.value, d0) === fmtNum(lo, d0) || fmtNum(r.value, d0) === fmtNum(hi, d0)) ? d0 + 1 : d0;
  const span = Math.max(hi - lo, Math.abs(r.value - (r.value > hi ? hi : lo)), unit === "°C" ? 1 : 10);
  const scale: [number, number] = [Math.min(lo, r.value) - span * 0.4, Math.max(hi, r.value) + span * 0.4];
  const icon = r.component === "temperature" ? "thermometer" : r.component === "heart_rate" ? "heart" : "paw";
  return (
    <li className="reason">
      <div className="reason-icon" aria-hidden="true"><Icon name={icon} size={20} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="reason-name">{COMPONENT_LABEL[r.component]}</div>
        <div className="reason-value tabular">{fmtNum(r.value, decimals)} {unit}</div>
        <div className="reason-range">Normal: {fmtNum(lo, decimals)}–{fmtNum(hi, decimals)} {unit}</div>
        <RangeBar value={r.value} range={[lo, hi]} scale={[Math.max(0, scale[0]), scale[1]]} color={color} />
        <p>{r.message}</p>
      </div>
    </li>
  );
}

/** The primary variable around the episode, from the 1-minute slots; older data only have 5-minute ones.
 * Unusual movements are charted as their own share (not as time in movement): a reason's band never goes on another
 * variable. Movement and unusual movements go as the engine's moving averages, the quantities their band refers to
 *, with the share of each minute behind. The episode is shaded. While the slots arrive, a placeholder of
 * the chart's size keeps the page from jumping. */
function EpisodeChart({ alert, reason, viewer, dogName, cfg, activityMean }: {
  alert: Alert; reason: AlertReason; viewer: Viewer; dogName: string;
  cfg: Pick<FusionConfig, "activity" | "novelty">; activityMean: number | null;
}) {
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.() ?? start + MARGIN_MS;
  const from = start - MARGIN_MS, to = end + MARGIN_MS;
  const minuteDocs = useTierDocs(MINUTE_TIER, alert.dogId, viewer, tierDocStart(MINUTE_TIER, from), to);
  const dayDocs = useTrendDocs(alert.dogId, viewer, dayKey(from));
  const minute = collectTierSlots(minuteDocs.data, from, to);
  const fine = minute.length >= 2;
  const slots = withMovingShare(fine ? minute : collectSlots(dayDocs.data, from, to), activityMean, windowAlpha(cfg.activity.timeConstantS));
  const band = reason.normalRange;
  const novelty = reason.code === "behavior_unusual";
  const movement = reason.component === "behavior" && !novelty;
  // The engine starts its novelty average at the expected rate, the top of this band.
  const noveltyAvg = novelty ? movingShare(slots, (s) => [s.nov, s.w], band[1] / 100, windowAlpha(cfg.novelty.timeConstantS)) : [];
  const points: ChartPoint[] = slots.flatMap((s, i) => {
    const p = toPoint(s);
    const raw = novelty ? noveltyAvg[i] : movement ? p.activityAvg : reason.component === "heart_rate" ? p.hr : p.temp;
    const v = raw == null ? null : novelty || movement ? 100 * raw : raw;
    return v == null ? [] : [{ t: p.t, v, mark: v < band[0] || v > band[1] }];
  });
  const detail = novelty || movement ? slots.flatMap((s) => {
    const share = novelty ? (s.slot.w ? s.slot.nov / s.slot.w : null) : toPoint(s).activity;
    return share == null ? [] : [{ t: s.t, v: 100 * share }];
  }) : undefined;
  if (points.length < 2) {
    if (!minuteDocs.loading && !dayDocs.loading) return null;
    return <section className="panel" aria-busy="true"><div className="skeleton" style={{ height: 236 }} /></section>;
  }
  const { unit, decimals } = reasonUnit(reason);
  const title = novelty ? "Movimientos poco habituales"
    : reason.component === "temperature" ? "Temperatura" : reason.component === "heart_rate" ? "Frecuencia cardiaca" : "Tiempo en movimiento";
  const every = fine ? "cada minuto" : "cada 5 minutos";
  const average = novelty ? `Promedio de ${fmtNum(cfg.novelty.timeConstantS / 60)} minutos` : movement ? `Promedio de ${fmtNum(cfg.activity.timeConstantS / 60)} minutos` : `Promedio de ${every}`;
  const last = points[points.length - 1]?.t ?? start;
  return (
    <section className="panel">
      <TrendChart title={title} sub="Antes, durante y después del aviso" rangeKey="1h" unit={unit}
        decimals={decimals} points={points} detail={detail} band={band} height={170} gapMs={fine ? 180_000 : 900_000} showLast={!alert.endedAt}
        highlight={{ from: start, to: alert.endedAt ? end : last, label: "Aviso" }}
        legendLine={average} legendDetail={detail ? `${every.charAt(0).toUpperCase()}${every.slice(1)}` : undefined}
        legendBand={novelty ? `Lo habitual (hasta ${fmtNum(band[1], decimals)} %)` : `Lo normal para ${dogName}`} legendMarks="Fuera de lo normal" />
    </section>
  );
}

export function AlertDetail() {
  const { alertId } = useParams();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: alert, loading, error } = useAlert(alertId);
  const { data: dog } = useDog(alert?.dogId);
  // The dog's current name: the alert keeps the one it had when it opened.
  const dogName = dog?.name ?? alert?.dogName ?? "";
  usePageTitle(alert ? `${dogName}: ${alertTitle(alert.reasons).toLowerCase()}` : "Alerta");
  const { data: cfg } = useFusionConfig();
  const { freshness, shownMs } = useFreshness(dog?.status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // After "Marcar como revisada" the button goes away: focus moves to the confirmation, which is read aloud.
  const [justReviewed, setJustReviewed] = useState(false);
  const reviewedRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (justReviewed && alert?.status !== "open") reviewedRef.current?.focus(); }, [justReviewed, alert?.status]);

  if (loading) return <PageLoading text="Cargando la alerta…" className="page-narrow" />;
  if (error || !alert) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos esta alerta" text="Puede que la dirección no sea correcta o que no tengas acceso."
          action={<Link className="btn btn-secondary" to="/alertas">Ir a Alertas</Link>} />
      </main>
    );
  }
  const reason = primaryReason(alert.reasons);
  // The reason that names the alert goes first.
  const reasons = reason ? [reason, ...alert.reasons.filter((r) => r !== reason)] : alert.reasons;
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.();
  const open = alert.status === "open";
  const markReviewed = async () => {
    setBusy(true); setMsg(null); setJustReviewed(true);
    try {
      await updateDoc(doc(db, "alerts", alert.id), { status: "acknowledged", acknowledgedBy: user!.uid, acknowledgedAt: serverTimestamp() });
    } catch {
      setJustReviewed(false);
      setMsg("No pudimos guardar el cambio. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  };
  const s = dog?.status;
  const stale = freshness === "stale";
  const now = describeDog(s, dog?.baseline, cfg, open ? alert.reasons : null);
  // Without an end, the episode goes on only while data keep arriving; otherwise say since when nothing arrives.
  const startText = whenPhrase(start);
  const going = end ? null : freshness === "live"
    ? <> y todavía continúa.</>
    : <>{startText.endsWith(".") ? "" : "."} {endSentence(`No llegan datos nuevos de ${dogName}${shownMs != null ? ` desde ${fmtAgo(new Date(shownMs))}` : ""}`)}</>;

  return (
    <main className="page page-narrow" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/alertas">Alertas</Link><span aria-hidden="true">›</span><Link to={`/perros/${alert.dogId}`}>{dogName}</Link></nav>
      <PageHead kicker={dogName} title={alertTitle(alert.reasons)} />
      <div className="stack">
        <section className="panel stack-sm" aria-label="Cuándo pasó">
          <div className="row">
            <LevelTag level={alert.severity} />
            <ReviewTag open={open} />
          </div>
          <p className="small">
            Empezó <strong>{startText}</strong>{end ? <> y duró <strong>{durationText(end - start)}</strong>.</> : going}
          </p>
          {s && freshness && (
            <div className="now-line small">
              <strong>Ahora:</strong>
              {stale ? <span className="tag tag-outline"><Icon name="clock" size={12} />Sin datos recientes</span> : <LevelTag level={s.level} iconSize={12} />}
              <span>{stale && shownMs != null ? endSentence(`No recibimos datos de ${dogName} desde ${whenPhrase(shownMs)}`) : now.phrase}</span>
              {!stale && <span className="xs muted"><DataTime freshness={freshness} shownMs={shownMs} /></span>}
            </div>
          )}
        </section>

        <section className="panel stack-sm" aria-labelledby="why">
          <h2 className="section-title" id="why">Qué lo originó</h2>
          <ul className="reason-list" style={levelVars(alert.severity)}>{reasons.map((r) => <ReasonRow key={r.code} r={r} color={LEVELS[alert.severity].color} />)}</ul>
        </section>

        {reason && <EpisodeChart alert={alert} reason={reason} viewer={viewer} dogName={dogName} cfg={cfg} activityMean={dog?.baseline?.activeRatioMean ?? null} />}

        <section className="panel stack-sm" aria-labelledby="todo">
          <h2 className="section-title" id="todo">Qué puedes hacer</h2>
          <ul className="todo-list">{whatToDo(alert.reasons, dogName, cfg, { endedAtMs: end }).map((t) => <li key={t}>{t}</li>)}</ul>
        </section>

        {msg && <Callout kind="error">{msg}</Callout>}
        {!open && (
          <p ref={reviewedRef} tabIndex={-1} role="status" className={justReviewed ? "small muted reviewed-line appear" : "small muted reviewed-line"}>
            <Icon name="check-circle" size={14} />{endSentence(`Revisada${alert.acknowledgedAt?.toMillis?.() ? ` ${whenPhrase(alert.acknowledgedAt.toMillis())}` : ""}`)}
          </p>
        )}
        <div className="row">
          {open && <button type="button" className="btn btn-primary" onClick={markReviewed} disabled={busy}><Icon name="check-circle" />{busy ? "Guardando…" : "Marcar como revisada"}</button>}
          {!open && justReviewed && <Link className="btn btn-secondary" to="/alertas">Volver a Alertas</Link>}
          <Link className="btn btn-secondary" to={`/perros/${alert.dogId}/veterinario`}><Icon name="stethoscope" />Vista para el veterinario</Link>
        </div>
        <Notice />
      </div>
    </main>
  );
}
