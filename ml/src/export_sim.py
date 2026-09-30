"""Exports the source signals the simulator replays. Refines D6: JSON is kept for the small
heart-rate series, but the IMU goes as raw Float32 (a JSON of every 10 s block would take about 0.5 GB).

  sim/imu/vehkaoja2022/<dog>.f32   neck IMU of every recording of the dog, in test order: little-endian float32,
                                   interleaved acc_x, acc_y, acc_z (g), gyr_x, gyr_y, gyr_z (°/s) at 100 Hz
  sim/hr/<source>/<dog>.json       1 Hz heart rate of the dog: valid seconds of its sessions, chained in order, and
                                   "breaks": the index where every later contiguous stretch starts (a gap or a new
                                   session), so the simulator can show the gap instead of joining the stretches
  sim/manifest.json                subjects with length and metadata, and the fitted activity threshold

Requires src.preprocess, src.hr_series and src.activity to have run. Usage (from ml/):
.venv/Scripts/python -m src.export_sim            # everything
.venv/Scripts/python -m src.export_sim --hr-only  # only the heart-rate series (keeps the IMU files and their manifest)
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config as C
from .hr_series import SOURCES


def contiguous_breaks(t_s: np.ndarray, session: np.ndarray) -> list[int]:
    """Indices (> 0) where a new contiguous stretch starts: a jump in time or a change of session."""
    return (np.flatnonzero((np.diff(t_s) != 1) | (session[1:] != session[:-1])) + 1).tolist()


def export_hr(out_dir, manifest: dict) -> None:
    for source in SOURCES:
        target = out_dir / "hr" / source
        target.mkdir(parents=True, exist_ok=True)
        items = []
        for path in sorted(glob.glob(str(C.HR_OUT / source / "*.parquet"))):
            dog = os.path.basename(path)[:-8]
            df = pd.read_parquet(path).sort_values(["session_order", "t_s"])
            values = np.round(df["hr_bpm"].to_numpy(dtype=float), 1)
            breaks = contiguous_breaks(df["t_s"].to_numpy(np.int64), pd.factorize(df["session_id"])[0])
            (target / f"{dog}.json").write_text(json.dumps({"subjectId": dog, "hz": 1, "values": values.tolist(), "breaks": breaks}),
                                                encoding="utf-8")
            items.append({"subjectId": dog, "values": int(len(values)), "hours": round(len(values) / 3600, 2),
                          "hrMean": round(float(values.mean()), 1), "sessions": int(df["session_id"].nunique()),
                          "stretches": len(breaks) + 1})
        manifest["hr"][source] = items


def export(out_dir=C.SIM_OUT, hr_only: bool = False) -> dict:
    if hr_only:
        manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
        manifest["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        export_hr(out_dir, manifest)
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
        return manifest
    manifest = {"version": 1, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "imuHz": C.IMU_HZ, "imuChannels": list(C.IMU_CHANNELS), "imu": {}, "hr": {}}

    recs = pd.read_parquet(C.VEHKAOJA_OUT / "recordings.parquet")
    # Per-dog z-score statistics used in training: the simulator stores them in dogs.baseline.
    stats = pd.read_parquet(C.VEHKAOJA_OUT / "norm_stats.parquet").pivot(index="dog_id", columns="channel")
    imu_dir = out_dir / "imu" / "vehkaoja2022"
    imu_dir.mkdir(parents=True, exist_ok=True)
    subjects = []
    for dog, g in recs.sort_values(["dog_id", "test_num"]).groupby("dog_id"):
        x = np.concatenate([pd.read_parquet(C.VEHKAOJA_OUT / f, columns=list(C.IMU_CHANNELS)).to_numpy(np.float32) for f in g["file"]])
        x.astype("<f4").tofile(imu_dir / f"{dog}.f32")
        r = g.iloc[0]
        subjects.append({"subjectId": str(dog), "samples": int(len(x)), "minutes": round(len(x) / C.IMU_HZ / 60, 1),
                         "tests": int(len(g)), "breed": r["breed"], "weightKg": float(r["weight_kg"]),
                         "imuMean": [round(float(stats.loc[dog, ("mean", ch)]), 6) for ch in C.IMU_CHANNELS],
                         "imuStd": [round(float(stats.loc[dog, ("std", ch)]), 6) for ch in C.IMU_CHANNELS]})
    manifest["imu"]["vehkaoja2022"] = subjects

    export_hr(out_dir, manifest)

    thr = json.loads((C.VEHKAOJA_OUT / "activity_threshold.json").read_text(encoding="utf-8"))
    manifest["activity"] = {"thresholdG": thr["threshold_g"], "balancedAccuracyVal": thr["val"]["balanced_accuracy"]}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hr-only", action="store_true")
    m = export(hr_only=ap.parse_args().hr_only)
    print(json.dumps({"imu_subjects": len(m["imu"]["vehkaoja2022"]), "hr_subjects": {k: len(v) for k, v in m["hr"].items()},
                      "activity": m["activity"]}, indent=1))
