"""Splits by dog, never by window: a fixed 70/15/15 split for development and leave-one-dog-out folds for
the final evaluation. A dog with two tests stays whole in one set.

Usage (from ml/):.venv/Scripts/python -m src.splits [--window-s 2]
Output: data/processed/vehkaoja/neck/splits.json
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd

from . import config as C


def split_dogs(dogs: list[int], seed: int = C.SEED, fractions: dict[str, float] = C.SPLIT_FRACTIONS) -> dict[str, list[int]]:
    dogs = sorted(dogs)
    perm = np.random.default_rng(seed).permutation(dogs).tolist()
    n_val, n_test = round(len(dogs) * fractions["val"]), round(len(dogs) * fractions["test"])
    return {
        "train": sorted(perm[n_val + n_test:]),
        "val": sorted(perm[:n_val]),
        "test": sorted(perm[n_val:n_val + n_test]),
    }


def run(window_s: float = C.WINDOW_S, out_dir=C.VEHKAOJA_OUT) -> dict:
    idx = pd.read_parquet(out_dir / f"windows_{window_s:.1f}s.parquet")
    clean = idx[idx["status"] == "clean"]
    dogs = sorted(int(d) for d in clean["dog_id"].unique())
    split = split_dogs(dogs)
    counts = {}
    for name, members in split.items():
        part = clean[clean["dog_id"].isin(members)]
        counts[name] = {"dogs": len(members), "windows": len(part),
                        "by_class": {c: int((part["label"] == i).sum()) for i, c in enumerate(C.CLASSES)}}
    missing = {name: [c for c, v in counts[name]["by_class"].items() if v == 0] for name in split}
    out = {
        "dataset": "vehkaoja2022", "sensor": C.SENSOR, "window_s": window_s, "seed": C.SEED,
        "fractions": C.SPLIT_FRACTIONS, **split, "lodo": dogs, "counts": counts,
        "classes_missing": {k: v for k, v in missing.items() if v},
    }
    assert not set(split["train"]) & set(split["val"]) | set(split["train"]) & set(split["test"]) | set(split["val"]) & set(split["test"])
    (out_dir / "splits.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--window-s", type=float, default=C.WINDOW_S)
    out = run(ap.parse_args().window_s)
    print(json.dumps({k: out[k] for k in ("train", "val", "test", "counts", "classes_missing")}, indent=1))


if __name__ == "__main__":
    main()
