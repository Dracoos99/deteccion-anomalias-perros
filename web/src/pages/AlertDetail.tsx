/* Screen 4 · Detalle de la alerta: what happened in plain language, when and for how long, which variable
   caused it with its value and normal range, a mini chart of the episode, what the owner can do, and
   "Marcar como revisada". */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { MINUTE_TIER, collectSlots, collectTierSlots, dayKey, tierDocStart, toPoint } from "@shared/trends";
import type { AlertReason } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { RangeBar, TrendChart, type ChartPoint } from "../components/charts";
import { Callout, EmptyState, Icon, LEVELS, LevelTag, Notice, PageHead, PageLoading, fmtNum, levelVars, usePageTitle } from "../components/ui";
import { db } from "../firebase";
import { useAlert, useFusionConfig, useTierDocs, useTrendDocs, type Alert, type Viewer } from "../data/hooks";
import { COMPONENT_LABEL, alertTitle, durationText, primaryReason, reasonUnit, whatToDo, whenText } from "../lib/plain";
import { alertStartMs } from "./AlertsPage";

const MARGIN_MS = 30 * 60_000;

/** "hoy a las 9:05 a. m." or "el 2 oct. 2026, 9:05 a. m.", to follow a verb ("Empezó …", "Revisada …"). */
const whenPhrase = (ms: number) => { const w = whenText(ms); return /^(hoy|ayer)/.test(w) ? w : `el ${w}`; };

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
        <p className="small" style={{ margin: "4px 0 0" }}>{r.message}</p>
      </div>
    </li>
  );
}

/** The primary variable around the episode, from the 1-minute slots; older data only have 5-minute ones. */
function EpisodeChart({ alert, reason, viewer }: { alert: Alert; reason: AlertReason; viewer: Viewer }) {
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.() ?? start + MARGIN_MS;
  const from = start - MARGIN_MS, to = end + MARGIN_MS;
  const { data: minuteDocs } = useTierDocs(MINUTE_TIER, alert.dogId, viewer, tierDocStart(MINUTE_TIER, from), to);
  const { data: docs } = useTrendDocs(alert.dogId, viewer, dayKey(from));
  const minute = collectTierSlots(minuteDocs, from, to);
  const fine = minute.length >= 2;
  const pick = reason.component === "temperature" ? "temp" : reason.component === "heart_rate" ? "hr" : "activity";
  const band = reason.normalRange;
  const points: ChartPoint[] = (fine ? minute : collectSlots(docs, from, to)).map(toPoint).flatMap((p) => {
    const raw = p[pick];
    const v = raw == null ? null : pick === "activity" ? 100 * raw : raw;
    return v == null ? [] : [{ t: p.t, v, mark: v < band[0] || v > band[1] }];
  });
  if (points.length < 2) return null;
  const { unit, decimals } = reasonUnit(reason);
  const title = reason.component === "temperature" ? "Temperatura" : reason.component === "heart_rate" ? "Frecuencia cardiaca" : "Tiempo en movimiento";
  return (
    <section className="panel">
      <TrendChart title={title} sub={`Antes, durante y después del aviso (promedios de ${fine ? "1 minuto" : "5 minutos"})`} rangeKey="1h" unit={unit}
        decimals={decimals} points={points} band={band} legendBand="Rango normal" legendMarks="Fuera de lo normal" height={170} gapMs={fine ? 180_000 : 900_000} showLast={!alert.endedAt} />
    </section>
  );
}

export function AlertDetail() {
  const { alertId } = useParams();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: alert, loading, error } = useAlert(alertId);
  usePageTitle(alert ? `${alert.dogName}: ${alertTitle(alert.reasons).toLowerCase()}` : "Alerta");
  const { data: cfg } = useFusionConfig();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (loading) return <PageLoading text="Cargando la alerta…" maxWidth={860} />;
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
    setBusy(true); setMsg(null);
    try {
      await updateDoc(doc(db, "alerts", alert.id), { status: "acknowledged", acknowledgedBy: user!.uid, acknowledgedAt: serverTimestamp() });
    } catch {
      setMsg("No pudimos guardar el cambio. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" id="main" style={{ maxWidth: 860 }}>
      <nav className="crumbs" aria-label="Ruta"><Link to="/alertas">Alertas</Link><span aria-hidden="true">›</span><Link to={`/perros/${alert.dogId}`}>{alert.dogName}</Link></nav>
      <PageHead kicker={alert.dogName} title={alertTitle(alert.reasons)} />
      <div className="stack">
        <section className="panel stack-sm" aria-label="Cuándo pasó">
          <div className="row">
            <LevelTag level={alert.severity} />
            <span className={open ? "tag tag-open" : "tag tag-done"}>{open ? "Sin revisar" : "Revisada"}</span>
          </div>
          <p className="small">
            Empezó <strong>{whenPhrase(start)}</strong>{end
              ? <> y duró <strong>{durationText(end - start)}</strong>.</>
              : <> y todavía continúa (o aún no llegan datos nuevos).</>}
          </p>
        </section>

        <section className="panel stack-sm" aria-labelledby="why">
          <h2 className="section-title" id="why">Qué lo originó</h2>
          <ul className="reason-list" style={levelVars(alert.severity)}>{reasons.map((r) => <ReasonRow key={r.code} r={r} color={LEVELS[alert.severity].color} />)}</ul>
        </section>

        {reason && <EpisodeChart alert={alert} reason={reason} viewer={viewer} />}

        <section className="panel stack-sm" aria-labelledby="todo">
          <h2 className="section-title" id="todo">Qué puedes hacer</h2>
          <ul className="todo-list">{whatToDo(alert.reasons, alert.dogName, cfg).map((t) => <li key={t}>{t}</li>)}</ul>
        </section>

        {msg && <Callout kind="error">{msg}</Callout>}
        {!open && (
          <p className="small muted reviewed-line"><Icon name="check-circle" size={14} />Revisada{alert.acknowledgedAt?.toMillis?.() ? ` ${whenPhrase(alert.acknowledgedAt.toMillis())}` : ""}.</p>
        )}
        <div className="row">
          {open && <button type="button" className="btn btn-primary" onClick={markReviewed} disabled={busy}><Icon name="check-circle" />{busy ? "Guardando…" : "Marcar como revisada"}</button>}
          <Link className="btn btn-secondary" to={`/perros/${alert.dogId}/veterinario`}><Icon name="stethoscope" />Vista para el veterinario</Link>
        </div>
        <Notice />
      </div>
    </main>
  );
}
