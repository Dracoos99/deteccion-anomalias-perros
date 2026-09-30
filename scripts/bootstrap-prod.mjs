// Bootstraps the real Firebase project (the "prod" alias of .firebaserc): first admin, config/fusion, modelVersions
// and, optionally, the fictitious demo dogs for the simulator.
// Credentials: Application Default Credentials (gcloud auth application-default login). Never a key file in the repo.
// Accounts are never created here: register them in the web app first, which records the Ley 29733 consent (RNF-03).
// Usage:
//   npm run prod:bootstrap -- --admin <email>                      grant "admin" to a registered account
//   npm run prod:bootstrap -- --dogs --owner <email>               create the 10 demo dogs for that owner account
// Both can go in one call. config/fusion is created only if missing (admins may have edited it); modelVersions is refreshed.
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { DOGS, FUSION, SCHEMA_VERSION, modelVersionDocs } from "./demo-data.mjs";

const { values: args } = parseArgs({
  options: {
    project: { type: "string" },
    admin: { type: "string" },
    dogs: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});

const rc = JSON.parse(fs.readFileSync(new URL("../.firebaserc", import.meta.url), "utf8"));
const PROJECT_ID = args.project || process.env.GCLOUD_PROJECT || rc.projects?.prod;
if (!PROJECT_ID || PROJECT_ID.startsWith("demo-")) {
  console.error(`Refusing to bootstrap "${PROJECT_ID ?? ""}": use a real project (the "prod" alias). For the emulators use npm run emulators:seed.`);
  process.exit(1);
}
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("Emulator host variables are set; unset FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST to reach the real project.");
  process.exit(1);
}
if (args.dogs && !args.owner) {
  console.error("--dogs needs --owner <email> (a registered owner account).");
  process.exit(1);
}

// Check the credentials first: without ADC the Firestore client fails in the background, outside any try/catch.
const credential = applicationDefault();
try {
  await credential.getAccessToken();
} catch {
  console.error("No Application Default Credentials. Run: gcloud auth application-default login");
  process.exit(1);
}
initializeApp({ projectId: PROJECT_ID, credential });
const auth = getAuth();
const db = getFirestore();

/** A registered account that finished sign-up in the app (users/{uid} exists), optionally with an expected role. */
async function registeredUser(email, expectedRole) {
  const user = await auth.getUserByEmail(email).catch((e) => {
    if (e.code === "auth/user-not-found") throw new Error(`${email} is not registered: create the account in the web app first.`);
    throw e;
  });
  const profile = await db.doc(`users/${user.uid}`).get();
  if (!profile.exists) throw new Error(`${email} has not finished sign-up in the web app (no users/${user.uid}).`);
  const role = user.customClaims?.role;
  if (expectedRole && role !== expectedRole) throw new Error(`${email} has role "${role ?? "none"}", expected "${expectedRole}".`);
  return { uid: user.uid, role };
}

async function grantAdmin(email) {
  const { uid, role } = await registeredUser(email);
  await auth.setCustomUserClaims(uid, { role: "admin" });
  await db.doc(`users/${uid}`).set({ role: "admin" }, { merge: true });
  console.log(`admin: ${email} (${role ?? "no role"} -> admin). Sign out and in again to refresh the token.`);
  return uid;
}

async function createDemoDogs(ownerEmail) {
  const owner = await registeredUser(ownerEmail, "owner");
  let created = 0;
  for (const { id, ...d } of DOGS) {
    // Every demo dog goes to the given owner.
    const doc = { ...d, ownerId: owner.uid, active: true,
      schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp() };
    try {
      await db.doc(`dogs/${id}`).create(doc);
      created++;
    } catch (e) {
      if (e.code !== 6) throw e; // ALREADY_EXISTS: keep the existing dog, its baseline and status
      console.log(`dogs/${id} already exists; left unchanged.`);
    }
  }
  console.log(`dogs: ${created} created for ${ownerEmail}.`);
}

try {
  const adminUid = args.admin ? await grantAdmin(args.admin) : null;

  const fusionRef = db.doc("config/fusion");
  if ((await fusionRef.get()).exists) {
    console.log("config/fusion already exists; left unchanged.");
  } else {
    await fusionRef.set({ ...FUSION, updatedBy: adminUid ?? "bootstrap", updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION });
    console.log("config/fusion: created with the defaults.");
  }

  for (const m of modelVersionDocs()) {
    await db.doc(`modelVersions/${m.id}`).set(m.doc);
    console.log(`modelVersions/${m.id}: written from ${m.doc.bundlePath}/metadata.json.`);
  }

  if (args.dogs) await createDemoDogs(args.owner);
  console.log(`Done: ${PROJECT_ID}.`);
} catch (e) {
  const msg = String(e?.message ?? e);
  if (/default credentials|invalid_grant|reauth/i.test(msg)) {
    console.error("No Application Default Credentials. Run: gcloud auth application-default login");
  } else if (/quota project/i.test(msg)) {
    console.error(`Run: gcloud auth application-default set-quota-project ${PROJECT_ID}`);
  } else {
    console.error(msg);
  }
  process.exit(1);
}
