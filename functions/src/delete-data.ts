/**
 * «Borrar mis datos». The owner deletes for good the data
 * of one dog or of the whole account: readings, results, the three trend tiers, alerts, uploads, the engine memory, the
 * research documents that name the dog, the dog itself and, for the account, the profile and the sign-in. Owners cannot
 * delete most of these with the client rules, so it goes through a callable function with the Admin SDK.
 *
 * A dog that a simulator run is still feeding is refused: the run would write its data again while it is deleted.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore";
import { REGION } from "./config";

/** Collections with one document per block, slot or alert of a dog: they carry dogId and ownerId. */
const DOG_DATA = ["readings", "results", "trends", "trendsMinute", "trendsTenSec", "alerts", "csvUploads"] as const;
/** Research collections (admin only) that name the dog: the annotated behavior of a run and the expert review queue. */
const RESEARCH = ["simulatorTruth", "expertReviews"] as const;
const PAGE = 400;

export const CONFIRM_WORD = "BORRAR";

export interface DeleteSummary { dogs: number; documents: number; account: boolean }

/** Deletes every document of a query, a page at a time, reading only the references (a reading is about 48 KB). */
async function deleteQuery(db: Firestore, query: Query): Promise<number> {
  let total = 0;
  for (;;) {
    const page = await query.select().limit(PAGE).get();
    if (page.empty) return total;
    const writer = db.bulkWriter();
    page.docs.forEach((d) => void writer.delete(d.ref));
    await writer.close();
    total += page.size;
    if (page.size < PAGE) return total;
  }
}

async function activeRun(db: Firestore, dogId: string): Promise<boolean> {
  const runs = await db.collection("simulatorRuns").where("dogIds", "array-contains", dogId).get();
  return runs.docs.some((r) => r.get("state") === "running" || r.get("state") === "paused");
}

async function deleteDog(db: Firestore, dogId: string): Promise<number> {
  let n = 0;
  for (const c of [...DOG_DATA, ...RESEARCH]) n += await deleteQuery(db, db.collection(c).where("dogId", "==", dogId));
  const state = db.doc(`dogState/${dogId}`);
  if ((await state.get()).exists) { await state.delete(); n++; }
  await db.doc(`dogs/${dogId}`).delete();
  return n + 1;
}

/**
 * The Firestore part, testable with the emulator. `dogId` deletes one dog of the caller; without it, every dog of the
 * caller (archived ones too), whatever else still carries their ownerId, and their profile.
 */
export async function deleteOwnerData(db: Firestore, uid: string, dogId?: string): Promise<DeleteSummary> {
  if (dogId) {
    const dog = await db.doc(`dogs/${dogId}`).get();
    if (!dog.exists) throw new HttpsError("not-found", "No encontramos este perro.");
    if (dog.get("ownerId") !== uid) throw new HttpsError("permission-denied", "Este perro no está en tu cuenta.");
    if (await activeRun(db, dogId)) throw new HttpsError("failed-precondition", "Este perro está recibiendo datos de una demostración en curso. Espera a que termine y vuelve a intentarlo.");
    return { dogs: 1, documents: await deleteDog(db, dogId), account: false };
  }
  const dogs = await db.collection("dogs").where("ownerId", "==", uid).get();
  for (const d of dogs.docs) {
    if (await activeRun(db, d.id)) throw new HttpsError("failed-precondition", `${d.get("name") ?? "Un perro"} está recibiendo datos de una demostración en curso. Espera a que termine y vuelve a intentarlo.`);
  }
  let documents = 0;
  for (const d of dogs.docs) documents += await deleteDog(db, d.id);
  // Anything left with the owner's id (a dog deleted earlier by other means, for example).
  for (const c of DOG_DATA) documents += await deleteQuery(db, db.collection(c).where("ownerId", "==", uid));
  const profile = db.doc(`users/${uid}`);
  if ((await profile.get()).exists) { await profile.delete(); documents++; }
  return { dogs: dogs.size, documents, account: true };
}

export const deleteMyData = onCall({ region: REGION, timeoutSeconds: 540, memory: "512MiB" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para continuar.");
  if (req.data?.confirm !== CONFIRM_WORD) throw new HttpsError("invalid-argument", "Falta la confirmación.");
  const scope = req.data?.scope;
  if (scope !== "dog" && scope !== "account") throw new HttpsError("invalid-argument", "Falta qué borrar.");
  const dogId = scope === "dog" ? String(req.data?.dogId ?? "").trim() : undefined;
  if (scope === "dog" && (!dogId || dogId.includes("/"))) throw new HttpsError("invalid-argument", "Falta el perro.");
  const summary = await deleteOwnerData(getFirestore(), req.auth.uid, dogId);
  // The sign-in goes last: if anything above failed, the person can still sign in and try again.
  if (scope === "account") await getAuth().deleteUser(req.auth.uid);
  return summary;
});
