/**
 * The simulator on Cloud Run Jobs. The prepared signals (ml/data/processed/sim, not versioned) live in a
 * Cloud Storage bucket; a job downloads only the manifest and the subjects of the dogs of its run, with the token of
 * its service account from the metadata server, and runs from a local copy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import type { DogDoc, SimulatorRunDoc } from "../../shared/types";

export type TokenFn = () => Promise<string>;

/** Access token of the service account the job runs as (Cloud Run metadata server). */
export const metadataToken: TokenFn = async () => {
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`No se obtuvo el token de la cuenta de servicio (${res.status}).`);
  return ((await res.json()) as { access_token: string }).access_token;
};

export function parseGsUri(uri: string): { bucket: string; prefix: string } {
  const m = /^gs:\/\/([^/]+)\/?(.*)$/.exec(uri.trim());
  if (!m) throw new Error(`SIM_DATA_URI debe tener la forma gs://bucket/carpeta (se recibió ${uri}).`);
  return { bucket: m[1], prefix: m[2] ? `${m[2].replace(/\/$/, "")}/` : "" };
}

/** Files a run needs: the manifest and, per dog, its IMU and heart-rate subjects (paths of ml/src/export_sim.py). */
export function runDataFiles(dogs: Pick<DogDoc, "source">[]): string[] {
  const files = new Set(["manifest.json"]);
  for (const d of dogs) {
    const imu = d.source?.imu, hr = d.source?.hr;
    if (imu?.datasetId && imu.subjectId) files.add(`imu/${imu.datasetId}/${imu.subjectId}.f32`);
    if (hr?.datasetId && hr.subjectId) files.add(`hr/${hr.datasetId}/${hr.subjectId}.json`);
  }
  return [...files];
}

/** The annotated behavior of the IMU subjects of a run that records it (optional: an older bucket does not
 * have it, and the run then goes on without the comparison). */
export function runLabelFiles(dogs: Pick<DogDoc, "source">[]): string[] {
  return [...new Set(dogs.flatMap((d) => (d.source?.imu?.datasetId && d.source.imu.subjectId ? [`labels/${d.source.imu.datasetId}/${d.source.imu.subjectId}.i8`] : [])))];
}

/** Downloads `files` from gs://bucket/prefix into `dir`, keeping their relative paths. `optional` files may be missing. */
export async function downloadFiles(uri: string, files: string[], dir: string, token: TokenFn = metadataToken,
  fetchImpl: typeof fetch = fetch, optional: ReadonlySet<string> = new Set()): Promise<void> {
  const { bucket, prefix } = parseGsUri(uri);
  const auth = `Bearer ${await token()}`;
  for (const f of files) {
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(prefix + f)}?alt=media`;
    const res = await fetchImpl(url, { headers: { Authorization: auth } });
    if (!res.ok && optional.has(f)) continue;
    if (!res.ok) throw new Error(`No se pudo descargar gs://${bucket}/${prefix}${f} (${res.status}).`);
    const out = path.join(dir, ...f.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  }
}

/** Local copy of the data of one run; returns the directory to pass as dataDir. */
export async function fetchRunData(db: Firestore, runId: string, uri: string, dir = path.join(os.tmpdir(), "sim-data")): Promise<string> {
  const run = (await db.doc(`simulatorRuns/${runId}`).get()).data() as SimulatorRunDoc | undefined;
  if (!run) throw new Error(`No existe la ejecución ${runId}.`);
  const dogs = await Promise.all(run.dogIds.map(async (id) => ((await db.doc(`dogs/${id}`).get()).data() ?? {}) as Pick<DogDoc, "source">));
  const labels = run.recordTruth ? runLabelFiles(dogs) : [];
  await downloadFiles(uri, [...runDataFiles(dogs), ...labels], dir, metadataToken, fetch, new Set(labels));
  return dir;
}

/** Worker id of a Cloud Run job execution, shown in the panel. */
export const jobWorkerId = (): string => `cloud-run:${process.env.CLOUD_RUN_EXECUTION ?? os.hostname()}`;
