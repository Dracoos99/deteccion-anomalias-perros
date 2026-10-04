/* Progress of the baseline the Function is learning from the dog's first blocks, in plain Spanish. */
import type { Dog, Fusion } from "../data/hooks";
import { durationText } from "../lib/plain";

export function BaselineProgress({ dog, cfg }: { dog: Dog; cfg: Fusion }) {
  const p = dog.status?.baselineProgress;
  if (!p) return null;
  const pct = p.share > 0 ? Math.max(1, Math.round(100 * p.share)) : 0;
  const span = durationText((cfg.baseline?.minBlocks ?? 360) * 10_000);
  const text = p.stage === "initial"
    ? `Aprendiendo qué es normal para ${dog.name}: ${pct} % (con ${span} de sus primeros datos).`
    : `Afinando cómo se mueve ${dog.name} con el modelo de conducta: ${pct} %.`;
  return (
    <div className="baseline-progress">
      <span className="xs muted">{text}</span>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Patrón normal">
        <div className="progress-fill" style={{ ["--p" as string]: pct / 100 }} />
      </div>
    </div>
  );
}
