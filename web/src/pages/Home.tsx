/* Screen 2 · Inicio: one card per dog, live from dogs.status, with a banner when an alert is open.
   Screen 9 · Primer uso: until one of the owner's dogs has data, a three-step guide leads from the account
   to registering the dog and loading its data. */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { DogCard, DogGroup } from "../components/DogCard";
import { Callout, EmptyState, Icon, Notice, PageHead, Skeleton, levelVars, useNow, usePageTitle } from "../components/ui";
import { useDogs, useFusionConfig, useOpenAlerts, type Alert, type Dog } from "../data/hooks";
import { freshness } from "../lib/live";
import { FROM_HOME } from "../lib/nav";
import { attentionOrder, describeDog, homeSummary, isLearning, scoreNote, shownScore, type HeldRanks } from "../lib/plain";

/** How many dogs without data share one group on Inicio instead of one card each. */
const GROUP_MIN = 3;
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
  // A welcome, not a card with a list. The title is display type and the one main step is a large pill under it;
  // the three steps are a track at its side, the current one in ink and the others quiet.
  return (
    <div className="bezel welcome-bezel">
      <section className="panel onboarding-panel welcome" aria-labelledby="onb-title">
        <div className="welcome-main">
          <h2 className="welcome-title" id="onb-title">{hasDog ? "Un paso más para empezar" : "Todavía no registras perros"}</h2>
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

export function Home() {
  const { user, isAdmin } = useAuth();
  // The research account sees every person's dogs, so the page does not say «Tus perros».
  const title = isAdmin ? "Todos los perros" : "Tus perros";
  usePageTitle(title);
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dogs, loading, error } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const { data: cfg } = useFusionConfig();
  const { data: open, loading: openLoading } = useOpenAlerts(viewer);
  const [hidden, setHidden] = useState(() => readHidden(user!.uid));
  const [search, setSearch] = useState("");
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
  const isStale = (d: Dog) => !!d.status && freshness(d.status.lastBlockAt?.toMillis?.() ?? null, d.status.updatedAt?.toMillis?.() ?? null, now, d.status.lastSource) === "stale";
  const levelOf = (d: Dog) => {
    const a = newestOpen.get(d.id);
    const sum = describeDog(d.status, d.baseline, cfg, undefined, !!a && !a.endedAt, { key: d.id });
    return {
      name: d.name, level: sum.level, slight: sum.slight, learning: isLearning(d.status, d.baseline), stale: isStale(d),
      // An alert that already ended is said apart from the dogs «como de costumbre».
      openAlert: !!a, alertEnded: !!a?.endedAt,
    };
  };
  // Cards: the dogs that need a look first, with the stable level and their new
  // alerts, once both have arrived. The order was fixed when the page opened, so a dog
  // whose level rose a minute later stayed under one in «Todo normal». Now a dog that starts to need a look moves up at
  // once, and one that needs it less keeps its place for a while (attentionOrder), so cards do not jump back and forth
  // while the owner reads. The summary above keeps updating.
  const ready = !loading && !openLoading;
  const held = useRef<HeldRanks>(new Map());
  const ranked = ready ? attentionOrder(sorted.map((d) => ({ id: d.id, ...levelOf(d) })), held.current, now) : null;
  if (ranked) held.current = ranked.held;
  const order = ranked?.ids ?? [];
  // The research account sees every dog: a search by name finds one among them.
  const needle = search.trim().toLocaleLowerCase("es");
  const cards = order.map((id) => sorted.find((d) => d.id === id)!).filter(Boolean)
    .filter((d) => !needle || d.name.toLocaleLowerCase("es").includes(needle));
  // The research account sees every person's dogs: «los N perros», with the real total.
  const summary = homeSummary(sorted.map(levelOf), { all: isAdmin });
  const anyData = sorted.some((d) => d.status);
  // The guide shows until a dog has data; with dogs registered it can be hidden (without dogs it is the empty state).
  const showGuide = !isAdmin && !loading && !anyData && (!sorted.length || !hidden);
  // From GROUP_MIN dogs without data (the research account, a clean seed) they share one card, a row each,
  // instead of as many identical cards. Fewer keep their own card: a new owner's first dog is a next step, not a list.
  const without = cards.filter((d) => !d.status);
  const grouped = without.length >= GROUP_MIN ? without : [];
  const listed = grouped.length ? cards.filter((d) => d.status) : cards;
  const hide = () => { try { localStorage.setItem(HIDE_KEY(user!.uid), "1"); } catch { /* not stored */ } setHidden(true); };
  // One figure leads the page. The first card that needs a look (a level other than
  // «Todo normal», or an alert waiting), or the only dog (once it has a normal pattern and recent data), is the
  // featured card; the others are compact. When no dog
  // needs a look and there are two or more, a band beside the summary shows the lowest Health Score, so a page where
  // every dog is «Todo normal» still has a focus. Nothing is computed that the cards do not already show.
  const needsLook = (d: Dog) => { const c = levelOf(d); return !c.stale && !c.learning && (c.level === "amber" || c.level === "red" || c.openAlert); };
  const only = sorted.length === 1 ? levelOf(sorted[0]) : null;
  const featuredId = cards.find(needsLook)?.id ?? (only && sorted[0].status && !only.learning && !only.stale ? sorted[0].id : null);
  const scored = sorted.flatMap((d) => {
    const score = shownScore(d.status, false).score;
    return d.status && score != null && !isLearning(d.status, d.baseline) && !isStale(d) ? [{ dog: d, score }] : [];
  });
  // The band is for the page where no dog needs a look: with a featured card, its score is already the large figure.
  const lowest = ready && !featuredId && scored.length >= 2 ? scored.reduce((a, b) => (b.score < a.score ? b : a)) : null;
  // The line that says what the Health Score is goes with the first score on the page: the band's
  // when there is one, else the featured card, else the first card that
  // shows one.
  const firstScored = lowest ? null : featuredId ?? cards.find((d) => d.status && !isLearning(d.status, d.baseline) && !isStale(d))?.id;
  return (
    <main className="page page-home" id="main">
      {/* Three levels of text: the title, the summary of every dog (the page's answer) and the fixed notice.
          The summary keeps its place while loading, so the cards below do not jump when it arrives. */}
      <div className="home-hero" data-band={lowest ? "true" : undefined}>
        <div className="home-hero-head">
          <PageHead title={title} sub={loading ? "Cargando tus perros…" : summary ?? "Aquí verás cómo están tus perros respecto a su patrón normal."} />
        </div>
        <div className="home-hero-notes"><Notice /></div>
        {/* A quiet line, not a second protagonist; it comes after the fixed notice and what the figure is
            goes with the figure. */}
        {lowest && (
          <div className="home-lowest" data-level={levelOf(lowest.dog).level ?? "none"} style={levelVars(levelOf(lowest.dog).level)}>
            <Link className="home-lowest-link" to={`/perros/${lowest.dog.id}`} aria-label={`Health Score más bajo, promedio de los últimos minutos: ${lowest.dog.name}, ${lowest.score} de 100`}>
              <span className="home-lowest-figure"><span className="home-lowest-value">{lowest.score}</span><span className="home-lowest-of">de 100</span></span>
              <span className="home-lowest-body">
                <span className="home-lowest-name">Health Score más bajo</span>
                <span className="home-lowest-dog"><Icon name="paw" size={16} />{lowest.dog.name}<Icon name="chevron-right" size={14} /></span>
              </span>
            </Link>
            <p className="home-score-note">{scoreNote(cfg)}</p>
          </div>
        )}
      </div>
      <div className="stack">
        {error && <Callout kind="error">No pudimos cargar tus perros. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {showGuide && <Onboarding dogs={sorted} onHide={sorted.length ? hide : null} />}
        {isAdmin && !loading && !sorted.length && <EmptyState title="Todavía no hay perros" text="Los perros de la demostración se crean con el seed o el bootstrap." />}
        {isAdmin && sorted.length > 6 && (
          <div className="field field-narrow">
            <label htmlFor="dog-search">Buscar un perro por su nombre</label>
            <input id="dog-search" className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          </div>
        )}
        {!ready ? (
          <div className="grid-cards" aria-busy="true"><Skeleton className="skeleton-card" /><Skeleton className="skeleton-card" lines={[35, 50, 100]} /></div>
        ) : sorted.length > 0 && (
          cards.length ? <>
            {listed.length > 0 && <div className="grid-cards">{listed.map((d) => {
              const a = newestOpen.get(d.id);
              return <DogCard key={d.id} dog={d} cfg={cfg} openAlert={a} alertIsNew={!!a && !!openAtLoad.current && !openAtLoad.current.has(a.id)}
                scoreNote={d.id === firstScored} featured={d.id === featuredId} />;
            })}</div>}
            {grouped.length > 0 && <DogGroup dogs={grouped} />}
          </> : <EmptyState icon="info" title="Ningún perro se llama así" text="Revisa el nombre o borra la búsqueda para ver todos." />
        )}
      </div>
    </main>
  );
}
