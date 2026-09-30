/**
 * The simulator in the cloud: a run created from the research panel (worker == null) starts an execution of
 * the Cloud Run job that runs the simulator (`job --run <runId>`), so no laptop has to keep `npm run sim -- serve`
 * open. The job claims the run like a serve process would: whichever process takes it first executes it.
 * The Function's service account needs the role roles/run.jobsExecutorWithOverrides. With the emulators, or without
 * a job name, nothing is launched and `npm run sim -- serve` keeps working as before.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineString } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { REGION } from "./config";
import type { SimulatorRunDoc } from "./shared/types";

const SIMULATOR_JOB = defineString("SIMULATOR_JOB", {
  default: "simulator", description: "Cloud Run job that executes the simulator runs created from the panel (empty: none)",
});

/** A run waits for a worker and nobody asked for a job yet. */
export function shouldLaunch(run: Pick<SimulatorRunDoc, "state" | "worker" | "cloudJob"> | undefined): boolean {
  return !!run && run.state !== "stopped" && !run.worker && !run.cloudJob;
}

export type TokenFn = () => Promise<string>;

/** Access token of the Function's service account (metadata server of Cloud Run). */
export const metadataToken: TokenFn = async () => {
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
};

/** Starts an execution of the job with the run id as arguments; returns the name of the operation. */
export async function launchJob(project: string, region: string, job: string, runId: string,
  token: TokenFn = metadataToken, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${job}:run`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: { containerOverrides: [{ args: ["job", "--run", runId] }] } }),
  });
  if (!res.ok) throw new Error(`Cloud Run ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { name?: string }).name ?? null;
}

export const onSimulatorRunCreated = onDocumentCreated({ document: "simulatorRuns/{runId}", region: REGION, retry: false }, async (event) => {
  const job = SIMULATOR_JOB.value();
  if (process.env.FUNCTIONS_EMULATOR === "true" || !job) return;
  const runId = event.params.runId;
  const ref = getFirestore().doc(`simulatorRuns/${runId}`);
  // Mark the request first, in a transaction: a duplicate delivery does not start a second execution.
  const go = await getFirestore().runTransaction(async (tx) => {
    const run = (await tx.get(ref)).data() as SimulatorRunDoc | undefined;
    if (!shouldLaunch(run)) return false;
    tx.update(ref, { cloudJob: { job, requestedAt: FieldValue.serverTimestamp(), operation: null, error: null } });
    return true;
  });
  if (!go) return;
  try {
    const operation = await launchJob(process.env.GCLOUD_PROJECT ?? "", REGION, job, runId);
    await ref.update({ "cloudJob.operation": operation });
  } catch (e) {
    // The run stays waiting: a local `npm run sim -- serve` can still take it.
    logger.error("simulator job not started", { runId, error: (e as Error).message });
    await ref.update({ "cloudJob.error": (e as Error).message });
  }
});
