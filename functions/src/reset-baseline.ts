/**
 * "Volver a aprender su patrón normal": the owner (or an admin) discards the dog's baseline, for example
 * when its first data were not normal. The next blocks start the baseline again (shared/baseline.ts). Owners cannot
 * write dogs.baseline themselves (firestore.rules), so this goes through a callable function.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { REGION } from "./config";

export async function resetDogBaseline(db: Firestore, dogId: string, caller: { uid: string; admin: boolean }): Promise<void> {
  const dogRef = db.doc(`dogs/${dogId}`);
  await db.runTransaction(async (tx) => {
    const dog = await tx.get(dogRef);
    if (!dog.exists) throw new HttpsError("not-found", "No encontramos este perro.");
    if (!caller.admin && dog.get("ownerId") !== caller.uid) throw new HttpsError("permission-denied", "Este perro no está en tu cuenta.");
    tx.update(dogRef, {
      baseline: FieldValue.delete(),
      // Only when the dog already has a status: a partial status would look like data in the app.
      ...(dog.get("status") ? { "status.baselineProgress": { stage: "initial", share: 0 } } : {}),
    });
    tx.set(db.doc(`dogState/${dogId}`), { baselineAcc: null }, { merge: true });
  });
}

export const resetBaseline = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para continuar.");
  const dogId = String(req.data?.dogId ?? "").trim();
  if (!dogId || dogId.includes("/")) throw new HttpsError("invalid-argument", "Falta el perro.");
  await resetDogBaseline(getFirestore(), dogId, { uid: req.auth.uid, admin: req.auth.token.role === "admin" });
  return { ok: true };
});
