"""Behavioral model v2: average of several CNN-LSTM members and a
causal temporal smoothing of the averaged softmax, chosen on the validation dogs and measured once on the test dogs.

The members come from `python -m src.train_behavior --version cnn-lstm-v2 --seed <s>... --member`. This script:
  1. reports each member and the average on the clean windows of val and test;
  2. replays every window of each recording (transitions and unlabelled stretches included) in time order, without
     overlap like the Function sees them, through an exponential average of the softmax with time constant tau, and
     picks tau on the validation dogs (macro F1 of the clean windows);
  3. calibrates the novelty threshold on the raw average and exports one flat Keras model that averages
     the members to TF.js, with the smoothing in its metadata.

Usage (from ml/):  python -m src.ensemble_behavior [--version cnn-lstm-v2] [--no-export]
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone

import numpy as np
from sklearn.metrics import f1_score

from . import config as C
from .tfsetup import keras, tf
from .dataset import load_sequences, load_windows
from .train_behavior import (ACTIVE_CLASSES, BUNDLE_DIR, NOVELTY_QUANTILE, PARITY_PATH, classification_report, export_tfjs,
                             git_commit, novelty_report)

TAUS_S = (0, 2, 4, 6, 8, 12, 20)   # 0: no smoothing


def smooth_sequence(probs: np.ndarray, meta, tau_s: float, step: int) -> tuple[np.ndarray, np.ndarray]:
    """Causal exponential average of the softmax over non-overlapping windows (every `step` samples), restarted at
    every gap. Returns the smoothed probabilities of those windows and their row indices in `probs`."""
    win_s = C.WINDOW_S
    alpha = 1.0 if tau_s <= 0 else 1 - np.exp(-win_s / tau_s)
    keep, out = [], []
    for _, g in meta.groupby(["dog_id", "file"], sort=False):
        rows, starts = g.index.to_numpy(), g["start"].to_numpy()
        # Two phases of the 50 % overlap: each is a stream of consecutive non-overlapping windows.
        for phase in (0, 1):
            sel = rows[(starts // (step // 2)) % 2 == phase] if step > 1 else rows
            if not len(sel):
                continue
            s = meta.loc[sel, "start"].to_numpy()
            ema = None
            for r, st, prev in zip(sel, s, np.r_[-10**9, s[:-1]]):
                p = probs[r]
                ema = p if ema is None or st - prev != step else ema + alpha * (p - ema)
                keep.append(r)
                out.append(ema)
    return np.asarray(out, np.float32), np.asarray(keep)


def sequence_f1(probs: np.ndarray, y: np.ndarray, meta, tau_s: float, step: int) -> float:
    sm, rows = smooth_sequence(probs, meta, tau_s, step)
    clean = y[rows] >= 0
    return float(f1_score(y[rows][clean], sm[clean].argmax(axis=1), average="macro"))


def flat_ensemble(members: list[keras.Model], input_len: int) -> keras.Model:
    """One functional model with every member's layers side by side and the average of their softmax (no nested models,
    so the TF.js layers loader reads it like v1)."""
    inp = keras.layers.Input((input_len, len(C.IMU_CHANNELS)), name="imu")
    outs = []
    for i, m in enumerate(members):
        x = inp
        for layer in m.layers:
            cfg = layer.get_config() | {"name": f"m{i}_{layer.name}"}
            clone = layer.__class__.from_config(cfg)
            x = clone(x)
            clone.set_weights(layer.get_weights())
        outs.append(x)
    return keras.Model(inp, keras.layers.Average(name="average")(outs), name="cnn_lstm_ensemble")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", default="cnn-lstm-v2")
    ap.add_argument("--no-export", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    base = C.ML_DIR / "models" / "behavior" / args.version
    member_dirs = sorted((base / "members").glob("seed-*"), key=lambda p: int(p.name.split("-")[1]))
    if not member_dirs:
        raise SystemExit(f"No members in {base / 'members'}: train them with src.train_behavior --member")
    probs = [np.load(d / "probs.npz") for d in member_dirs]
    seeds = [int(d.name.split("-")[1]) for d in member_dirs]

    _, y_va, _ = load_windows("val")
    _, y_te, _ = load_windows("test")
    _, sy_va, smeta_va = load_sequences("val")
    _, sy_te, smeta_te = load_sequences("test")
    step, _ = C.window_samples()   # window length in samples: windows of the deployed stream do not overlap

    avg = {k: np.mean([p[k] for p in probs], axis=0) for k in ("val", "test", "test_unlabeled", "val_sequence", "test_sequence")}
    per_member = [{"seed": s, "val_macro_f1": round(float(f1_score(y_va, p["val"].argmax(1), average="macro")), 4),
                   "test_macro_f1": round(float(f1_score(y_te, p["test"].argmax(1), average="macro")), 4)} for s, p in zip(seeds, probs)]
    for m in per_member:
        print(f"seed {m['seed']}: val {m['val_macro_f1']} · test {m['test_macro_f1']}")

    # Temporal smoothing: tau chosen on validation only.
    tau_val = {tau: round(sequence_f1(avg["val_sequence"], sy_va, smeta_va, tau, step), 4) for tau in TAUS_S}
    best_tau = max(TAUS_S, key=lambda t: (tau_val[t], -t))
    tau_test = {tau: round(sequence_f1(avg["test_sequence"], sy_te, smeta_te, tau, step), 4) for tau in (0, best_tau)}
    print("tau (s) -> val macro F1 on the stream:", tau_val, "· chosen", best_tau, "· test", tau_test)

    sm_te, rows_te = smooth_sequence(avg["test_sequence"], smeta_te, best_tau, step)
    clean_te = sy_te[rows_te] >= 0
    metrics = {
        "version": args.version, "members": per_member, "seeds": seeds,
        "val": classification_report(y_va, avg["val"].argmax(axis=1)),
        "test": classification_report(y_te, avg["test"].argmax(axis=1)),
        "novelty": novelty_report(avg["val"], avg["test"], avg["test_unlabeled"]),
        "smoothing": {
            "time_constant_s": best_tau, "stream": "non-overlapping 2 s windows per recording, every status; scored on clean windows",
            "val_macro_f1_by_tau": {str(k): v for k, v in tau_val.items()},
            "test_macro_f1_raw": tau_test[0], "test_macro_f1_smoothed": tau_test[best_tau],
            "test_smoothed": classification_report(sy_te[rows_te][clean_te], sm_te[clean_te].argmax(axis=1)),
        },
        "seconds": round(time.time() - t0),
    }
    (base / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8", newline="\n")
    print(json.dumps({"val_macro_f1": metrics["val"]["macro_f1"], "test_macro_f1": metrics["test"]["macro_f1"],
                      "smoothing": {k: metrics["smoothing"][k] for k in ("time_constant_s", "test_macro_f1_raw", "test_macro_f1_smoothed")},
                      "novelty": metrics["novelty"]}, indent=1))
    if args.no_export:
        return

    members = [keras.models.load_model(d / "model.h5", compile=False) for d in member_dirs]
    x_te, _, _ = load_windows("test")
    model = flat_ensemble(members, x_te.shape[1])
    # The flat model must reproduce its members exactly on the same device. The members' saved probabilities came from
    # the GPU (cuDNN LSTM), so against those only the class is expected to match (rounding differs by ~1e-3).
    n = min(1024, len(x_te))
    check = model.predict(x_te[:n], batch_size=256, verbose=0)
    members_here = np.mean([m.predict(x_te[:n], batch_size=256, verbose=0) for m in members], axis=0)
    assert np.allclose(check, members_here, atol=1e-5), "the flat ensemble must reproduce the average of its members"
    metrics["export_check"] = {"windows": n, "max_abs_diff_vs_members": float(np.abs(check - members_here).max()),
                               "max_abs_diff_vs_gpu_probs": float(np.abs(check - avg["test"][:n]).max()),
                               "class_agreement_vs_gpu_probs": float((check.argmax(1) == avg["test"][:n].argmax(1)).mean())}
    (base / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8", newline="\n")
    print("export check:", metrics["export_check"])
    model.save(base / "model.h5")
    splits = json.loads((C.VEHKAOJA_OUT / "splits.json").read_text(encoding="utf-8"))
    metadata = {
        "version": args.version, "kind": "behavior",
        "architecture": f"Promedio de {len(members)} CNN-LSTM (Conv1D(64,5)+BN+ReLU · MaxPool(2) · Conv1D(128,3)+BN+ReLU · Dropout(0.3) · "
                        f"LSTM(64) · Dense(64) · Dense(7, softmax)), semillas {', '.join(map(str, seeds))}",
        "classes": list(C.CLASSES), "activeClasses": list(ACTIVE_CLASSES), "windowSamples": int(x_te.shape[1]), "imuHz": C.IMU_HZ,
        "channels": list(C.IMU_CHANNELS), "normalization": "per-dog z-score per channel (dogs.baseline.imuMean / imuStd)",
        "noveltyThreshold": metrics["novelty"]["threshold"], "noveltyQuantile": NOVELTY_QUANTILE,
        # Causal exponential average of the softmax for the class shown (not for activity or novelty).
        "smoothingTimeConstantS": best_tau,
        # Shown to admins in the web app (modelVersions.trainingData): Spanish.
        "trainingData": [f"Vehkaoja et al. (2022), sensor {'del cuello' if C.SENSOR == 'Neck' else 'de la espalda'}: "
                         f"{len(splits['train'])} perros de entrenamiento, {len(splits['val'])} de validación y {len(splits['test'])} de prueba"],
        "metrics": {"test_macro_f1": metrics["test"]["macro_f1"], "test_accuracy": metrics["test"]["accuracy"], "val_macro_f1": metrics["val"]["macro_f1"],
                    "test_active_balanced_accuracy": metrics["test"]["active_balanced_accuracy"], "novelty_auroc": metrics["novelty"]["auroc_clean_vs_unlabeled"],
                    "test_macro_f1_smoothed": tau_test[best_tau]},
        "params": int(model.count_params()), "seeds": seeds, "gitCommit": git_commit(),
        "software": {"tensorflow": tf.__version__, "tf_keras": keras.__version__, "numpy": np.__version__},
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    parity_idx = np.random.default_rng(C.SEED).choice(len(x_te), 6, replace=False)
    parity = {"version": args.version, "windows": x_te[parity_idx].round(6).tolist()}
    parity["probs"] = model.predict(np.array(parity["windows"], dtype=np.float32), verbose=0).tolist()
    export_tfjs(model, metadata, parity)
    print(f"exported to {BUNDLE_DIR}")


if __name__ == "__main__":
    main()
