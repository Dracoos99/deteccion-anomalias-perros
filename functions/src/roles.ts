/**
 * Sign-up completion with custom claims.
 * - setInitialRole: every new account becomes an "owner" and its profile stores the Ley N.° 29733 consent.
 *   There is no role choice: the app is for dog owners and never shows roles.
 * - "admin" is never granted here. It comes from a server-side script with the Admin SDK:
 *   scripts/seed-emulator.mjs (emulators) or scripts/bootstrap-prod.mjs (real project).
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { REGION, SCHEMA_VERSION } from "./config";

export const setInitialRole = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Inicia sesión para continuar.");
  // Accounts from before may carry the retired "vet" claim: they become owners like any new account.
  const current = req.auth.token.role;
  if (current === "owner" || current === "admin") throw new HttpsError("already-exists", "Tu cuenta ya está lista.");

  const displayName = String(req.data?.displayName ?? "").trim().slice(0, 80);
  if (!displayName) throw new HttpsError("invalid-argument", "Escribe tu nombre.");
  // RNF-03: the Ley N.° 29733 consent is mandatory and its timestamp is kept with the profile.
  if (req.data?.privacyConsent !== true) throw new HttpsError("failed-precondition", "Falta la autorización para tratar tus datos personales.");

  const role = "owner";
  const user = await getAuth().getUser(req.auth.uid);
  await getAuth().setCustomUserClaims(req.auth.uid, { role });
  await getFirestore().doc(`users/${req.auth.uid}`).set({
    role, displayName, email: user.email ?? "", privacyConsentAt: FieldValue.serverTimestamp(),
    schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp(),
  });
  return { role };
});
