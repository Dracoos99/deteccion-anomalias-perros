"""Trade-off of the heart-rate detectors: the autoencoder, the level rule at several sigmas, and
their combination (flag if either fires). Choices are made on the validation dogs; the test dogs are reported once.

Usage (from ml/):.venv/Scripts/python -m src.physio_tradeoff
Output: ml/models/physio/<version>/tradeoff.json, plus the summary of the combination at the default level (2 sigma, the
engine's levelSigma = baselineSigma) in the metrics of functions/models/physio/metadata.json (modelVersions reads them).
"""
from __future__ import annotations

import json

import numpy as np

from . import config as C
from . import physio_data as P
from .tfsetup import keras
from .train_physio import BUNDLE_DIR, MAGNITUDES, VERSION, f1_at, reconstruction_error

SIGMAS = (2.0, 2.5, 3.0)
DEFAULT_SIGMA = 2.0


def detectors(err: np.ndarray, rule: np.ndarray, threshold: float) -> dict[str, np.ndarray]:
    out = {"autoencoder": err > threshold}
    for k in SIGMAS:
        out[f"rule_{k}"] = rule > k
        out[f"combined_{k}"] = (err > threshold) | (rule > k)
    return out


def rates(model, dogs, keys, threshold, evaluation=True) -> dict:
    by = {d.key: d for d in dogs}
    z, raw, who = P.normal_set(dogs, keys, evaluation)
    base = np.array([by[k].baseline for k in who], dtype=np.float64)
    zs = lambda r: ((r - base[:, :1]) / np.maximum(base[:, 1:], C.HR_SD_FLOOR)).astype(np.float32)  # noqa: E731
    normal = detectors(reconstruction_error(model, z), P.rule_score(z), threshold)
    anomalous: dict[str, list[np.ndarray]] = {k: [] for k in normal}
    for kind, mags in MAGNITUDES.items():
        for m in mags:
            zi = zs(P.inject_sequences(raw, kind, m, onset=False))
            for name, flag in detectors(reconstruction_error(model, zi), P.rule_score(zi), threshold).items():
                anomalous[name].append(flag)
    out = {}
    for name in normal:
        a = np.concatenate(anomalous[name])
        # F1 with the flags as scores (threshold 0.5 on booleans).
        out[name] = {"normal_flagged": float(normal[name].mean()), "anomaly_detected": float(a.mean()),
                     "f1": f1_at(normal[name].astype(float), a.astype(float), 0.5)}
    return out


def main() -> None:
    out_dir = C.ML_DIR / "models" / "physio" / VERSION
    metrics = json.loads((out_dir / "metrics.json").read_text(encoding="utf-8"))
    model = keras.models.load_model(out_dir / "model.h5", compile=False)
    threshold = metrics["threshold"]
    dogs = P.load_series()
    split = metrics["split"]
    P.set_baselines(dogs, split)
    result = {"threshold": threshold, "validation": rates(model, dogs, split["val"], threshold),
              "test": rates(model, dogs, split["test"], threshold)}
    activity = {}
    for phase, z in P.activity_study_sets(P.load_activity_study()).items():
        activity[phase] = {k: float(v.mean()) for k, v in detectors(reconstruction_error(model, z), P.rule_score(z), threshold).items()}
    result["activity_study"] = activity
    (out_dir / "tradeoff.json").write_text(json.dumps(result, indent=1), encoding="utf-8", newline="\n")
    meta_path = BUNDLE_DIR / "metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    t, dara = result["test"], activity["DARA"]
    meta["metrics"].update({
        "combined_test_f1": round(t[f"combined_{DEFAULT_SIGMA}"]["f1"], 4),
        "combined_test_normal_flagged": round(t[f"combined_{DEFAULT_SIGMA}"]["normal_flagged"], 4),
        "rule_test_f1": round(t[f"rule_{DEFAULT_SIGMA}"]["f1"], 4),
        "autoencoder_test_f1": round(t["autoencoder"]["f1"], 4),
        "activity_flagged_autoencoder": round(dara["autoencoder"], 4),
        "activity_flagged_rule": round(dara[f"rule_{DEFAULT_SIGMA}"], 4),
        "activity_flagged_combined": round(dara[f"combined_{DEFAULT_SIGMA}"], 4),
    })
    meta_path.write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")
    head = f"{'detector':<16}{'val FP':>8}{'val det':>9}{'val F1':>8}{'test FP':>9}{'test det':>10}{'test F1':>9}{'activity':>10}"
    print(head)
    for name in result["test"]:
        v, t = result["validation"][name], result["test"][name]
        print(f"{name:<16}{v['normal_flagged']:>8.3f}{v['anomaly_detected']:>9.3f}{v['f1']:>8.3f}"
              f"{t['normal_flagged']:>9.3f}{t['anomaly_detected']:>10.3f}{t['f1']:>9.3f}{activity['DARA'][name]:>10.3f}")


if __name__ == "__main__":
    main()
