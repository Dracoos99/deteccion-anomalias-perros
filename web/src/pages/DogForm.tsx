/* Screen 6 · Registro y edición del perro: name, breed, weight, birth date and sex. No vet assignment (v3).
   The rules keep ownerId, status and baseline out of the owner's reach; "Volver a aprender su patrón normal" goes
   through the resetBaseline function. «Quitar perro» archives the dog (active: false) without
   deleting its data, and both actions ask on the page, not with a browser dialog. «Borrar sus datos» deletes
   the dog and all its data for good, through the deleteMyData function, after the owner types the confirmation word. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { collection, doc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, PageHead, PageLoading, Seg, usePageTitle } from "../components/ui";
import { callFunction, db } from "../firebase";
import { useDog, type Dog } from "../data/hooks";
import { fromHome } from "../lib/nav";
import { CONFIRM_WORD } from "../lib/myData";

/** An action that asks first, on the page: the question and two buttons that name what they do. */
function ConfirmRow({ question, yes, onYes, onNo, busy, danger = false }: { question: string; yes: string; onYes: () => void; onNo: () => void; busy: boolean; danger?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="callout callout-warn stack-sm" role="group" aria-label={question} tabIndex={-1} ref={ref}>
      <p>{question}</p>
      <div className="row">
        <button className={danger ? "btn btn-danger-solid btn-sm" : "btn btn-primary btn-sm"} type="button" onClick={onYes} disabled={busy}>{busy ? "Un momento…" : yes}</button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onNo} disabled={busy}>Cancelar</button>
      </div>
    </div>
  );
}

/** Discards the learned baseline so the next data teach it again. */
function ResetBaseline({ dog }: { dog: Dog }) {
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "done" | "error">("idle");
  const learning = !!dog.status?.baselineProgress && dog.status.baselineProgress.stage === "initial" && !dog.baseline;
  if (!dog.baseline && !learning) return null;
  const onReset = async () => {
    setState("busy");
    try { await callFunction("resetBaseline", { dogId: dog.id }); setState("done"); }
    catch { setState("error"); }
  };
  return (
    <section className="panel stack-sm" aria-labelledby="d-baseline">
      <h2 className="section-title" id="d-baseline">Patrón normal</h2>
      <p className="small muted">
        {learning ? `El sistema está aprendiendo qué es normal para ${dog.name} con sus primeros datos.`
          : `El sistema aprendió qué es normal para ${dog.name} con sus primeros datos.`}
        {/* An example, never a diagnosis. */}
        {" "}Si en esos días no estuvo en su mejor momento (por ejemplo, tuvo un malestar o una operación reciente), puedes pedir que lo aprenda de nuevo con sus próximos datos.
      </p>
      {state === "done" ? <Callout kind="ok">Listo: su patrón normal se aprenderá de nuevo con los próximos datos.</Callout>
        : state === "error" ? <Callout kind="error">No pudimos hacerlo. Inténtalo de nuevo.</Callout> : null}
      {state === "confirm" || state === "busy" ? (
        <ConfirmRow question={`¿Volver a aprender el patrón normal de ${dog.name}? Se usarán sus próximos datos; mientras tanto, solo se revisan los rangos de referencia.`}
          yes="Sí, volver a aprender" onYes={onReset} onNo={() => setState("idle")} busy={state === "busy"} />
      ) : state !== "done" && (
        <div><button className="btn btn-secondary btn-sm" type="button" onClick={() => setState("confirm")}>Volver a aprender su patrón normal</button></div>
      )}
    </section>
  );
}

/** «Quitar perro»: the dog is archived (active: false), never deleted. It leaves Inicio, Alertas, the
 * data upload and the research panel; its data, its alerts and its vet view stay. Perfil offers «Deshacer» right after. */
