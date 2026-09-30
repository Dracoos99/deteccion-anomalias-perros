import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

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
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || "us-central1");

export const usingEmulators = (env.VITE_USE_EMULATORS ?? "true") !== "false" || projectId.startsWith("demo-");
if (usingEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
