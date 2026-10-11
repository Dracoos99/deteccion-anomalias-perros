// «Descargar mis datos» and the install helpers: the pure parts.
import { describe, expect, it } from "vitest";
import { exportFileName, plain, profileForExport } from "../src/lib/myData";
import { isIos } from "../src/lib/install";

const ts = (iso: string) => ({ toDate: () => new Date(iso), toMillis: () => Date.parse(iso) });

describe("my data export", () => {
  it("turns timestamps into ISO dates at any depth and keeps the rest", () => {
    expect(plain({ at: ts("2026-10-10T15:00:00.000Z"), n: 3, list: [ts("2026-10-01T00:00:00.000Z"), "x"], nested: { b: null } }))
      .toEqual({ at: "2026-10-10T15:00:00.000Z", n: 3, list: ["2026-10-01T00:00:00.000Z", "x"], nested: { b: null } });
  });
  it("leaves the browsers' tokens out of the profile and says how many there were", () => {
    expect(profileForExport({ displayName: "Lucía Paredes", fcmTokens: ["a", "b"], privacyConsentAt: ts("2026-09-30T12:00:00.000Z") }))
      .toEqual({ displayName: "Lucía Paredes", privacyConsentAt: "2026-09-30T12:00:00.000Z", notificationBrowsers: 2 });
    expect(profileForExport(null)).toBeNull();
  });
  it("names the file with the local date", () => {
    expect(exportFileName(new Date(2026, 9, 10, 23, 30))).toBe("mis-datos-2026-10-10.json");
  });
});

describe("install", () => {
  it("recognizes the iPhone and the iPad, also when the iPad says it is a Mac", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5)).toBe(false);
  });
});
