/* Screen 4 · Detalle de la alerta: what happened in plain language, when and for how long, how the dog is now,
   which variable caused it with its value and normal range, a mini chart of the episode, what the owner can do, and
   "Marcar como revisada", with «Deshacer» for a few minutes. of the title and the
   first cause are the reason the engine fixed for the alert, the level is labelled as the highest it reached
, «Qué puedes hacer» follows that level and two causes never share a name. The
   causes are the one that names the alert and the variables clearly out of their band; those near the bound go in one
   line of context. */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MINUTE_TIER, collectSlots, collectTierSlots, dayKey, movingShare, tierDocStart, toPoint, windowAlpha, withMovingShare } from "@shared/trends";
import type { AlertReason, FusionConfig } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { RangeBar, TrendChart, type ChartPoint } from "../components/charts";
import { Callout, DataTime, EmptyState, Icon, LEVELS, LevelTag, Notice, PageHead, PageLoading, StateTag, fmtAgo, fmtNum, levelVars, useFreshness, useNow, usePageTitle } from "../components/ui";
import { useAlert, useDog, useFusionConfig, useTierDocs, useTrendDocs, type Alert, type Viewer } from "../data/hooks";
import { applyBulk } from "../lib/alertActions";
import { UNDO_MS } from "../lib/bulkAlerts";
import { simulatedTime } from "../lib/live";
import {
  aheadNote, alertGoing, alertStartMs, alertTitle, contextLine, describeDog, durationText, endSentence, isLearning, messageInPast, reasonHolds, reasonLabel, reasonRangeText, reasonUnit,
  splitReasons, titleReason, whatToDo, whenPhrase,
} from "../lib/plain";
import { ReviewTag } from "../components/AlertItem";

const MARGIN_MS = 30 * 60_000;

/** One cause of the alert: the variable with an icon in the colour of the alert level, its value (serif), the dog's
 * normal range, the value against that range and the explanation. */
function ReasonRow({ r, color, ended }: { r: AlertReason; color: string; ended: boolean }) {
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
        <div className="reason-name">{reasonLabel(r)}</div>
        <div className="reason-value tabular"><span>{fmtNum(r.value, decimals)}</span> <span className="reason-unit">{unit}</span></div>
        <div className="reason-range">{reasonRangeText(r, decimals)}</div>
        <RangeBar value={r.value} range={[lo, hi]} scale={[Math.max(0, scale[0]), scale[1]]} color={color} />
        {/* The engine writes the explanation in the present; once the episode ended it is in the past.
 Also when the alert goes on for another cause and this variable is back in its band. */}
        <p>{ended ? messageInPast(r.message) : r.message}</p>
      </div>
    </li>
  );
}

