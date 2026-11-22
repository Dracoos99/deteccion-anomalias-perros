// A person who tries to break the app without the interface, with the client SDK against the local emulators: an
// owner's session (Martín) and no session or a fresh account. Everything must be refused except the controls.
// Needs: emulators (Firestore, Auth and Functions) and the seed. Writes one CSV upload and one block for Canela.
// With an alert of Bruno (e.g. a fever from the simulator) it also checks the alert fields; without one, they are skipped.
// Usage: npm run test:e2e:attack
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword } from "firebase/auth";
import {
  addDoc, collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, initializeFirestore, limit, query,
  serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const app = initializeApp({ projectId: "demo-perros-tesis", apiKey: "demo-key", authDomain: "demo-perros-tesis.firebaseapp.com" });
const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const db = initializeFirestore(app, { experimentalForceLongPolling: true }); connectFirestoreEmulator(db, "127.0.0.1", 8080);
const fns = getFunctions(app, "us-central1"); connectFunctionsEmulator(fns, "127.0.0.1", 5001);

const rows = [];
async function expect(name, shouldPass, fn) {
  let ok, detail = "";
  try { await fn(); ok = true; } catch (e) { ok = false; detail = e.code ?? e.message; }
  const pass = ok === shouldPass;
  rows.push(`${pass ? "PASS" : "FAIL"}  ${shouldPass ? "permitido" : "rechazado"}  ${name}${pass ? "" : `  — ${ok ? "se aceptó" : detail}`}`);
}
let UPLOAD = "none";
const csvBlock = (dogId, extra = {}) => ({
  dogId, ownerId: "martin-quispe", source: "csv", sourceRef: UPLOAD, blockStart: Timestamp.now(), imuHz: 100,
  imu: new Array(6000).fill(0), hr: [], processed: false, expireAt: Timestamp.fromMillis(Date.now() + 7 * 864e5),
  schemaVersion: 1, createdAt: serverTimestamp(), ...extra,
});

// ── Scenario 4: Martín (owner of Bruno and Canela) attacks with his own session ──
await signInWithEmailAndPassword(auth, "martin.quispe@example.com", "demo-1234");
await expect("controles: leer su perro Bruno", true, () => getDoc(doc(db, "dogs/bruno")));
await expect("controles: listar sus alertas", true, () => getDocs(query(collection(db, "alerts"), where("ownerId", "==", "martin-quispe"), limit(5))));
await expect("controles: leer config/fusion", true, () => getDoc(doc(db, "config/fusion")));
await expect("controles: cambiar su nombre a uno válido", true, () => updateDoc(doc(db, "users/martin-quispe"), { displayName: "Martín Quispe" }));
await expect("leer Toby, perro de otra dueña", false, () => getDoc(doc(db, "dogs/toby")));
await expect("listar las alertas de Lucía", false, () => getDocs(query(collection(db, "alerts"), where("ownerId", "==", "lucia-paredes"))));
await expect("listar todos los resultados sin filtro", false, () => getDocs(query(collection(db, "results"), limit(5))));
await expect("listar todos los perros sin filtro", false, () => getDocs(query(collection(db, "dogs"), limit(5))));
await expect("leer el perfil de Lucía", false, () => getDoc(doc(db, "users/lucia-paredes")));
await expect("subirse a admin en su perfil", false, () => updateDoc(doc(db, "users/martin-quispe"), { role: "admin" }));
await expect("nombre de 81 caracteres", false, () => updateDoc(doc(db, "users/martin-quispe"), { displayName: "M".repeat(81) }));
await expect("escribir alertsCleared (retirado)", false, () => updateDoc(doc(db, "users/martin-quispe"), { alertsCleared: Timestamp.now() }));
await expect("poner Health Score 100 a Bruno", false, () => updateDoc(doc(db, "dogs/bruno"), { "status.healthScore": 100 }));
await expect("regalar Bruno a Lucía (cambiar ownerId)", false, () => updateDoc(doc(db, "dogs/bruno"), { ownerId: "lucia-paredes" }));
await expect("cambiar la línea base de Bruno", false, () => updateDoc(doc(db, "dogs/bruno"), { "baseline.hrMean": 1 }));
await expect("crear un perro a nombre de Lucía", false, () => addDoc(collection(db, "dogs"), { name: "Intruso", ownerId: "lucia-paredes", active: true, schemaVersion: 1, createdAt: serverTimestamp() }));
await expect("borrar a Bruno directamente (sin deleteMyData)", false, () => deleteDoc(doc(db, "dogs/bruno")));
await expect("cambiar los pesos de config/fusion", false, () => updateDoc(doc(db, "config/fusion"), { "weights.b": 0 }));
await expect("crear una ejecución del simulador", false, () => addDoc(collection(db, "simulatorRuns"), { createdBy: "martin-quispe", dogIds: ["toby"], speed: 10, state: "running" }));
await expect("crear una alerta falsa", false, () => addDoc(collection(db, "alerts"), { dogId: "bruno", ownerId: "martin-quispe", severity: "red", status: "open" }));
await expect("escribir un resultado", false, () => setDoc(doc(db, "results/fake"), { dogId: "bruno", ownerId: "martin-quispe", healthScore: 100 }));
await expect("registrar un modelo", false, () => setDoc(doc(db, "modelVersions/hack"), { kind: "behavior", active: true }));
await expect("controles: crear una carga CSV de Canela", true, async () => { const r = doc(collection(db, "csvUploads")); UPLOAD = r.id; await setDoc(r, { dogId: "canela", ownerId: "martin-quispe", uploadedBy: "martin-quispe", fileName: "x.csv", rows: 1000, columns: [], status: "validated", errors: [], warnings: [], blocksExpected: 1, blocksProcessed: 0, schemaVersion: 1, createdAt: serverTimestamp() }); });
await expect("controles: lectura CSV válida para su perra Canela", true, () => addDoc(collection(db, "readings"), csvBlock("canela")));
await expect("lectura con source simulator", false, () => addDoc(collection(db, "readings"), csvBlock("canela", { source: "simulator" })));
await expect("lectura CSV para Toby (perro ajeno)", false, () => addDoc(collection(db, "readings"), csvBlock("toby", { ownerId: "lucia-paredes" })));
await expect("carga CSV con 5000 bloques", false, () => setDoc(doc(collection(db, "csvUploads")), { dogId: "canela", ownerId: "martin-quispe", uploadedBy: "martin-quispe", status: "validated", blocksExpected: 5000, blocksProcessed: 0 }));
await expect("carga CSV ya marcada como terminada", false, () => setDoc(doc(collection(db, "csvUploads")), { dogId: "canela", ownerId: "martin-quispe", uploadedBy: "martin-quispe", status: "done", blocksExpected: 1, blocksProcessed: 1 }));
await expect("lectura CSV de Canela con imu de 7000 valores", false, () => addDoc(collection(db, "readings"), csvBlock("canela", { imu: new Array(7000).fill(0) })));
await expect("lectura CSV sin hora", false, () => addDoc(collection(db, "readings"), csvBlock("canela", { blockStart: "ayer" })));
await expect("lectura CSV a 50 Hz", false, () => addDoc(collection(db, "readings"), csvBlock("canela", { imuHz: 50 })));
await expect("lectura CSV con anomalía inyectada (ground truth)", false, () => addDoc(collection(db, "readings"), csvBlock("canela", { injectedAnomaly: { type: "fever", magnitude: 1, durationS: 60 } })));
const myAlerts = await getDocs(query(collection(db, "alerts"), where("ownerId", "==", "martin-quispe"), limit(1)));
if (myAlerts.empty) rows.push("SKIP  (Bruno aún no tiene alertas: no se probó su revisión experta ni el cambio de severidad)");
else {
  const a = myAlerts.docs[0].ref;
  await expect("escribir expertReview en su alerta", false, () => updateDoc(a, { expertReview: { relevant: false } }));
  await expect("bajar la severidad de su alerta", false, () => updateDoc(a, { severity: "amber" }));
  await expect("marcar como revisada por otra persona", false, () => updateDoc(a, { status: "acknowledged", acknowledgedBy: "lucia-paredes", acknowledgedAt: serverTimestamp() }));
}
await expect("deleteMyData sobre Toby (perro ajeno)", false, async () => { await httpsCallable(fns, "deleteMyData")({ scope: "dog", dogId: "toby" }); });
await expect("resetBaseline sobre Toby (perro ajeno)", false, async () => { await httpsCallable(fns, "resetBaseline")({ dogId: "toby" }); });
await signOut(auth);

// ── Scenario 5: no session, and a fresh account that tries to make itself admin ──
await expect("sin sesión: leer un perro", false, () => getDoc(doc(db, "dogs/bruno")));
await expect("sin sesión: leer config/fusion", false, () => getDoc(doc(db, "config/fusion")));
await expect("sin sesión: deleteMyData", false, async () => { await httpsCallable(fns, "deleteMyData")({ scope: "account" }); });
const cred = await createUserWithEmailAndPassword(auth, `intruso.${Date.now()}@example.com`, "clave-segura-1");
const uid = cred.user.uid;
await expect("cuenta nueva: crearse el perfil como admin", false, () => setDoc(doc(db, `users/${uid}`), { role: "admin", displayName: "X", email: cred.user.email, fcmTokens: [], schemaVersion: 1, createdAt: serverTimestamp() }));
await expect("cuenta nueva: leer la bitácora configHistory", false, () => getDocs(query(collection(db, "configHistory"), limit(1))));
await expect("cuenta nueva: listar simulatorRuns", false, () => getDocs(query(collection(db, "simulatorRuns"), limit(1))));
const token = await cred.user.getIdTokenResult(true);
rows.push(`${token.claims.role === "admin" ? "FAIL" : "PASS"}  rechazado  cuenta nueva sin claim admin (claim: ${token.claims.role ?? "ninguno"})`);
await cred.user.delete();

console.log(rows.join("\n"));
const fails = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${rows.filter((r) => r.startsWith("PASS")).length} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
