"""Baselines on the window features (phase 2): Random Forest (7 classes) and Isolation Forest (novelty).

Same fixed split by dog as the CNN-LSTM (splits.json); the test dogs are evaluated once. Optional:
  --lodo          leave-one-dog-out for the Random Forest (45 folds), the final evaluation
  --sensitivity   Random Forest for neck and back × windows of 2, 3, 4 and 5 s (D1 and RF-01)

Usage (from ml/):.venv/Scripts/python -m src.baselines [--lodo] [--sensitivity]
Output: ml/models/baselines/metrics.json (+ lodo.json, sensitivity.json)
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import f1_score, roc_auc_score

from . import config as C
from .train_behavior import NOVELTY_QUANTILE, classification_report

OUT = C.ML_DIR / "models" / "baselines"
RF_PARAMS = dict(n_estimators=300, min_samples_leaf=2, class_weight="balanced_subsample", n_jobs=-1, random_state=C.SEED)


def load_features(out_dir: Path, window_s: float = C.WINDOW_S) -> tuple[pd.DataFrame, list[str], dict]:
    f = pd.read_parquet(out_dir / f"features_{window_s:.1f}s.parquet")
    cols = [c for c in f.columns if c not in ("dog_id", "label", "status")]
    splits = json.loads((C.VEHKAOJA_OUT / "splits.json").read_text(encoding="utf-8"))  # same dogs for every variant
    return f, cols, splits


def random_forest(f: pd.DataFrame, cols: list[str], splits: dict) -> tuple[dict, RandomForestClassifier]:
    clean = f[f["status"] == "clean"]
    tr, te = clean[clean["dog_id"].isin(splits["train"])], clean[clean["dog_id"].isin(splits["test"])]
    va = clean[clean["dog_id"].isin(splits["val"])]
    rf = RandomForestClassifier(**RF_PARAMS).fit(tr[cols], tr["label"])
    return {"val": classification_report(va["label"].to_numpy(), rf.predict(va[cols])),
            "test": classification_report(te["label"].to_numpy(), rf.predict(te[cols]))}, rf


def isolation_forest(f: pd.DataFrame, cols: list[str], splits: dict) -> dict:
    """Fitted on normal training windows; threshold at the 5 % least normal validation windows (same rule as the CNN)."""
    clean = f[f["status"] == "clean"]
    tr = clean[clean["dog_id"].isin(splits["train"])]
    va = clean[clean["dog_id"].isin(splits["val"])]
    te_c = clean[clean["dog_id"].isin(splits["test"])]
    te_u = f[(f["status"] == "unlabeled") & f["dog_id"].isin(splits["test"])]
    iso = IsolationForest(n_estimators=300, random_state=C.SEED, n_jobs=-1).fit(tr[cols])
    thr = np.quantile(iso.score_samples(va[cols]), NOVELTY_QUANTILE)
    s_c, s_u = iso.score_samples(te_c[cols]), iso.score_samples(te_u[cols])
    y = np.concatenate([np.zeros(len(s_c)), np.ones(len(s_u))])
    return {"threshold": round(float(thr), 4), "test_clean_flagged": round(float((s_c < thr).mean()), 4),
            "test_unlabeled_flagged": round(float((s_u < thr).mean()), 4),
            "auroc_clean_vs_unlabeled": round(float(roc_auc_score(y, -np.concatenate([s_c, s_u]))), 4)}


def lodo(f: pd.DataFrame, cols: list[str]) -> dict:
    """Resumable: each dog's predictions are saved in models/baselines/lodo/ and reused on the next run."""
    clean = f[f["status"] == "clean"]
    parts = OUT / "lodo"
    parts.mkdir(parents=True, exist_ok=True)
    per_dog, y_all, p_all = {}, [], []
    for dog in sorted(clean["dog_id"].unique()):
        tr, te = clean[clean["dog_id"] != dog], clean[clean["dog_id"] == dog]
        cache = parts / f"dog_{int(dog):03d}.npy"
        if cache.exists() and len(np.load(cache)) == len(te):
            pred = np.load(cache)
        else:
            pred = RandomForestClassifier(**RF_PARAMS).fit(tr[cols], tr["label"]).predict(te[cols])
            np.save(cache, pred)
        per_dog[int(dog)] = {"windows": int(len(te)), "macro_f1": round(float(f1_score(te["label"], pred, average="macro")), 4),
                             "accuracy": round(float((pred == te["label"].to_numpy()).mean()), 4)}
        y_all.append(te["label"].to_numpy())
        p_all.append(pred)
        print(f"  dog {dog}: macro F1 {per_dog[int(dog)]['macro_f1']:.3f}", flush=True)
    f1s = np.array([d["macro_f1"] for d in per_dog.values()])
    return {"pooled": classification_report(np.concatenate(y_all), np.concatenate(p_all)),
            "per_dog_macro_f1": {"mean": round(float(f1s.mean()), 4), "std": round(float(f1s.std()), 4),
                                 "min": round(float(f1s.min()), 4), "max": round(float(f1s.max()), 4)},
            "per_dog": per_dog}


def sensitivity() -> dict:
    rows = []
    for sensor in ("neck", "back"):
        out_dir = C.PROCESSED_DIR / "vehkaoja" / sensor
        for w in (2.0, 3.0, 4.0, 5.0):
            path = out_dir / f"features_{w:.1f}s.parquet"
            if not path.exists():
                print(f"  missing {path}; run preprocess/windows/features for that variant", flush=True)
                continue
            f, cols, splits = load_features(out_dir, w)
            m, _ = random_forest(f, cols, splits)
            rows.append({"sensor": sensor, "window_s": w, "test_macro_f1": m["test"]["macro_f1"], "val_macro_f1": m["val"]["macro_f1"],
                         "test_windows": m["test"]["windows"]})
            print(f"  {sensor} {w:.0f} s: val {m['val']['macro_f1']:.3f} · test {m['test']['macro_f1']:.3f}", flush=True)
    return {"model": "random_forest", "params": {k: v for k, v in RF_PARAMS.items() if k != "n_jobs"}, "rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lodo", action="store_true")
    ap.add_argument("--sensitivity", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    f, cols, splits = load_features(C.VEHKAOJA_OUT)
    rf_metrics, rf = random_forest(f, cols, splits)
    importances = sorted(zip(cols, rf.feature_importances_), key=lambda t: -t[1])[:15]
    metrics = {"random_forest": rf_metrics | {"params": {k: v for k, v in RF_PARAMS.items() if k != "n_jobs"},
                                              "top_features": [[c, round(float(v), 4)] for c, v in importances]},
               "isolation_forest": isolation_forest(f, cols, splits), "features": len(cols), "seconds": round(time.time() - t0)}
    (OUT / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8", newline="\n")
    print(json.dumps({"rf_val_macro_f1": rf_metrics["val"]["macro_f1"], "rf_test_macro_f1": rf_metrics["test"]["macro_f1"],
                      "rf_test_accuracy": rf_metrics["test"]["accuracy"], "isolation_forest": metrics["isolation_forest"]}, indent=1))
    if args.lodo:
        res = lodo(f, cols)
        (OUT / "lodo.json").write_text(json.dumps(res, indent=1), encoding="utf-8", newline="\n")
        print(json.dumps({"lodo_pooled_macro_f1": res["pooled"]["macro_f1"], "per_dog": res["per_dog_macro_f1"]}, indent=1))
    if args.sensitivity:
        res = sensitivity()
        (OUT / "sensitivity.json").write_text(json.dumps(res, indent=1), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
