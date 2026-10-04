import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import type { Functions } from "firebase/functions";

// With the demo project everything runs against the local emulators.
const env = import.meta.env;
const projectId = env.VITE_FIREBASE_PROJECT_ID || "demo-perros-tesis";

export const app = initializeApp({
  projectId,
  apiKey: env.VITE_FIREBASE_API_KEY || "demo-api-key",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  appId: env.VITE_FIREBASE_APP_ID || undefined,
  // The project number, needed by Firebase Cloud Messaging for browser notifications.
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || undefined,
});

export const auth = getAuth(app);
export const db = getFirestore(app);

export const usingEmulators = (env.VITE_USE_EMULATORS ?? "true") !== "false" || projectId.startsWith("demo-");
if (usingEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// Cloud Functions are only called on sign-up and on "Volver a aprender": their client loads the first time, not with
// the app.
let functionsReady: Promise<Functions> | null = null;
function functionsClient(): Promise<Functions> {
  functionsReady ??= import("firebase/functions").then(({ getFunctions, connectFunctionsEmulator }) => {
    const f = getFunctions(app, env.VITE_FUNCTIONS_REGION || "us-central1");
    if (usingEmulators) connectFunctionsEmulator(f, "127.0.0.1", 5001);
    return f;
  });
  return functionsReady;
}

/** Calls a callable Cloud Function and returns its data. */
export async function callFunction<T = unknown>(name: string, data: unknown): Promise<T> {
  const [{ httpsCallable }, f] = await Promise.all([import("firebase/functions"), functionsClient()]);
  return (await httpsCallable(f, name)(data)).data as T;
}