function ArchiveDog({ dog }: { dog: Dog }) {
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "error">("idle");
  const onArchive = async () => {
    setState("busy");
    const write = updateDoc(doc(db, "dogs", dog.id), { active: false, updatedAt: serverTimestamp() });
    const done = () => navigate("/perfil", { replace: true, state: { archived: { id: dog.id, name: dog.name } } });
    try {
      // Offline, Firestore sends the change when the connection returns; the page does not wait for it.
      const sent = await Promise.race([write.then(() => true), new Promise<false>((r) => window.setTimeout(() => r(false), SAVE_WAIT_MS))]);
      if (!sent) write.catch(() => undefined);
      done();
    } catch {
      setState("error");
    }
  };
  return (
    <section className="panel stack-sm" aria-labelledby="d-archive">
      <h2 className="section-title" id="d-archive">Quitar a {dog.name}</h2>
      <p className="small muted">Deja de aparecer en Inicio, en Alertas y en la carga de datos. Sus datos y sus alertas no se borran.</p>
      {state === "error" && <Callout kind="error">No pudimos quitarlo. Revisa tu conexión e inténtalo de nuevo.</Callout>}
      {state === "confirm" || state === "busy" ? (
        <ConfirmRow question={`¿Quitar a ${dog.name} de tus perros? Justo después podrás deshacerlo.`} yes={`Sí, quitar a ${dog.name}`}
          onYes={onArchive} onNo={() => setState("idle")} busy={state === "busy"} danger />
      ) : (
        <div><button className="btn btn-danger btn-sm" type="button" onClick={() => setState("confirm")}><Icon name="archive" size={14} />Quitar perro</button></div>
      )}
    </section>
  );
}

