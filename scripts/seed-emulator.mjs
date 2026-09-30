// Seeds the local Firebase emulators with fictitious demo accounts, dogs and the default config/fusion.
// Usage: npm run emulators (in another terminal), then npm run emulators:seed
// Safety: it only runs against a "demo-" project and forces the emulator hosts, so it can never touch a real project.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { DOGS, FUSION, SCHEMA_VERSION, USERS, modelVersionDocs } from "./demo-data.mjs";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "demo-perros-tesis";
if (!PROJECT_ID.startsWith("demo-")) {
  console.error(`Refusing to seed "${PROJECT_ID}": only demo-* projects (emulators) are allowed. For the real project use scripts/bootstrap-prod.mjs.`);
  process.exit(1);
}
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";

initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const db = getFirestore();
const PASSWORD = "demo-1234";

async function upsertUser(u) {
  try {
    await auth.getUser(u.uid);
    await auth.updateUser(u.uid, { email: u.email, displayName: u.displayName, password: PASSWORD });
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    await auth.createUser({ uid: u.uid, email: u.email, displayName: u.displayName, password: PASSWORD, emailVerified: true });
  }
  await auth.setCustomUserClaims(u.uid, { role: u.role });
  await db.doc(`users/${u.uid}`).set({
    role: u.role, displayName: u.displayName, email: u.email, fcmTokens: [],
    privacyConsentAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp(),
  });
}

try {
  for (const u of USERS) await upsertUser(u);
  const batch = db.batch();
  for (const { id, ...d } of DOGS) {
    // No status/baseline: the simulator computes the baseline from the dog's sources and the Function writes status.
    batch.set(db.doc(`dogs/${id}`), { ...d, active: true, schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp() });
  }
  batch.set(db.doc("config/fusion"), { ...FUSION, updatedBy: "admin-demo", updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION });
  const models = modelVersionDocs();
  for (const m of models) batch.set(db.doc(`modelVersions/${m.id}`), m.doc);
  await batch.commit();
  console.log(`Seeded ${PROJECT_ID}: ${USERS.length} users, ${DOGS.length} dogs, config/fusion${models.map((m) => `, modelVersions/${m.id}`).join("")}.`);
  console.log(`Password for every account: ${PASSWORD}`);
  for (const u of USERS) console.log(`  ${u.role.padEnd(5)}  ${u.email}`);
} catch (e) {
  if (e.code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed/.test(String(e.message))) {
    console.error("Could not reach the emulators. Start them first with: npm run emulators");
  } else {
    console.error(e);
  }
  process.exit(1);
}