/** The primary variable around the episode, from the 1-minute slots; older data only have 5-minute ones.
 * Unusual movements are charted as their own share (not as time in movement): a reason's band never goes on another
 * variable. Movement and unusual movements go as the engine's moving averages, the quantities their band refers to
 * with the share of each minute behind. The episode is shaded. While the slots arrive, a placeholder of
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
      <TrendChart title={title} sub="Antes, durante y después de la alerta" rangeKey="1h" unit={unit}
        decimals={decimals} points={points} detail={detail} band={band} height={170} gapMs={fine ? 180_000 : 900_000} showLast={!alert.endedAt}
        highlight={{ from: start, to: alert.endedAt ? end : last, label: "Alerta" }}
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
  // «Deshacer» leaves a minute before firestore.rules stop accepting it.
  const now = useNow(15_000);
  const { data: cfg } = useFusionConfig();
  // The dog now, as Inicio and its detail show it; while this
  // alert goes on, its phrase names what holds the level.
  const dogNow = alert ? describeDog(dog?.status, dog?.baseline, cfg, alert, !alert.endedAt, { key: alert.dogId }) : null;
  // The title is in the present while the episode goes on. And while the variable that
  // names it is still out of its band.
  const going = !!alert && alertGoing(alert, now) && dogNow?.titleStill !== false;
  usePageTitle(alert ? `${dogName}: ${alertTitle(alert.reasons, alert.titleCode, going).toLowerCase()}` : "Alerta");
  const { freshness, shownMs } = useFreshness(dog?.status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // After "Marcar como revisada" the button goes away: focus moves to the confirmation, which is read aloud.
  const [justReviewed, setJustReviewed] = useState(false);
  const reviewedRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (justReviewed && alert?.status !== "open") reviewedRef.current?.focus(); }, [justReviewed, alert?.status]);

  if (loading) return <PageLoading text="Cargando la alerta…" />;
  if (error || !alert || !dogNow) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos esta alerta" text="Puede que la dirección no sea correcta o que no tengas acceso."
          action={<Link className="btn btn-secondary" to="/alertas">Ir a Alertas</Link>} />
      </main>
    );
  }
  // The reason that names the alert (fixed by the engine while it lasts) goes first, then the others by
  // how far they are out of their band.
  const reason = titleReason(alert.reasons, alert.titleCode);
  const { causes, context } = splitReasons(alert.reasons, alert.titleCode);
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.();
  const open = alert.status === "open";
  // The same writes as the bulk actions of Alertas (lib/alertActions.ts): a review, and its undo for the same person.
  const markReviewed = async () => {
    setBusy(true); setMsg(null); setJustReviewed(true);
    const r = await applyBulk({ kind: "review", reviewed: [alert.id] }, user!.uid);
    if (r.error) {
      setJustReviewed(false);
      setMsg("No pudimos guardar el cambio. Revisa tu conexión e inténtalo de nuevo.");
    }
    setBusy(false);
  };
  const undoReview = async () => {
    setBusy(true); setMsg(null);
    const r = await applyBulk({ kind: "review", reviewed: [alert.id] }, user!.uid, true);
    if (r.error) setMsg("No pudimos deshacer el cambio. Revisa tu conexión e inténtalo de nuevo.");
    else setJustReviewed(false);
    setBusy(false);
  };
  const ackMs = alert.acknowledgedAt?.toMillis?.() ?? null;
  // While the server time of the review is on its way, the review just made can be undone.
  const canUndo = !open && alert.acknowledgedBy === user!.uid && (ackMs == null ? justReviewed : now - ackMs < UNDO_MS);
  const s = dog?.status;
  const stale = freshness === "stale";
  const learning = !stale && isLearning(s, dog?.baseline);
  // A simulation faster than the clock dates its alerts after their write time.
  const simulated = simulatedTime(start, alert.createdAt?.toMillis?.(), now);
  // Without an end, the episode goes on only while data keep arriving; otherwise say since when nothing arrives.
  const startText = whenPhrase(start);
  const goingText = end ? null : freshness === "live"
    ? <> y todavía continúa.</>
    : <>{startText.endsWith(".") ? "" : "."} {endSentence(`No llegan datos nuevos de ${dogName}${shownMs != null ? ` desde ${fmtAgo(new Date(shownMs))}` : ""}`)}</>;

  return (
    <main className="page" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/alertas">Alertas</Link><span aria-hidden="true">›</span><Link to={`/perros/${alert.dogId}`}>{dogName}</Link></nav>
      <PageHead kicker={dogName} kickerIcon="paw" title={alertTitle(alert.reasons, alert.titleCode, going)} />
      <div className="stack">
        <section className="panel stack-sm alert-when" aria-label="Cuándo pasó">
          <div className="row">
            <LevelTag level={alert.severity} prefix="Nivel más alto" />
            <ReviewTag open={open} />
          </div>
          <p>
            Empezó <strong>{startText}</strong>{end ? <> y duró <strong>{durationText(end - start)}</strong>.</> : goingText}
          </p>
          {simulated && <p className="xs muted">{aheadNote(dog?.status?.lastSource)}</p>}
          {s && freshness && (
            <div className="now-block">
              {stale ? (
                // Old data are the last state, never «Ahora».
                <div className="now-line small">
                  <strong>Último estado:</strong>
                  <LevelTag level={dogNow.level} iconSize={12} />
                  <span>{shownMs != null ? endSentence(`No recibimos datos de ${dogName} desde ${whenPhrase(shownMs)}`) : null}</span>
                </div>
              ) : <>
                <div className="now-line small">
                  <strong>Ahora:</strong>
                  <StateTag level={dogNow.level} learning={learning} iconSize={12} />
                  <span>{dogNow.phrase}</span>
                  <span className="small muted"><DataTime freshness={freshness} shownMs={shownMs} /></span>
                </div>
                {/* Two levels on one page, each said for what it is; the note hangs under «Ahora». */}
                <p className="now-note">El nivel de la alerta es el más alto que alcanzó; «Ahora» es cómo está {dogName} en este momento.</p>
              </>}
            </div>
          )}
        </section>

        <div className="alert-cols">
          <div className="alert-main">
            <div className="bezel">
              <section className="panel stack-sm alert-why" aria-labelledby="why" style={levelVars(alert.severity)}>
                <h2 className="section-title" id="why">Qué lo originó</h2>
                <ul className="reason-list" style={levelVars(alert.severity)}>{causes.map((r) => <ReasonRow key={r.code} r={r} color={LEVELS[alert.severity].color} ended={!!end || !reasonHolds(r, dogNow)} />)}</ul>
                {context.length > 0 && <p className="alert-context"><Icon name="info" size={14} />{contextLine(context)}</p>}
              </section>
            </div>

            {reason && <EpisodeChart alert={alert} reason={reason} viewer={viewer} dogName={dogName} cfg={cfg} activityMean={dog?.baseline?.activeRatioMean ?? null} />}
          </div>

          <div className="alert-side stack">
            <section className="panel stack-sm" aria-labelledby="todo">
              <h2 className="section-title" id="todo">Qué puedes hacer</h2>
              <ul className="todo-list">{whatToDo(alert.reasons, dogName, cfg, { endedAtMs: end, severity: alert.severity }).map((t) => <li key={t}>{t}</li>)}</ul>
            </section>

            {msg && <Callout kind="error">{msg}</Callout>}
            {!open && (
              <p ref={reviewedRef} tabIndex={-1} role="status" className={justReviewed ? "small muted reviewed-line appear" : "small muted reviewed-line"}>
                <Icon name="check-circle" size={14} />{endSentence(`Revisada${ackMs ? ` ${whenPhrase(ackMs)}` : ""}`)}
              </p>
            )}
            <div className="row">
              {open && <button type="button" className="btn btn-primary" onClick={markReviewed} disabled={busy}><Icon name="check-circle" />{busy ? "Guardando…" : "Marcar como revisada"}</button>}
              {canUndo && <button type="button" className="btn btn-secondary" onClick={undoReview} disabled={busy}>{busy ? "Deshaciendo…" : "Deshacer"}</button>}
              {!open && justReviewed && <Link className="btn btn-secondary" to="/alertas">Volver a Alertas</Link>}
              <Link className="btn btn-secondary" to={`/perros/${alert.dogId}/veterinario`}><Icon name="stethoscope" />Vista para el veterinario</Link>
            </div>
          </div>
        </div>
        <Notice />
      </div>
    </main>
  );
}
