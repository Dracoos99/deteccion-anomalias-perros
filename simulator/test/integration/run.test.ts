// End to end in the emulators (npm run test:sim): simulator → readings → Cloud Function (Functions emulator) →
// results, dogs.status and alerts. Needs the data exported by ml/src/export_sim.py; skipped when it is missing.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { Timestamp, getFirestore, type Firestore } from "firebase-admin/firestore";
import { SIM_DATA_DIR } from "../../src/config";
import { SimulatorRun, createRun, runJob, serveRuns } from "../../src/run";
import { buildReport } from "../../src/report";
import { RUN_ABANDONED_MS } from "../../../shared/runs";

const PROJECT = "demo-perros-tesis";
const MODEL_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../functions/models/behavior/metadata.json"), "utf8")).version;
const hasData = fs.existsSync(path.join(SIM_DATA_DIR, "manifest.json"));
let app: App;
let db: Firestore;
const quiet = () => undefined;

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    v = await fn();
  }
  return v;
}

const dog = (name: string, imu: string, hr: string) => ({
  name, ownerId: "lucia", active: true, schemaVersion: 1,
  source: { imu: { datasetId: "vehkaoja2022", subjectId: imu }, hr: { datasetId: "invoxia2023", subjectId: hr }, temp: { datasetId: "synthetic", subjectId: null } },
});

