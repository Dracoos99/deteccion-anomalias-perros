/* Screen 2 · Inicio: one card per dog, live from dogs.status, with a banner when an alert is open.
   Screen 9 · Primer uso: until one of the owner's dogs has data, a three-step guide leads from the account
   to registering the dog and loading its data. */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { DogCard } from "../components/DogCard";
import { Callout, EmptyState, Icon, Notice, PageHead, Skeleton, useNow, usePageTitle } from "../components/ui";
import { useDogs, useFusionConfig, useOpenAlerts, type Alert, type Dog } from "../data/hooks";
import { freshness } from "../lib/live";
import { byAttention, homeSummary } from "../lib/plain";

const HIDE_KEY = (uid: string) => `onboarding-hidden:${uid}`;

function readHidden(uid: string): boolean {
  try { return localStorage.getItem(HIDE_KEY(uid)) === "1"; } catch { return false; }
}

function Onboarding({ dogs, onHide }: { dogs: Dog[]; onHide: (() => void) | null }) {
  const hasDog = dogs.length > 0;
  const waiting = dogs.find((d) => !d.status);
  const steps = [
    { title: "Crea tu cuenta", text: "Listo.", done: true, action: null },
    {
      title: "Registra a tu perro", text: "Su nombre y, si quieres, raza, peso y fecha de nacimiento.", done: hasDog,
      action: <Link className="btn btn-primary btn-sm" to="/perros/nuevo"><Icon name="plus" size={14} />Registrar a mi perro</Link>,
    },
    {
      title: "Conecta sus datos",
      text: "Sube un archivo CSV con las lecturas de su sensor. Si solo quieres probar, en la página de carga hay un archivo de ejemplo.",
      done: false,
      action: <Link className="btn btn-primary btn-sm" to={`/perfil/datos${waiting ? `?perro=${waiting.id}` : ""}`}><Icon name="upload" size={14} />Cargar datos</Link>,
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <section className="panel stack-sm onboarding-panel" aria-labelledby="onb-title">
      <div className="row-between">
        <h2 className="section-title" id="onb-title">{hasDog ? "Un paso más para empezar" : "Todavía no registras perros"}</h2>
        {onHide && <button className="btn btn-ghost btn-sm" type="button" onClick={onHide}><Icon name="x" size={14} />Ocultar guía</button>}
      </div>
      <p className="small muted">
        {hasDog ? "Cuando lleguen los primeros datos, aquí verás cómo está respecto a su patrón normal."
          : "Registra a tu perro para empezar. Cuando lleguen sus primeros datos, aquí verás cómo está."}
      </p>
      <ol className="onboarding">
        {steps.map((s, i) => (
          <li key={s.title} data-done={s.done} aria-current={i === current ? "step" : undefined}>
            <span className="step-num">{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
            <div className="onboarding-text">
              <strong>{s.title}</strong>
              <span className="small muted">{s.text}</span>
              {i === current && s.action && <div>{s.action}</div>}
            </div>
          </li>
        ))}
      </ol>
      <p className="xs muted">El sistema aprende el patrón normal de tu perro con sus primeros datos.</p>
    </section>
  );
}

export function Home() {
  const { user, isAdmin } = useAuth();
  usePageTitle("Tus perros");
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dogs, loading, error } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const { data: cfg } = useFusionConfig();
  const { data: open, loading: openLoading } = useOpenAlerts(viewer);
  const [hidden, setHidden] = useState(() => readHidden(user!.uid));
  const now = useNow(5000);
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
  // Cards: the dogs that need a look first, in the order they had when the page
  // opened. With live data a level can change every few seconds, and cards that move while the owner reads them are
  // disorienting; a dog added later goes after the others. The summary above keeps updating.
  const ids = sorted.map((d) => d.id).join(",");
  const orderRef = useRef<string[]>([]);
  const order = useMemo(() => {
    const kept = orderRef.current.filter((id) => sorted.some((d) => d.id === id));
    const added = byAttention(sorted.filter((d) => !kept.includes(d.id)).map((d) => ({ id: d.id, name: d.name, level: d.status?.level ?? null })));
    return [...kept, ...added.map((d) => d.id)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  orderRef.current = order;
  const cards = order.map((id) => sorted.find((d) => d.id === id)!).filter(Boolean);
  const isStale = (d: Dog) => !!d.status && freshness(d.status.lastBlockAt?.toMillis?.() ?? null, d.status.updatedAt?.toMillis?.() ?? null, now) === "stale";
  const summary = homeSummary(sorted.map((d) => ({
    name: d.name, level: d.status?.level ?? null, learning: !d.baseline, stale: isStale(d), openAlert: newestOpen.has(d.id),
  })));
  const anyData = sorted.some((d) => d.status);
  // The guide shows until a dog has data; with dogs registered it can be hidden (without dogs it is the empty state).
  const showGuide = !isAdmin && !loading && !anyData && (!sorted.length || !hidden);
  const hide = () => { try { localStorage.setItem(HIDE_KEY(user!.uid), "1"); } catch { /* not stored */ } setHidden(true); };
  return (
    <main className="page" id="main">
      {/* The summary line keeps its place while loading, so the cards below do not jump when it arrives. */}
      <PageHead title="Tus perros" sub={loading ? "Cargando tus perros…" : summary ?? "Aquí verás cómo están tus perros respecto a su patrón normal."} />
      <div className="stack">
        <Notice />
        {error && <Callout kind="error">No pudimos cargar tus perros. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {showGuide && <Onboarding dogs={sorted} onHide={sorted.length ? hide : null} />}
        {isAdmin && !loading && !sorted.length && <EmptyState title="Todavía no hay perros" text="Los perros de la demostración se crean con el seed o el bootstrap." />}
        {loading ? (
          <div className="grid-cards" aria-busy="true"><Skeleton className="skeleton-card" /><Skeleton className="skeleton-card" lines={[35, 50, 100]} /></div>
        ) : sorted.length > 0 && (
          <div className="grid-cards">{cards.map((d) => {
            const a = newestOpen.get(d.id);
            return <DogCard key={d.id} dog={d} cfg={cfg} openAlert={a} alertIsNew={!!a && !!openAtLoad.current && !openAtLoad.current.has(a.id)} />;
          })}</div>
        )}
      </div>
    </main>
  );
}
