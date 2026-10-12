/* Carga de CSV: choose the dog, drop the file, check it,
   preview rows and problems, confirm, and follow how the blocks are written and scored. Layout of the v3 mockups
: the dog, the file and its review in one panel, the preview, then the main action. */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, PageFrame, PageHead, fmtNum, useInConsole, usePageTitle } from "../components/ui";
import { useCsvUploads, useDogs, useFusionConfig, type CsvUpload, type Dog } from "../data/hooks";
import { CSV_HEADER, CSV_MAX_BYTES, checkCsv, sampleCsv, templateCsv, type CsvCheck } from "../lib/csv";
import { uploadCsv, type UploadProgress } from "../lib/csvUpload";
import { fromHome } from "../lib/nav";
import { dateTimeText, durationText } from "../lib/plain";

const COLUMNS: [string, string][] = [
  ["timestamp", "Fecha y hora en UTC, por ejemplo 2026-10-01T10:00:00.000Z"],
  ["dog_id", "Identificador del perro en tu archivo (uno por archivo)"],
  ["acc_x, acc_y, acc_z", "Acelerómetro en g, 100 lecturas por segundo"],
  ["gyr_x, gyr_y, gyr_z", "Giroscopio en °/s, 100 lecturas por segundo"],
  ["hr_bpm", "Frecuencia cardiaca en lpm (opcional, puede ir vacía)"],
  ["temp_c", "Temperatura en °C (opcional, puede ir vacía)"],
];
const STEPS = ["Archivo", "Revisión", "Vista previa", "Carga"];
const NUMERIC = new Set(["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z", "hr_bpm", "temp_c"]);
/** The preview shows the heart rate and the temperature right after the time, where they are always
 * in view (most problems are there), then the dog's id (the least informative: the dog is chosen above) and the
 * movement columns. On a 390 px phone the first four columns are the ones in view. */
const PREVIEW_ORDER = ["timestamp", "hr_bpm", "temp_c", "dog_id", "acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"];
const previewRank = (h: string) => { const i = PREVIEW_ORDER.indexOf(h); return i < 0 ? PREVIEW_ORDER.length : i; };
/** The file's columns in preview order, with their position in the file. */
const previewCols = (check: CsvCheck) => check.header.map((h, j) => ({ h, j })).sort((a, b) => previewRank(a.h) - previewRank(b.h));

