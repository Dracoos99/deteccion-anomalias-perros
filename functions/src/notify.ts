/**
 * Push notifications. When an alert opens, and when an open alert rises to "Revisar"
 * (red), the owner's browsers get an FCM message in plain Spanish that opens the alert in the app. The owner chooses
 * which alerts are pushed (users/{uid}.notificationPrefs) and on which browsers (users/{uid}.fcmTokens).
 *
 * Each kind ("new", "escalated") is attempted once per alert: alerts/{id}.notify[kind] records the attempt, also when
 * nothing was sent and why. A retry after a crash between the send and that write can repeat a push; nothing else can.
 * The Firebase emulators do not emulate FCM: there the attempt is recorded as skipped ("emulator").
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { getMessaging } from "firebase-admin/messaging";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { REGION } from "./config";
import { pushText } from "./shared/alert-text";
import type { AlertDoc, UserDoc } from "./shared/types";

export type PushKind = "new" | "escalated";

export interface PushMessage { title: string; body: string; link: string; alertId: string; dogId: string; kind: PushKind }

export interface PushResult { sent: number; failed: number; invalidTokens: string[]; skipped?: string }

export interface PushSender { send(tokens: string[], message: PushMessage): Promise<PushResult> }

type AlertLike = Pick<AlertDoc, "dogId" | "dogName" | "severity" | "reasons" | "status">;
type UserLike = Pick<UserDoc, "fcmTokens" | "notificationPrefs">;

/** Who gets what, or why nothing is sent. Pure. */
export function planPush(alertId: string, alert: AlertLike, user: UserLike | null, kind: PushKind, appUrl: string):
  { tokens: string[]; message: PushMessage } | { skipped: string } {
  if (alert.status !== "open") return { skipped: "acknowledged" };
  if (!user) return { skipped: "no_user" };
  const severity = kind === "escalated" ? "red" : alert.severity;
  const prefs = user.notificationPrefs ?? { red: true, amber: true };
  if (prefs[severity] === false) return { skipped: "prefs" };
  const tokens = [...new Set(user.fcmTokens ?? [])];
  if (!tokens.length) return { skipped: "no_tokens" };
  const { title, body } = pushText(alert.dogName, alert.reasons, kind);
  return { tokens, message: { title, body, link: `${appUrl.replace(/\/$/, "")}/alertas/${alertId}`, alertId, dogId: alert.dogId, kind } };
}

/** Sends (or skips) one kind of push for one alert and records the attempt. */
export async function notifyAlert(db: Firestore, alertId: string, kind: PushKind, sender: PushSender, appUrl: string):
  Promise<{ sent: number; failed: number; skipped: string | null } | null> {
  const ref = db.doc(`alerts/${alertId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const alert = snap.data() as AlertDoc;
  if (alert.notify?.[kind]) return null;   // already attempted
  const userRef = db.doc(`users/${alert.ownerId}`);
  const user = ((await userRef.get()).data() as UserLike | undefined) ?? null;
  const plan = planPush(alertId, alert, user, kind, appUrl);
  let result: { sent: number; failed: number; skipped: string | null };
  if ("skipped" in plan) {
    result = { sent: 0, failed: 0, skipped: plan.skipped };
  } else {
    const r = await sender.send(plan.tokens, plan.message);
    result = { sent: r.sent, failed: r.failed, skipped: r.skipped ?? null };
    // Tokens of browsers that turned notifications off or were reset are dropped from the profile.
    if (r.invalidTokens.length) await userRef.update({ fcmTokens: FieldValue.arrayRemove(...r.invalidTokens) });
  }
  await ref.update({ [`notify.${kind}`]: { at: FieldValue.serverTimestamp(), ...result }, ...(result.sent > 0 ? { notified: true } : {}) });
  return result;
}

const INVALID_TOKEN = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

export function fcmSender(): PushSender {
  return {
    async send(tokens, m) {
      const res = await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title: m.title, body: m.body },
        webpush: { fcmOptions: { link: m.link }, notification: { tag: m.alertId, renotify: m.kind === "escalated" } },
        data: { alertId: m.alertId, dogId: m.dogId, kind: m.kind },
      });
      const invalidTokens = res.responses.flatMap((r, i) => (!r.success && INVALID_TOKEN.has(r.error?.code ?? "") ? [tokens[i]] : []));
      return { sent: res.successCount, failed: res.failureCount, invalidTokens };
    },
  };
}

const emulatorSender: PushSender = {
  async send(tokens, m) {
    logger.info("push not sent: FCM is not emulated", { alertId: m.alertId, kind: m.kind, tokens: tokens.length, title: m.title });
    return { sent: 0, failed: 0, invalidTokens: [], skipped: "emulator" };
  },
};

export const pushSender = (): PushSender => (process.env.FUNCTIONS_EMULATOR === "true" ? emulatorSender : fcmSender());

/** Base URL of the app that the notification opens (Firebase Hosting of the project unless APP_URL is set). */
export const appUrl = (): string => process.env.APP_URL || `https://${process.env.GCLOUD_PROJECT ?? "localhost"}.web.app`;

export const onAlertCreated = onDocumentCreated({ document: "alerts/{alertId}", region: REGION, retry: true }, async (event) => {
  await notifyAlert(getFirestore(), event.params.alertId, "new", pushSender(), appUrl());
});
