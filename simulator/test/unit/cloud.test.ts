import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadFiles, metadataToken, parseGsUri, runDataFiles } from "../../src/cloud";

describe("simulator data in Cloud Storage", () => {
  it("reads the bucket and folder of SIM_DATA_URI", () => {
    expect(parseGsUri("gs://mi-bucket/sim")).toEqual({ bucket: "mi-bucket", prefix: "sim/" });
    expect(parseGsUri("gs://mi-bucket/sim/")).toEqual({ bucket: "mi-bucket", prefix: "sim/" });
    expect(parseGsUri("gs://mi-bucket")).toEqual({ bucket: "mi-bucket", prefix: "" });
    expect(() => parseGsUri("/local/sim")).toThrow(/gs:\/\//);
  });

  it("asks only for the manifest and the subjects of the dogs of the run", () => {
    const dog = (imu: string, hr: string) => ({ source: {
      imu: { datasetId: "vehkaoja2022" as const, subjectId: imu }, hr: { datasetId: "invoxia2023" as const, subjectId: hr }, temp: { datasetId: "synthetic" as const, subjectId: null } } });
    expect(runDataFiles([dog("23", "30"), dog("16", "8"), dog("23", "30"), {}])).toEqual([
      "manifest.json", "imu/vehkaoja2022/23.f32", "hr/invoxia2023/30.json", "imu/vehkaoja2022/16.f32", "hr/invoxia2023/8.json",
    ]);
  });

  it("downloads each file with the service account token into the same relative path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-cloud-"));
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response(url.includes("manifest.json") ? "{}" : "abc");
    }) as typeof fetch;
    await downloadFiles("gs://b/sim", ["manifest.json", "hr/invoxia2023/30.json"], dir, async () => "tok", fakeFetch);
    expect(urls).toEqual([
      "https://storage.googleapis.com/storage/v1/b/b/o/sim%2Fmanifest.json?alt=media",
      "https://storage.googleapis.com/storage/v1/b/b/o/sim%2Fhr%2Finvoxia2023%2F30.json?alt=media",
    ]);
    expect(fs.readFileSync(path.join(dir, "hr", "invoxia2023", "30.json"), "utf8")).toBe("abc");
    const failing = (async () => new Response("no", { status: 403 })) as typeof fetch;
    await expect(downloadFiles("gs://b/sim", ["manifest.json"], dir, async () => "tok", failing)).rejects.toThrow(/403/);
  });
  it("asks the metadata server for the token of the service account", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3599 }));
    });
    try {
      expect(await metadataToken()).toBe("tok");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls[0].url).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect((calls[0].init?.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
  });
});
