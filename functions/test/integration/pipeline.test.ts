// Integration tests of the block pipeline against the Firestore emulator (npm run test:functions).
// processReading is called directly, so retries and concurrent deliveries can be reproduced on purpose.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { Timestamp, getFirestore, type Firestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { countOpenAlerts, processReading, resetConfigCache } from "../../src/readings";
import { BUNDLE_DIR } from "../../src/behavior";
import { PHYSIO_BUNDLE_DIR } from "../../src/physio";
import { ENGINE_VERSION } from "../../src/shared/engine";
import { DEFAULT_FUSION_CONFIG } from "../../src/shared/types";
import { resetDogBaseline } from "../../src/baseline";
import { notifyAlert, type PushSender } from "../../src/notify";

const PROJECT = "demo-perros-tesis";
let app: App;
let db: Firestore;
const baseline = { activeRatioMean: 0.3, activeRatioStd: 0.08, hrMean: 70, hrStd: 5, tempMean: 38.6, tempStd: 0.15, samples: 100, computedAt: Timestamp.now() };
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

function reading(k: number, over: Record<string, unknown> = {}) {
  const imu: number[] = [];
  for (let i = 0; i < 1000; i++) imu.push(0, 0, 1, 0, 0, 0);
  return {
    dogId: "toby", ownerId: "lucia", source: "simulator", sourceRef: "run1",
    blockStart: Timestamp.fromMillis(T0 + k * 10_000), imuHz: 100, imu, hr: Array(10).fill(70), temp: 38.6,
    processed: false, expireAt: Timestamp.fromMillis(T0 + 7 * 86_400_000), schemaVersion: 1,
    createdAt: Timestamp.fromMillis(Date.now() - 50), ...over,
  } as any;
}

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`clear failed: ${res.status}`);
}

beforeAll(() => {
  app = initializeApp({ projectId: PROJECT }, "pipeline-test");
  db = getFirestore(app);
});
afterAll(async () => { await deleteApp(app); });
beforeEach(async () => {
  await clearFirestore();
  resetConfigCache();
  await db.doc("dogs/toby").set({ name: "Toby", ownerId: "lucia", active: true, baseline, schemaVersion: 1 });
});

