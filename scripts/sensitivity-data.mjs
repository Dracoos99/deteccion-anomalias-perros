// Prepares the data of the phase 2 sensitivity analysis (D1 sensor, RF-01 window length):
// back sensor preprocessing, window indexes of 2-5 s and their features, for neck and back.
// Usage: node scripts/sensitivity-data.mjs   (then: node scripts/ml.mjs -m src.baselines --sensitivity)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ml = path.join(path.dirname(fileURLToPath(import.meta.url)), "ml.mjs");
const run = (sensor, ...args) => {
  console.log(`[${sensor}] python ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [ml, ...args], { stdio: "inherit", env: { ...process.env, VEHKAOJA_SENSOR: sensor } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("Back", "-m", "src.preprocess");
for (const sensor of ["Neck", "Back"]) {
  for (const w of ["2", "3", "4", "5"]) {
    if (!(sensor === "Neck" && w === "2")) run(sensor, "-m", "src.windows", "--window-s", w);
    if (!(sensor === "Neck" && w === "2")) run(sensor, "-m", "src.features", "--window-s", w);
  }
}