/** The dog and all its data, for good. Only its owner sees it (the function refuses anyone else). */
function DeleteDog({ dog }: { dog: Dog }) {
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "confirm" | "busy">("idle");
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = word.trim().toUpperCase() === CONFIRM_WORD;
  const onDelete = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setState("busy"); setError(null);
    try {
      await callFunction("deleteMyData", { scope: "dog", dogId: dog.id, confirm: CONFIRM_WORD });
      navigate("/perfil", { replace: true, state: { deletedDog: dog.name } });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      setError(code.endsWith("failed-precondition") ? (err as Error).message : "No pudimos borrar sus datos. Revisa tu conexión e inténtalo de nuevo.");
      setState("confirm");
    }
  };
  return (
    <section className="panel stack-sm" aria-labelledby="d-delete">
      <h2 className="section-title" id="d-delete">Borrar los datos de {dog.name}</h2>
      <p className="small muted">Borra para siempre a {dog.name} y todos sus datos. Si solo quieres que deje de aparecer, usa «Quitar perro».</p>
      {state === "idle" ? (
        <div><button className="btn btn-danger btn-sm" type="button" onClick={() => { setState("confirm"); setWord(""); setError(null); }}><Icon name="trash" size={14} />Borrar sus datos</button></div>
      ) : (
        <form className="callout callout-warn stack-sm" onSubmit={onDelete} aria-labelledby="d-delete-q">
          <p id="d-delete-q">Se borran para siempre {dog.name}, sus lecturas, sus alertas, sus tendencias y sus cargas. No se puede deshacer. Las copias de seguridad del sistema los conservan hasta 7 días más y después se borran solas.</p>
          <div className="field"><label htmlFor="d-delete-word">Escribe {CONFIRM_WORD} para confirmar</label>
            <input id="d-delete-word" className="input" autoComplete="off" value={word} onChange={(e) => setWord(e.target.value)} disabled={state === "busy"} autoFocus /></div>
          {error && <p className="small" role="alert">{error}</p>}
          <div className="row">
            <button className="btn btn-danger-solid btn-sm" type="submit" disabled={state === "busy" || !ready}>{state === "busy" ? "Borrando…" : `Borrar a ${dog.name} para siempre`}</button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setState("idle")} disabled={state === "busy"}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}

type SexChoice = "female" | "male" | "none";
const SEXES = [{ value: "female" as const, label: "Hembra" }, { value: "male" as const, label: "Macho" }, { value: "none" as const, label: "Sin indicar" }];
const NAME_MAX = 40, BREED_MAX = 60, MAX_AGE_YEARS = 30;   // name: the limit of firestore.rules
/** A local calendar date as YYYY-MM-DD (the UTC date is already tomorrow in the evening in Lima). */
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => isoDate(new Date());
const oldestBirth = () => { const d = new Date(); d.setFullYear(d.getFullYear() - MAX_AGE_YEARS); return isoDate(d); };
/** How long a save may wait for the server before the owner is told it will finish later. */
const SAVE_WAIT_MS = 8000;

export function DogForm() {
  const { dogId } = useParams();
  const editing = !!dogId;
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  // Opened from the first-use guide of Inicio, the form keeps Inicio in its trail and its «Cancelar».
  const fromInicio = fromHome(useLocation().search);
  const { data: dog, loading } = useDog(dogId);
  usePageTitle(editing ? (dog ? `Editar a ${dog.name}` : "Editar perro") : "Registrar a tu perro");
  const [f, setF] = useState({ name: "", breed: "", weight: "", birthDate: "", sex: "none" as SexChoice });
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submits, setSubmits] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing && dog && !loaded) {
      setF({ name: dog.name, breed: dog.breed ?? "", weight: dog.weightKg ? String(dog.weightKg) : "", birthDate: dog.birthDate ?? "", sex: dog.sex ?? "none" });
      setLoaded(true);
    }
  }, [editing, dog, loaded]);
  // After a submit with mistakes, the first field to fix gets the focus (its message is read with it).
  useEffect(() => { if (submits) document.querySelector<HTMLElement>("form [aria-invalid=true]")?.focus(); }, [submits]);

  if (editing && loading) return <PageLoading className="page-form" />;
  if (editing && (!dog || (dog.ownerId !== user!.uid && !isAdmin))) {
    return <main className="page" id="main"><EmptyState icon="info" title="No encontramos este perro" action={<Link className="btn btn-secondary" to="/perfil">Ir a Perfil</Link>} /></main>;
  }

  const nameLength = f.name.trim().length;
  const weightText = f.weight.trim().replace(/\s*kg\.?$/i, "");
  const weight = weightText ? Number(weightText.replace(",", ".")) : null;
  const errors: Partial<Record<"name" | "breed" | "weight" | "birthDate", string>> = {};
  if (!f.name.trim()) errors.name = "Escribe el nombre de tu perro.";
  else if (nameLength > NAME_MAX) errors.name = `Usa como máximo ${NAME_MAX} caracteres: quita ${nameLength - NAME_MAX}.`;
  if (f.breed.trim().length > BREED_MAX) errors.breed = `Usa como máximo ${BREED_MAX} caracteres.`;
  if (weight != null && (!Number.isFinite(weight) || weight < 0.5 || weight > 100)) errors.weight = "Escribe un peso entre 0.5 y 100 kg.";
  if (f.birthDate && f.birthDate > today()) errors.birthDate = "La fecha de nacimiento no puede ser futura.";
  else if (f.birthDate && f.birthDate < oldestBirth()) {
    errors.birthDate = `Revisa el año: tendría ${new Date().getFullYear() - Number(f.birthDate.slice(0, 4))} años.`;
  }
  const shown = (k: keyof typeof errors) => (touched ? errors[k] : undefined);
  const err = (k: keyof typeof errors) => shown(k) && <div className="field-error" id={`d-${k}-err`}><Icon name="alert-triangle" size={13} />{shown(k)}</div>;
  const inv = (k: keyof typeof errors, hint?: string) => {
    const ids = [hint, shown(k) ? `d-${k}-err` : null].filter(Boolean).join(" ");
    return { ...(shown(k) ? { "aria-invalid": true } : {}), ...(ids ? { "aria-describedby": ids } : {}) };
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) { setSubmits((n) => n + 1); return; }
    setBusy(true); setError(null);
    const profile = { name: f.name.trim(), breed: f.breed.trim() || null, weightKg: weight, birthDate: f.birthDate || null, sex: f.sex === "none" ? null : f.sex };
    const ref = editing ? doc(db, "dogs", dogId!) : doc(collection(db, "dogs"));
    const write = editing
      ? updateDoc(ref, { ...profile, updatedAt: serverTimestamp() })
      : setDoc(ref, { ...profile, ownerId: user!.uid, active: true, schemaVersion: 1, createdAt: serverTimestamp() });
    // Offline, Firestore keeps the change and sends it when the connection returns; the write only resolves then.
    const later = () => navigate(`/perros/${ref.id}`, { replace: true, state: { offlineSaved: true } });
    if (!navigator.onLine) { write.catch(() => undefined); later(); return; }
    try {
      const done = await Promise.race([write.then(() => true), new Promise<false>((r) => window.setTimeout(() => r(false), SAVE_WAIT_MS))]);
      if (done) navigate(`/perros/${ref.id}`, { replace: true });
      else { write.catch(() => undefined); later(); }
    } catch {
      setError("No pudimos guardar los datos. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page-form" id="main">
      <nav className="crumbs" aria-label="Ruta">{fromInicio && !editing ? <Link to="/">Inicio</Link> : <Link to="/perfil">Perfil</Link>}<span aria-hidden="true">›</span><span>{editing ? dog!.name : "Nuevo perro"}</span></nav>
      <PageHead title={editing ? `Editar a ${dog!.name}` : "Registrar a tu perro"} sub={editing ? undefined : "Con estos datos lo reconocerás en la app y en la Vista para el veterinario."} />
      <div className="stack">
      <form className="panel stack-sm" onSubmit={onSubmit} noValidate aria-busy={busy}>
        {error && <Callout kind="error">{error}</Callout>}
        {/* A counter instead of cutting the name silently at the limit of firestore.rules. The counter and one message; once the error shows, the counter only counts. */}
        <div className="field"><label htmlFor="d-name">Nombre</label>
          <input id="d-name" className="input" aria-required="true" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} {...inv("name", "d-name-hint")} />
          <div className="field-hint" id="d-name-hint">{nameLength > NAME_MAX && !shown("name")
            ? `${nameLength} de ${NAME_MAX} caracteres: quita ${nameLength - NAME_MAX}.`
            : `${nameLength} de ${NAME_MAX} caracteres.`}</div>{err("name")}</div>
        <div className="field"><label htmlFor="d-breed">Raza <span className="muted">(opcional)</span></label>
          <input id="d-breed" className="input" maxLength={BREED_MAX} value={f.breed} onChange={(e) => setF({ ...f, breed: e.target.value })} placeholder="Por ejemplo, mestizo" {...inv("breed")} />{err("breed")}</div>
        <div className="field"><label htmlFor="d-weight">Peso en kg <span className="muted">(opcional)</span></label>
          <input id="d-weight" className="input" inputMode="decimal" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} {...inv("weight")} />{err("weight")}</div>
        <div className="field"><label htmlFor="d-birth">Fecha de nacimiento <span className="muted">(opcional)</span></label>
          <input id="d-birth" className="input" type="date" min={oldestBirth()} max={today()} value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} {...inv("birthDate")} />{err("birthDate")}</div>
        <div className="field"><span className="field-label" id="d-sex">Sexo</span>
          <Seg label="Sexo" options={SEXES} value={f.sex} onChange={(sex) => setF({ ...f, sex })} /></div>
        <div className="row form-row-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Registrar"}</button>
          <Link className="btn btn-ghost" to={editing ? `/perros/${dogId}` : fromInicio ? "/" : "/perfil"}>Cancelar</Link>
        </div>
      </form>
      {editing && dog && <ResetBaseline dog={dog} />}
      {editing && dog && <ArchiveDog dog={dog} />}
      {editing && dog && dog.ownerId === user!.uid && <DeleteDog dog={dog} />}
      </div>
    </main>
  );
}