describe("processReading", () => {
  it("writes the result, the engine memory and dogs.status, and measures latency", async () => {
    expect(await processReading(db, "b0", reading(0))).toBe("written");
    const r = (await db.doc("results/b0").get()).data()!;
    expect(r).toMatchObject({ readingId: "b0", dogId: "toby", ownerId: "lucia", sourceRef: "run1",
      predictedBehavior: null, level: "green", modelVersions: { behavior: ENGINE_VERSION, physiological: ENGINE_VERSION } });
    expect(r.latencyMs).toBeGreaterThanOrEqual(50);
    expect(r.signals).toMatchObject({ activeFraction: 0, temp: 38.6 });
    const st = (await db.doc("dogState/toby").get()).data()!;
    expect(st.blocks).toBe(1);
    expect(st.lastBlockStartMs).toBe(T0);
    const status = (await db.doc("dogs/toby").get()).get("status");
    expect(status).toMatchObject({ level: "green", lastBehavior: null, lastTemp: 38.6, openAlerts: 0 });
  });

  it("is idempotent: a retried delivery writes nothing twice (RNF-02)", async () => {
    expect(await processReading(db, "b0", reading(0))).toBe("written");
    const first = (await db.doc("results/b0").get()).get("createdAt");
    expect(await processReading(db, "b0", reading(0))).toBe("duplicate");
    expect((await db.doc("results/b0").get()).get("createdAt")).toEqual(first);
    expect((await db.doc("dogState/toby").get()).get("blocks")).toBe(1);
  });

  it("handles concurrent deliveries of the same block with exactly one write", async () => {
    const out = await Promise.all(Array.from({ length: 5 }, () => processReading(db, "b0", reading(0))));
    expect(out.filter((o) => o === "written")).toHaveLength(1);
    expect(out.filter((o) => o === "duplicate")).toHaveLength(4);
    expect((await db.doc("dogState/toby").get()).get("blocks")).toBe(1);
  });

  it("skips blocks of a dog that does not exist", async () => {
    expect(await processReading(db, "x0", reading(0, { dogId: "ghost" }))).toBe("missing_dog");
    expect((await db.doc("results/x0").get()).exists).toBe(false);
  });

  it("opens one alert per episode with reasons and keeps the open count in dogs.status", async () => {
    for (let k = 0; k < 6; k++) await processReading(db, `b${k}`, reading(k, { temp: 40.3 }));
    const alerts = await db.collection("alerts").get();
    expect(alerts.size).toBe(1);
    const a = alerts.docs[0];
    expect(a.id).toBe("b0");
    expect(a.data()).toMatchObject({ dogId: "toby", dogName: "Toby", ownerId: "lucia", status: "open",
      severity: "amber", provisional: true, resultId: "b0" });
    expect(a.get("reasons")[0]).toMatchObject({ component: "temperature", code: "temp_high", value: 40.3 });
    expect(await countOpenAlerts(db, "toby")).toBe(1);
    expect((await db.doc("dogs/toby").get()).get("status.openAlerts")).toBe(1);
  });

  it("dates the alert with the data time of the episode and closes it after the gap", async () => {
    for (let k = 0; k < 6; k++) await processReading(db, `b${k}`, reading(k, { temp: 40.3 }));
    let a = await db.doc("alerts/b0").get();
    expect(a.get("startedAt").toMillis()).toBe(T0 + 2_000);  // second window of the first block
    expect(a.get("endedAt")).toBeNull();
    for (let k = 6; k < 12; k++) await processReading(db, `b${k}`, reading(k));
    a = await db.doc("alerts/b0").get();
    expect(a.get("endedAt").toMillis()).toBe(T0 + 60_000);   // end of the last hot window (block 5)
  });

  it("aggregates 5-minute trend slots and anchors dogs.status at the last block", async () => {
    for (let k = 0; k < 7; k++) await processReading(db, `b${k}`, reading(k));
    // Every block writes the slot being filled, so the charts move with each block.
    const day = new Date(T0).toISOString().slice(0, 10);
    const doc = await db.doc(`trends/toby_${day}`).get();
    expect(doc.data()).toMatchObject({ dogId: "toby", ownerId: "lucia", day, slotMinutes: 5 });
    expect(doc.get("slots")[String((10 * 60) / 5)]).toMatchObject({ n: 7, hrN: 70, hrMin: 70, hrMax: 70, tN: 7, w: 35, act: 0 });
    expect((await db.doc("dogState/toby").get()).get("trend")).toMatchObject({ day, pending: 0 });
    // With blocks 10 s apart the status (statusMinIntervalS of data time) follows every block.
    expect((await db.doc("dogs/toby").get()).get("status.lastBlockAt").toMillis()).toBe(T0 + 60_000);
    // A block in the next slot starts a new one and leaves the previous slot as it was.
    await processReading(db, "b30", reading(30));
    const slots = (await db.doc(`trends/toby_${day}`).get()).get("slots");
    expect([slots[String(120)].n, slots[String(121)].n]).toEqual([7, 1]);
  });

  it("does not overwrite the acknowledgement when the episode keeps updating its alert", async () => {
    await processReading(db, "b0", reading(0, { temp: 39.6 }));  // HS 86
    await db.doc("alerts/b0").update({ status: "acknowledged", acknowledgedBy: "lucia", acknowledgedAt: Timestamp.now() });
    // A much hotter block worsens the episode (HS 80, 6 points lower) and updates the same alert.
    await processReading(db, "b1", reading(1, { temp: 41.2 }));
    const a = (await db.doc("alerts/b0").get()).data()!;
    expect(a.status).toBe("acknowledged");
    expect(a.lastResultId).toBe("b1");
    expect((await db.collection("alerts").get()).size).toBe(1);
  });

  it("writes dogs.status at most every statusMinIntervalS of data time unless the level changes", async () => {
    await db.doc("config/fusion").set({ statusMinIntervalS: 30, updatedBy: "admin", updatedAt: Timestamp.now() });
    resetConfigCache();
    const at = async () => (await db.doc("dogs/toby").get()).get("status.lastBlockAt").toMillis();
    await processReading(db, "b0", reading(0));
    expect(await at()).toBe(T0);
    await processReading(db, "b1", reading(1));
    await processReading(db, "b2", reading(2));
    expect(await at()).toBe(T0);
    await processReading(db, "b3", reading(3));
    expect(await at()).toBe(T0 + 30_000);
    await processReading(db, "b4", reading(4, { temp: 41.5 }));   // the level changes: written at once
    expect(await at()).toBe(T0 + 40_000);
  });

  it("writes the 1-minute and 10 s trend tiers with every block, in small documents", async () => {
    for (let k = 0; k < 7; k++) await processReading(db, `b${k}`, reading(k));
    const minute = (await db.doc("trendsMinute/toby_2026-10-01T10").get()).data()!;
    expect(minute).toMatchObject({ dogId: "toby", ownerId: "lucia", startMs: T0, slotMs: 60_000 });
    expect([minute.slots["0"].n, minute.slots["1"].n]).toEqual([6, 1]);         // 10:00-10:01 and 10:01-10:02
    const ten = (await db.doc("trendsTenSec/toby_2026-10-01T1000").get()).data()!;
    expect(ten).toMatchObject({ startMs: T0, slotMs: 10_000 });
    expect(Object.keys(ten.slots)).toHaveLength(7);
    expect(ten.slots["6"]).toMatchObject({ n: 1, hrN: 10, hrv: Array(10).fill(70) });
    expect(ten.expireAt.toMillis()).toBe(T0 + 600_000 + 7 * 86_400_000);
    expect(minute.slots["0"].hrv).toBeUndefined();
  });

  it("processes a 2 s block like the simulator sends it", async () => {
    const imu: number[] = [];
    for (let i = 0; i < 200; i++) imu.push(0, 0, 1, 0, 0, 0);
    await processReading(db, "s0", reading(0, { imu, hr: [70, 71], blockSeconds: 2 }));
    await processReading(db, "s1", reading(0, { imu, hr: [72, 73], blockStart: Timestamp.fromMillis(T0 + 2_000), blockSeconds: 2 }));
    const r = (await db.doc("results/s1").get()).data()!;
    expect(r.prefilterFlags.filter((f: string) => f.startsWith("imu_length") || f.startsWith("gap"))).toEqual([]);
    expect(r.hrValues).toEqual([72, 73]);
    expect((await db.doc("dogState/toby").get()).get("lastBlockEndMs")).toBe(T0 + 4_000);
    expect((await db.doc("trendsTenSec/toby_2026-10-01T1000").get()).get("slots")["0"]).toMatchObject({ n: 2, hrv: [70, 71, 72, 73] });
  });

  it("keeps the heart-rate values of the block in its result for the live view", async () => {
    await processReading(db, "b0", reading(0, { hr: [70, 71, 72, 400, 73] }));
    expect((await db.doc("results/b0").get()).get("hrValues")).toEqual([70, 71, 72, 73]);   // 400 lpm: prefiltered out
  });

  it("does not let a late block rewind the engine memory", async () => {
    await processReading(db, "b5", reading(5));
    await processReading(db, "b3", reading(3));
    expect((await db.doc("results/b3").get()).get("prefilterFlags")).toContain("out_of_order");
    expect((await db.doc("dogState/toby").get()).get("lastBlockStartMs")).toBe(T0 + 50_000);
  });

  it("never uses the injected ground truth", async () => {
    await db.doc("dogs/twin").set({ name: "Twin", ownerId: "lucia", active: true, baseline, schemaVersion: 1 });
    await processReading(db, "plain", reading(0, { temp: 40.0 }));
    await processReading(db, "truth", reading(0, { dogId: "twin", temp: 40.0, injectedAnomaly: { type: "fever", magnitude: 1.5, durationS: 600 } }));
    const pick = (d: FirebaseFirestore.DocumentData) => ({ rB: d.rB, rP: d.rP, rT: d.rT, hs: d.healthScore, level: d.level });
    expect(pick((await db.doc("results/truth").get()).data()!)).toEqual(pick((await db.doc("results/plain").get()).data()!));
  });

  it("reads weights and thresholds from config/fusion", async () => {
    await db.doc("config/fusion").set({ weights: { b: 0.2, p: 0.2, t: 0.6 }, updatedBy: "admin", updatedAt: Timestamp.now() });
    resetConfigCache();
    await processReading(db, "b0", reading(0, { temp: 39.8 }));
    const r = (await db.doc("results/b0").get()).data()!;
    expect(r.healthScore).toBe(Math.round(100 * (1 - 0.6 * r.rT)));
  });

  it("classifies behavior with the CNN-LSTM when the dog has IMU statistics", async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, "metadata.json"), "utf8"));
    await db.doc("dogs/toby").update({ baseline: { ...baseline, imuMean: [0, 0, 0.9, 0, 0, 0], imuStd: [0.5, 0.5, 0.5, 60, 60, 60], activitySource: meta.version } });
    await processReading(db, "b0", reading(0));
    const r = (await db.doc("results/b0").get()).data()!;
    expect(meta.classes).toContain(r.predictedBehavior);
    expect(r.behaviorProbs).toHaveLength(7);
    expect(r.modelVersions.behavior).toBe(meta.version);
    expect(r.prefilterFlags).not.toContain("behavior_rules");
    const status = (await db.doc("dogs/toby").get()).get("status");
    expect(status).toMatchObject({ lastBehavior: r.predictedBehavior, behaviorModel: meta.version });
  });

  it("scores the heart rate with the autoencoder once there are 60 s of it", async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(PHYSIO_BUNDLE_DIR, "metadata.json"), "utf8"));
    for (let k = 0; k < 7; k++) await processReading(db, `b${k}`, reading(k));
    const warm = (await db.doc("results/b0").get()).data()!;
    expect(warm.modelVersions.physiological).toBe(ENGINE_VERSION);
    expect(warm.prefilterFlags).toContain("physio_warmup");
    const r = (await db.doc("results/b6").get()).data()!;
    expect(r.modelVersions.physiological).toBe(meta.version);
    expect(r.signals.hrRatio).toBeGreaterThan(0);
    expect(r.prefilterFlags).not.toContain("physio_rules");
    expect(r.prefilterFlags).not.toContain("physio_warmup");
    expect((await db.doc("dogState/toby").get()).get("hrBuffer")).toHaveLength(60);
  });

  it("falls back to the movement rule when the dog has no IMU statistics", async () => {
    await processReading(db, "b0", reading(0));
    const r = (await db.doc("results/b0").get()).data()!;
    expect(r.predictedBehavior).toBeNull();
    expect(r.prefilterFlags).toContain("behavior_rules");
  });

  it("flags impossible values through the prefilter", async () => {
    await processReading(db, "b0", reading(0, { hr: [15, 70, 320], temp: 50 }));
    const r = (await db.doc("results/b0").get()).data()!;
    expect(r.prefilterFlags).toEqual(expect.arrayContaining(["hr_out_of_range:2", "temp_out_of_range"]));
    expect(r.signals.temp).toBeNull();
  });
});

