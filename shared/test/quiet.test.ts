import { describe, expect, it } from "vitest";
import { inQuietHours, localMinutes, validTime } from "../quiet";

// 10 Oct 2026 in Lima (UTC-5, no daylight saving): 03:00 UTC is 22:00 of the 9th.
const lima = (h: number, m = 0) => Date.UTC(2026, 9, 10, h + 5, m);

describe("quiet hours", () => {
  it("reads the local time of the owner's zone", () => {
    expect(localMinutes(lima(22, 30), "America/Lima")).toBe(22 * 60 + 30);
    expect(localMinutes(lima(7), "America/Lima")).toBe(7 * 60);
    expect(localMinutes(Date.UTC(2026, 9, 10, 12, 15), "Mars/Olympus")).toBe(12 * 60 + 15);   // unknown zone: UTC
  });

  it("works across midnight, start included and end excluded", () => {
    const q = { from: "22:00", to: "07:00", tz: "America/Lima" };
    expect(inQuietHours(lima(21, 59), q)).toBe(false);
    expect(inQuietHours(lima(22), q)).toBe(true);
    expect(inQuietHours(lima(3), q)).toBe(true);
    expect(inQuietHours(lima(6, 59), q)).toBe(true);
    expect(inQuietHours(lima(7), q)).toBe(false);
    expect(inQuietHours(lima(13), q)).toBe(false);
  });

  it("works inside one day too", () => {
    const q = { from: "13:00", to: "15:30", tz: "America/Lima" };
    expect(inQuietHours(lima(14), q)).toBe(true);
    expect(inQuietHours(lima(15, 30), q)).toBe(false);
    expect(inQuietHours(lima(12, 59), q)).toBe(false);
  });

  it("is off without a window, with equal ends or with a malformed hour", () => {
    expect(inQuietHours(lima(23), null)).toBe(false);
    expect(inQuietHours(lima(23), undefined)).toBe(false);
    expect(inQuietHours(lima(23), { from: "22:00", to: "22:00", tz: "America/Lima" })).toBe(false);
    expect(inQuietHours(lima(23), { from: "25:00", to: "07:00", tz: "America/Lima" })).toBe(false);
    expect(validTime("07:05")).toBe(true);
    expect(validTime("7:05")).toBe(false);
    expect(validTime("24:00")).toBe(false);
  });
});
