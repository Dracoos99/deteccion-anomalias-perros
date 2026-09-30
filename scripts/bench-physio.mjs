// Measures the physiological model inside the Functions runtime (functions/lib/physio.js, built): backend, time per
// 10 s block (5 sequences in one batch, as the engine scores them), agreement with Keras and bundle size. Writes
// ml/models/physio/<version>/runtime.json, read by ml/src/report_physio.py.
// Usage: npm --prefix functions run build && node scripts/bench-physio.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "functions", "package.json"));
const { loadPhysioModel, PHYSIO_BUNDLE_DIR } = require("./lib/physio.js");
const { loadBehaviorModel } = require("./lib/behavior.js");
const tfjsVersion = require("@tensorflow/tfjs/package.json").version;

const runner = await loadPhysioModel();
if (!runner) throw new Error(`No hay modelo en ${PHYSIO_BUNDLE_DIR}`);
const fixture = JSON.parse(fs.readFileSync(path.join(root, "functions", "test", "fixtures", "physio-parity.json"), "utf8"));
const errors = runner.errors(new Float32Array(fixture.sequences.flat()), fixture.sequences.length);
const maxRelDiff = Math.max(...errors.map((e, i) => Math.abs(e - fixture.errors[i]) / Math.max(fixture.errors[i], 1e-3)));

const L = runner.meta.sequenceLength;
const block = Array.from({ length: 5 }, (_, k) => Float32Array.from({ length: L }, (_, i) => Math.sin((i + 2 * k) / 7)));
const time = (n, fn) => { for (let i = 0; i < 5; i++) fn(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; };
const batchMs = time(50, () => runner.score(block));
const oneMs = time(50, () => runner.score([block[0]]));
// The behavioral model in the same run: the absolute times depend on the machine's power state (battery, power plan).
const behavior = await loadBehaviorModel();
const imu = Array.from({ length: 6000 }, (_, i) => Math.sin(i / 17) * (i % 6 < 3 ? 0.3 : 40));
const behaviorMs = behavior ? time(50, () => behavior.run(imu, [0, 0, 0, 0, 0, 0], [0.5, 0.5, 0.5, 60, 60, 60])) : null;
const bundleKb = Math.round(fs.readdirSync(PHYSIO_BUNDLE_DIR).reduce((s, f) => s + fs.statSync(path.join(PHYSIO_BUNDLE_DIR, f)).size, 0) / 1024);

const out = { version: runner.meta.version, backend: runner.backend, tfjs: tfjsVersion, block_batch_ms: Math.round(batchMs * 10) / 10,
  one_sequence_ms: Math.round(oneMs * 10) / 10, behavior_block_ms_same_run: behaviorMs == null ? null : Math.round(behaviorMs * 10) / 10, max_rel_diff: maxRelDiff, bundle_kb: bundleKb, node: process.version, measuredAt: new Date().toISOString() };
const dest = path.join(root, "ml", "models", "physio", runner.meta.version, "runtime.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
console.log(out);
