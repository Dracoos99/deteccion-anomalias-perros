/* Carga de CSV: choose the dog, drop the file, check it,
   preview rows and problems, confirm, and follow how the blocks are written and scored. Layout of the v2 prototype
. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, PageHead, fmtNum, usePageTitle } from "../components/ui";
import { useCsvUploads, useDogs, useFusionConfig, type CsvUpload, type Dog } from "../data/hooks";
import { CSV_HEADER, CSV_MAX_BYTES, checkCsv, sampleCsv, templateCsv, type CsvCheck } from "../lib/csv";
import { uploadCsv, type UploadProgress } from "../lib/csvUpload";
import { dateTimeText, durationText } from "../lib/plain";

const COLUMNS: [string, string][] = [
  ["timestamp", "Fecha y hora ISO 8601 en UTC (termina en Z)"],
  ["dog_id", "Identificador del perro en tu archivo (uno por archivo)"],
  ["acc_x, acc_y, acc_z", "Acelerómetro en g, 100 muestras por segundo"],
  ["gyr_x, gyr_y, gyr_z", "Giroscopio en °/s, 100 muestras por segundo"],
  ["hr_bpm", "Frecuencia cardiaca en lpm (opcional, puede ir vacía)"],
  ["temp_c", "Temperatura en °C (opcional, puede ir vacía)"],
];
const STEPS = ["Archivo", "Revisión", "Vista previa", "Carga"];
const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${fmtNum(b / 1024)} KB` : `${fmtNum(b / 1048576, 1)} MB`);

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
  return <li><Icon name={icon} size={18} style={{ color }} /><span>{children}</span></li>;
}

/** Status of an upload in plain Spanish; a stale one (the tab was closed) reads as interrupted. */
function uploadState(u: CsvUpload, now = Date.now()): { text: string; tone: "ok" | "warn" | "muted" } {
  if (u.status === "done") return { text: "Analizada", tone: "ok" };
  const last = (u.updatedAt ?? u.createdAt)?.toMillis?.() ?? now;
  if (now - last > 5 * 60_000) return { text: `Interrumpida (${u.blocksProcessed} de ${u.blocksExpected} bloques)`, tone: "warn" };
  return { text: `En curso (${u.blocksProcessed} de ${u.blocksExpected} bloques)`, tone: "muted" };
}

