/* Screen 4 · Detalle de la alerta: what happened in plain language, when and for how long, which variable
   caused it with its value and normal range, a mini chart of the episode, what the owner can do, and
   "Marcar como revisada". */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { collectSlots, dayKey, toPoint } from "@shared/trends";
import type { AlertReason } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { RangeBar, TrendChart, type ChartPoint } from "../components/charts";
import { Callout, EmptyState, Icon, LevelTag, Notice, PageHead, fmtNum } from "../components/ui";
import { db } from "../firebase";
import { useAlert, useFusionConfig, useTrendDocs, type Alert, type Viewer } from "../data/hooks";
import { COMPONENT_LABEL, alertTitle, dateTimeText, durationText, primaryReason, reasonUnit, whatToDo } from "../lib/plain";
import { alertStartMs } from "./AlertsPage";

const MARGIN_MS = 30 * 60_000;

function ReasonRow({ r }: { r: AlertReason }) {
  const { unit, decimals } = reasonUnit(r);
  const [lo, hi] = r.normalRange;
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
        <RangeBar value={r.value} range={[lo, hi]} scale={[Math.max(0, scale[0]), scale[1]]} unit={unit} decimals={decimals} />
        <p className="small" style={{ margin: "4px 0 0" }}>{r.message}</p>
      </div>
    </li>
  );
}

/** The primary variable around the episode, from the 5-minute trend slots. */
function EpisodeChart({ alert, reason, viewer }: { alert: Alert; reason: AlertReason; viewer: Viewer }) {
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.() ?? start + MARGIN_MS;
  const from = start - MARGIN_MS, to = end + MARGIN_MS;
  const { data: docs } = useTrendDocs(alert.dogId, viewer, dayKey(from));
  const pick = reason.component === "temperature" ? "temp" : reason.component === "heart_rate" ? "hr" : "activity";
  const band = reason.normalRange;
  const points: ChartPoint[] = collectSlots(docs, from, to).map(toPoint).flatMap((p) => {
    const raw = p[pick];
    const v = raw == null ? null : pick === "activity" ? 100 * raw : raw;
    return v == null ? [] : [{ t: p.t, v, mark: v < band[0] || v > band[1] }];
  });
  if (points.length < 2) return null;
  const { unit, decimals } = reasonUnit(reason);
  const title = reason.component === "temperature" ? "Temperatura" : reason.component === "heart_rate" ? "Frecuencia cardiaca" : "Tiempo en movimiento";
  return (
    <section className="panel">
      <TrendChart title={title} sub="Antes, durante y después del aviso (promedios de 5 minutos)" rangeKey="1h" unit={unit} decimals={decimals}
        points={points} band={band} legendBand="Rango normal" legendMarks="Fuera de lo normal" height={170} />
    </section>
  );
}

export function AlertDetail() {
  const { alertId } = useParams();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: alert, loading, error } = useAlert(alertId);
  const { data: cfg } = useFusionConfig();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (loading) return <div className="boot" aria-busy="true">Cargando…</div>;
  if (error || !alert) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos esta alerta" text="Puede que la dirección no sea correcta o que no tengas acceso."
          action={<Link className="btn btn-secondary" to="/alertas">Ir a Alertas</Link>} />
      </main>
    );
  }
  const reason = primaryReason(alert.reasons);
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
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <LevelTag level={alert.severity} />
            <span className={open ? "tag tag-open" : "tag tag-done"}>{open ? "Sin revisar" : "Revisada"}</span>
          </div>
          <p style={{ margin: 0 }}>
            Empezó el <strong>{dateTimeText(start)}</strong>{end
              ? <> y duró <strong>{durationText(end - start)}</strong>.</>
              : <>. Todavía no termina (o aún no llegan datos nuevos).</>}
          </p>
        </section>

        <section className="panel stack-sm" aria-labelledby="why">
          <h2 className="section-title" id="why">Qué lo originó</h2>
          <ul className="reason-list">{alert.reasons.map((r) => <ReasonRow key={r.code} r={r} />)}</ul>
        </section>

        {reason && <EpisodeChart alert={alert} reason={reason} viewer={viewer} />}

        <section className="panel stack-sm" aria-labelledby="todo">
          <h2 className="section-title" id="todo">Qué puedes hacer</h2>
          <ul className="todo-list">{whatToDo(alert.reasons, alert.dogName, cfg).map((t) => <li key={t}>{t}</li>)}</ul>
        </section>

        {msg && <Callout kind="error">{msg}</Callout>}
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {open
            ? <button type="button" className="btn btn-primary" onClick={markReviewed} disabled={busy}><Icon name="check-circle" />{busy ? "Guardando…" : "Marcar como revisada"}</button>
            : <span className="small muted"><Icon name="check-circle" size={14} /> Revisada{alert.acknowledgedAt?.toMillis?.() ? ` el ${dateTimeText(alert.acknowledgedAt.toMillis())}` : ""}.</span>}
          <Link className="btn btn-secondary" to={`/perros/${alert.dogId}/veterinario`}><Icon name="stethoscope" />Vista para el veterinario</Link>
        </div>
        <Notice />
      </div>
    </main>
  );
}
