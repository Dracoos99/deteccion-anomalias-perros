/* Screen 2 · Inicio as a dashboard: four figures at the top (every dog, those in «Todo normal», the new
   alerts and those without data), a toolbar (search by name, filter by state, «Registrar perro») and one card per dog,
   live from dogs.status. A dog without recent data is grey («Sin datos»), never «Todo normal».
   Screen 9 · Primer uso: until one of the owner's dogs has data, a three-step guide leads from the account
   to registering the dog and loading its data. */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { DogCard } from "../components/DogCard";
import { Callout, EmptyState, Icon, Notice, PageHead, Seg, useNow, usePageTitle } from "../components/ui";
import { openCountText, useDogs, useFusionConfig, useOpenAlerts, type Alert, type Dog } from "../data/hooks";
import { dashboardKpis, matchesFilter, matchesSearch, type DogFilter, type DogView } from "../lib/dashboard";
import { freshness } from "../lib/live";
import { FROM_HOME } from "../lib/nav";
import { usePlayful } from "../lib/theme";
import { attentionOrder, describeDog, isLearning, type HeldRanks } from "../lib/plain";

const HIDE_KEY = (uid: string) => `onboarding-hidden:${uid}`;

function readHidden(uid: string): boolean {
  try { return localStorage.getItem(HIDE_KEY(uid)) === "1"; } catch { return false; }
}

