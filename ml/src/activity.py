"""Provisional activity rule for phase 1: a 2 s window is "active" when the standard deviation of the
accelerometer magnitude exceeds a threshold. It stands in for the CNN-LSTM until phase 2 and feeds the per-dog
active-time ratio. The threshold is fitted on the training dogs (trot, walk, play, sniff = active;
sit, stand, lie = inactive) by maximising balanced accuracy, and checked on the validation dogs.

The same intensity is computed in TypeScript by shared/engine.ts (windowIntensity); tests/fixtures keep both equal.

Usage (from ml/):.venv/Scripts/python -m src.activity
Output: data/processed/vehkaoja/neck/activity_threshold.json
"""
from __future__ import annotations

import json

import numpy as np

from . import config as C
from .dataset import load_windows

ACTIVE_CLASSES = ("trot", "walk", "play", "sniff")


def window_intensity(raw: np.ndarray) -> np.ndarray:
    """raw: (N, T, 6) in g and °/s. Population std (ddof=0) of the accelerometer magnitude, in g."""
    return np.linalg.norm(raw[:, :, :3].astype(np.float64), axis=2).std(axis=1)


def balanced_accuracy(active_true: np.ndarray, active_pred: np.ndarray) -> float:
    tpr = (active_pred & active_true).sum() / max(1, active_true.sum())
    tnr = (~active_pred & ~active_true).sum() / max(1, (~active_true).sum())
    return float((tpr + tnr) / 2)


def fit_threshold(intensity: np.ndarray, active: np.ndarray) -> tuple[float, float]:
    """Threshold (midpoint between candidate values) that maximises balanced accuracy."""
    cand = np.unique(np.quantile(intensity, np.linspace(0.01, 0.99, 981)))
    best = max(cand, key=lambda t: balanced_accuracy(active, intensity > t))
    return float(best), balanced_accuracy(active, intensity > best)


def run() -> dict:
    active_idx = [C.CLASSES.index(c) for c in ACTIVE_CLASSES]
    res = {}
    raw, y, _ = load_windows("train", normalize=False)
    it, act = window_intensity(raw), np.isin(y, active_idx)
    thr, ba_train = fit_threshold(it, act)
    res["train"] = {"windows": int(len(y)), "balanced_accuracy": round(ba_train, 3)}
    raw, y, _ = load_windows("val", normalize=False)
    it_val, act_val = window_intensity(raw), np.isin(y, active_idx)
    res["val"] = {"windows": int(len(y)), "balanced_accuracy": round(balanced_accuracy(act_val, it_val > thr), 3),
                  "active_recall_by_class": {C.CLASSES[k]: round(float((it_val[y == k] > thr).mean()), 3) for k in range(len(C.CLASSES))}}
    out = {"threshold_g": round(thr, 4), "active_classes": list(ACTIVE_CLASSES), "window_s": C.WINDOW_S,
           "sensor": C.SENSOR, **res}
    (C.VEHKAOJA_OUT / "activity_threshold.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


if __name__ == "__main__":
    print(json.dumps(run(), indent=1))
