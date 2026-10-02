/* Screen 6 · Registro y edición del perro: name, breed, weight, birth date and sex. No vet assignment (v3).
   The rules keep ownerId, status and baseline out of the owner's reach; "Volver a aprender su patrón normal" goes
   through the resetBaseline function. */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { addDoc, collection, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, PageHead, Seg, usePageTitle } from "../components/ui";
import { db, functions } from "../firebase";
import { useDog, type Dog } from "../data/hooks";

/** Discards the learned baseline so the next data teach it again. */
function ResetBaseline({ dog }: { dog: Dog }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const learning = !!dog.status?.baselineProgress && dog.status.baselineProgress.stage === "initial" && !dog.baseline;
  if (!dog.baseline && !learning) return null;
  const onReset = async () => {
    if (!window.confirm(`¿Volver a aprender el patrón normal de ${dog.name}? Se usarán sus próximos datos.`)) return;
    setState("busy");
    try { await httpsCallable(functions, "resetBaseline")({ dogId: dog.id }); setState("done"); }
    catch { setState("error"); }
  };
  return (
    <section className="panel stack-sm" aria-labelledby="d-baseline" style={{ marginTop: 24 }}>
      <h2 className="section-title" id="d-baseline">Patrón normal</h2>
      <p className="small" style={{ margin: 0 }}>
        {learning ? `El sistema está aprendiendo qué es normal para ${dog.name} con sus primeros datos.`
          : `El sistema aprendió qué es normal para ${dog.name} con sus primeros datos.`}
        {" "}Si en esos días no estuvo bien (por ejemplo, estaba enfermo o recién operado), puedes pedir que lo aprenda de nuevo con sus próximos datos.
      </p>
      {state === "done" ? <Callout kind="ok">Listo: su patrón normal se aprenderá de nuevo con los próximos datos.</Callout>
        : state === "error" ? <Callout kind="error">No pudimos hacerlo. Inténtalo de nuevo.</Callout> : null}
      {state !== "done" && <div><button className="btn btn-secondary" type="button" onClick={onReset} disabled={state === "busy"}>
        {state === "busy" ? "Un momento…" : "Volver a aprender su patrón normal"}</button></div>}
    </section>
  );
}

type SexChoice = "female" | "male" | "none";
const SEXES = [{ value: "female" as const, label: "Hembra" }, { value: "male" as const, label: "Macho" }, { value: "none" as const, label: "Sin indicar" }];
const today = () => new Date().toISOString().slice(0, 10);

export function DogForm() {
  const { dogId } = useParams();
  const editing = !!dogId;
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { data: dog, loading } = useDog(dogId);
  usePageTitle(editing ? (dog ? `Editar a ${dog.name}` : "Editar perro") : "Registrar a tu perro");
  const [f, setF] = useState({ name: "", breed: "", weight: "", birthDate: "", sex: "none" as SexChoice });
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing && dog && !loaded) {
      setF({ name: dog.name, breed: dog.breed ?? "", weight: dog.weightKg ? String(dog.weightKg) : "", birthDate: dog.birthDate ?? "", sex: dog.sex ?? "none" });
      setLoaded(true);
    }
  }, [editing, dog, loaded]);

  if (editing && loading) return <div className="boot" aria-busy="true">Cargando…</div>;
  if (editing && (!dog || (dog.ownerId !== user!.uid && !isAdmin))) {
    return <main className="page" id="main"><EmptyState icon="info" title="No encontramos este perro" action={<Link className="btn btn-secondary" to="/perfil">Ir a Perfil</Link>} /></main>;
  }

  const weight = f.weight.trim() ? Number(f.weight.replace(",", ".")) : null;
  const errors: Partial<Record<"name" | "weight" | "birthDate", string>> = {};
  if (!f.name.trim()) errors.name = "Escribe el nombre de tu perro.";
  else if (f.name.trim().length > 40) errors.name = "Usa como máximo 40 caracteres.";
  if (weight != null && (!Number.isFinite(weight) || weight < 0.5 || weight > 100)) errors.weight = "Escribe un peso entre 0.5 y 100 kg.";
  if (f.birthDate && f.birthDate > today()) errors.birthDate = "La fecha de nacimiento no puede ser futura.";
  const shown = (k: keyof typeof errors) => (touched ? errors[k] : undefined);
  const err = (k: keyof typeof errors) => shown(k) && <div className="field-error" id={`d-${k}-err`}><Icon name="alert-triangle" size={13} />{shown(k)}</div>;
  const inv = (k: keyof typeof errors) => (shown(k) ? { "aria-invalid": true, "aria-describedby": `d-${k}-err` } : {});

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true); setError(null);
    const profile = { name: f.name.trim(), breed: f.breed.trim() || null, weightKg: weight, birthDate: f.birthDate || null, sex: f.sex === "none" ? null : f.sex };
    try {
      if (editing) {
        await updateDoc(doc(db, "dogs", dogId!), { ...profile, updatedAt: serverTimestamp() });
        navigate(`/perros/${dogId}`, { replace: true });
      } else {
        const ref = await addDoc(collection(db, "dogs"), { ...profile, ownerId: user!.uid, active: true, schemaVersion: 1, createdAt: serverTimestamp() });
        navigate(`/perros/${ref.id}`, { replace: true });
      }
    } catch {
      setError("No pudimos guardar los datos. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" id="main" style={{ maxWidth: 640 }}>
      <nav className="crumbs" aria-label="Ruta"><Link to="/perfil">Perfil</Link><span aria-hidden="true">›</span><span>{editing ? dog!.name : "Nuevo perro"}</span></nav>
      <PageHead title={editing ? `Editar a ${dog!.name}` : "Registrar a tu perro"} sub={editing ? undefined : "Con estos datos lo reconocerás en la app y en la Vista para el veterinario."} />
      <form className="stack-sm" onSubmit={onSubmit} noValidate aria-busy={busy}>
        {error && <Callout kind="error">{error}</Callout>}
        <div className="field"><label htmlFor="d-name">Nombre</label>
          <input id="d-name" className="input" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} {...inv("name")} />{err("name")}</div>
        <div className="field"><label htmlFor="d-breed">Raza <span className="muted">(opcional)</span></label>
          <input id="d-breed" className="input" value={f.breed} onChange={(e) => setF({ ...f, breed: e.target.value })} placeholder="Por ejemplo, mestizo" /></div>
        <div className="field"><label htmlFor="d-weight">Peso en kg <span className="muted">(opcional)</span></label>
          <input id="d-weight" className="input" inputMode="decimal" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} {...inv("weight")} />{err("weight")}</div>
        <div className="field"><label htmlFor="d-birth">Fecha de nacimiento <span className="muted">(opcional)</span></label>
          <input id="d-birth" className="input" type="date" max={today()} value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} {...inv("birthDate")} />{err("birthDate")}</div>
        <div className="field"><span className="field-label" id="d-sex">Sexo</span>
          <Seg label="Sexo" options={SEXES} value={f.sex} onChange={(sex) => setF({ ...f, sex })} /></div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Registrar"}</button>
          <Link className="btn btn-ghost" to={editing ? `/perros/${dogId}` : "/perfil"}>Cancelar</Link>
        </div>
      </form>
      {editing && dog && <ResetBaseline dog={dog} />}
    </main>
  );
}