describe("phase 5", () => {
  const csv = (k: number) => reading(k, { source: "csv", sourceRef: "up1" });

  it("counts the CSV blocks in their upload once each and marks it done", async () => {
    await db.doc("csvUploads/up1").set({ dogId: "toby", ownerId: "lucia", uploadedBy: "lucia", fileName: "a.csv", status: "validated", blocksExpected: 3, blocksProcessed: 0 });
    await processReading(db, "up1_000000", csv(0));
    expect((await db.doc("csvUploads/up1").get()).data()).toMatchObject({ blocksProcessed: 1, status: "processing" });
    for (const k of [1, 2]) await processReading(db, `up1_00000${k}`, csv(k));
    expect(await processReading(db, "up1_000002", csv(2))).toBe("duplicate");
    const up = (await db.doc("csvUploads/up1").get()).data()!;
    expect(up).toMatchObject({ blocksProcessed: 3, status: "done" });
    expect(up.completedAt).toBeTruthy();
    // Its last minute reaches the trends at once (3 blocks, fewer than the usual 6 before a write).
    const day = new Date(T0).toISOString().slice(0, 10);
    expect((await db.doc(`trends/toby_${day}`).get()).get("slots.120.n")).toBe(3);
    // ... and dogs.status shows the last block, though it is written at most every 10 s.
    expect((await db.doc("dogs/toby").get()).get("status.lastBlockAt").toMillis()).toBe(T0 + 20_000);
    expect(await processReading(db, "orphan", reading(3, { source: "csv", sourceRef: "missing" }))).toBe("written");
  });

  it("learns the baseline of a dog without one, then its activity with the behavioral model", async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, "metadata.json"), "utf8"));
    await db.doc("config/fusion").set({ ...DEFAULT_FUSION_CONFIG, baseline: { minBlocks: 7 } });
    await db.doc("dogs/toby").set({ name: "Toby", ownerId: "lucia", active: true, schemaVersion: 1 });
    await processReading(db, "b0", reading(0));
    expect((await db.doc("results/b0").get()).get("prefilterFlags")).toContain("no_baseline");
    expect((await db.doc("dogs/toby").get()).get("status.baselineProgress")).toEqual({ stage: "initial", share: 0.143 });
    for (let k = 1; k < 7; k++) await processReading(db, `b${k}`, reading(k));
    let dog = (await db.doc("dogs/toby").get()).data()!;
    expect(dog.baseline).toMatchObject({ origin: "function", activitySource: "rules", hrMean: 70, hrStd: 0, tempMean: 38.6, activeRatioMean: 0 });
    expect(dog.baseline.imuMean).toEqual([0, 0, 1, 0, 0, 0]);
    expect(dog.status.baselineProgress).toBeNull();
    for (let k = 7; k < 14; k++) await processReading(db, `b${k}`, reading(k));
    dog = (await db.doc("dogs/toby").get()).data()!;
    expect(dog.baseline.activitySource).toBe(meta.version);
    expect(dog.baseline.imuMean).toEqual([0, 0, 1, 0, 0, 0]);
    expect((await db.doc("dogState/toby").get()).get("baselineAcc")).toBeNull();
    expect((await db.doc("results/b13").get()).get("modelVersions.behavior")).toBe(meta.version);
  });

  it("lets the owner or an admin discard the learned baseline, nobody else", async () => {
    await db.doc("dogs/toby").update({ baseline: { ...baseline, origin: "function" }, status: { healthScore: 90, level: "green", openAlerts: 0 } });
    await expect(resetDogBaseline(db, "toby", { uid: "otro", admin: false })).rejects.toThrow();
    await resetDogBaseline(db, "toby", { uid: "lucia", admin: false });
    const dog = (await db.doc("dogs/toby").get()).data()!;
    expect(dog.baseline).toBeUndefined();
    expect(dog.status).toMatchObject({ healthScore: 90, baselineProgress: { stage: "initial", share: 0 } });
    expect((await db.doc("dogState/toby").get()).get("baselineAcc")).toBeNull();
    await resetDogBaseline(db, "toby", { uid: "admin1", admin: true });
  });

  it("records one push attempt per alert and kind, and drops tokens of browsers that left", async () => {
    await db.doc("users/lucia").set({ role: "owner", fcmTokens: ["good", "gone"] });
    const reasons = [{ component: "temperature", code: "temp_high", value: 40.2, normalRange: [37.7, 39.5], message: "" }];
    await db.doc("alerts/a1").set({ dogId: "toby", ownerId: "lucia", dogName: "Toby", severity: "amber", status: "open", reasons, notified: false });
    const sent: string[][] = [];
    const sender: PushSender = { send: async (tokens, m) => { sent.push(tokens); expect(m.title).toBe("Toby: su temperatura estuvo alta"); return { sent: 1, failed: 1, invalidTokens: ["gone"] }; } };
    expect(await notifyAlert(db, "a1", "new", sender, "https://x.web.app")).toEqual({ sent: 1, failed: 1, skipped: null });
    expect(await notifyAlert(db, "a1", "new", sender, "https://x.web.app")).toBeNull();
    expect(sent).toEqual([["good", "gone"]]);
    const a1 = (await db.doc("alerts/a1").get()).data()!;
    expect(a1).toMatchObject({ notified: true, notify: { new: { sent: 1, failed: 1, skipped: null } } });
    expect((await db.doc("users/lucia").get()).get("fcmTokens")).toEqual(["good"]);
    await db.doc("users/lucia").update({ notificationPrefs: { red: true, amber: false } });
    await db.doc("alerts/a2").set({ dogId: "toby", ownerId: "lucia", dogName: "Toby", severity: "amber", status: "open", reasons, notified: false });
    expect(await notifyAlert(db, "a2", "new", sender, "https://x.web.app")).toEqual({ sent: 0, failed: 0, skipped: "prefs" });
    expect((await db.doc("alerts/a2").get()).get("notified")).toBe(false);
    expect(await notifyAlert(db, "a2", "escalated", sender, "https://x.web.app")).toEqual({ sent: 1, failed: 1, skipped: null });
  });
});
