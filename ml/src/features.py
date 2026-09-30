"""Statistical features per window for the Random Forest and Isolation Forest baselines.

Per channel: mean, std, min, max, median, p25, p75, skewness, kurtosis, RMS, mean absolute
deviation and zero-crossing rate. Orientation-free magnitudes of the accelerometer and gyroscope (raw units): mean,
std, max and spectral features (dominant frequency, band energies and spectral entropy). Correlations between axes.

Usage (from ml/):.venv/Scripts/python -m src.features
Output: data/processed/vehkaoja/neck/features_2.0s.parquet (dog_id, label, status + one column per feature)
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd

from . import config as C
from .dataset import load_windows

BANDS_HZ = ((0.0, 1.0), (1.0, 3.0), (3.0, 5.0), (5.0, 10.0), (10.0, 25.0))


def _channel_stats(x: np.ndarray, name: str) -> dict[str, np.ndarray]:
    """x: (N, T) one channel of every window."""
    mean = x.mean(axis=1)
    c = x - mean[:, None]
    std = x.std(axis=1)
    safe = np.where(std > 1e-12, std, 1.0)
    z = c / safe[:, None]
    p25, med, p75 = np.percentile(x, [25, 50, 75], axis=1)
    sign = np.signbit(c)
    return {
        f"{name}_mean": mean, f"{name}_std": std, f"{name}_min": x.min(axis=1), f"{name}_max": x.max(axis=1),
        f"{name}_median": med, f"{name}_p25": p25, f"{name}_p75": p75,
        f"{name}_skew": np.where(std > 1e-12, (z ** 3).mean(axis=1), 0.0),
        f"{name}_kurt": np.where(std > 1e-12, (z ** 4).mean(axis=1) - 3.0, 0.0),
        f"{name}_rms": np.sqrt((x ** 2).mean(axis=1)), f"{name}_mad": np.abs(c).mean(axis=1),
        f"{name}_zcr": (sign[:, 1:] != sign[:, :-1]).mean(axis=1),
    }


def _spectral(x: np.ndarray, name: str, fs: float = C.IMU_HZ) -> dict[str, np.ndarray]:
    """Band energies (share of total), dominant frequency and normalised spectral entropy of a mean-removed signal."""
    c = x - x.mean(axis=1, keepdims=True)
    p = np.abs(np.fft.rfft(c, axis=1)) ** 2
    f = np.fft.rfftfreq(x.shape[1], d=1 / fs)
    p[:, 0] = 0.0
    total = p.sum(axis=1)
    safe = np.where(total > 0, total, 1.0)
    out = {f"{name}_domfreq": np.where(total > 0, f[p.argmax(axis=1)], 0.0)}
    for lo, hi in BANDS_HZ:
        m = (f > lo) & (f <= hi)
        out[f"{name}_band_{lo:g}_{hi:g}"] = p[:, m].sum(axis=1) / safe
    q = p[:, 1:] / safe[:, None]
    ent = -(q * np.log(np.where(q > 0, q, 1.0))).sum(axis=1) / np.log(q.shape[1])
    out[f"{name}_spec_entropy"] = np.where(total > 0, ent, 0.0)
    return out


def window_features(z: np.ndarray, raw: np.ndarray) -> pd.DataFrame:
    """z: (N, T, 6) z-scored windows; raw: the same windows in g and °/s. Returns one row per window."""
    feats: dict[str, np.ndarray] = {}
    for i, ch in enumerate(C.IMU_CHANNELS):
        feats.update(_channel_stats(z[:, :, i], ch))
    for name, sl in (("acc_norm", slice(0, 3)), ("gyr_norm", slice(3, 6))):
        n = np.linalg.norm(raw[:, :, sl], axis=2)
        feats.update({f"{name}_mean": n.mean(axis=1), f"{name}_std": n.std(axis=1), f"{name}_max": n.max(axis=1)})
        feats.update(_spectral(n, name))
    for base, off in (("acc", 0), ("gyr", 3)):
        for a, b in ((0, 1), (0, 2), (1, 2)):
            xa, xb = z[:, :, off + a], z[:, :, off + b]
            ca, cb = xa - xa.mean(axis=1, keepdims=True), xb - xb.mean(axis=1, keepdims=True)
            den = np.sqrt((ca ** 2).sum(axis=1) * (cb ** 2).sum(axis=1))
            feats[f"{base}_corr_{'xyz'[a]}{'xyz'[b]}"] = np.where(den > 1e-12, (ca * cb).sum(axis=1) / np.where(den > 1e-12, den, 1.0), 0.0)
    return pd.DataFrame({k: v.astype(np.float32) for k, v in feats.items()})


def run(window_s: float = C.WINDOW_S, out_dir=C.VEHKAOJA_OUT) -> pd.DataFrame:
    parts = []
    for status in ("clean", "unlabeled"):
        z, y, dogs = load_windows(window_s=window_s, status=status)
        raw, _, _ = load_windows(window_s=window_s, status=status, normalize=False)
        f = window_features(z, raw)
        f.insert(0, "status", status)
        f.insert(0, "label", y)
        f.insert(0, "dog_id", dogs)
        parts.append(f)
    out = pd.concat(parts, ignore_index=True)
    out.to_parquet(out_dir / f"features_{window_s:.1f}s.parquet", index=False)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--window-s", type=float, default=C.WINDOW_S)
    f = run(ap.parse_args().window_s)
    print(json.dumps({"rows": len(f), "features": f.shape[1] - 3, "by_status": f["status"].value_counts().to_dict(),
                      "any_nan": bool(f.iloc[:, 3:].isna().any().any())}, indent=1))


if __name__ == "__main__":
    main()
