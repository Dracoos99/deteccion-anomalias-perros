"""Physiological model: LSTM autoencoder on 60 s heart-rate sequences.

Trained only on normal sequences of the training dogs (src/physio_data.py: split by dog, per-dog z-score). The anomaly
score is the reconstruction error (mean squared error of the 60 z values); the threshold is its 95th percentile on the
validation dogs' normal sequences. The engine turns error / threshold into r_p and the heart-rate critical rule
(config/fusion.physio: fullScaleRatio and criticalRatio, calibrated here on validation, never on test).

Evaluation, once, on the test dogs (their data after their own baseline part):
  - normal sequences above the threshold (false positives by sequence);
  - tachycardia and bradycardia injected with the catalog formula, sustained and at onset: AUROC and F1 at the
    threshold, against the provisional rule (|z| of the 60 s mean > baselineSigma);
  - the activity study of 4 dogs: sequences flagged before, during and after the activity.

Usage (from ml/):.venv/Scripts/python -m src.train_physio [--epochs 80] [--quick] [--recalibrate]
Outputs:
  ml/models/physio/<version>/          Keras model (h5), metrics.json, history.json (not versioned)
  functions/models/physio/             model.json + weights (TF.js layers format) and metadata.json (versioned)
  functions/test/fixtures/physio-parity.json   sequences + Keras errors that the TF.js loader must reproduce
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
from datetime import datetime, timezone

import numpy as np

from . import config as C
from . import physio_data as P
from .tfsetup import keras, load_tfjs_keras_converter, seed_everything, tf

REPO = C.ML_DIR.parent
VERSION = "lstm-ae-v1"
THRESHOLD_QUANTILE = 0.95         #
CRITICAL_QUANTILE = 0.999        # heart-rate critical rule of the model; at 0.99 the system sweep gave about 2 more alerts per dog-hour
BUNDLE_DIR = REPO / "functions" / "models" / "physio"
PARITY_PATH = REPO / "functions" / "test" / "fixtures" / "physio-parity.json"
BASELINE_SIGMA = 2.0              # config/fusion.baselineSigma: the rule the model is compared with
MAGNITUDES = {"tachycardia": (0.2, 0.4, 0.6, 1.0), "bradycardia": (0.2, 0.3, 0.5)}
DEFAULT_MAGNITUDE = {"tachycardia": 0.4, "bradycardia": 0.3}   # catalog defaults


def build_model(length: int = C.HR_SEQUENCE_S, units: int = 32) -> keras.Model:
    """Encoder LSTM(32), repeated code and a symmetric LSTM(32) decoder."""
    inp = keras.Input((length, 1))
    code = keras.layers.LSTM(units)(inp)
    x = keras.layers.RepeatVector(length)(code)
    x = keras.layers.LSTM(units, return_sequences=True)(x)
    out = keras.layers.TimeDistributed(keras.layers.Dense(1))(x)
    return keras.Model(inp, out, name="hr_autoencoder")


def reconstruction_error(model: keras.Model, z: np.ndarray, batch: int = 1024) -> np.ndarray:
    rec = model.predict(z[..., None], batch_size=batch, verbose=0)[..., 0]
    return ((rec - z) ** 2).mean(axis=1)


def git_commit() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001 - informative only
        return None


def average_ranks(x: np.ndarray) -> np.ndarray:
    """1-based ranks with ties averaged (the Mann-Whitney convention)."""
    order = np.argsort(x, kind="mergesort")
    xs = x[order]
    ranks = np.empty(len(x), dtype=np.float64)
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[j + 1] == xs[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return ranks


def auroc(normal: np.ndarray, anomalous: np.ndarray) -> float:
    """Probability that an anomalous sequence scores above a normal one (Mann-Whitney U / (n1 n0))."""
    r = average_ranks(np.r_[normal, anomalous].astype(np.float64))
    n0, n1 = len(normal), len(anomalous)
    return float((r[n0:].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def f1_at(normal: np.ndarray, anomalous: np.ndarray, threshold: float) -> float:
    tp = float((anomalous > threshold).sum())
    fp = float((normal > threshold).sum())
    fn = float(len(anomalous) - tp)
    return 0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn)


def injected_report(model, raw: np.ndarray, who: list[str], dogs_by_key: dict, err_normal: np.ndarray, rule_normal: np.ndarray,
                    threshold: float) -> dict:
    """AUROC, F1 and detection rate per type, magnitude and mode, for the model and the rule."""
    base = np.array([dogs_by_key[k].baseline for k in who], dtype=np.float64)
    zs = lambda r: ((r - base[:, :1]) / np.maximum(base[:, 1:], C.HR_SD_FLOOR)).astype(np.float32)  # noqa: E731
    out = {}
    for kind, mags in MAGNITUDES.items():
        for mode in ("sustained", "onset"):
            e_all, r_all = [], []
            for m in mags:
                z = zs(P.inject_sequences(raw, kind, m, onset=(mode == "onset")))
                e, r = reconstruction_error(model, z), P.rule_score(z)
                e_all.append(e)
                r_all.append(r)
                out[f"{kind}/{mode}/{m}"] = {
                    "model_detected": float((e > threshold).mean()), "rule_detected": float((r > BASELINE_SIGMA).mean()),
                    "model_auroc": auroc(err_normal, e), "rule_auroc": auroc(rule_normal, r),
                }
            e_cat, r_cat = np.concatenate(e_all), np.concatenate(r_all)
            out[f"{kind}/{mode}"] = {
                "model_auroc": auroc(err_normal, e_cat), "rule_auroc": auroc(rule_normal, r_cat),
                "model_f1": f1_at(err_normal, e_cat, threshold), "rule_f1": f1_at(rule_normal, r_cat, BASELINE_SIGMA),
                "anomalous": int(len(e_cat)), "normal": int(len(err_normal)),
            }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--quick", action="store_true", help="2 epochs, to check the pipeline")
    ap.add_argument("--no-export", action="store_true")
    ap.add_argument("--recalibrate", action="store_true",
                    help="reuse the trained model.h5: recompute the calibration, the evaluation and the export without training")
    args = ap.parse_args()
    seed_everything(C.SEED)
    t0 = time.time()

    dogs = P.load_series()
    split = P.split_by_dog(dogs)
    P.set_baselines(dogs, split)
    by = {d.key: d for d in dogs}
    z_tr, _, _ = P.normal_set(dogs, split["train"], evaluation=False)
    z_va, raw_va, who_va = P.normal_set(dogs, split["val"], evaluation=True)
    z_te, raw_te, who_te = P.normal_set(dogs, split["test"], evaluation=True)
    if args.quick:
        args.epochs = 2
    print(f"dogs train {len(split['train'])} · val {len(split['val'])} · test {len(split['test'])}; "
          f"sequences train {len(z_tr)} · val {len(z_va)} · test {len(z_te)}", flush=True)

    out = C.ML_DIR / "models" / "physio" / (VERSION + ("-quick" if args.quick else ""))
    if args.recalibrate:
        prev = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
        if prev["split"] != split:
            raise SystemExit("The split changed since training: retrain instead of recalibrating.")
        model = keras.models.load_model(out / "model.h5", compile=False)
        hist = None
        epochs_run, best_epoch, train_seconds = prev["epochs_run"], prev["best_epoch"], prev["train_seconds"]
        print(f"recalibrating the model trained for {epochs_run} epochs (best {best_epoch})", flush=True)
    else:
        model = build_model()
        model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")
        ds = tf.data.Dataset.from_tensor_slices((z_tr[..., None], z_tr[..., None])).shuffle(len(z_tr), seed=C.SEED).batch(args.batch)
        hist = model.fit(ds, validation_data=(z_va[..., None], z_va[..., None]), epochs=args.epochs, verbose=0, callbacks=[
            keras.callbacks.EarlyStopping(monitor="val_loss", patience=args.patience, restore_best_weights=True),
            keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=3, min_lr=1e-5),
        ])
        epochs_run = len(hist.history["loss"])
        best_epoch = int(np.argmin(hist.history["val_loss"])) + 1
        train_seconds = round(time.time() - t0)
        print(f"trained {epochs_run} epochs (best {best_epoch}) in {train_seconds} s", flush=True)

    # Threshold and the engine's ramps, calibrated on validation only.
    err_va = reconstruction_error(model, z_va)
    threshold = float(np.quantile(err_va, THRESHOLD_QUANTILE))
    critical_ratio = float(np.quantile(err_va, CRITICAL_QUANTILE) / threshold)
    base_va = np.array([by[k].baseline for k in who_va])
    zdef = {}
    for kind, m in DEFAULT_MAGNITUDE.items():
        inj = P.inject_sequences(raw_va, kind, m, onset=False)
        zdef[kind] = ((inj - base_va[:, :1]) / np.maximum(base_va[:, 1:], C.HR_SD_FLOOR)).astype(np.float32)
    # r_p from the shape reaches 0.5 at the critical ratio (99.9th percentile of normal validation) and 1 at twice its
    # excess, as the level rule reaches 0.5 at 3 sigma. The autoencoder barely reacts to a smooth level shift (it
    # reconstructs it), so the injected anomalies cannot anchor this ramp; the level of the heart rate keeps
    # its own rule in the engine.
    full_scale_ratio = 2 * critical_ratio - 1
    print(f"threshold {threshold:.4f} · criticalRatio {critical_ratio:.2f} · fullScaleRatio {full_scale_ratio:.2f}", flush=True)

    # Test, once.
    err_te = reconstruction_error(model, z_te)
    rule_te = P.rule_score(z_te)
    injected = injected_report(model, raw_te, who_te, by, err_te, rule_te, threshold)
    activity = {}
    for phase, z in P.activity_study_sets(P.load_activity_study()).items():
        e = reconstruction_error(model, z)
        activity[phase] = {"sequences": int(len(z)), "model_flagged": float((e > threshold).mean()),
                           "model_critical": float((e > threshold * critical_ratio).mean()),
                           "rule_flagged": float((P.rule_score(z) > BASELINE_SIGMA).mean())}

    metrics = {
        "version": VERSION, "split": {k: v for k, v in split.items()}, "best_epoch": best_epoch, "epochs_run": epochs_run,
        "sequences": {"train": int(len(z_tr)), "val": int(len(z_va)), "test": int(len(z_te))},
        "threshold": threshold, "threshold_quantile": THRESHOLD_QUANTILE, "critical_ratio": critical_ratio,
        "full_scale_ratio": full_scale_ratio,
        "critical_quantile": CRITICAL_QUANTILE,
        "val_error": {"p50": float(np.median(err_va)), "p95": threshold, "p99": float(np.quantile(err_va, 0.99)),
                      "p99.5": float(np.quantile(err_va, 0.995)), "p99.9": float(np.quantile(err_va, 0.999))},
        "test_normal": {"model_flagged": float((err_te > threshold).mean()), "model_critical": float((err_te > threshold * critical_ratio).mean()),
                        "rule_flagged": float((rule_te > BASELINE_SIGMA).mean())},
        "injected": injected, "activity_study": activity,
        "params": int(model.count_params()), "train_seconds": train_seconds, "quick": args.quick,
    }
    out.mkdir(parents=True, exist_ok=True)
    if hist is not None:
        model.save(out / "model.h5")
        (out / "history.json").write_text(json.dumps({k: [float(x) for x in v] for k, v in hist.history.items()}), encoding="utf-8", newline="\n")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8", newline="\n")
    s = injected
    print(json.dumps({"test_normal": metrics["test_normal"], "tachy_sustained": s["tachycardia/sustained"],
                      "brady_sustained": s["bradycardia/sustained"], "activity": activity}, indent=1), flush=True)

    if args.no_export or args.quick:
        return
    trained_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    if args.recalibrate and (BUNDLE_DIR / "metadata.json").exists():
        trained_at = json.loads((BUNDLE_DIR / "metadata.json").read_text(encoding="utf-8")).get("trainedAt", trained_at)
    k = load_tfjs_keras_converter()
    BUNDLE_DIR.mkdir(parents=True, exist_ok=True)
    for f in BUNDLE_DIR.glob("*"):
        f.unlink()
    k.save_keras_model(model, str(BUNDLE_DIR))
    ts = s["tachycardia/sustained"]
    metadata = {
        "version": VERSION, "kind": "physiological",
        "architecture": "LSTM(32) · RepeatVector(60) · LSTM(32, secuencias) · TimeDistributed(Dense(1))",
        "sequenceLength": C.HR_SEQUENCE_S, "hz": 1,
        "normalization": "per-dog z-score: (hr - dogs.baseline.hrMean) / max(hrStd, 1)",
        "threshold": round(threshold, 6), "thresholdQuantile": THRESHOLD_QUANTILE,
        "criticalRatio": round(critical_ratio, 3), "criticalQuantile": CRITICAL_QUANTILE, "fullScaleRatio": round(full_scale_ratio, 3),
        # Shown to admins in the web app: the source is named without the company.
        "trainingData": [f"Dataset público de frecuencia cardiaca (2023), PhysioZoo y 23 perros: {len(split['train'])} perros de entrenamiento, "
                         f"{len(split['val'])} de validación y {len(split['test'])} de prueba (solo FC normal)"],
        "metrics": {"test_normal_flagged": round(metrics["test_normal"]["model_flagged"], 4),
                    "tachycardia_auroc": round(ts["model_auroc"], 4), "tachycardia_f1": round(ts["model_f1"], 4),
                    "bradycardia_auroc": round(s["bradycardia/sustained"]["model_auroc"], 4),
                    "bradycardia_f1": round(s["bradycardia/sustained"]["model_f1"], 4)},
        "params": metrics["params"], "seed": C.SEED, "gitCommit": git_commit(),
        "software": {"tensorflow": tf.__version__, "numpy": np.__version__},
        "trainedAt": trained_at,
    }
    (BUNDLE_DIR / "metadata.json").write_text(json.dumps(metadata, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")
    rng = np.random.default_rng(C.SEED)
    idx = rng.choice(len(z_te), 4, replace=False)
    parity_z = np.concatenate([z_te[idx], zdef["tachycardia"][:1]])
    PARITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    PARITY_PATH.write_text(json.dumps({"version": VERSION, "sequences": parity_z.round(6).tolist(),
                                       "errors": reconstruction_error(model, parity_z.round(6)).round(8).tolist()}), encoding="utf-8", newline="\n")
    print(f"exported to {BUNDLE_DIR}")


if __name__ == "__main__":
    main()
