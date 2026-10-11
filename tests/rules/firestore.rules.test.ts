// Security rules tests (run with: npm run test:rules). Cover the access matrix,,
// (owners and a script-assigned admin; no vet role), (CSV uploads, notification tokens),
// (clearing the Alertas list and undoing a review) (archiving a dog).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  Timestamp, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where,
} from "firebase/firestore";

let env: RulesTestEnvironment;
const owner = () => env.authenticatedContext("owner1", { role: "owner" }).firestore();
const otherOwner = () => env.authenticatedContext("owner2", { role: "owner" }).firestore();
// An account from before that still carries the retired claim: it must get nothing.
const legacyVet = () => env.authenticatedContext("vet1", { role: "vet" }).firestore();
const noRole = () => env.authenticatedContext("new1", {}).firestore();
const admin = () => env.authenticatedContext("admin1", { role: "admin" }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const dog1 = { name: "Toby", ownerId: "owner1", active: true, schemaVersion: 1,
  status: { healthScore: 88, level: "green", openAlerts: 1 } };
const csvReading = { dogId: "dog1", ownerId: "owner1", source: "csv", sourceRef: "up1",
  imuHz: 100, imu: [0, 0, 0, 0, 0, 0], hr: [], processed: false, schemaVersion: 1 };

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-perros-tesis",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
  });
});
afterAll(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/owner1"), { role: "owner", displayName: "Lucía", email: "l@example.com" });
    await setDoc(doc(db, "users/owner2"), { role: "owner", displayName: "Martín", email: "m@example.com" });
    await setDoc(doc(db, "dogs/dog1"), dog1);
    await setDoc(doc(db, "dogs/dog2"), { name: "Bruno", ownerId: "owner2", active: true, schemaVersion: 1 });
    await setDoc(doc(db, "results/r1"), { dogId: "dog1", ownerId: "owner1", healthScore: 88 });
    await setDoc(doc(db, "alerts/a1"), { dogId: "dog1", ownerId: "owner1", severity: "red", status: "open" });
    await setDoc(doc(db, "alerts/a2"), { dogId: "dog1", ownerId: "owner1", severity: "amber", status: "open" });
    await setDoc(doc(db, "config/fusion"), { alertThreshold: 60 });
    await setDoc(doc(db, "simulatorRuns/run1"), { state: "paused" });
    await setDoc(doc(db, "simulatorTruth/run1_dog1_000000"), { runId: "run1", dogId: "dog1", behavior: "lie" });
    await setDoc(doc(db, "expertReviews/item1"), { kind: "alert", dogId: "dog1", systemFlagged: true, order: 0, review: null });
    await setDoc(doc(db, "csvUploads/up1"), { dogId: "dog1", ownerId: "owner1", uploadedBy: "owner1", status: "processing", blocksExpected: 6, blocksProcessed: 0 });
    await setDoc(doc(db, "csvUploads/up2"), { dogId: "dog2", ownerId: "owner2", uploadedBy: "owner2", status: "processing", blocksExpected: 6, blocksProcessed: 0 });
  });
});

describe("dogs", () => {
  it("owner reads own dog, not others; admin reads all", async () => {
    await assertSucceeds(getDoc(doc(owner(), "dogs/dog1")));
    await assertFails(getDoc(doc(owner(), "dogs/dog2")));
    await assertSucceeds(getDoc(doc(admin(), "dogs/dog2")));
  });
  it("anonymous users, accounts without a role and retired vet claims read nothing", async () => {
    await assertFails(getDoc(doc(anon(), "dogs/dog1")));
    await assertFails(getDoc(doc(noRole(), "dogs/dog1")));
    await assertFails(getDoc(doc(legacyVet(), "dogs/dog1")));
  });
  it("owner creates a dog only for itself and without status/baseline", async () => {
    const base = { name: "Luna", ownerId: "owner1", active: true, schemaVersion: 1 };
    await assertSucceeds(setDoc(doc(owner(), "dogs/new1"), base));
    await assertFails(setDoc(doc(owner(), "dogs/new2"), { ...base, ownerId: "owner2" }));
    await assertFails(setDoc(doc(owner(), "dogs/new3"), { ...base, status: { healthScore: 100 } }));
    await assertFails(setDoc(doc(noRole(), "dogs/new4"), { ...base, ownerId: "new1" }));
  });
  it("owner edits profile fields but not ownerId or status", async () => {
    await assertSucceeds(updateDoc(doc(owner(), "dogs/dog1"), { name: "Toby II", weightKg: 30 }));
    await assertFails(updateDoc(doc(owner(), "dogs/dog1"), { status: { healthScore: 100 } }));
    await assertFails(updateDoc(doc(owner(), "dogs/dog1"), { ownerId: "owner2" }));
    await assertFails(updateDoc(doc(otherOwner(), "dogs/dog1"), { name: "X" }));
  });
  it("only the owner (or admin) deletes", async () => {
    await assertFails(deleteDoc(doc(otherOwner(), "dogs/dog1")));
    await assertSucceeds(deleteDoc(doc(owner(), "dogs/dog1")));
  });
  it("the owner archives its dog («Quitar perro») and brings it back; nobody else can", async () => {
    await assertFails(updateDoc(doc(otherOwner(), "dogs/dog1"), { active: false }));
    await assertFails(updateDoc(doc(owner(), "dogs/dog1"), { active: "no" }));
    await assertFails(updateDoc(doc(owner(), "dogs/dog1"), { active: false, status: { healthScore: 100 } }));
    await assertSucceeds(updateDoc(doc(owner(), "dogs/dog1"), { active: false, updatedAt: serverTimestamp() }));
    // The owner's lists ask only for its active dogs; the archived dog and its alerts stay readable (history, vet view).
    await assertSucceeds(getDocs(query(collection(owner(), "dogs"), where("ownerId", "==", "owner1"), where("active", "==", true))));
    await assertSucceeds(getDoc(doc(owner(), "dogs/dog1")));
    await assertSucceeds(getDoc(doc(owner(), "alerts/a1")));
    await assertSucceeds(updateDoc(doc(owner(), "dogs/dog1"), { active: true, updatedAt: serverTimestamp() }));
  });
});

