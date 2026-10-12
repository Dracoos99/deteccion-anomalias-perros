/* A3 · Blind expert review: a queue of stretches, alert episodes mixed with control stretches
   without alert, each with its charts and without the system's verdict; the reviewer says whether there is a relevant
   deviation from the dog's normal pattern, and the page computes Cohen's kappa between the system and the reviewer. */
import { useMemo, useState } from "react";
import { collection, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch, type Timestamp } from "firebase/firestore";
import { MINUTE_TIER, collectSlots, collectTierSlots, dayKey, slotStartMs, tierDocStart } from "@shared/trends";
import type { ExpertReviewItem } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { db } from "../firebase";
import { TrendChart } from "../components/charts";
import { Callout, EmptyState, Icon, PageFrame, PageHead, fmtNum, usePageTitle } from "../components/ui";
import { useDog, useDogs, useFusionConfig, useReviewItems, useTierDocs, useTrendDocs, type Dog, type ReviewItem } from "../data/hooks";
import { activityBand, alertStartMs, glueTime, hrBand } from "../lib/plain";
import { alertWindow, cohenKappa, controlWindows, kappaText, shuffledOrder, type Verdict } from "../lib/review";

const QUEUE_ALERTS = 60;
const GOAL_ALERTS = 50;
const range = (from: number, to: number) => {
  const d = new Date(from).toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric" });
  const t = (ms: number) => glueTime(new Date(ms).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" }));
  return `${d}, ${t(from)} – ${t(to)}`;
};

export function ReviewPage() {
  usePageTitle("Revisión experta");
  const { user } = useAuth();
  const { data: items, loading } = useReviewItems();
  const { data: dogs } = useDogs({ kind: "all" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sorted = useMemo(() => [...items].sort((a, b) => a.order - b.order), [items]);
  const next = sorted.find((it) => !it.review);
  const kappa = cohenKappa(sorted.map((it) => ({ system: it.systemFlagged, verdict: it.review?.verdict })));
  const alertsReviewed = sorted.filter((it) => it.kind === "alert" && it.review && it.review.verdict !== "unsure").length;
  const done = sorted.filter((it) => it.review).length;
  // The agreement, and anything that depends on what the system said, shows only once every stretch of
  // the queue has an answer; before that it would tell the reviewer whether the stretch just answered was an alert.
  const complete = sorted.length > 0 && done === sorted.length;
  const controls = sorted.filter((it) => it.kind === "control").length;

  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      await buildQueue(user!.uid, dogs, new Set(items.flatMap((it) => (it.alertId ? [it.alertId] : []))), items.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo preparar la cola.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageFrame>
      <PageHead title="Revisión experta"
        sub="Tramos de datos mezclados, unos con alerta y otros sin ella, sin decir cuál es cuál. Quien revisa decide si ve una desviación relevante del patrón normal; la página calcula el acuerdo con el sistema." />
      <div className="stack">
        <section className="panel stack-sm" aria-labelledby="kappa-title">
          <h2 className="panel-title" id="kappa-title">Acuerdo con el sistema</h2>
          <div className="review-stats">
            <p><span className="review-num">{done}</span><span className="xs muted">de {sorted.length} tramos revisados</span></p>
            {complete && <p><span className="review-num">{alertsReviewed}</span><span className="xs muted">alertas con respuesta (meta: {GOAL_ALERTS})</span></p>}
            {complete && <p><span className="review-num">{kappa.kappa == null ? "—" : fmtNum(kappa.kappa, 2)}</span><span className="xs muted">kappa de Cohen · {kappaText(kappa.kappa)} (meta: 0.60)</span></p>}
          </div>
          {!complete && sorted.length > 0 && <p className="small muted">El acuerdo con el sistema se muestra cuando todos los tramos de la cola tengan respuesta: antes diría si el tramo que acabas de responder tenía alerta.</p>}
          {sorted.length > 0 && controls === 0 && <div className="callout"><Icon name="alert-triangle" size={16} /><div>La cola no tiene tramos sin alerta, así que el kappa no se puede calcular. Hacen falta perros con datos lejos de sus alertas.</div></div>}
          {complete && kappa.n > 0 && (
            <table className="table review-table">
              <caption className="sr-only">Tabla de acuerdo entre el sistema y quien revisa</caption>
              <thead><tr><th scope="col" /><th scope="col">Revisión: sí</th><th scope="col">Revisión: no</th></tr></thead>
              <tbody>
                <tr><th scope="row">Sistema: alerta</th><td className="num">{kappa.table.yy}</td><td className="num">{kappa.table.yn}</td></tr>
                <tr><th scope="row">Sistema: sin alerta</th><td className="num">{kappa.table.ny}</td><td className="num">{kappa.table.nn}</td></tr>
              </tbody>
            </table>
          )}
          {complete && <p className="xs muted">Acuerdo observado {fmtNum(100 * kappa.po)} %, esperado por azar {fmtNum(100 * kappa.pe)} %{kappa.unsure ? `; ${kappa.unsure} ${kappa.unsure === 1 ? "respuesta «No estoy seguro» queda" : "respuestas «No estoy seguro» quedan"} fuera del cálculo` : ""}.</p>}
          <p className="xs muted">Meta de la tesis: kappa de 0.60 o más con al menos {GOAL_ALERTS} alertas revisadas a ciegas por un veterinario independiente.</p>
        </section>

        {error && <Callout kind="error">{error}</Callout>}
        {loading ? <div className="skeleton" style={{ height: 240 }} /> : !sorted.length ? (
          <EmptyState icon="flask" title="Todavía no hay una cola de revisión"
            text={`Se toman hasta ${QUEUE_ALERTS} alertas y la misma cantidad de tramos de control sin alerta, de los perros con datos, y se mezclan.`}
            action={<button className="btn btn-primary" type="button" onClick={prepare} disabled={busy}><Icon name="play" />{busy ? "Preparando…" : "Preparar la cola"}</button>} />
        ) : next ? (
          <ReviewCard key={next.id} item={next} position={sorted.indexOf(next) + 1} total={sorted.length} uid={user!.uid} />
        ) : (
          <Callout kind="ok">Revisaste todos los tramos de la cola. Puedes agregar más con las alertas nuevas.</Callout>
        )}
        {sorted.length > 0 && (
          <div><button className="btn btn-secondary btn-sm" type="button" onClick={prepare} disabled={busy}>{busy ? "Agregando…" : "Agregar a la cola las alertas nuevas"}</button></div>
        )}
      </div>
    </PageFrame>
  );
}

/** One stretch to judge: the dog, the time, its movement, heart rate and temperature against its normal pattern. */
function ReviewCard({ item, position, total, uid }: { item: ReviewItem; position: number; total: number; uid: string }) {
  const { data: dog } = useDog(item.dogId);
  const { data: cfg } = useFusionConfig();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!verdict) return;
    setBusy(true); setError(null);
    try {
      await updateDoc(doc(db, "expertReviews", item.id), { review: { reviewerId: uid, verdict, notes: notes.trim(), reviewedAt: serverTimestamp() } });
      // the alert keeps its own expert review too.
      if (item.alertId) {
        await updateDoc(doc(db, "alerts", item.alertId), {
          expertReview: { reviewerId: uid, relevant: verdict === "unsure" ? null : verdict === "relevant", notes: notes.trim(), reviewedAt: serverTimestamp() },
        });
      }
    } catch {
      setError("No se pudo guardar la respuesta. Revisa tu conexión y tu rol.");
      setBusy(false);
    }
  };
  const name = dog?.name ?? item.dogName;
  return (
    <section className="panel stack-sm review-card" aria-labelledby="item-title">
      <div className="row-between">
        <h2 className="panel-title" id="item-title">Tramo {position} de {total} · {name}</h2>
        <span className="small muted">{range(item.fromMs, item.toMs)}</span>
      </div>
      {dog && <ReviewCharts dog={dog} cfg={cfg} fromMs={item.fromMs} toMs={item.toMs} />}
      <fieldset className="field fieldset-plain">
        <legend className="field-label">¿Ves en este tramo una desviación relevante respecto al patrón normal de {name}?</legend>
        <div className="review-verdicts">
          {([["relevant", "Sí"], ["not_relevant", "No"], ["unsure", "No estoy seguro"]] as const).map(([v, label]) => (
            <label key={v} className="check review-verdict" data-checked={verdict === v ? "true" : undefined}>
              <input type="radio" name="verdict" value={v} checked={verdict === v} onChange={() => setVerdict(v)} /><span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field"><label htmlFor="rv-notes">Notas (opcional)</label>
        <textarea id="rv-notes" className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Qué viste, en tus palabras" /></div>
      {error && <Callout kind="error">{error}</Callout>}
      <div><button className="btn btn-primary" type="button" onClick={save} disabled={!verdict || busy}><Icon name="check" />{busy ? "Guardando…" : "Guardar y seguir"}</button></div>
      <p className="xs muted">El tramo no dice si el sistema abrió una alerta: así la respuesta no depende de él.</p>
    </section>
  );
}

/** Movement (the engine's 20-minute average), heart rate (1-minute mean) and temperature of a stretch, from the
 * 1-minute slots, against the dog's normal bands. */
function ReviewCharts({ dog, cfg, fromMs, toMs }: { dog: Dog; cfg: ReturnType<typeof useFusionConfig>["data"]; fromMs: number; toMs: number }) {
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const docs = useTierDocs(MINUTE_TIER, dog.id, viewer, tierDocStart(MINUTE_TIER, fromMs), toMs);
  // A stretch without 1-minute slots uses the 5-minute ones, so an empty stretch never tells which kind it is.
  const days = useTrendDocs(dog.id, viewer, dayKey(fromMs - 86_400_000));
  const fine = collectTierSlots(docs.data, fromMs, toMs);
  const slots = fine.length ? fine : collectSlots(days.data, fromMs, toMs);
  const move = slots.flatMap(({ t, slot }) => {
    const v = slot.aeN ? (100 * (slot.aeSum ?? 0)) / slot.aeN : slot.w ? (100 * slot.act) / slot.w : null;
    return v == null ? [] : [{ t, v }];
  });
  const hr = slots.flatMap(({ t, slot }) => (slot.hrN ? [{ t, v: slot.hrSum / slot.hrN }] : []));
  const temp = slots.flatMap(({ t, slot }) => (slot.tN ? [{ t, v: slot.tSum / slot.tN }] : []));
  const a = activityBand(dog.baseline, cfg), h = hrBand(dog.baseline, cfg);
  const aPct: [number, number] | null = a && [100 * a[0], 100 * a[1]];
  // No point is marked «fuera de lo normal»: that is the system's reading, and the review is blind to it.
  const mark = (_band: [number, number] | null) => (p: { t: number; v: number }) => ({ ...p, mark: false });
  if (docs.loading || days.loading) return <div className="skeleton" style={{ height: 180 }} />;
  if (!slots.length) return <p className="small muted">No quedan datos de este tramo (los de más de 7 días pueden haber expirado).</p>;
  return (
    <div className="review-charts">
      <TrendChart title="Tiempo en movimiento" rangeKey="1h" unit="%" domain={[0, 100]} height={130} gapMs={180_000} points={move.map(mark(aPct))} band={aPct} legendBand="Lo normal para el perro" />
      {hr.length > 0 && <TrendChart title="Frecuencia cardiaca" rangeKey="1h" unit="lpm" height={130} gapMs={180_000} points={hr.map(mark(h))} band={h} legendBand="Lo normal para el perro" />}
      {temp.length > 0 && <TrendChart title="Temperatura" rangeKey="1h" unit="°C" decimals={1} height={130} gapMs={180_000} points={temp.map(mark(cfg.tempRange))} band={cfg.tempRange} legendBand="Lo normal para un perro" />}
    </div>
  );
}

/** Adds to the queue the alerts not yet in it and as many control stretches, in a shuffled order after the existing ones. */
async function buildQueue(uid: string, dogs: Dog[], queued: Set<string>, existing: number): Promise<void> {
  const snap = await getDocs(collection(db, "alerts"));
  const alerts = snap.docs.map((d) => ({ id: d.id, ...(d.data() as { dogId: string; dogName: string; startedAt?: Timestamp; createdAt?: Timestamp; endedAt?: Timestamp | null }) }));
  const fresh = alerts.filter((a) => !queued.has(a.id)).sort((a, b) => alertStartMs(b) - alertStartMs(a)).slice(0, QUEUE_ALERTS);
  if (!fresh.length) throw new Error("No hay alertas nuevas para revisar.");
  // Episodes of every alert (also the queued ones), so no control stretch touches an alert.
  const episodes = new Map<string, { fromMs: number; toMs: number }[]>();
  for (const a of alerts) {
    const w = alertWindow(alertStartMs(a), a.endedAt?.toMillis?.() ?? null, 0);
    episodes.set(a.dogId, [...(episodes.get(a.dogId) ?? []), w]);
  }
  // Data of every dog with data (not only those with alerts), last 30 days of each, from the 5-minute slots.
  const newest = Math.max(...fresh.map((a) => alertStartMs(a)));
  const dogIds = [...new Set([...fresh.map((a) => a.dogId), ...dogs.filter((d) => d.status).map((d) => d.id)])];
  const perDog = await Promise.all(dogIds.map(async (dogId) => {
    const own = fresh.filter((a) => a.dogId === dogId).map((a) => alertStartMs(a));
    const last = own.length ? Math.max(...own) : newest;
    const q = query(collection(db, "trends"), where("dogId", "==", dogId), where("day", ">=", dayKey(last - 30 * 86_400_000)));
    const docs = (await getDocs(q)).docs.map((d) => d.data() as { day: string; slots?: Record<string, { n: number }> });
    const slots = docs.flatMap((d) => Object.entries(d.slots ?? {}).filter(([, s]) => s.n > 0).map(([k]) => slotStartMs(d.day, Number(k))));
    return { dogId, slots, episodes: episodes.get(dogId) ?? [] };
  }));
  // The control stretches last what the alert stretches last.
  const lengthsMs = fresh.map((a) => { const w = alertWindow(alertStartMs(a), a.endedAt?.toMillis?.() ?? null); return w.toMs - w.fromMs; });
  const controls = controlWindows(perDog, fresh.length, { seed: existing + 7, lengthsMs });
  const nameOf = (id: string) => dogs.find((d) => d.id === id)?.name ?? fresh.find((a) => a.dogId === id)?.dogName ?? id;
  const items: Omit<ExpertReviewItem, "order">[] = [
    ...fresh.map((a) => ({ kind: "alert" as const, dogId: a.dogId, dogName: nameOf(a.dogId), alertId: a.id, systemFlagged: true, ...alertWindow(alertStartMs(a), a.endedAt?.toMillis?.() ?? null) })),
    ...controls.map((c) => ({ kind: "control" as const, dogId: c.dogId, dogName: nameOf(c.dogId), alertId: null, systemFlagged: false, fromMs: c.fromMs, toMs: c.toMs })),
  ];
  const order = shuffledOrder(items.length, existing + 11);
  const batch = writeBatch(db);
  items.forEach((it, i) => {
    batch.set(doc(collection(db, "expertReviews")), { ...it, order: existing + order[i], review: null, createdBy: uid, schemaVersion: 1, createdAt: serverTimestamp() });
  });
  await batch.commit();
}
