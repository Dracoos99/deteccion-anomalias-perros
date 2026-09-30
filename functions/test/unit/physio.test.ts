// The TF.js autoencoder loaded by the Function must reproduce the Keras reconstruction errors saved at export time
// (functions/test/fixtures/physio-parity.json, written by ml/src/train_physio.py).
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PHYSIO_BUNDLE_DIR, loadPhysioModel, type PhysioRunner } from "../../src/physio";

const fixturePath = path.resolve(__dirname, "../fixtures/physio-parity.json");
const hasBundle = fs.existsSync(path.join(PHYSIO_BUNDLE_DIR, "metadata.json")) && fs.existsSync(fixturePath);

describe.skipIf(!hasBundle)("physiological model bundle", () => {
  let runner: PhysioRunner;
  const fixture = hasBundle ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : null;

  beforeAll(async () => {
    runner = (await loadPhysioModel())!;
  }, 60_000);

  it("loads with the WebAssembly backend and the metadata of the export", () => {
    expect(runner).not.toBeNull();
    expect(runner.backend).toBe("wasm");
    expect(runner.meta.version).toBe(fixture.version);
    expect(runner.meta.sequenceLength).toBe(60);
    expect(runner.meta.threshold).toBeGreaterThan(0);
    expect(runner.meta.criticalRatio).toBeGreaterThan(1);
    expect(runner.meta.fullScaleRatio).toBeGreaterThan(runner.meta.criticalRatio);
  });

  it("reproduces the Keras reconstruction errors within 1e-4 (relative)", () => {
    const n = fixture.sequences.length;
    const errors = runner.errors(new Float32Array(fixture.sequences.flat()), n);
    errors.forEach((e, i) => expect(Math.abs(e - fixture.errors[i]) / Math.max(fixture.errors[i], 1e-3)).toBeLessThan(1e-4));
  });

  it("scores a batch of sequences like one by one", () => {
    const batch = fixture.sequences.map((s: number[]) => Float32Array.from(s));
    const together = runner.score(batch);
    const alone = batch.map((z: Float32Array) => runner.score([z])[0]);
    together.forEach((e, i) => expect(e).toBeCloseTo(alone[i], 5));
    expect(runner.score([])).toEqual([]);
  });

  it("keeps the model under the 5 MB", () => {
    const size = fs.readdirSync(PHYSIO_BUNDLE_DIR).reduce((s, f) => s + fs.statSync(path.join(PHYSIO_BUNDLE_DIR, f)).size, 0);
    expect(size).toBeLessThan(5 * 1024 * 1024);
  });
});
