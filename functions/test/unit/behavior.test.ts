// The TF.js bundle loaded by the Function must reproduce the Keras probabilities saved at export time
// (functions/test/fixtures/behavior-parity.json, written by ml/src/train_behavior.py).
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_DIR, loadBehaviorModel, type BehaviorRunner } from "../../src/behavior";

const fixturePath = path.resolve(__dirname, "../fixtures/behavior-parity.json");
const hasBundle = fs.existsSync(path.join(BUNDLE_DIR, "metadata.json")) && fs.existsSync(fixturePath);

describe.skipIf(!hasBundle)("behavioral model bundle", () => {
  let runner: BehaviorRunner;
  const fixture = hasBundle ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : null;

  beforeAll(async () => {
    runner = (await loadBehaviorModel())!;
  }, 60_000);

  it("loads with the WebAssembly backend and the metadata of the export", () => {
    expect(runner).not.toBeNull();
    expect(runner.backend).toBe("wasm");
    expect(runner.meta.version).toBe(fixture.version);
    expect(runner.meta.classes).toEqual(["sit", "stand", "lie", "trot", "walk", "play", "sniff"]);
    expect(runner.meta.noveltyThreshold).toBeGreaterThan(0);
    expect(runner.meta.noveltyThreshold).toBeLessThan(1);
  });

  it("reproduces the Keras probabilities within 1e-5", () => {
    const n = fixture.windows.length;
    const data = new Float32Array(fixture.windows.flat(2));
    const probs = runner.predictWindows(data, n);
    let maxDiff = 0;
    probs.forEach((row, i) => row.forEach((v, j) => { maxDiff = Math.max(maxDiff, Math.abs(v - fixture.probs[i][j])); }));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it("classifies a raw 10 s block into 5 windows with the dog's z-score", () => {
    const imu = Array.from({ length: 1000 * 6 }, (_, i) => (i % 6 === 2 ? 1 : 0));
    const out = runner.run(imu, [0, 0, 0.9, 0, 0, 0], [0.5, 0.5, 0.5, 60, 60, 60])!;
    expect(out.probs).toHaveLength(5);
    out.probs.forEach((p) => expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4));
    expect(runner.run(imu, undefined, undefined)).toBeNull();
  });

  it("keeps the model under the 5 MB", () => {
    const size = fs.readdirSync(BUNDLE_DIR).reduce((s, f) => s + fs.statSync(path.join(BUNDLE_DIR, f)).size, 0);
    expect(size).toBeLessThan(5 * 1024 * 1024);
  });
});