describe("readings", () => {
  it("owner uploads CSV blocks of own dog", async () => {
    await assertSucceeds(setDoc(doc(owner(), "readings/b1"), csvReading));
  });
  it("owner cannot write simulator blocks, ground truth or blocks of other dogs", async () => {
    await assertFails(setDoc(doc(owner(), "readings/b2"), { ...csvReading, source: "simulator" }));
    await assertFails(setDoc(doc(owner(), "readings/b3"), { ...csvReading, injectedAnomaly: { type: "fever", magnitude: 40, durationS: 60 } }));
    await assertFails(setDoc(doc(owner(), "readings/b4"), { ...csvReading, ownerId: "owner2" }));
    await assertFails(setDoc(doc(owner(), "readings/b5"), { ...csvReading, dogId: "dog2" }));
    await assertFails(setDoc(doc(owner(), "readings/b6"), { ...csvReading, injectedAnomalies: [{ type: "fever", magnitude: 1.5, durationS: 60 }] }));
  });
  it("a CSV block must belong to an upload of the same owner and dog, within the block size", async () => {
    await assertFails(setDoc(doc(owner(), "readings/b7"), { ...csvReading, sourceRef: "up2" }));
    await assertFails(setDoc(doc(owner(), "readings/b8"), { ...csvReading, sourceRef: "missing" }));
    await assertFails(setDoc(doc(owner(), "readings/b9"), { ...csvReading, imu: new Array(6006).fill(0) }));
    await assertFails(setDoc(doc(owner(), "readings/b10"), { ...csvReading, hr: new Array(11).fill(70) }));
  });
});

describe("results", () => {
  it("readable by the owner, never writable by clients", async () => {
    await assertSucceeds(getDoc(doc(owner(), "results/r1")));
    await assertFails(getDoc(doc(otherOwner(), "results/r1")));
    await assertFails(setDoc(doc(owner(), "results/r2"), { dogId: "dog1", ownerId: "owner1" }));
    await assertFails(setDoc(doc(admin(), "results/r3"), { dogId: "dog1", ownerId: "owner1" }));
  });
});

describe("trends", () => {
  it("the owner and admin read the dog's aggregates; no client writes them", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "trends/dog1_2026-09-29"), { dogId: "dog1", ownerId: "owner1", day: "2026-09-29", slots: {} });
    });
    await assertSucceeds(getDoc(doc(owner(), "trends/dog1_2026-09-29")));
    await assertSucceeds(getDoc(doc(admin(), "trends/dog1_2026-09-29")));
    await assertFails(getDoc(doc(otherOwner(), "trends/dog1_2026-09-29")));
    await assertFails(setDoc(doc(owner(), "trends/dog1_2026-09-30"), { dogId: "dog1", ownerId: "owner1", day: "2026-09-30", slots: {} }));
  });
});

describe("dogState (engine memory)", () => {
  it("is invisible and read-only for every client, admin included", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "dogState/dog1"), { blocks: 3 }); });
    for (const db of [owner(), admin()]) {
      await assertFails(getDoc(doc(db, "dogState/dog1")));
      await assertFails(setDoc(doc(db, "dogState/dog1"), { blocks: 0 }));
    }
  });
});

