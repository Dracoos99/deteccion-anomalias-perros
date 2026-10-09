"""Vehkaoja et al. (2022) -> one Parquet per recording with the chosen sensor, resolved labels and flags.

Every sample is kept (labelled or not) so the window length can change (RF-01) and the unlabelled stretches can
calibrate novelty in phase 2. Values are stored raw; the per-dog z-score is applied when windows are loaded.

Usage (from ml/):.venv/Scripts/python -m src.preprocess
Outputs in data/processed/vehkaoja/neck/:
  recordings/dogNNN_testT.parquet   t_sec, acc_* gyr_* label, saturated, task, behavior_1..3
  recordings.parquet                one row per recording with its metadata and quality counts
  norm_stats.parquet                per-dog, per-channel mean and std for the z-score
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
import pandas as pd

from . import config as C

CHUNK_ROWS = 1_000_000


def resolve_labels(behaviors: pd.DataFrame) -> np.ndarray:
    """D2: class index if exactly one project class is annotated, UNLABELED if none, AMBIGUOUS if two or more."""
    codes = np.stack([
        behaviors[c].map({k: C.CLASSES.index(v) for k, v in C.LABEL_MAP.items()}).fillna(-1).to_numpy(np.int16)
        for c in behaviors.columns
    ], axis=1)
    hi = codes.max(axis=1)
    lo = np.where(codes >= 0, codes, np.iinfo(np.int16).max).min(axis=1)
    return np.where(hi < 0, C.UNLABELED, np.where(lo == hi, hi, C.AMBIGUOUS)).astype(np.int8)


def saturation_mask(imu: np.ndarray) -> np.ndarray:
    """True where any accelerometer or gyroscope axis reaches the sensor full scale."""
    return (np.abs(imu[:, :3]) >= C.SAT_ACC_G).any(axis=1) | (np.abs(imu[:, 3:]) >= C.SAT_GYR_DPS).any(axis=1)


def _to_frame(raw: pd.DataFrame) -> pd.DataFrame:
    imu = raw[[C.SOURCE_COLUMNS[ch] for ch in C.IMU_CHANNELS]].to_numpy(np.float32)
    out = pd.DataFrame(imu, columns=list(C.IMU_CHANNELS))
    out.insert(0, "t_sec", raw["t_sec"].to_numpy(np.float64))
    out["label"] = resolve_labels(raw[list(C.BEHAVIOR_COLUMNS)])
    out["saturated"] = saturation_mask(imu)
    for col, src in [("task", "Task"), *[(f"behavior_{i + 1}", b) for i, b in enumerate(C.BEHAVIOR_COLUMNS)]]:
        out[col] = raw[src].replace("<undefined>", pd.NA).astype("category").to_numpy()
    return out


def _write_recording(frames: list[pd.DataFrame], dog: int, test: int, rec_dir) -> dict:
    df = pd.concat(frames, ignore_index=True)
    for col in ("task", "behavior_1", "behavior_2", "behavior_3"):
        df[col] = df[col].astype("category")
    name = f"dog{dog:03d}_test{test}.parquet"
    df.to_parquet(rec_dir / name, index=False, compression="zstd")
    dt = np.diff(df["t_sec"].to_numpy())
    counts = np.bincount(df["label"].to_numpy() - C.AMBIGUOUS, minlength=len(C.CLASSES) + 2)
    return {
        "dog_id": dog, "test_num": test, "file": f"recordings/{name}", "n_samples": len(df),
        "duration_s": round(float(df["t_sec"].iloc[-1] - df["t_sec"].iloc[0]), 2),
        "gaps": int((dt > C.MAX_SAMPLE_GAP_S).sum()), "non_increasing": int((dt <= 0).sum()),
        "saturated_samples": int(df["saturated"].sum()),
        "unlabeled_samples": int(counts[C.UNLABELED - C.AMBIGUOUS]), "ambiguous_samples": int(counts[0]),
        **{f"n_{c}": int(counts[i + 2]) for i, c in enumerate(C.CLASSES)},
    }


def run(csv_path=C.VEHKAOJA_CSV, out_dir=C.VEHKAOJA_OUT) -> pd.DataFrame:
    rec_dir = out_dir / "recordings"
    rec_dir.mkdir(parents=True, exist_ok=True)
    usecols = ["DogID", "TestNum", "t_sec", *C.SOURCE_COLUMNS.values(), "Task", *C.BEHAVIOR_COLUMNS]
    dtypes = {"DogID": np.int32, "TestNum": np.int16, "t_sec": np.float64, **{c: np.float32 for c in C.SOURCE_COLUMNS.values()},
              "Task": "string", **{c: "string" for c in C.BEHAVIOR_COLUMNS}}

    rows, seen, key, frames = [], set(), None, []
    t0 = time.time()
    for chunk in pd.read_csv(csv_path, usecols=usecols, dtype=dtypes, chunksize=CHUNK_ROWS):
        # Recordings are contiguous in the CSV; split the chunk wherever (DogID, TestNum) changes.
        k = chunk["DogID"].to_numpy() * 100 + chunk["TestNum"].to_numpy()
        cuts = np.flatnonzero(np.diff(k)) + 1
        for part in np.split(np.arange(len(chunk)), cuts):
            sub = chunk.iloc[part]
            this = (int(sub["DogID"].iat[0]), int(sub["TestNum"].iat[0]))
            if this != key:
                if frames:
                    rows.append(_write_recording(frames, *key, rec_dir))
                if this in seen:
                    raise ValueError(f"Recording {this} is not contiguous in the CSV")
                seen.add(this)
                key, frames = this, []
            frames.append(_to_frame(sub))
        print(f"  {len(rows)} recordings written, {time.time() - t0:.0f} s", flush=True)
    if frames:
        rows.append(_write_recording(frames, *key, rec_dir))

    recs = pd.DataFrame(rows).sort_values(["dog_id", "test_num"], ignore_index=True)
    info = pd.read_csv(C.VEHKAOJA_DOGINFO).rename(columns={
        "DogID": "dog_id", "Breed": "breed", "Weight": "weight_kg", "Age months": "age_months",
        "Gender": "gender", "NeuteringStatus": "neutering_status"})
    recs = recs.merge(info, on="dog_id", how="left")
    recs.to_parquet(out_dir / "recordings.parquet", index=False)
    stats = norm_stats(recs, out_dir)
    stats.to_parquet(out_dir / "norm_stats.parquet", index=False)
    return recs


def norm_stats(recs: pd.DataFrame, out_dir) -> pd.DataFrame:
    """Per-dog z-score parameters over all non-saturated samples of the dog (both tests), labels not used.
    In production the same statistics come from the dog's first normal data (its baseline)."""
    out = []
    for dog, g in recs.groupby("dog_id"):
        x = np.concatenate([
            pd.read_parquet(out_dir / f, columns=[*C.IMU_CHANNELS, "saturated"]).query("~saturated")[list(C.IMU_CHANNELS)].to_numpy(np.float64)
            for f in g["file"]])
        mean, std = x.mean(axis=0), x.std(axis=0)
        out += [{"dog_id": dog, "channel": ch, "mean": mean[i], "std": std[i], "n": len(x)} for i, ch in enumerate(C.IMU_CHANNELS)]
    return pd.DataFrame(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=str(C.VEHKAOJA_CSV))
    args = ap.parse_args()
    recs = run(csv_path=args.csv)
    summary = {
        "recordings": len(recs), "dogs": int(recs["dog_id"].nunique()),
        "dogs_with_two_tests": int((recs.groupby("dog_id").size() > 1).sum()),
        "hours": round(recs["duration_s"].sum() / 3600, 2), "samples": int(recs["n_samples"].sum()),
        "gaps": int(recs["gaps"].sum()), "non_increasing": int(recs["non_increasing"].sum()),
        "saturated_samples": int(recs["saturated_samples"].sum()),
    }
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