/** Whether a scrolling box has more to its right (the preview table on a narrow screen). */
function useMoreToTheRight(ref: React.RefObject<HTMLDivElement | null>, dep: unknown): boolean {
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", update); };
  }, [ref, dep]);
  return more;
}
const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${fmtNum(b / 1024)} KB` : `${fmtNum(b / 1048576, 1)} MB`);
/** Warnings that the checks above already say in their own words. */
const REPEATS_A_CHECK = ["con la fecha o el movimiento mal escritos", "imposibles o mal escritos"];

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Check({ state, children }: { state: "ok" | "warn" | "error"; children: ReactNode }) {
  const icon = state === "ok" ? "check-circle" : state === "warn" ? "alert-triangle" : "alert-octagon";
  const color = `var(--color-status-${state === "ok" ? "green" : state === "warn" ? "amber" : "red"})`;
  return <li><Icon name={icon} size={14} style={{ color }} /><span>{children}</span></li>;
}

/** Status of an upload in plain Spanish; a stale one (the tab was closed) reads as interrupted. */
function uploadState(u: CsvUpload, now = Date.now()): { text: string; tone: "ok" | "warn" | "muted" } {
  if (u.status === "done") return { text: "Analizada", tone: "ok" };
  const last = (u.updatedAt ?? u.createdAt)?.toMillis?.() ?? now;
  if (now - last > 5 * 60_000) return { text: `Interrumpida (${fmtNum(u.blocksProcessed)} de ${fmtNum(u.blocksExpected)} bloques)`, tone: "warn" };
  return { text: `En curso (${fmtNum(u.blocksProcessed)} de ${fmtNum(u.blocksExpected)} bloques)`, tone: "muted" };
}

/** A long file name keeps its start and its end: "lecturas_collar_de_toby…_2026-10-02.csv". */
const shortName = (n: string) => (n.length > 40 ? `${n.slice(0, 22)}…${n.slice(-14)}` : n);

function RecentUploads({ uploads, dogs }: { uploads: CsvUpload[]; dogs: Map<string, Dog> }) {
  if (!uploads.length) return null;
  return (
    <section className="panel stack-sm" aria-labelledby="recent-title">
      <h2 className="panel-title" id="recent-title">Cargas recientes</h2>
      <div className="table-wrap" role="region" aria-label="Cargas recientes" tabIndex={0}>
        <table className="table table-stack uploads-table">
          <thead><tr><th scope="col">Archivo</th><th scope="col">Perro</th><th scope="col">Datos</th><th scope="col">Estado</th></tr></thead>
          <tbody>{uploads.map((u) => {
            const st = uploadState(u);
            const first = u.firstBlockAt?.toMillis?.();
            return (
              <tr key={u.id}>
                <td title={u.fileName} data-title><strong>{shortName(u.fileName)}</strong></td>
                <td data-label="Perro">{dogs.get(u.dogId)?.name ?? "—"}</td>
                <td data-label="Datos"><span className="upload-meta"><span className="nowrap">{first ? dateTimeText(first) : "—"}</span><span aria-hidden="true">·</span><span className="nowrap">{durationText(u.blocksExpected * 10_000)}</span></span></td>
                <td data-label="Estado" data-wide><span className={`tag ${st.tone === "ok" ? "tag-green" : st.tone === "warn" ? "tag-amber" : "tag-open"}`}>
                  <Icon name={st.tone === "ok" ? "check-circle" : st.tone === "warn" ? "alert-triangle" : "clock"} size={12} />{st.text}</span></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

export function CsvUploadPage() {
  const { user, isAdmin } = useAuth();
  const inConsole = useInConsole();
  usePageTitle(inConsole ? "Ingesta CSV" : "Cargar datos");
  const viewer = { uid: user!.uid, isAdmin };
  const [params] = useSearchParams();
  const { data: allDogs, loading: dogsLoading } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const dogs = useMemo(() => [...allDogs].sort((a, b) => a.name.localeCompare(b.name, "es")), [allDogs]);
  const dogMap = useMemo(() => new Map(allDogs.map((d) => [d.id, d])), [allDogs]);
  const { data: cfg } = useFusionConfig();
  const { data: uploads } = useCsvUploads(viewer, 8);
  // The dog comes from the page that opened the upload (?perro=); with two or more dogs and none
  // given, the owner chooses it: the data teach that dog its normal pattern.
  const [dogId, setDogId] = useState(params.get("perro") ?? "");
  const fromInicio = fromHome(`?${params.toString()}`);
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLUListElement>(null);
  const changedFile = useRef(false);
  // The drop zone (and the focused button) go away when a file is chosen: focus moves to its review; after "Cambiar
  // archivo", back to the file button.
  useEffect(() => {
    if (file) reviewRef.current?.focus();
    else if (changedFile.current) inputRef.current?.focus();
  }, [file]);

  useEffect(() => { if (!dogId && dogs.length === 1) setDogId(dogs[0].id); }, [dogs, dogId]);
  const dog = dogMap.get(dogId) ?? null;
  const previewRef = useRef<HTMLDivElement>(null);
  const moreColumns = useMoreToTheRight(previewRef, file);
  // The dog's latest data when the file (or the dog) was chosen: the upload itself moves it forward, and the file must
  // not turn "older than the latest data" while it is being uploaded.
  const [notAfter, setNotAfter] = useState<number | null>(null);
  const lastDataOf = (d: Dog | null | undefined) => d?.status?.lastBlockAt?.toMillis?.() ?? null;
  const check: CsvCheck | null = useMemo(
    () => (file ? checkCsv(file.text, file.size, cfg.prefilter, { notAfterMs: notAfter, dogName: dog?.name }) : null),
    [file, cfg.prefilter, notAfter, dog?.name]);

  // Leaving the page stops the upload: the browser asks first.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const load = (name: string, size: number, text: string) => {
    setNotAfter(lastDataOf(dog));
    setFile({ name, size, text }); setProgress(null); setDone(false); setError(null);
  };
  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > CSV_MAX_BYTES) { load(f.name, f.size, ""); return; }
    f.text().then((t) => load(f.name, f.size, t), () => setError("No pudimos leer el archivo."));
  };
  const reset = () => { changedFile.current = true; setFile(null); setProgress(null); setDone(false); setError(null); if (inputRef.current) inputRef.current.value = ""; };
  const useSample = () => { const t = sampleCsv(); load("ejemplo_60s.csv", new Blob([t]).size, t); };

  const upload = async () => {
    if (!check || !dog || check.blocking.length) return;
    setBusy(true); setError(null);
    try {
      await uploadCsv({ dogId: dog.id, ownerId: dog.ownerId, uid: user!.uid, fileName: file!.name, check, onProgress: setProgress });
      setDone(true);
    } catch {
      setError("La carga se detuvo. Revisa tu conexión: los bloques ya enviados se conservan y puedes cargar el resto en otro archivo.");
    } finally {
      setBusy(false);
    }
  };

  const step = done ? STEPS.length + 1 : progress ? 4 : check ? (check.blocking.length ? 2 : 3) : 1;
  const learnTime = durationText((cfg.baseline?.minBlocks ?? 360) * 10_000);
  const writtenPct = progress ? Math.round((100 * progress.written) / progress.total) : 0;
  const processedPct = progress ? Math.round((100 * progress.processed) / progress.total) : 0;
  const warnings = check ? check.warnings.filter((w) => !REPEATS_A_CHECK.some((r) => w.includes(r))) : [];
  // Screen readers hear the start, every quarter and the end of an upload, not each of its blocks.
  const quarter = progress ? Math.min(3, Math.floor((4 * progress.processed) / progress.total)) : -1;
  const milestone = done && progress ? `Listo: ${plural(progress.processed, "bloque analizado", "bloques analizados")}.`
    : quarter === 0 ? `Cargando ${plural(progress!.total, "bloque", "bloques")}.` : quarter > 0 ? `${quarter * 25} % analizado.` : "";

  return (
    <PageFrame>
      {!inConsole && <nav className="crumbs" aria-label="Ruta">{fromInicio ? <Link to="/">Inicio</Link> : <Link to="/perros">Perros</Link>}<span aria-hidden="true">›</span><span>Cargar datos</span></nav>}
      {inConsole
        ? <PageHead title="Ingesta CSV" sub="Carga en cualquier perro las lecturas de un archivo CSV. Se revisan en el navegador antes de escribir los bloques de 10 s en readings." />
        : <PageHead title="Cargar datos desde un archivo" sub="Sube las lecturas del sensor de tu perro. Las revisamos antes de guardarlas." hero />}
      <p className="sr-only" role="status">{milestone}</p>
      <ol className="stepper" aria-label="Pasos">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? "step" : undefined} data-done={step > i + 1}>
            <span className="step-num" aria-hidden={step > i + 1 ? true : undefined}>{step > i + 1 ? <Icon name="check" size={12} /> : i + 1}</span>{s}
            {step > i + 1 && <span className="sr-only"> (listo)</span>}
          </li>
        ))}
      </ol>
      <div className="split csv-layout">
        <div className="stack">
          {dogsLoading ? (
            <div className="stack-sm" aria-busy="true"><p className="small muted">Cargando…</p><div className="skeleton" style={{ height: 40, maxWidth: 360 }} /></div>
          ) : !dogs.length ? (
            <EmptyState title="Primero registra a tu perro" text="Los datos del archivo se guardan en el perfil de uno de tus perros."
              action={<Link className="btn btn-primary" to="/perros/nuevo"><Icon name="plus" />Registrar a mi perro</Link>} />
          ) : (
            <>
              {/* The step the person is on is the protagonist of the page, in the one bezel of the screen. */}
              <div className="bezel csv-stage">
              <section className="panel stack-sm" aria-labelledby="val-title">
                <h2 className="sr-only" id="val-title">{file ? `Revisión de ${file.name}` : "Archivo"}</h2>
                <div className="field field-dog">
                  <label htmlFor="csv-dog">¿De qué perro son los datos?</label>
                  <select id="csv-dog" className="select" value={dog ? dogId : ""} title={dog ? `${dog.name}${dog.breed ? ` · ${dog.breed}` : ""}` : undefined} required aria-required="true" aria-describedby={dog ? undefined : "csv-dog-hint"}
                    onChange={(e) => { setDogId(e.target.value); setNotAfter(lastDataOf(dogMap.get(e.target.value))); }} disabled={busy || done}>
                    {!dog && <option value="" disabled>Elige un perro</option>}
                    {dogs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.breed ? ` · ${d.breed}` : ""}</option>)}
                  </select>
                  {!dog && <div className="field-hint" id="csv-dog-hint">Los datos le enseñan a ese perro su patrón normal: elígelo antes de cargar.</div>}
                </div>

                {!file && (
                  <div className="dropzone" data-over={over} onDragEnter={(e) => { e.preventDefault(); setOver(true); }} onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
                    onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
                    <Icon name="upload" size={28} />
                    <div className="drop-title">Arrastra tu archivo CSV aquí</div>
                    <div className="small muted">o</div>
                    <div className="row drop-actions">
                      <input ref={inputRef} id="csv-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
                      <label className="btn btn-primary" htmlFor="csv-file"><Icon name="file" />Elegir archivo</label>
                      <button className="btn btn-secondary" type="button" onClick={useSample}>Probar con un archivo de ejemplo</button>
                    </div>
                    <div className="small muted">Hasta {CSV_MAX_BYTES / 1048576} MB · 100 lecturas por segundo</div>
                  </div>
                )}

                {error && <Callout kind="error">{error}</Callout>}

                {file && check && (
                  <>
                    <div className="row-between file-row">
                      <span className="small file-name"><Icon name="file" size={14} /> <strong>{file.name}</strong> · {fmtBytes(file.size)}</span>
                      {!busy && !done && <button className="btn btn-ghost btn-sm" type="button" onClick={reset}><Icon name="x" size={12} />Cambiar archivo</button>}
                    </div>
                    <ul className="checklist" ref={reviewRef} tabIndex={-1} aria-labelledby="val-title">
                      {!check.otherSeparator && <Check state={check.missing.length ? "error" : "ok"}>{check.missing.length ? `Faltan columnas: ${check.missing.join(", ")}.` : "Las 10 columnas esperadas están presentes."}</Check>}
                      {!check.missing.length && <Check state={check.rowsDropped ? (check.valid ? "warn" : "error") : "ok"}>
                        {check.rowsDropped ? `${plural(check.rowsDropped, "fila", "filas")} con la fecha o el movimiento mal escritos: no se cargan.` : "Fechas y movimiento bien escritos en todas las filas."}</Check>}
                      {!check.missing.length && <Check state={check.valuesDropped ? "warn" : "ok"}>
                        {check.valuesDropped ? `${plural(check.valuesDropped, "valor", "valores")} de frecuencia cardiaca o temperatura imposibles o mal escritos: se dejan fuera (el resto de la fila sí se carga).` : "Ningún valor fuera de lo posible."}</Check>}
                      {check.rateHz != null && <Check state={Math.abs(check.rateHz - 100) <= 5 ? "ok" : "error"}>{Math.abs(check.rateHz - 100) <= 5 ? "100 lecturas por segundo, como se espera." : `${plural(check.rateHz, "lectura", "lecturas")} por segundo; se esperan 100.`}</Check>}
                      {file.size > CSV_MAX_BYTES && <Check state="error">Tamaño: {fmtBytes(file.size)} de {CSV_MAX_BYTES / 1048576} MB.</Check>}
                      {!check.blocking.length && warnings.map((w) => <Check key={w} state="warn">{w}</Check>)}
                    </ul>
                    {check.blocking.length > 0 ? (
                      <div className="callout callout-error" role="alert"><Icon name="alert-octagon" size={16} style={{ marginTop: 1, color: "var(--color-status-red)" }} />
                        <div><strong>No se puede cargar este archivo.</strong> {check.blocking.join(" ")}</div></div>
                    ) : (
                      <p className="small">{plural(check.valid, "fila válida", "filas válidas")} · se crearán <strong>{plural(check.blocks.length, "bloque", "bloques")} de 10 s</strong> ({durationText(check.blocks.length * 10_000)} de datos, desde el {dateTimeText(check.blocks[0].startMs)}){dog ? ` para ${dog.name}` : ""}.</p>
                    )}
                  </>
                )}
              </section>
              </div>

              {file && check && check.preview.length > 0 && (
                <section className="panel stack-sm" aria-labelledby="prev-title">
                  <h2 className="panel-title" id="prev-title">Vista previa</h2>
                  <div className="table-wrap" role="region" aria-label="Vista previa del archivo" tabIndex={0} ref={previewRef}>
                    <table className="table table-preview">
                      <thead><tr><th scope="col" className="num">Fila</th>{previewCols(check).map(({ h }) => (
                        <th scope="col" key={h} className={NUMERIC.has(h) ? "num" : undefined} title={check.issues.some((i) => i.column === h) ? "Esta columna tiene problemas" : undefined}>
                          {check.issues.some((i) => i.column === h) && <Icon name="alert-triangle" size={12} style={{ marginRight: 3 }} />}{h}</th>
                      ))}</tr></thead>
                      <tbody>{check.preview.map((p) => (
                        <tr key={p.row}><td className="num">{p.row}</td>{previewCols(check).map(({ h, j }) => {
                          const c = p.cols[j], e = p.cellErr[h];
                          const kind = e ? (!e.includes("se deja fuera") ? "cell-error" : "cell-warn") : "";
                          return <td key={h} className={[NUMERIC.has(h) ? "num" : "", kind].filter(Boolean).join(" ") || undefined} title={e || undefined}>
                            {e && <Icon name="alert-triangle" size={12} style={{ marginRight: 3 }} />}{c || <span className="muted">vacío</span>}</td>;
                        })}</tr>
                      ))}</tbody>
                    </table>
                  </div>
                  {moreColumns && <p className="xs muted">Hay más columnas a la derecha: desliza la tabla hacia un lado para verlas.</p>}
                  {check.issues.length > 0 && (
                    <>
                      <h3 className="field-label">Problemas encontrados ({check.issues.length >= 200 ? "200 o más" : check.issues.length})</h3>
                      <ul className="plain-list small">
                        {check.issues.slice(0, 8).map((e, i) => <li key={i}>Fila {e.row}, columna <span className="mono">{e.column}</span>: {e.message}</li>)}
                        {check.issues.length > 8 && <li>y {check.issues.length - 8} más.</li>}
                      </ul>
                    </>
                  )}
                </section>
              )}

              {file && check && !check.blocking.length && (
                <section className="stack-sm upload-step" aria-labelledby="up-title">
                  <h2 className="sr-only" id="up-title">Carga</h2>
                  {done && progress ? (
                    <div className="callout callout-ok appear"><Icon name="check-circle" size={16} style={{ marginTop: 1, color: "var(--color-status-green)" }} />
                      <div><strong>Listo: {plural(progress.processed, "bloque analizado", "bloques analizados")} de {progress.total}.</strong> Ya puedes ver los resultados de {dog?.name}.
                        {!dog?.baseline && ` Su patrón normal se aprende con ${learnTime} de sus primeros datos: hasta entonces, solo se vigilan los valores fuera de los rangos de referencia.`}
                        <div className="row csv-done-actions">
                          <Link className="btn btn-primary btn-sm" to={`/perros/${dog?.id}`}>Ver a {dog?.name}</Link>
                          <button className="btn btn-secondary btn-sm" type="button" onClick={reset}>Cargar otro archivo</button>
                        </div></div></div>
                  ) : progress ? (
                    <>
                      <div className="row-between small"><span>Enviando bloques de 10 s…</span><span className="tabular">{fmtNum(progress.written)} de {fmtNum(progress.total)}</span></div>
                      <div className="progress" role="progressbar" aria-valuenow={writtenPct} aria-valuemin={0} aria-valuemax={100} aria-label="Bloques enviados"><div className="progress-fill" style={{ ["--p" as string]: writtenPct / 100 }} /></div>
                      <div className="row-between small"><span>Analizados por el sistema</span><span className="tabular">{fmtNum(progress.processed)} de {fmtNum(progress.total)}</span></div>
                      <div className="progress" role="progressbar" aria-valuenow={processedPct} aria-valuemin={0} aria-valuemax={100} aria-label="Bloques analizados"><div className="progress-fill" style={{ ["--p" as string]: processedPct / 100 }} /></div>
                      <p className="small muted">Se envían en orden, uno tras otro, para que el sistema los analice como si llegaran en vivo. No cierres esta pestaña hasta que termine.</p>
                    </>
                  ) : (
                    <>
                      {/* The button names the dog the data go to. */}
                      <button className="btn btn-primary btn-lg upload-confirm" type="button" onClick={upload} disabled={busy || !dog}>
                        <Icon name="upload" />{dog ? `Cargar ${plural(check.blocks.length, "bloque", "bloques")} para ${dog.name}` : "Elige un perro para cargar"}</button>
                      <p className="small muted">Se envían en orden, uno tras otro, para que el sistema los analice como si llegaran en vivo.{warnings.length > 0 ? " Lo que no se carga está en la revisión de arriba." : ""}</p>
                    </>
                  )}
                </section>
              )}
            </>
          )}
          <RecentUploads uploads={uploads} dogs={dogMap} />
        </div>

        {/* What surrounds the current step is quiet (no cards): what is checked and the normal pattern are short notes,
            and the technical format is folded, with the template one click away. */}
        <aside className="stack csv-aside" aria-label="Formato del archivo">
          <section className="csv-note small stack-sm">
            <h2 className="csv-note-title">Qué revisamos</h2>
            <ul className="plain-list">
              <li>Columnas, formato de fecha y números.</li>
              <li>Valores imposibles: frecuencia cardiaca fuera de {cfg.prefilter.hrMin}–{cfg.prefilter.hrMax} lpm o temperatura fuera de {cfg.prefilter.tempMin}–{cfg.prefilter.tempMax} °C.</li>
              <li>Que haya 100 lecturas por segundo y si hay cortes en los datos.</li>
              <li>Que los datos sean posteriores a los últimos datos del perro, y que sus horas no sean posteriores a la hora actual.</li>
              <li>Agrupamos las lecturas en bloques de 10 s.</li>
            </ul>
          </section>
          <section className="csv-note small stack-sm">
            <h2 className="csv-note-title">Su patrón normal</h2>
            <p>Si tu perro todavía no tiene un patrón normal, el sistema lo aprende con {learnTime} de sus primeros datos y afina su actividad con {learnTime} más de datos. Carga datos de un periodo en que tu perro estuvo bien.</p>
          </section>
          <details className="disclosure csv-format">
            <summary><Icon name="chevron-right" size={14} />Formato esperado</summary>
            <div className="stack-sm disclosure-body">
              <p className="small">Una fila por muestra, separada por comas, con esta cabecera:</p>
              <div className="codeblock codeblock-wrap">{CSV_HEADER.map((h, i) => <Fragment key={h}>{h}{i < CSV_HEADER.length - 1 && <>,<wbr /></>}</Fragment>)}</div>
              <table className="table"><tbody>{COLUMNS.map(([c, d]) => <tr key={c}><td className="mono nowrap">{c}</td><td>{d}</td></tr>)}</tbody></table>
            </div>
          </details>
          <div><button className="btn btn-secondary btn-sm" type="button" onClick={() => download("plantilla_lecturas.csv", templateCsv())}><Icon name="download" size={14} />Descargar plantilla</button></div>
        </aside>
      </div>
    </PageFrame>
  );
}