describe("alerts", () => {
  it("the owner marks as reviewed with its uid and server time", async () => {
    await assertSucceeds(updateDoc(doc(owner(), "alerts/a1"), { status: "acknowledged", acknowledgedBy: "owner1", acknowledgedAt: serverTimestamp() }));
  });
  it("clients cannot create alerts, change severity or impersonate", async () => {
    await assertFails(setDoc(doc(owner(), "alerts/a9"), { dogId: "dog1", ownerId: "owner1" }));
    await assertFails(updateDoc(doc(owner(), "alerts/a1"), { severity: "amber" }));
    await assertFails(updateDoc(doc(owner(), "alerts/a1"), { status: "acknowledged", acknowledgedBy: "owner2", acknowledgedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(otherOwner(), "alerts/a1"), { status: "acknowledged", acknowledgedBy: "owner2", acknowledgedAt: serverTimestamp() }));
  });
  it("whoever reviewed an alert can make it new again within 10 minutes, and nobody else", async () => {
    const reopen = { status: "open", acknowledgedBy: null, acknowledgedAt: null };
    await assertSucceeds(updateDoc(doc(owner(), "alerts/a1"), { status: "acknowledged", acknowledgedBy: "owner1", acknowledgedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(otherOwner(), "alerts/a1"), reopen));
    await assertFails(updateDoc(doc(admin(), "alerts/a1"), reopen));
    await assertFails(updateDoc(doc(owner(), "alerts/a1"), { status: "open" }));
    await assertFails(updateDoc(doc(owner(), "alerts/a1"), { ...reopen, severity: "amber" }));
    await assertSucceeds(updateDoc(doc(owner(), "alerts/a1"), reopen));
    // A review older than 10 minutes stays.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "alerts/a3"), { dogId: "dog1", ownerId: "owner1", severity: "amber", status: "acknowledged",
        acknowledgedBy: "owner1", acknowledgedAt: Timestamp.fromMillis(Date.now() - 11 * 60_000) });
    });
    await assertFails(updateDoc(doc(owner(), "alerts/a3"), reopen));
    // Alerts are never deleted: the dog's history and the vet view are built from them.
    await assertFails(deleteDoc(doc(owner(), "alerts/a1")));
    await assertFails(deleteDoc(doc(admin(), "alerts/a2")));
  });
  it("only an admin writes the expert review, as itself and with server time", async () => {
    const review = { reviewerId: "admin1", relevant: true, notes: "", reviewedAt: serverTimestamp() };
    await assertFails(updateDoc(doc(owner(), "alerts/a2"), { expertReview: { ...review, reviewerId: "owner1" } }));
    await assertFails(updateDoc(doc(admin(), "alerts/a2"), { expertReview: { ...review, reviewerId: "someone" } }));
    await assertFails(updateDoc(doc(admin(), "alerts/a2"), { expertReview: review, severity: "red" }));
    await assertSucceeds(updateDoc(doc(admin(), "alerts/a2"), { expertReview: review }));
  });
});

describe("config, modelVersions and simulatorRuns", () => {
  it("everyone signed in reads config; only admin writes it, stamping who and when", async () => {
    await assertSucceeds(getDoc(doc(owner(), "config/fusion")));
    await assertFails(setDoc(doc(owner(), "config/fusion"), { alertThreshold: 50, updatedBy: "owner1", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(admin(), "config/fusion"), { alertThreshold: 50 }));
    await assertSucceeds(setDoc(doc(admin(), "config/fusion"), { alertThreshold: 50, updatedBy: "admin1", updatedAt: serverTimestamp() }));
  });
  it("simulator runs are admin only", async () => {
    await assertFails(getDoc(doc(owner(), "simulatorRuns/run1")));
    await assertSucceeds(getDoc(doc(admin(), "simulatorRuns/run1")));
  });
  it("the blind expert review is admin only", async () => {
    await assertFails(getDoc(doc(owner(), "expertReviews/item1")));
    await assertFails(updateDoc(doc(owner(), "expertReviews/item1"), { review: { verdict: "relevant" } }));
    await assertSucceeds(getDoc(doc(admin(), "expertReviews/item1")));
    await assertSucceeds(updateDoc(doc(admin(), "expertReviews/item1"), { review: { reviewerId: "admin1", verdict: "relevant", notes: "" } }));
  });
  it("the annotated behavior of simulated blocks is read by an admin only and written by the simulator only", async () => {
    await assertFails(getDoc(doc(owner(), "simulatorTruth/run1_dog1_000000")));
    await assertSucceeds(getDoc(doc(admin(), "simulatorTruth/run1_dog1_000000")));
    await assertFails(setDoc(doc(admin(), "simulatorTruth/run1_dog1_000001"), { runId: "run1", dogId: "dog1", behavior: "sit" }));
  });
});

describe("users", () => {
  it("profiles are created by the server only; a user edits its contact fields, never its role", async () => {
    await assertFails(setDoc(doc(noRole(), "users/new1"), { role: "owner", displayName: "Nueva", email: "n@example.com" }));
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { displayName: "Lucía P.", phone: "999 999 999" }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { role: "admin" }));
    await assertFails(updateDoc(doc(owner(), "users/owner2"), { displayName: "X" }));
  });
  it("a user reads only its own profile; admin reads all", async () => {
    await assertSucceeds(getDoc(doc(owner(), "users/owner1")));
    await assertFails(getDoc(doc(owner(), "users/owner2")));
    await assertSucceeds(getDoc(doc(admin(), "users/owner2")));
  });
  it("a user marks when it cleared its own Alertas list, for every dog or one, and undoes it", async () => {
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { "alertsCleared.all": serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { "alertsCleared.byDog.dog1": serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { "alertsCleared.all": deleteField() }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { "alertsCleared.other": serverTimestamp() }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { alertsCleared: "all" }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"),
      { "alertsCleared.byDog": Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`d${i}`, new Date()])) }));
    await assertFails(updateDoc(doc(otherOwner(), "users/owner1"), { "alertsCleared.all": serverTimestamp() }));
    await assertFails(updateDoc(doc(admin(), "users/owner1"), { "alertsCleared.all": serverTimestamp() }));
  });
});