function Onboarding({ dogs, onHide }: { dogs: Dog[]; onHide: (() => void) | null }) {
  const hasDog = dogs.length > 0;
  const playful = usePlayful();
  const waiting = dogs.find((d) => !d.status);
  const steps = [
    { title: "Crea tu cuenta", text: "Listo.", done: true, action: null },
    {
      title: "Registra a tu perro", text: "Su nombre y, si quieres, raza, peso y fecha de nacimiento.", done: hasDog,
      action: <Link className="btn btn-primary btn-lg" to={`/perros/nuevo?${FROM_HOME}`}><Icon name="plus" />Registrar a mi perro</Link>,
    },
    {
      title: "Conecta sus datos",
      text: "Sube un archivo CSV con las lecturas de su sensor. Si solo quieres probar, en la página de carga hay un archivo de ejemplo.",
      done: false,
      action: <Link className="btn btn-primary btn-lg" to={`/perfil/datos?${waiting ? `perro=${waiting.id}&` : ""}${FROM_HOME}`}><Icon name="upload" />Cargar datos</Link>,
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  const primary = steps[current]?.action ?? null;
  return (
    <div className="bezel welcome-bezel">
      <section className="panel onboarding-panel welcome" aria-labelledby="onb-title">
        <div className="welcome-main">
          <h2 className="welcome-title" id="onb-title">{hasDog ? "Un paso más para empezar" : playful ? "¡El parque está vacío!" : "Todavía no registras perros"}</h2>
          <p className="welcome-text">
            {hasDog ? "Cuando lleguen los primeros datos, aquí verás cómo está respecto a su patrón normal."
              : "Registra a tu perro para empezar. Cuando lleguen sus primeros datos, aquí verás cómo está."}
          </p>
          {(primary || onHide) && (
            <div className="welcome-cta">
              {primary}
              {onHide && <button className="btn btn-ghost" type="button" onClick={onHide}><Icon name="x" size={14} />Ocultar guía</button>}
            </div>
          )}
        </div>
        <ol className="onboarding">
          {steps.map((s, i) => (
            <li key={s.title} data-done={s.done} aria-current={i === current ? "step" : undefined}>
              <span className="step-num">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
              <div className="onboarding-text">
                <strong>{s.title}</strong>
                <span className="small muted">{s.text}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="welcome-note">El sistema aprende el patrón normal de tu perro con sus primeros datos.</p>
      </section>
    </div>
  );
}

type Tone = "neutral" | "green" | "amber" | "red";

/** One figure of the top bar: its icon, the number and what it counts. The colour of a state goes with its icon and words. */
function Kpi({ icon, label, value, tone }: { icon: string; label: string; value: number | string; tone: Tone }) {
  return (
    <div className="kpi" data-tone={tone}>
      <span className="kpi-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <span className="kpi-body">
        <span className="kpi-value">{value}</span>
        <span className="kpi-label">{label}</span>
      </span>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="kpis" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => <div key={i} className="kpi kpi-loading"><span className="skeleton kpi-skel-icon" /><span className="kpi-body"><span className="skeleton kpi-skel-value" /><span className="skeleton kpi-skel-label" /></span></div>)}
    </div>
  );
}

const FILTERS: { value: DogFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "alert", label: "En alerta" },
  { value: "nodata", label: "Sin datos" },
];

export function Home() {
  const { user, isAdmin } = useAuth();
  usePageTitle("Inicio");
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dogs, loading, error } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const { data: cfg } = useFusionConfig();
  const { data: openAll, loading: openLoading } = useOpenAlerts(viewer);
  const [hidden, setHidden] = useState(() => readHidden(user!.uid));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DogFilter>("all");
  const now = useNow(5000);
  // An archived dog's alerts leave the count, as in the badge of Alertas.
  const open = loading ? openAll : openAll.filter((a) => dogs.some((d) => d.id === a.dogId));
  // Alerts open when the page loaded arrive with their cards; only one that opens while the owner looks eases in.
  const openAtLoad = useRef<Set<string> | null>(null);
  if (!openLoading && openAtLoad.current == null) openAtLoad.current = new Set(open.map((a) => a.id));
  const newestOpen = useMemo(() => {
    const m = new Map<string, Alert>();
    for (const a of open) {
      const t = a.createdAt?.toMillis?.() ?? 0, prev = m.get(a.dogId);
      if (!prev || t > (prev.createdAt?.toMillis?.() ?? 0)) m.set(a.dogId, a);
    }
    return m;
  }, [open]);
  const sorted = [...dogs].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const isStale = (d: Dog) => !!d.status && freshness(d.status.lastBlockAt?.toMillis?.() ?? null, d.status.updatedAt?.toMillis?.() ?? null, now, d.status.lastSource) === "stale";
  const levelOf = (d: Dog) => {
    const a = newestOpen.get(d.id);
    const sum = describeDog(d.status, d.baseline, cfg, undefined, !!a && !a.endedAt, { key: d.id });
    const stale = isStale(d);
    return {
      name: d.name, level: sum.level, slight: sum.slight, learning: isLearning(d.status, d.baseline), stale,
      sensorOff: !stale && d.status?.sensor === "no_wear", openAlert: !!a, alertEnded: !!a?.endedAt,
    };
  };
  const views: DogView[] = sorted.map((d) => {
    const l = levelOf(d);
    return { id: d.id, name: d.name, hasData: !!d.status, level: d.status ? l.level : null, learning: l.learning, stale: l.stale, sensorOff: l.sensorOff, openAlert: l.openAlert };
  });
  const viewOf = new Map(views.map((v) => [v.id, v]));
  const kpis = dashboardKpis(views, open.length);
  const alertTone: Tone = !open.length ? "neutral" : open.some((a) => a.severity === "red") ? "red" : "amber";
  // Cards: the dogs that need a look first, with their new alerts, once both have arrived. A dog that starts to
  // need a look moves up at once; one that needs it less keeps its place for a while.
  const ready = !loading && !openLoading;
  const held = useRef<HeldRanks>(new Map());
  const ranked = ready ? attentionOrder(sorted.map((d) => ({ id: d.id, ...levelOf(d) })), held.current, now) : null;
  if (ranked) held.current = ranked.held;
  const cards = (ranked?.ids ?? []).map((id) => sorted.find((d) => d.id === id)!).filter(Boolean)
    .filter((d) => matchesSearch(d.name, search) && matchesFilter(viewOf.get(d.id)!, filter));
  const anyData = sorted.some((d) => d.status);
  // The guide shows until a dog has data; with dogs registered it can be hidden (without dogs it is the whole page).
  const showGuide = !isAdmin && !loading && !anyData && (!sorted.length || !hidden);
  const hide = () => { try { localStorage.setItem(HIDE_KEY(user!.uid), "1"); } catch { /* not stored */ } setHidden(true); };
  // One card leads the grid, the first that needs a look, or the only dog once it has a normal
  // pattern and recent data.
  const needsLook = (d: Dog) => { const c = levelOf(d); return !c.stale && !c.learning && (c.level === "amber" || c.level === "red" || c.openAlert); };
  const only = sorted.length === 1 ? levelOf(sorted[0]) : null;
  const featuredId = cards.find(needsLook)?.id ?? (only && sorted[0].status && !only.learning && !only.stale ? sorted[0].id : null);
  const firstScored = featuredId ?? cards.find((d) => d.status && !isLearning(d.status, d.baseline) && !isStale(d))?.id;
  const filtered = !!search.trim() || filter !== "all";
  const noDogs = ready && !sorted.length;
  return (
    <main className="page page-home" id="main">
      <div className="page-intro">
        <PageHead title="Inicio" sub={isAdmin ? "Todos los perros de la plataforma, de un vistazo." : "Así están tus perros ahora."} hero />
        <Notice />
      </div>
      <div className="stack">
        {error && <Callout kind="error">No pudimos cargar tus perros. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {!ready ? (
          <>
            <KpiSkeleton />
            <div className="dash-tools" aria-hidden="true"><span className="skeleton dash-skel-search" /><span className="skeleton dash-skel-filter" /></div>
            <div className="grid-cards" aria-busy="true"><div className="panel skeleton-card"><span className="skeleton" style={{ display: "block", height: 22, width: "45%" }} /></div><div className="panel skeleton-card"><span className="skeleton" style={{ display: "block", height: 22, width: "35%" }} /></div></div>
            <p className="sr-only" role="status">Cargando tus perros…</p>
          </>
        ) : noDogs ? (
          isAdmin ? <EmptyState title="Todavía no hay perros" text="Los perros de la demostración se crean con el seed o el bootstrap." /> : <Onboarding dogs={sorted} onHide={null} />
        ) : (
          <>
            <section className="kpis" aria-label="Resumen">
              <Kpi icon="paw" label="Total de perros" value={kpis.total} tone="neutral" />
              <Kpi icon="check-circle" label="En estado normal" value={kpis.normal} tone={kpis.normal ? "green" : "neutral"} />
              <Kpi icon={alertTone === "red" ? "alert-octagon" : "alert-triangle"} label={kpis.alerts === 1 ? "Alerta activa" : "Alertas activas"} value={openCountText(kpis.alerts, openAll.length)} tone={alertTone} />
              <Kpi icon="wifi-off" label="Sin datos recientes" value={kpis.nodata} tone="neutral" />
            </section>
            {showGuide && <Onboarding dogs={sorted} onHide={hide} />}
            <div className="dash-tools">
              <div className="dash-search">
                <Icon name="search" size={16} />
                <input id="dog-search" className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por nombre" aria-label="Buscar un perro por su nombre" autoComplete="off" />
              </div>
              <Seg options={FILTERS} value={filter} onChange={setFilter} label="Filtrar por estado" />
              <Link className={showGuide ? "btn btn-secondary dash-add" : "btn btn-primary dash-add"} to="/perros/nuevo"><Icon name="plus" />Registrar perro</Link>
            </div>
            {filtered && <p className="small muted dash-count" role="status">{cards.length === 1 ? "1 perro" : `${cards.length} perros`} de {sorted.length}</p>}
            {cards.length ? (
              <div className="grid-cards">{cards.map((d) => {
                const a = newestOpen.get(d.id);
                return <DogCard key={d.id} dog={d} cfg={cfg} openAlert={a} alertIsNew={!!a && !!openAtLoad.current && !openAtLoad.current.has(a.id)}
                  scoreNote={d.id === firstScored} featured={d.id === featuredId} />;
              })}</div>
            ) : (
              <div className="dash-empty">
                <EmptyState icon="search" title="Ningún perro coincide" text={filter === "alert" ? "Ningún perro está en alerta ahora." : filter === "nodata" ? "Todos los perros tienen datos recientes." : "Revisa el nombre o borra la búsqueda."}
                  action={<button type="button" className="btn btn-secondary" onClick={() => { setSearch(""); setFilter("all"); }}>Ver todos</button>} />
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
