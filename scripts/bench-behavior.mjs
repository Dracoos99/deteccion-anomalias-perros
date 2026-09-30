// Measures the behavioral model inside the Functions runtime (functions/lib/behavior.js, built): backend, time per
// 10 s block (5 windows), agreement with Keras and bundle size. Writes ml/models/behavior/<version>/runtime.json,
// read by ml/src/report.py. Usage: npm --prefix functions run build && node scripts/bench-behavior.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "functions", "package.json"));
const { loadBehaviorModel, BUNDLE_DIR } = require("./lib/behavior.js");
const tfjsVersion = require("@tensorflow/tfjs/package.json").version;

const runner = await loadBehaviorModel();
if (!runner) throw new Error(`No hay modelo en ${BUNDLE_DIR}`);
const fixture = JSON.parse(fs.readFileSync(path.join(root, "functions", "test", "fixtures", "behavior-parity.json"), "utf8"));
const probs = runner.predictWindows(new Float32Array(fixture.windows.flat(2)), fixture.windows.length);
let maxDiff = 0;
probs.forEach((row, i) => row.forEach((v, j) => { maxDiff = Math.max(maxDiff, Math.abs(v - fixture.probs[i][j])); }));

const imu = Array.from({ length: 6000 }, (_, i) => Math.sin(i / 17) * (i % 6 < 3 ? 0.3 : 40));
const mean = [0, 0, 0, 0, 0, 0], std = [0.5, 0.5, 0.5, 60, 60, 60];
for (let i = 0; i < 5; i++) runner.run(imu, mean, std);
const n = 50, t0 = performance.now();
for (let i = 0; i < n; i++) runner.run(imu, mean, std);
const ms = (performance.now() - t0) / n;
const bundleKb = Math.round(fs.readdirSync(BUNDLE_DIR).reduce((s, f) => s + fs.statSync(path.join(BUNDLE_DIR, f)).size, 0) / 1024);

const out = { version: runner.meta.version, backend: runner.backend, tfjs: tfjsVersion, predict_block_ms: Math.round(ms * 10) / 10,
  max_abs_diff: maxDiff, bundle_kb: bundleKb, node: process.version, measuredAt: new Date().toISOString() };
const dest = path.join(root, "ml", "models", "behavior", runner.meta.version, "runtime.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
console.log(out);
