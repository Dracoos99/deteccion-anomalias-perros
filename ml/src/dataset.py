"""Loads windows as arrays for training (phase 2): per-dog z-score applied on the fly.

    from src.dataset import load_windows
    X, y, dogs = load_windows("train")   # X: (N, 200, 6) float32, y: (N) int8 class index, dogs: (N)
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config as C


def load_windows(split: str | None = None, window_s: float = C.WINDOW_S, status: str | tuple[str, ...] = "clean",
                 out_dir=C.VEHKAOJA_OUT, dogs: list[int] | None = None, normalize: bool = True
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Windows of one split ("train" | "val" | "test"), of explicit dogs, or all. status="unlabeled" returns the
    held-out windows used to calibrate the novelty threshold. normalize=False returns raw units (g, °/s)."""
    idx = pd.read_parquet(out_dir / f"windows_{window_s:.1f}s.parquet")
    idx = idx[idx["status"].isin([status] if isinstance(status, str) else list(status))]
    if split is not None:
        dogs = json.loads((out_dir / "splits.json").read_text(encoding="utf-8"))[split]
    if dogs is not None:
        idx = idx[idx["dog_id"].isin(dogs)]
    win, _ = C.window_samples(window_s)
    stats = pd.read_parquet(out_dir / "norm_stats.parquet").pivot(index="dog_id", columns="channel")
    X = np.empty((len(idx), win, len(C.IMU_CHANNELS)), np.float32)
    row = 0
    for (dog, file), g in idx.groupby(["dog_id", "file"], sort=False):
        mean = stats.loc[dog, "mean"][list(C.IMU_CHANNELS)].to_numpy(np.float32)
        std = stats.loc[dog, "std"][list(C.IMU_CHANNELS)].to_numpy(np.float32)
        sig = pd.read_parquet(out_dir / file, columns=list(C.IMU_CHANNELS)).to_numpy(np.float32)
        if normalize:
            sig = (sig - mean) / std
        starts = g["start"].to_numpy()
        X[row:row + len(g)] = sig[starts[:, None] + np.arange(win)]
        row += len(g)
    order = idx.groupby(["dog_id", "file"], sort=False).ngroup().argsort(kind="stable")
    ordered = idx.iloc[order]
    return X, ordered["label"].to_numpy(np.int8), ordered["dog_id"].to_numpy()


def load_sequences(split: str, window_s: float = C.WINDOW_S, out_dir=C.VEHKAOJA_OUT) -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    """Every window of a split (any status) in time order per recording, z-scored per dog, with its metadata: the
    stream a deployed model sees, transitions and unlabelled stretches included. y is the class index of clean windows
    and -1 for the others; meta has dog_id, file, start and status, aligned with X."""
    idx = pd.read_parquet(out_dir / f"windows_{window_s:.1f}s.parquet")
    dogs = json.loads((out_dir / "splits.json").read_text(encoding="utf-8"))[split]
    idx = idx[idx["dog_id"].isin(dogs)].sort_values(["dog_id", "file", "start"], kind="stable").reset_index(drop=True)
    win, _ = C.window_samples(window_s)
    stats = pd.read_parquet(out_dir / "norm_stats.parquet").pivot(index="dog_id", columns="channel")
    X = np.empty((len(idx), win, len(C.IMU_CHANNELS)), np.float32)
    row = 0
    for (dog, file), g in idx.groupby(["dog_id", "file"], sort=False):
        mean = stats.loc[dog, "mean"][list(C.IMU_CHANNELS)].to_numpy(np.float32)
        std = stats.loc[dog, "std"][list(C.IMU_CHANNELS)].to_numpy(np.float32)
        sig = (pd.read_parquet(out_dir / file, columns=list(C.IMU_CHANNELS)).to_numpy(np.float32) - mean) / std
        starts = g["start"].to_numpy()
        X[row:row + len(g)] = sig[starts[:, None] + np.arange(win)]
        row += len(g)
    clean = (idx["status"] == "clean").to_numpy()
    y = np.where(clean, idx["label"].fillna(-1).to_numpy(), -1).astype(np.int8)
    return X, y, idx[["dog_id", "file", "start", "status"]]
