/**
 * Around alerts:
 * - when an alert is marked as reviewed, recount the dog's open alerts (idempotent: a recount, not a decrement) and
 *   store it in dogState and dogs.status;
 * - when an open alert rises from "Atención" (amber) to "Revisar" (red), push it again to the owner.
 */
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { REGION } from "./config";
import { countOpenAlerts } from "./readings";
import { appUrl, notifyAlert, pushSender } from "./notify";

export const onAlertUpdated = onDocumentUpdated({ document: "alerts/{alertId}", region: REGION, retry: true }, async (event) => {
  const before = event.data?.before.data(), after = event.data?.after.data();
  if (!before || !after) return;
  const db = getFirestore();
  if (before.status !== after.status) {
    const open = await countOpenAlerts(db, after.dogId);
    const batch = db.batch();
    batch.set(db.doc(`dogState/${after.dogId}`), { openAlerts: open }, { merge: true });
    const dog = await db.doc(`dogs/${after.dogId}`).get();
    if (dog.exists && dog.get("status")) batch.update(dog.ref, { "status.openAlerts": open });
    await batch.commit();
  }
  if (before.severity === "amber" && after.severity === "red" && after.status === "open") {
    await notifyAlert(db, event.params.alertId, "escalated", pushSender(), appUrl());
  }
});
