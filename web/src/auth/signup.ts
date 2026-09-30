import { httpsCallable } from "firebase/functions";
import type { Role } from "@shared/types";
import { functions } from "../firebase";

/** Calls functions/src/roles.ts#setInitialRole and refreshes the ID token
 * so the new claim reaches the client. */
export async function completeSignUp(displayName: string, refreshRole: () => Promise<Role | null>): Promise<Role | null> {
  await httpsCallable(functions, "setInitialRole")({ displayName, privacyConsent: true });
  return refreshRole();
}
