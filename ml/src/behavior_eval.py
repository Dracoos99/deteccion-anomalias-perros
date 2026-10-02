"""Extra evaluations of the CNN-LSTM with the recipe of the v2 members. Nothing here is exported or used by the Function.

  lodo     leave-one-dog-out: one member per held-out dog (45 folds), comparable with the Random Forest of
           src.baselines --lodo. Each fold early-stops on the fixed validation dogs (minus the held-out one) and trains
           on every other dog.
  sensor   the same recipe on the harness sensor (Back) with the fixed split of the collar, for decision D1.
           Needs the Back windows: VEHKAOJA_SENSOR=Back python -m src.preprocess &&... -m src.windows.

Resumable: every fold or seed saves its predictions under ml/models/behavior/eval/ and is skipped on the next run.
Usage (from ml/; GPU through Docker, about 5 to 9 min per member):
  python -m src.behavior_eval lodo [--dogs 16 18]
  python -m src.behavior_eval sensor [--seeds 1 2 3]
Output: ml/models/behavior/eval/lodo.json, sensor.json
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone

import numpy as np
from sklearn.metrics import f1_score

from . import config as C
from .dataset import load_sequences, load_windows
from .ensemble_behavior import smooth_sequence
from .tfsetup import seed_everything
from .train_behavior import classification_report, fit_model

OUT = C.ML_DIR / "models" / "behavior" / "eval"
NECK_DIR = C.PROCESSED_DIR / "vehkaoja" / "neck"
BACK_DIR = C.PROCESSED_DIR / "vehkaoja" / "back"
RECIPE = dict(epochs=60, patience=15, batch=128, label_smoothing=0.1, cosine=True)
TAU_S = 6.0   # smoothing of the deployed model (functions/models/behavior/metadata.json)


def splits() -> dict:
    return json.loads((NECK_DIR / "splits.json").read_text(encoding="utf-8"))


def macro_f1(y: np.ndarray, pred: np.ndarray) -> float:
    return round(float(f1_score(y, pred, average="macro")), 4)


def smoothed(model, dogs: list[int], out_dir) -> tuple[np.ndarray, np.ndarray]:
    """Clean labels and smoothed predictions of the stream of `dogs` (non-overlapping windows, as deployed)."""
    xs, ys, meta = load_sequences(None, out_dir=out_dir, dogs=dogs)
    probs = model.predict(xs, batch_size=512, verbose=0)
    step, _ = C.window_samples()
    sm, rows = smooth_sequence(probs, meta, TAU_S, step)
    clean = ys[rows] >= 0
    return ys[rows][clean], sm[clean].argmax(axis=1)


def fold_split(dog: int, every: list[int], fixed_val: list[int]) -> tuple[list[int], list[int]]:
    """Training and early-stopping dogs of the fold that holds out `dog`: the fixed validation dogs without it, and
    every other dog for training. The held-out dog is in neither."""
    val = [d for d in fixed_val if d != dog]
    return [d for d in every if d != dog and d not in val], val


def summary(per: dict) -> dict:
    f = np.array([d["macro_f1"] for d in per.values()])
    return {"mean": round(float(f.mean()), 4), "std": round(float(f.std()), 4), "min": round(float(f.min()), 4), "max": round(float(f.max()), 4)}


def lodo(only: list[int] | None) -> dict:
    sp = splits()
    every = sorted(sp["lodo"])
    x, y, dog_of = load_windows(dogs=every, out_dir=NECK_DIR)
    parts = OUT / "lodo"
    parts.mkdir(parents=True, exist_ok=True)
    for dog in (only or every):
        cache = parts / f"dog_{dog:03d}.npz"
        if cache.exists():
            continue
        t0 = time.time()
        train_dogs, val = fold_split(dog, every, sp["val"])
        tr, va, te = np.isin(dog_of, train_dogs), np.isin(dog_of, val), dog_of == dog
        seed_everything(C.SEED)
        model, stopper = fit_model(x[tr], y[tr], x[va], y[va], seed=C.SEED, **RECIPE)
        pred = model.predict(x[te], batch_size=512, verbose=0).argmax(axis=1)
        ys, ps = smoothed(model, [dog], NECK_DIR)
        np.savez_compressed(cache, y=y[te], pred=pred, y_smooth=ys, pred_smooth=ps,
                            info=json.dumps({"best_epoch": stopper.best_epoch, "epochs_run": len(stopper.history),
                                             "val_macro_f1": round(float(stopper.best), 4), "seconds": round(time.time() - t0)}))
        print(f"dog {dog}: macro F1 {macro_f1(y[te], pred):.3f} · smoothed {macro_f1(ys, ps):.3f} · {time.time() - t0:.0f} s", flush=True)

    per, y_all, p_all, ys_all, ps_all = {}, [], [], [], []
    for dog in every:
        cache = parts / f"dog_{dog:03d}.npz"
        if not cache.exists():
            continue
        z = np.load(cache)
        per[dog] = {"windows": int(len(z["y"])), "macro_f1": macro_f1(z["y"], z["pred"]),
                    "accuracy": round(float((z["y"] == z["pred"]).mean()), 4), "smoothed_macro_f1": macro_f1(z["y_smooth"], z["pred_smooth"]),
                    **json.loads(str(z["info"]))}
        y_all.append(z["y"]), p_all.append(z["pred"]), ys_all.append(z["y_smooth"]), ps_all.append(z["pred_smooth"])
    if not per:
        raise SystemExit("no folds yet")
    return {
        "recipe": RECIPE | {"seed": C.SEED, "members_per_fold": 1}, "folds": len(per), "of": len(every),
        "validation": "fixed validation dogs of splits.json without the held-out dog (early stopping only)",
        "pooled": classification_report(np.concatenate(y_all), np.concatenate(p_all)),
        "pooled_smoothed_macro_f1": macro_f1(np.concatenate(ys_all), np.concatenate(ps_all)),
        "smoothing_time_constant_s": TAU_S,
        "per_dog_macro_f1": summary(per),
        "per_dog_smoothed_macro_f1": summary({d: {"macro_f1": v["smoothed_macro_f1"]} for d, v in per.items()}),
        "per_dog": per,
    }


def sensor(seeds: list[int]) -> dict:
    if not (BACK_DIR / f"windows_{C.WINDOW_S:.1f}s.parquet").exists():
        raise SystemExit("missing the Back windows: VEHKAOJA_SENSOR=Back python -m src.preprocess, then src.windows")
    sp = splits()
    data = {s: load_windows(dogs=sp[s], out_dir=BACK_DIR)[:2] for s in ("train", "val", "test")}
    parts = OUT / "sensor-back"
    parts.mkdir(parents=True, exist_ok=True)
    for seed in seeds:
        cache = parts / f"seed-{seed}.npz"
        if cache.exists():
            continue
        t0 = time.time()
        seed_everything(seed)
        model, stopper = fit_model(*data["train"], *data["val"], seed=seed, **RECIPE)
        p_va = model.predict(data["val"][0], batch_size=512, verbose=0)
        p_te = model.predict(data["test"][0], batch_size=512, verbose=0)
        ys, ps = smoothed(model, sp["test"], BACK_DIR)
        np.savez_compressed(cache, val=p_va, test=p_te, y_smooth=ys, pred_smooth=ps,
                            info=json.dumps({"best_epoch": stopper.best_epoch, "epochs_run": len(stopper.history), "seconds": round(time.time() - t0)}))
        print(f"seed {seed}: val {macro_f1(data['val'][1], p_va.argmax(1)):.3f} · test {macro_f1(data['test'][1], p_te.argmax(1)):.3f}"
              f" · smoothed test {macro_f1(ys, ps):.3f} · {time.time() - t0:.0f} s", flush=True)

    runs = {int(p.stem.split("-")[1]): np.load(p) for p in sorted(parts.glob("seed-*.npz"))}
    if not runs:
        raise SystemExit("no seeds yet")
    y_va, y_te = data["val"][1], data["test"][1]
    members = [{"seed": s, "val_macro_f1": macro_f1(y_va, z["val"].argmax(1)), "test_macro_f1": macro_f1(y_te, z["test"].argmax(1)),
                "smoothed_test_macro_f1": macro_f1(z["y_smooth"], z["pred_smooth"]), **json.loads(str(z["info"]))} for s, z in runs.items()]
    avg_va = np.mean([z["val"] for z in runs.values()], axis=0)
    avg_te = np.mean([z["test"] for z in runs.values()], axis=0)
    # Collar members of the deployed model, same recipe (ml/models/behavior/cnn-lstm-v2/members/).
    neck = []
    for p in sorted((C.ML_DIR / "models" / "behavior" / "cnn-lstm-v2" / "members").glob("seed-*/metrics.json")):
        m = json.loads(p.read_text(encoding="utf-8"))
        neck.append({"seed": m["seed"], "val_macro_f1": m["val"]["macro_f1"], "test_macro_f1": m["test"]["macro_f1"]})
    col = lambda rows, k: {"mean": round(float(np.mean([r[k] for r in rows])), 4), "std": round(float(np.std([r[k] for r in rows])), 4)} if rows else None
    return {
        "recipe": RECIPE, "split": "fixed split of the collar (neck/splits.json)",
        "back": {"members": members, "val_macro_f1": col(members, "val_macro_f1"), "test_macro_f1": col(members, "test_macro_f1"),
                 "ensemble_val": classification_report(y_va, avg_va.argmax(1)), "ensemble_test": classification_report(y_te, avg_te.argmax(1))},
        "neck_members": {"members": neck, "val_macro_f1": col(neck, "val_macro_f1"), "test_macro_f1": col(neck, "test_macro_f1")},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=("lodo", "sensor"))
    ap.add_argument("--dogs", type=int, nargs="*", help="lodo: only these held-out dogs (the summary uses every fold done)")
    ap.add_argument("--seeds", type=int, nargs="*", default=[1, 2, 3])
    args = ap.parse_args()
    res = lodo(args.dogs) if args.what == "lodo" else sensor(args.seeds)
    res["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{args.what}.json"
    path.write_text(json.dumps(res, indent=1), encoding="utf-8", newline="\n")
    brief = ({"folds": res["folds"], "pooled_macro_f1": res["pooled"]["macro_f1"], "pooled_smoothed_macro_f1": res["pooled_smoothed_macro_f1"],
              "per_dog": res["per_dog_macro_f1"]} if args.what == "lodo"
             else {"back": {k: res["back"][k] for k in ("val_macro_f1", "test_macro_f1")}, "neck": {k: res["neck_members"][k] for k in ("val_macro_f1", "test_macro_f1")}})
    print(json.dumps(brief, indent=1))
    print(f"written {path}")


if __name__ == "__main__":
    main()
