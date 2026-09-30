"""CNN-LSTM behavioral model.

Trains on the fixed split by dog (splits.json), early-stops on the validation macro F1, evaluates the test dogs once,
calibrates the novelty threshold of the softmax on validation and exports the model to TF.js for the Function.

Usage (from ml/):.venv/Scripts/python -m src.train_behavior [--epochs 40] [--quick]
Outputs:
  ml/models/behavior/<version>/        Keras model (h5), metrics.json, history.json (not versioned)
  functions/models/behavior/           model.json + weights (TF.js layers format) and metadata.json (versioned)
  functions/test/fixtures/behavior-parity.json   windows + Keras probabilities that the TF.js loader must reproduce
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.metrics import (accuracy_score, balanced_accuracy_score, confusion_matrix, f1_score,
                             precision_recall_fscore_support, roc_auc_score)
from sklearn.utils.class_weight import compute_class_weight

from . import config as C
from .tfsetup import keras, load_tfjs_keras_converter, seed_everything, tf
from .dataset import load_windows

REPO = C.ML_DIR.parent
VERSION = "cnn-lstm-v1"
ACTIVE_CLASSES = ("trot", "walk", "play", "sniff")
NOVELTY_QUANTILE = 0.05   # 5 % of normal validation windows fall below the threshold
BUNDLE_DIR = REPO / "functions" / "models" / "behavior"
PARITY_PATH = REPO / "functions" / "test" / "fixtures" / "behavior-parity.json"


def build_model(input_len: int, n_channels: int = len(C.IMU_CHANNELS), n_classes: int = len(C.CLASSES)) -> keras.Model:
    """Architecture (padding 'same' so the sequence halves exactly at the pooling)."""
    L = keras.layers
    return keras.Sequential([
        L.Input((input_len, n_channels)),
        L.Conv1D(64, 5, padding="same"), L.BatchNormalization(), L.ReLU(),
        L.MaxPooling1D(2),
        L.Conv1D(128, 3, padding="same"), L.BatchNormalization(), L.ReLU(),
        L.Dropout(0.3),
        L.LSTM(64),
        L.Dense(64, activation="relu"),
        L.Dense(n_classes, activation="softmax"),
    ], name="cnn_lstm")


def augment(x, y):
    """Training-only augmentation: small rotation of the sensor axes (same for accelerometer and gyroscope),
    per-channel scaling and Gaussian noise, in z-score units."""
    angle = tf.random.uniform([], -np.pi / 18, np.pi / 18)       # ±10°
    axis = tf.math.l2_normalize(tf.random.normal([3]))
    k = tf.stack([[0.0, -axis[2], axis[1]], [axis[2], 0.0, -axis[0]], [-axis[1], axis[0], 0.0]])
    rot = tf.eye(3) + tf.sin(angle) * k + (1 - tf.cos(angle)) * tf.matmul(k, k)   # Rodrigues
    x = tf.concat([tf.matmul(x[:, :3], rot), tf.matmul(x[:, 3:], rot)], axis=1)
    x = x * tf.random.uniform([1, x.shape[1]], 0.9, 1.1) + tf.random.normal(tf.shape(x), stddev=0.05)
    return x, y


class MacroF1EarlyStopping(keras.callbacks.Callback):
    """Stops on the validation macro F1 and restores the best weights."""

    def __init__(self, x_val, y_val, patience: int):
        super().__init__()
        self.x_val, self.y_val, self.patience = x_val, y_val, patience
        self.best, self.best_epoch, self.best_weights, self.wait, self.history = -1.0, -1, None, 0, []

    def on_epoch_end(self, epoch, logs=None):
        pred = self.model.predict(self.x_val, batch_size=512, verbose=0).argmax(axis=1)
        f1 = f1_score(self.y_val, pred, average="macro")
        self.history.append({"epoch": epoch + 1, "val_macro_f1": round(float(f1), 4), **{k: round(float(v), 4) for k, v in (logs or {}).items()}})
        print(f"  epoch {epoch + 1}: val macro F1 {f1:.4f} · loss {logs.get('loss', float('nan')):.4f} · val_loss {logs.get('val_loss', float('nan')):.4f}", flush=True)
        if f1 > self.best:
            self.best, self.best_epoch, self.wait = f1, epoch + 1, 0
            self.best_weights = self.model.get_weights()
        else:
            self.wait += 1
            if self.wait >= self.patience:
                self.model.stop_training = True

    def on_train_end(self, logs=None):
        if self.best_weights is not None:
            self.model.set_weights(self.best_weights)


def classification_report(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=range(len(C.CLASSES)), zero_division=0)
    active = np.isin(np.arange(len(C.CLASSES)), [C.CLASSES.index(c) for c in ACTIVE_CLASSES])
    return {
        "windows": int(len(y_true)),
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 4),
        "macro_f1": round(float(f1_score(y_true, y_pred, average="macro")), 4),
        "per_class": {c: {"precision": round(float(p[i]), 4), "recall": round(float(r[i]), 4), "f1": round(float(f[i]), 4), "support": int(s[i])}
                      for i, c in enumerate(C.CLASSES)},
        "confusion_matrix": confusion_matrix(y_true, y_pred, labels=range(len(C.CLASSES))).tolist(),
        "active_balanced_accuracy": round(float(balanced_accuracy_score(active[y_true], active[y_pred])), 4),
    }


def novelty_report(p_clean_val: np.ndarray, p_clean_test: np.ndarray, p_unlab_test: np.ndarray) -> dict:
    """Novelty = max softmax below the threshold. Unlabelled windows mix held-out behaviours (eating, galloping,
    shaking...) with unannotated stretches, so they are an imperfect proxy of 'novel'."""
    thr = float(np.quantile(p_clean_val.max(axis=1), NOVELTY_QUANTILE))
    m_clean, m_unlab = p_clean_test.max(axis=1), p_unlab_test.max(axis=1)
    y = np.concatenate([np.zeros(len(m_clean)), np.ones(len(m_unlab))])
    return {"threshold": round(thr, 4), "quantile_on_val_clean": NOVELTY_QUANTILE,
            "test_clean_flagged": round(float((m_clean < thr).mean()), 4),
            "test_unlabeled_flagged": round(float((m_unlab < thr).mean()), 4),
            "auroc_clean_vs_unlabeled": round(float(roc_auc_score(y, -np.concatenate([m_clean, m_unlab]))), 4),
            "test_unlabeled_windows": int(len(m_unlab))}


def git_commit() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001 - informative only
        return None


def export_tfjs(model: keras.Model, metadata: dict, parity: dict) -> None:
    k = load_tfjs_keras_converter()
    BUNDLE_DIR.mkdir(parents=True, exist_ok=True)
    for f in BUNDLE_DIR.glob("*"):
        f.unlink()
    k.save_keras_model(model, str(BUNDLE_DIR))
    (BUNDLE_DIR / "metadata.json").write_text(json.dumps(metadata, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")
    PARITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    PARITY_PATH.write_text(json.dumps(parity), encoding="utf-8", newline="\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--patience", type=int, default=6)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--quick", action="store_true", help="2 epochs on a subset, to check the pipeline")
    ap.add_argument("--no-export", action="store_true")
    args = ap.parse_args()
    seed_everything(C.SEED)
    t0 = time.time()

    x_tr, y_tr, _ = load_windows("train")
    x_va, y_va, _ = load_windows("val")
    x_te, y_te, _ = load_windows("test")
    u_te, _, _ = load_windows("test", status="unlabeled")
    if args.quick:
        rng = np.random.default_rng(C.SEED)
        idx = rng.choice(len(x_tr), 4000, replace=False)
        x_tr, y_tr, args.epochs = x_tr[idx], y_tr[idx], 2
    print(f"train {len(y_tr)} · val {len(y_va)} · test {len(y_te)} · test unlabeled {len(u_te)}", flush=True)

    weights = compute_class_weight("balanced", classes=np.arange(len(C.CLASSES)), y=y_tr)
    ds = (tf.data.Dataset.from_tensor_slices((x_tr, y_tr.astype(np.int32)))
          .shuffle(len(y_tr), seed=C.SEED, reshuffle_each_iteration=True)
          .map(augment, num_parallel_calls=tf.data.AUTOTUNE, deterministic=True)
          .batch(args.batch).prefetch(tf.data.AUTOTUNE))
    model = build_model(x_tr.shape[1])
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    stopper = MacroF1EarlyStopping(x_va, y_va, args.patience)
    model.fit(ds, validation_data=(x_va, y_va.astype(np.int32)), epochs=args.epochs, verbose=0,
              class_weight={i: float(w) for i, w in enumerate(weights)},
              callbacks=[stopper, keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=3, verbose=0)])

    p_va = model.predict(x_va, batch_size=512, verbose=0)
    p_te = model.predict(x_te, batch_size=512, verbose=0)
    p_un = model.predict(u_te, batch_size=512, verbose=0)
    metrics = {
        "version": VERSION, "split": "fixed by dog (splits.json)", "best_epoch": stopper.best_epoch, "epochs_run": len(stopper.history),
        "val": classification_report(y_va, p_va.argmax(axis=1)), "test": classification_report(y_te, p_te.argmax(axis=1)),
        "novelty": novelty_report(p_va, p_te, p_un), "train_seconds": round(time.time() - t0), "params": int(model.count_params()),
        "quick": bool(args.quick),
    }
    out = C.ML_DIR / "models" / "behavior" / (VERSION + ("-quick" if args.quick else ""))
    out.mkdir(parents=True, exist_ok=True)
    model.save(out / "model.h5")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8", newline="\n")
    (out / "history.json").write_text(json.dumps(stopper.history, indent=1), encoding="utf-8", newline="\n")
    print(json.dumps({k: metrics[k] for k in ("best_epoch", "epochs_run", "train_seconds")} | {
        "val_macro_f1": metrics["val"]["macro_f1"], "test_macro_f1": metrics["test"]["macro_f1"], "test_accuracy": metrics["test"]["accuracy"],
        "novelty": metrics["novelty"]}, indent=1))

    if args.quick or args.no_export:
        return
    splits = json.loads((C.VEHKAOJA_OUT / "splits.json").read_text(encoding="utf-8"))
    metadata = {
        "version": VERSION, "kind": "behavior", "architecture": "Conv1D(64,5)+BN+ReLU · MaxPool(2) · Conv1D(128,3)+BN+ReLU · Dropout(0.3) · LSTM(64) · Dense(64) · Dense(7, softmax)",
        "classes": list(C.CLASSES), "activeClasses": list(ACTIVE_CLASSES), "windowSamples": int(x_tr.shape[1]), "imuHz": C.IMU_HZ,
        "channels": list(C.IMU_CHANNELS), "normalization": "per-dog z-score per channel (dogs.baseline.imuMean / imuStd)",
        "noveltyThreshold": metrics["novelty"]["threshold"], "noveltyQuantile": NOVELTY_QUANTILE,
        # Shown to admins in the web app (modelVersions.trainingData): Spanish.
        "trainingData": [f"Vehkaoja et al. (2022), sensor {'del cuello' if C.SENSOR == 'Neck' else 'de la espalda'}: "
                         f"{len(splits['train'])} perros de entrenamiento, {len(splits['val'])} de validación y {len(splits['test'])} de prueba"],
        "metrics": {"test_macro_f1": metrics["test"]["macro_f1"], "test_accuracy": metrics["test"]["accuracy"], "val_macro_f1": metrics["val"]["macro_f1"],
                    "test_active_balanced_accuracy": metrics["test"]["active_balanced_accuracy"], "novelty_auroc": metrics["novelty"]["auroc_clean_vs_unlabeled"]},
        "params": metrics["params"], "seed": C.SEED, "gitCommit": git_commit(),
        "software": {"tensorflow": tf.__version__, "tf_keras": keras.__version__, "numpy": np.__version__},
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    parity_idx = np.random.default_rng(C.SEED).choice(len(x_te), 6, replace=False)
    parity = {"version": VERSION, "windows": x_te[parity_idx].round(6).tolist()}
    parity["probs"] = model.predict(np.array(parity["windows"], dtype=np.float32), verbose=0).tolist()
    export_tfjs(model, metadata, parity)
    print(f"exported to {BUNDLE_DIR}")


if __name__ == "__main__":
    main()