function RecentUploads({ uploads, dogs }: { uploads: CsvUpload[]; dogs: Map<string, Dog> }) {
  if (!uploads.length) return null;
  return (
    <section className="panel" aria-labelledby="recent-title">
      <h2 className="panel-title" id="recent-title">Cargas recientes</h2>
      <div className="table-wrap" role="region" aria-label="Cargas recientes" tabIndex={0}>
        <table className="table table-compact">
          <thead><tr><th scope="col">Archivo</th><th scope="col">Perro</th><th scope="col">Datos</th><th scope="col">Estado</th></tr></thead>
          <tbody>{uploads.map((u) => {
            const st = uploadState(u);
            const first = u.firstBlockAt?.toMillis?.();
            return (
              <tr key={u.id}>
                <td className="small">{u.fileName}</td>
                <td className="small">{dogs.get(u.dogId)?.name ?? "—"}</td>
                <td className="small">{first ? dateTimeText(first) : "—"} · {durationText(u.blocksExpected * 10_000)}</td>
                <td className={`small ${st.tone === "warn" ? "out-of-range" : st.tone === "muted" ? "muted" : ""}`}>{st.text}</td>
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
  usePageTitle("Cargar datos");
  const viewer = { uid: user!.uid, isAdmin };
  const [params] = useSearchParams();
  const { data: allDogs, loading: dogsLoading } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const dogs = useMemo(() => [...allDogs].sort((a, b) => a.name.localeCompare(b.name, "es")), [allDogs]);
  const dogMap = useMemo(() => new Map(allDogs.map((d) => [d.id, d])), [allDogs]);
  const { data: cfg } = useFusionConfig();
  const { data: uploads } = useCsvUploads(viewer, 8);
  const [dogId, setDogId] = useState(params.get("perro") ?? "");
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!dogId && dogs.length) setDogId(dogs[0].id); }, [dogs, dogId]);
  const dog = dogMap.get(dogId) ?? null;
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
  const reset = () => { setFile(null); setProgress(null); setDone(false); setError(null); if (inputRef.current) inputRef.current.value = ""; };
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

  const step = progress || done ? 4 : check ? (check.blocking.length ? 2 : 3) : 1;
  const learnTime = durationText((cfg.baseline?.minBlocks ?? 360) * 10_000);
  const writtenPct = progress ? Math.round((100 * progress.written) / progress.total) : 0;
  const processedPct = progress ? Math.round((100 * progress.processed) / progress.total) : 0;

  return (
    <main className="page" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/perfil">Perfil</Link><span aria-hidden="true">›</span><span>Cargar datos</span></nav>
      <PageHead title="Cargar datos desde un archivo" sub="Sube las lecturas del sensor de tu perro (movimiento y, si las tienes, frecuencia cardiaca y temperatura). Las revisamos antes de guardarlas." />
      <ol className="stepper" aria-label="Pasos">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? "step" : undefined} data-done={step > i + 1}>
            <span className="step-num">{step > i + 1 ? <Icon name="check" size={12} /> : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      <div className="split">
        <div className="stack">
          {dogsLoading ? <p className="small">Cargando…</p> : !dogs.length ? (
            <EmptyState title="Primero registra a tu perro" text="Los datos del archivo se guardan en el perfil de uno de tus perros."
              action={<Link className="btn btn-primary" to="/perros/nuevo"><Icon name="plus" />Registrar a mi perro</Link>} />
          ) : (
            <>
              <div className="field" style={{ maxWidth: 360 }}>
                <label htmlFor="csv-dog">¿De qué perro son los datos?</label>
                <select id="csv-dog" className="select" value={dogId} onChange={(e) => { setDogId(e.target.value); setNotAfter(lastDataOf(dogMap.get(e.target.value))); }} disabled={busy || done}>
                  {dogs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.breed ? ` · ${d.breed}` : ""}</option>)}
                </select>
              </div>

              {!file && (
                <div className="dropzone" data-over={over} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                  onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
                  <Icon name="upload" size={32} />
                  <div style={{ fontWeight: 600, fontSize: 17 }}>Arrastra tu archivo CSV aquí</div>
                  <div className="small muted">o</div>
                  <div className="row" style={{ justifyContent: "center", flexWrap: "wrap", gap: 8 }}>
                    <label className="btn btn-primary" htmlFor="csv-file"><Icon name="file" />Elegir archivo</label>
                    <button className="btn btn-secondary" type="button" onClick={useSample}>Probar con un archivo de ejemplo</button>
                  </div>
                  <input ref={inputRef} id="csv-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
                  <div className="xs muted">Hasta {CSV_MAX_BYTES / 1048576} MB · 100 muestras por segundo</div>
                </div>
              )}

              {error && <Callout kind="error">{error}</Callout>}

              {file && check && (
                <section className="panel stack-sm" aria-labelledby="val-title">
                  <div className="row-between">
                    <h2 className="panel-title" id="val-title" style={{ margin: 0 }}>Revisión de {file.name}</h2>
                    {!busy && !done && <button className="btn btn-ghost btn-sm" type="button" onClick={reset}><Icon name="x" size={14} />Cambiar archivo</button>}
                  </div>
                  <ul className="checklist">
                    <Check state={check.missing.length ? "error" : "ok"}>{check.missing.length ? `Faltan columnas: ${check.missing.join(", ")}.` : "Las 10 columnas esperadas están presentes."}</Check>
                    {!check.missing.length && <Check state={check.rowsDropped ? (check.valid ? "warn" : "error") : "ok"}>
                      {check.rowsDropped ? `${plural(check.rowsDropped, "fila", "filas")} con la fecha o el movimiento mal escritos: no se cargan.` : "Fechas y movimiento bien escritos en todas las filas."}</Check>}
                    {!check.missing.length && <Check state={check.valuesDropped ? "warn" : "ok"}>
                      {check.valuesDropped ? `${plural(check.valuesDropped, "valor", "valores")} de frecuencia cardiaca o temperatura imposibles o mal escritos: se dejan fuera (el resto de la fila sí se carga).` : "Ningún valor fuera de lo posible."}</Check>}
                    {check.rateHz != null && <Check state={Math.abs(check.rateHz - 100) <= 5 ? "ok" : "error"}>Frecuencia de muestreo: {check.rateHz} Hz{Math.abs(check.rateHz - 100) <= 5 ? "." : "; se esperan 100 Hz."}</Check>}
                    <Check state={file.size <= CSV_MAX_BYTES ? "ok" : "error"}>Tamaño: {fmtBytes(file.size)} de {CSV_MAX_BYTES / 1048576} MB.</Check>
                  </ul>
                  {check.blocking.length > 0 && (
                    <div className="callout callout-error" role="alert"><Icon name="alert-octagon" size={18} style={{ marginTop: 2 }} />
                      <div><strong>No se puede cargar este archivo.</strong> {check.blocking.join(" ")}</div></div>
                  )}
                  {!check.blocking.length && (
                    <div className="callout callout-ok"><Icon name="check-circle" size={18} style={{ marginTop: 2, color: "var(--color-status-green)" }} />
                      <div>{plural(check.valid, "fila válida", "filas válidas")} · se crearán <strong>{plural(check.blocks.length, "bloque", "bloques")} de 10 s</strong> ({durationText(check.blocks.length * 10_000)} de datos, desde el {dateTimeText(check.blocks[0].startMs)}) para {dog?.name ?? "—"}.</div></div>
                  )}
                  {check.warnings.length > 0 && !check.blocking.length && (
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{check.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                  )}
                </section>
              )}

              {file && check && check.preview.length > 0 && (
                <section className="panel" aria-labelledby="prev-title">
                  <h2 className="panel-title" id="prev-title">Vista previa</h2>
                  <div className="table-wrap" role="region" aria-label="Vista previa del archivo" tabIndex={0}>
                    <table className="table table-compact">
                      <thead><tr><th scope="col">Fila</th>{check.header.map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead>
                      <tbody>{check.preview.map((p) => (
                        <tr key={p.row}><td className="muted">{p.row}</td>{p.cols.map((c, j) => {
                          const e = p.cellErr[check.header[j]];
                          return <td key={j} className={e ? (p.cellErr[check.header[j]] && !e.includes("se deja fuera") ? "cell-error" : "cell-warn") : ""} title={e || undefined}>
                            {e && <Icon name="alert-triangle" size={12} style={{ marginRight: 3 }} />}{c || <span className="muted">vacío</span>}</td>;
                        })}</tr>
                      ))}</tbody>
                    </table>
                  </div>
                  {check.issues.length > 0 && (
                    <>
                      <h3 className="small" style={{ margin: "14px 0 6px" }}>Problemas encontrados ({check.issues.length >= 200 ? "200 o más" : check.issues.length})</h3>
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {check.issues.slice(0, 8).map((e, i) => <li key={i}>Fila {e.row}, columna <span className="mono">{e.column}</span>: {e.message}</li>)}
                        {check.issues.length > 8 && <li>y {check.issues.length - 8} más.</li>}
                      </ul>
                    </>
                  )}
                </section>
              )}

              {file && check && !check.blocking.length && (
                <section className="panel stack-sm" aria-live="polite" aria-labelledby="up-title">
                  <h2 className="sr-only" id="up-title">Carga</h2>
                  {done && progress ? (
                    <div className="callout callout-ok"><Icon name="check-circle" size={18} style={{ marginTop: 2, color: "var(--color-status-green)" }} />
                      <div><strong>Listo: {plural(progress.processed, "bloque analizado", "bloques analizados")} de {progress.total}.</strong> Ya puedes ver los resultados de {dog?.name}.
                        {!dog?.baseline && ` Su patrón normal se aprende con ${learnTime} de sus primeros datos: hasta entonces, solo se vigilan los valores fuera de los rangos de referencia.`}
                        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                          <Link className="btn btn-primary btn-sm" to={`/perros/${dog?.id}`}>Ver a {dog?.name}</Link>
                          <button className="btn btn-secondary btn-sm" type="button" onClick={reset}>Cargar otro archivo</button>
                        </div></div></div>
                  ) : progress ? (
                    <>
                      <div className="row-between small"><span>Enviando bloques de 10 s…</span><span className="tabular">{progress.written} de {progress.total}</span></div>
                      <div className="progress" role="progressbar" aria-valuenow={writtenPct} aria-valuemin={0} aria-valuemax={100} aria-label="Bloques enviados"><div className="progress-fill" style={{ width: `${writtenPct}%` }} /></div>
                      <div className="row-between small"><span>Analizados por el sistema</span><span className="tabular">{progress.processed} de {progress.total}</span></div>
                      <div className="progress" role="progressbar" aria-valuenow={processedPct} aria-valuemin={0} aria-valuemax={100} aria-label="Bloques analizados"><div className="progress-fill" style={{ width: `${processedPct}%` }} /></div>
                      <p className="xs muted" style={{ margin: 0 }}>Se envían en orden, uno tras otro, para que el sistema los analice como si llegaran en vivo. No cierres esta pestaña hasta que termine.</p>
                    </>
                  ) : (
                    <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                      <button className="btn btn-primary btn-lg" type="button" onClick={upload} disabled={busy || !dog}><Icon name="upload" />Confirmar y cargar {plural(check.blocks.length, "bloque", "bloques")}</button>
                      {check.warnings.length > 0 && <span className="small muted">Lo que no se carga está en la lista de arriba.</span>}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          <RecentUploads uploads={uploads} dogs={dogMap} />
        </div>

        <aside className="stack" aria-label="Formato del archivo">
          <section className="panel stack-sm">
            <h2 className="panel-title">Formato esperado</h2>
            <p className="small" style={{ margin: 0 }}>Una fila por muestra, separada por comas, con esta cabecera:</p>
            <div className="codeblock" role="region" aria-label="Cabecera del archivo CSV" tabIndex={0}>{CSV_HEADER.join(",")}</div>
            <table className="table table-compact small"><tbody>{COLUMNS.map(([c, d]) => <tr key={c}><td className="mono nowrap">{c}</td><td>{d}</td></tr>)}</tbody></table>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => download("plantilla_lecturas.csv", templateCsv())}><Icon name="download" size={14} />Descargar plantilla</button>
          </section>
          <section className="panel small stack-sm">
            <h2 className="panel-title">Qué revisamos</h2>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              <li>Columnas, formato de fecha y números.</li>
              <li>Valores imposibles: frecuencia cardiaca fuera de {cfg.prefilter.hrMin}–{cfg.prefilter.hrMax} lpm o temperatura fuera de {cfg.prefilter.tempMin}–{cfg.prefilter.tempMax} °C.</li>
              <li>Frecuencia de muestreo de 100 Hz y cortes en los datos.</li>
              <li>Que los datos sean posteriores a los últimos datos del perro.</li>
              <li>Agrupamos las muestras en bloques de 10 s; el sistema analiza cada bloque en ventanas de 2 s.</li>
            </ul>
          </section>
          <section className="panel small stack-sm">
            <h2 className="panel-title">Su patrón normal</h2>
            <p style={{ margin: 0 }}>Si tu perro todavía no tiene un patrón normal, el sistema lo aprende con {learnTime} de sus primeros datos y afina su actividad con otros {learnTime} de datos. Carga datos de un periodo en que tu perro estuvo bien.</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
