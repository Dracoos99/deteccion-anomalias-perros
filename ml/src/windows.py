"""Window index over the preprocessed recordings. Windows are not copied to disk: the index stores
where each one starts, and dataset.py slices them when training.

Usage (from ml/):.venv/Scripts/python -m src.windows [--window-s 2] [--overlap 0.5]
Output: data/processed/vehkaoja/neck/windows_2.0s.parquet with dog_id, test_num, file, start, label, status.
status is "clean" (one project class, trainable) or why the window is rejected: "gap", "saturated", "mixed"
(transition or mixed labels), "unlabeled" (held-out behaviours, used to calibrate novelty) or "ambiguous".
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from . import config as C

STATUS = ("clean", "gap", "saturated", "mixed", "unlabeled", "ambiguous")


def window_status(label: np.ndarray, saturated: np.ndarray, t_sec: np.ndarray, win: int, hop: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Start index, label and status code (index into STATUS) of every window of one recording.
    Rejection order: gap, saturation, mixed labels, then the single label decides (same order as the exploration)."""
    n = len(label)
    if n < win:
        return np.empty(0, np.int64), np.empty(0, np.int8), np.empty(0, np.int8)
    starts = np.arange(0, n - win + 1, hop)
    lab = sliding_window_view(label, win)[starts]
    lo, hi = lab.min(axis=1), lab.max(axis=1)
    sat = np.concatenate([[0], np.cumsum(saturated, dtype=np.int64)])
    has_sat = (sat[starts + win] - sat[starts]) > 0
    jump = np.concatenate([[0], np.cumsum(np.diff(t_sec) > C.MAX_SAMPLE_GAP_S, dtype=np.int64)])
    has_gap = (jump[starts + win - 1] - jump[starts]) > 0

    status = np.select(
        [has_gap, has_sat, lo != hi, lo == C.UNLABELED, lo == C.AMBIGUOUS],
        [STATUS.index("gap"), STATUS.index("saturated"), STATUS.index("mixed"), STATUS.index("unlabeled"), STATUS.index("ambiguous")],
        default=STATUS.index("clean"),
    ).astype(np.int8)
    return starts, lo.astype(np.int8), status


def build_index(window_s: float = C.WINDOW_S, overlap: float = C.OVERLAP, out_dir=C.VEHKAOJA_OUT) -> pd.DataFrame:
    win, hop = C.window_samples(window_s, overlap)
    recs = pd.read_parquet(out_dir / "recordings.parquet")
    parts = []
    for r in recs.itertuples():
        d = pd.read_parquet(out_dir / r.file, columns=["t_sec", "label", "saturated"])
        starts, lab, st = window_status(d["label"].to_numpy(), d["saturated"].to_numpy(), d["t_sec"].to_numpy(), win, hop)
        parts.append(pd.DataFrame({"dog_id": r.dog_id, "test_num": r.test_num, "file": r.file, "start": starts, "label": lab, "status": st}))
    idx = pd.concat(parts, ignore_index=True)
    idx["status"] = pd.Categorical.from_codes(idx["status"], categories=list(STATUS))
    idx.attrs = {"window_s": window_s, "overlap": overlap, "win": win, "hop": hop}
    idx.to_parquet(out_dir / f"windows_{window_s:.1f}s.parquet", index=False)
    return idx


def summarize(idx: pd.DataFrame) -> dict:
    clean = idx[idx["status"] == "clean"]
    return {
        "windows": len(idx),
        "clean": len(clean),
        "clean_by_class": {C.CLASSES[k]: int(v) for k, v in clean["label"].value_counts().sort_index().items()},
        "clean_dogs_by_class": {C.CLASSES[k]: int(v) for k, v in clean.groupby("label")["dog_id"].nunique().items()},
        "rejected": {s: int((idx["status"] == s).sum()) for s in STATUS[1:]},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--window-s", type=float, default=C.WINDOW_S)
    ap.add_argument("--overlap", type=float, default=C.OVERLAP)
    args = ap.parse_args()
    print(json.dumps(summarize(build_index(args.window_s, args.overlap)), indent=1))


if __name__ == "__main__":
    main()