describe("csvUploads", () => {
  const up = { dogId: "dog1", uploadedBy: "owner1", ownerId: "owner1", fileName: "a.csv", rows: 10, columns: [], status: "validated",
    errors: [], warnings: [], blocksExpected: 6, blocksProcessed: 0 };
  it("owner registers an upload of its own dog in validated state", async () => {
    await assertSucceeds(setDoc(doc(owner(), "csvUploads/u1"), up));
    await assertFails(setDoc(doc(owner(), "csvUploads/u2"), { ...up, status: "done" }));
    await assertFails(setDoc(doc(owner(), "csvUploads/u3"), { ...up, dogId: "dog2" }));
  });
  it("the processed count starts at 0 and the size stays bounded; only Functions move it", async () => {
    await assertFails(setDoc(doc(owner(), "csvUploads/u4"), { ...up, blocksProcessed: 6 }));
    await assertFails(setDoc(doc(owner(), "csvUploads/u5"), { ...up, blocksExpected: 0 }));
    await assertFails(setDoc(doc(owner(), "csvUploads/u6"), { ...up, blocksExpected: 5000 }));
    await assertFails(updateDoc(doc(owner(), "csvUploads/up1"), { blocksProcessed: 6, status: "done" }));
    await assertSucceeds(getDoc(doc(owner(), "csvUploads/up1")));
    await assertFails(getDoc(doc(owner(), "csvUploads/up2")));
  });
});

describe("configHistory", () => {
  it("only an admin appends a change log entry signed with its uid and the server time; nobody edits it", async () => {
    const entry = { changes: [{ field: "Pesos", before: "0.4 · 0.4 · 0.2", after: "0.5 · 0.3 · 0.2" }], updatedBy: "admin1", updatedAt: serverTimestamp() };
    await assertSucceeds(setDoc(doc(admin(), "configHistory/h1"), entry));
    await assertFails(setDoc(doc(admin(), "configHistory/h2"), { ...entry, updatedBy: "other" }));
    await assertFails(setDoc(doc(owner(), "configHistory/h3"), { ...entry, updatedBy: "owner1" }));
    await assertFails(updateDoc(doc(admin(), "configHistory/h1"), { changes: [] }));
    await assertFails(getDoc(doc(owner(), "configHistory/h1")));
  });
});

describe("notification settings", () => {
  it("a user stores its browser tokens and preferences, at most 10 tokens", async () => {
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { fcmTokens: ["t1", "t2"], notificationPrefs: { red: true, amber: false } }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { fcmTokens: Array.from({ length: 11 }, (_, i) => `t${i}`) }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { role: "admin" }));
    await assertFails(updateDoc(doc(otherOwner(), "users/owner1"), { fcmTokens: ["x"] }));
  });
  it("the quiet hours are two HH:MM hours and a time zone, or nothing", async () => {
    const quiet = { from: "22:00", to: "07:00", tz: "America/Lima" };
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { notificationPrefs: { red: true, amber: true, quiet } }));
    await assertSucceeds(updateDoc(doc(owner(), "users/owner1"), { notificationPrefs: { red: true, amber: true, quiet: null } }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { notificationPrefs: { red: true, amber: true, quiet: { ...quiet, from: "25:00" } } }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { notificationPrefs: { red: true, amber: true, quiet: { ...quiet, extra: 1 } } }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { notificationPrefs: { red: "yes", amber: true } }));
    await assertFails(updateDoc(doc(owner(), "users/owner1"), { notificationPrefs: { red: true, amber: true, sound: "loud" } }));
  });
});