describe.skipIf(!hasData)("simulator end to end", () => {
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, "sim-test");
    db = getFirestore(app);
  });
  afterAll(async () => { await deleteApp(app); });
  beforeEach(async () => {
    await clearFirestore();
    await db.doc("dogs/toby").set(dog("Toby", "23", "30"));
    await db.doc("dogs/luna").set(dog("Luna", "16", "8"));
  });

  it("writes every block, gets every result from the Function and reports latency", async () => {
    const runId = await createRun(db, { dogIds: ["toby", "luna"], speed: 10, durationS: 60, createdBy: "test", worker: "test" });
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 60_000 });
    await run.start();
    await run.done;
    const report = await waitFor(() => buildReport(db, runId), (r) => r.results === 12);
    expect(report).toMatchObject({ readings: 12, results: 12, lostBlocks: 0, windowsExpected: 60, windowsWritten: 60, ok: true, state: "stopped" });
    expect(report.latency.avgMs).toBeGreaterThanOrEqual(0);
    const reading = (await db.doc(`readings/${runId}_toby_000000`).get()).data()!;
    expect(reading.imu).toHaveLength(6000);
    expect(reading.hr).toHaveLength(10);
    expect(reading).toMatchObject({ dogId: "toby", ownerId: "lucia", source: "simulator", sourceRef: runId, imuHz: 100, processed: false });
    expect(reading.expireAt.toMillis()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const toby = (await db.doc("dogs/toby").get()).data()!;
    expect(toby.baseline).toMatchObject({ samples: expect.any(Number), activitySource: MODEL_VERSION });
    expect(toby.baseline.imuMean).toHaveLength(6);
    expect(toby.baseline.hrMean).toBeGreaterThan(30);
    expect(toby.status).toMatchObject({ level: expect.stringMatching(/green|amber|red/), behaviorModel: MODEL_VERSION });
    expect(["sit", "stand", "lie", "trot", "walk", "play", "sniff"]).toContain(toby.status.lastBehavior);
    const result = (await db.doc(`results/${runId}_toby_000005`).get()).data()!;
    expect(result.modelVersions.behavior).toBe(MODEL_VERSION);
    expect(result.prefilterFlags).not.toContain("activity_rules");
    const stats = (await db.doc(`simulatorRuns/${runId}`).get()).get("stats");
    expect(stats).toMatchObject({ blocksWritten: 12, resultsSeen: 12 });
    // A run that reached its duration says so, so the panel shows «Terminada».
    expect((await db.doc(`simulatorRuns/${runId}`).get()).get("endedBy")).toBe("duration");
    // Each dog's next block waits for the previous result, so the Function never sees them out of order.
    const flags = (await db.collection("results").where("sourceRef", "==", runId).get()).docs.flatMap((r) => r.get("prefilterFlags") as string[]);
    expect(flags.filter((f) => f === "out_of_order" || f.startsWith("gap"))).toEqual([]);
    expect(stats.stoppedAt).toBeInstanceOf(Timestamp);
  }, 120_000);

  it("sends 2 s blocks up to ×2, so the app gets data every 2 s of real time", async () => {
    const runId = await createRun(db, { dogIds: ["luna"], speed: 2, durationS: 20, createdBy: "test", worker: "test" });
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 60_000 });
    await run.start();
    await run.done;
    const report = await waitFor(() => buildReport(db, runId), (r) => r.results === 10);
    expect(report).toMatchObject({ readings: 10, results: 10, lostBlocks: 0, windowsExpected: 10, windowsWritten: 10, ok: true });
    const r2 = (await db.doc(`readings/${runId}_luna_000002`).get()).data()!;
    const r3 = (await db.doc(`readings/${runId}_luna_000003`).get()).data()!;
    expect(r3.imu).toHaveLength(1200);
    expect(r3.blockSeconds).toBe(2);
    expect(r3.hr.length).toBeLessThanOrEqual(2);
    expect(r3.blockStart.toMillis() - r2.blockStart.toMillis()).toBe(2000);
    expect((await db.doc(`results/${runId}_luna_000003`).get()).get("prefilterFlags")).not.toContain("imu_length:1200");
  }, 90_000);

  it("injects a fever from the run document and the Function opens an alert with the ground truth stored", async () => {
    const runId = await createRun(db, { dogIds: ["toby"], speed: 10, durationS: 150, createdBy: "test", worker: "test" });
    await db.doc(`simulatorRuns/${runId}`).update({ pendingInjection: { dogId: "toby", type: "fever", magnitude: 2.0, durationS: 600 } });
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 60_000 });
    await run.start();
    await run.done;
    const report = await waitFor(() => buildReport(db, runId), (r) => r.results === r.readings && r.injections[0]?.detected === true);
    expect(report.injections).toHaveLength(1);
    expect(report.injections[0]).toMatchObject({ dogId: "toby", type: "fever", detected: true });
    const truth = (await db.doc(`readings/${runId}_toby_000010`).get()).get("injectedAnomaly");
    expect(truth).toMatchObject({ type: "fever", magnitude: 2, durationS: 600, offsetS: expect.any(Number) });
    const alert = (await db.collection("alerts").where("dogId", "==", "toby").get()).docs[0].data();
    expect(alert.reasons.map((r: { component: string }) => r.component)).toContain("temperature");
    expect((await db.doc("dogs/toby").get()).get("status.openAlerts")).toBe(1);
  }, 120_000);

  it("a «new dog» run discards the baseline and the Function learns it from the stream, in its two stages", async () => {
    // A short learning period (3 blocks of 10 s per stage); the Function caches config/fusion for 15 s.
    await db.doc("config/fusion").set({ baseline: { minBlocks: 3 } });
    await new Promise((r) => setTimeout(r, 16_000));
    await db.doc("dogs/toby").update({ baseline: { activeRatioMean: 0.3, activeRatioStd: 0.1, hrMean: 70, hrStd: 5, tempMean: 38.6, tempStd: 0.1, samples: 100, activitySource: "rules", computedAt: Timestamp.now() } });
    const runId = await createRun(db, { dogIds: ["toby"], speed: 10, durationS: 90, createdBy: "test", worker: "test", learnBaseline: true });
    expect((await db.doc(`simulatorRuns/${runId}`).get()).get("learnBaseline")).toBe(true);
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 60_000 });
    await run.start();
    await run.done;
    await waitFor(() => buildReport(db, runId), (r) => r.results === r.readings);
    const learned = await waitFor(async () => (await db.doc("dogs/toby").get()).data()!, (d) => d.baseline?.activitySource === MODEL_VERSION);
    // The simulator's baseline went away; the Function learned one (origin «function»), first with the movement rule and
    // then with the behavioral model, and the learning period ended.
    expect(learned.baseline).toMatchObject({ origin: "function", activitySource: MODEL_VERSION });
    expect(learned.baseline.hrMean).not.toBe(70);
    expect(learned.status.baselineProgress).toBeNull();
    await db.doc("config/fusion").delete();
  }, 150_000);

  it("a collar taken off says «Revisa el collar» and opens no alert of low activity", async () => {
    const runId = await createRun(db, { dogIds: ["toby"], speed: 10, durationS: 600, createdBy: "test", worker: "test" });
    await db.doc(`simulatorRuns/${runId}`).update({ pendingInjection: { dogId: "toby", type: "collar_off", magnitude: 24, durationS: 3600 } });
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 60_000 });
    await run.start();
    await run.done;
    await waitFor(() => buildReport(db, runId), (r) => r.results === r.readings);
    const status = (await db.doc("dogs/toby").get()).get("status");
    expect(status.sensor).toBe("no_wear");
    expect((await db.doc(`results/${runId}_toby_000050`).get()).get("prefilterFlags")).toContain("imu_no_wear");
    // Ten minutes of a collar on a table: no alert, although the signal is as still as a dog that does not move.
    expect((await db.collection("alerts").where("dogId", "==", "toby").get()).size).toBe(0);
  }, 150_000);

  it("records the behavior annotated from video apart from the readings when the run asks for it", async () => {
    const runId = await createRun(db, { dogIds: ["toby"], speed: 10, durationS: 60, createdBy: "test", worker: "test", recordTruth: true });
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 60_000 });
    await run.start();
    await run.done;
    const truth = await db.collection("simulatorTruth").where("runId", "==", runId).get();
    expect(truth.size).toBe(6);
    const first = truth.docs.find((d) => d.id === `${runId}_toby_000000`)!.data();
    expect(first.behaviors).toHaveLength(5);
    expect(first.subject).toMatchObject({ datasetId: "vehkaoja2022", subjectId: "23", split: "train" });
    // The reading carries no annotation: the Function never sees it.
    expect((await db.doc(`readings/${runId}_toby_000000`).get()).get("behaviors")).toBeUndefined();
  }, 90_000);

  it("serve mode claims a run created without worker (from the panel) and executes it", async () => {
    const runId = await createRun(db, { dogIds: ["luna"], speed: 10, durationS: 30, createdBy: "panel", worker: null });
    const stop = serveRuns(db, { workerId: "serve-test", log: quiet, drainMs: 30_000 });
    const done = await waitFor(async () => (await db.doc(`simulatorRuns/${runId}`).get()).data()!, (r) => r.state === "stopped" && r.stats.stoppedAt, 60_000);
    await stop();
    expect(done.worker?.id).toBe("serve-test");
    expect(done.stats.blocksWritten).toBe(3);
    expect((await db.collection("readings").where("sourceRef", "==", runId).get()).size).toBe(3);
  }, 90_000);

  it("job mode (Cloud Run) claims one run, executes it to the end and leaves runs taken by others alone", async () => {
    const runId = await createRun(db, { dogIds: ["luna"], speed: 10, durationS: 30, createdBy: "panel", worker: null });
    expect(await runJob(db, runId, { workerId: "cloud-run:test", log: quiet, drainMs: 30_000 })).toBe("done");
    const done = (await db.doc(`simulatorRuns/${runId}`).get()).data()!;
    expect(done).toMatchObject({ state: "stopped", worker: { id: "cloud-run:test" } });
    expect(done.stats.blocksWritten).toBe(3);
    const taken = await createRun(db, { dogIds: ["toby"], speed: 10, durationS: 30, createdBy: "panel", worker: "serve-elsewhere" });
    expect(await runJob(db, taken, { workerId: "cloud-run:test", log: quiet, drainMs: 0 })).toBe("not_claimed");
    expect(await runJob(db, "missing", { workerId: "cloud-run:test", log: quiet, drainMs: 0 })).toBe("not_claimed");
  }, 90_000);

  it("refuses to run a dog that is already in another active run", async () => {
    await createRun(db, { dogIds: ["toby"], speed: 1, createdBy: "test", worker: "other" });
    const second = await createRun(db, { dogIds: ["toby", "luna"], speed: 1, createdBy: "test", worker: "test" });
    await expect(new SimulatorRun(db, second, { workerId: "test", log: quiet, drainMs: 0 }).start()).rejects.toThrow(/ya está en la ejecución activa/);
    expect((await db.collection("readings").get()).size).toBe(0);
  });

  it("frees the dogs of a run whose process stopped beating, and closes it as abandoned", async () => {
    const dead = await createRun(db, { dogIds: ["toby"], speed: 1, createdBy: "test", worker: "cloud-run:killed" });
    await db.doc(`simulatorRuns/${dead}`).update({ "worker.heartbeatAt": Timestamp.fromMillis(Date.now() - RUN_ABANDONED_MS - 60_000) });
    const next = await createRun(db, { dogIds: ["toby"], speed: 10, durationS: 20, createdBy: "test", worker: "test" });
    const run = new SimulatorRun(db, next, { workerId: "test", log: quiet, drainMs: 30_000 });
    await run.start();
    await run.done;
    expect((await db.doc(`simulatorRuns/${dead}`).get()).data()).toMatchObject({ state: "stopped", endedBy: "abandoned", worker: null });
    expect((await db.doc(`simulatorRuns/${next}`).get()).get("stats.blocksWritten")).toBe(2);
  }, 90_000);

  it("stops itself at the process limit and says so", async () => {
    const runId = await createRun(db, { dogIds: ["luna"], speed: 1, createdBy: "panel", worker: null });
    expect(await runJob(db, runId, { workerId: "cloud-run:test", log: quiet, drainMs: 0, maxRunMs: 1_500 })).toBe("done");
    expect((await db.doc(`simulatorRuns/${runId}`).get()).data()).toMatchObject({ state: "stopped", endedBy: "limit" });
  }, 90_000);

  it("pauses and resumes from the run document, and rejects an invalid injection with a visible error", async () => {
    const runId = await createRun(db, { dogIds: ["luna"], speed: 10, createdBy: "test", worker: "test" });
    const run = new SimulatorRun(db, runId, { workerId: "test", log: quiet, drainMs: 0 });
    await run.start();
    await waitFor(async () => run.written, (n) => n >= 2);
    await db.doc(`simulatorRuns/${runId}`).update({ state: "paused" });
    await new Promise((r) => setTimeout(r, 1500));
    const paused = run.written;
    await new Promise((r) => setTimeout(r, 2500));
    expect(run.written).toBe(paused);
    await db.doc(`simulatorRuns/${runId}`).update({ state: "running", pendingInjection: { dogId: "toby", type: "fever", magnitude: 1.5, durationS: 60 } });
    const err = await waitFor(async () => (await db.doc(`simulatorRuns/${runId}`).get()).get("error"), (e) => !!e, 10_000);
    expect(err).toMatch(/no está en esta ejecución/);
    await waitFor(async () => run.written, (n) => n > paused + 1, 10_000);
    await db.doc(`simulatorRuns/${runId}`).update({ state: "stopped" });
    await run.done;
    expect((await db.doc(`simulatorRuns/${runId}`).get()).get("stats.stoppedAt")).toBeInstanceOf(Timestamp);
  }, 60_000);
});
