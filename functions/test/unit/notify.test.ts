// Who gets a push and what it says. The send itself is covered in the integration tests with a fake sender.
import { describe, expect, it } from "vitest";
import { planPush } from "../../src/notify";

const alert = {
  dogId: "toby", dogName: "Toby", severity: "amber" as const, status: "open" as const,
  reasons: [{ component: "heart_rate" as const, code: "hr_high", value: 118, normalRange: [65, 75] as [number, number], message: "" }],
};
const APP = "https://example.web.app/";

describe("planPush", () => {
  it("sends a new alert to every browser of the owner, once per token, with a link to the alert", () => {
    const plan = planPush("a1", alert, { fcmTokens: ["t1", "t2", "t1"] }, "new", APP);
    expect(plan).toEqual({
      tokens: ["t1", "t2"],
      message: { title: "Toby: su frecuencia cardiaca está alta", body: expect.stringContaining("patrón normal"),
        link: "https://example.web.app/alertas/a1", alertId: "a1", dogId: "toby", kind: "new" },
    });
  });
  it("respects the preferences: amber can be turned off, an escalation counts as red", () => {
    const user = { fcmTokens: ["t1"], notificationPrefs: { red: true, amber: false } };
    expect(planPush("a1", alert, user, "new", APP)).toEqual({ skipped: "prefs" });
    expect("tokens" in planPush("a1", alert, user, "escalated", APP)).toBe(true);
    expect("tokens" in planPush("a1", { ...alert, severity: "red" }, user, "new", APP)).toBe(true);
  });
  it("keeps «Atención» silent in the quiet hours and still sends «Revisar»", () => {
    const quiet = { from: "22:00", to: "07:00", tz: "America/Lima" };
    const user = { fcmTokens: ["t1"], notificationPrefs: { red: true, amber: true, quiet } };
    const night = Date.UTC(2026, 9, 10, 4, 0);   // 23:00 in Lima
    const day = Date.UTC(2026, 9, 10, 17, 0);    // 12:00 in Lima
    expect(planPush("a1", alert, user, "new", APP, night)).toEqual({ skipped: "quiet" });
    expect("tokens" in planPush("a1", alert, user, "new", APP, day)).toBe(true);
    expect("tokens" in planPush("a1", alert, user, "escalated", APP, night)).toBe(true);
    expect("tokens" in planPush("a1", { ...alert, severity: "red" }, user, "new", APP, night)).toBe(true);
  });
  it("skips reviewed alerts, owners without browsers and missing profiles", () => {
    expect(planPush("a1", { ...alert, status: "acknowledged" }, { fcmTokens: ["t1"] }, "new", APP)).toEqual({ skipped: "acknowledged" });
    expect(planPush("a1", alert, { fcmTokens: [] }, "new", APP)).toEqual({ skipped: "no_tokens" });
    expect(planPush("a1", alert, {}, "new", APP)).toEqual({ skipped: "no_tokens" });
    expect(planPush("a1", alert, null, "new", APP)).toEqual({ skipped: "no_user" });
  });
  it("names the alert by the reason the engine fixed for it", () => {
    const fever = { component: "temperature" as const, code: "temp_high", value: 39.6, normalRange: [37.7, 39.5] as [number, number], message: "" };
    const both = { ...alert, reasons: [fever, ...alert.reasons] };
    // Without titleCode, the largest deviation in band widths: 118 lpm against 65–75 lpm (4.3 widths) over 39.6 °C (0.06).
    expect(planPush("a1", both, { fcmTokens: ["t1"] }, "new", APP)).toMatchObject({ message: { title: "Toby: su frecuencia cardiaca está alta" } });
    expect(planPush("a1", { ...both, titleCode: "temp_high" }, { fcmTokens: ["t1"] }, "escalated", APP)).toMatchObject({ message: { title: "Toby: su temperatura está alta" } });
  });
});
