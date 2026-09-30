// Runs the ml/ virtual-env Python with the given arguments, on Windows or Unix: node scripts/ml.mjs -m pytest -q
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ml");
const python = process.platform === "win32" ? path.join(mlDir, ".venv", "Scripts", "python.exe") : path.join(mlDir, ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`No existe ${python}. Crea el entorno: cd ml && python -m venv .venv && pip install -r requirements.txt`);
  process.exit(1);
}
const r = spawnSync(python, process.argv.slice(2), { cwd: mlDir, stdio: "inherit", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
process.exit(r.status ?? 1);
