"""Heart-rate series at 1 Hz from beat times.

Sources: Invoxia (ecg_pulses without the bad_ecg stretches), PhysioZoo (hand-corrected R peaks) and the 23 healthy
dogs (R-R intervals). Procedure, identical for the three:
  1. beats inside poor-quality stretches are discarded;
  2. R-R intervals outside prefilter (20-300 bpm, i.e. 0.2-3.0 s) are discarded;
  3. HR(t) at every whole second = 60 / mean(R-R) of the valid intervals ending within t ± window/2.
     The mean (not the median) is deliberate: dogs have a strong respiratory sinus arrhythmia (R-R from 0.5 to 1.2 s
     in the same healthy dog), so a median or a "20 % change" artifact filter would bias the rate or drop real beats.
     The window also smooths the series. Seconds with fewer than `min_intervals` valid intervals are left out.

Usage (from ml/):.venv/Scripts/python -m src.hr_series
Outputs in data/processed/hr/: <source>/<dog>.parquet (session_id, t_s, hr_bpm), summary.parquet, validation.json
"""
from __future__ import annotations

import argparse
import ast
import glob
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config as C


def beats_to_hr(beat_times, bad_segments=(), window_s: float = C.HR_WINDOW_S, min_intervals: int = C.HR_MIN_INTERVALS,
                rr_range=C.HR_RR_RANGE_S, start: float | None = None, end: float | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Whole-second times and HR (bpm) of one recording. Beat times in seconds, sorted or not."""
    b = np.sort(np.asarray(beat_times, dtype=np.float64))
    if len(b) < 2:
        return np.empty(0), np.empty(0)
    ok = np.ones(len(b), dtype=bool)
    for s, e in bad_segments:
        ok &= ~((b >= s) & (b <= e))
    rr, tb = np.diff(b), b[1:]
    valid = ok[1:] & ok[:-1] & (rr >= rr_range[0]) & (rr <= rr_range[1])
    rr, tb = rr[valid], tb[valid]
    t0 = np.ceil(b[0] if start is None else start)
    t1 = np.floor(b[-1] if end is None else end)
    if len(rr) < min_intervals or t1 < t0:
        return np.empty(0), np.empty(0)
    t = np.arange(t0, t1 + 1)
    cs = np.concatenate([[0.0], np.cumsum(rr)])
    i0 = np.searchsorted(tb, t - window_s / 2, side="left")
    i1 = np.searchsorted(tb, t + window_s / 2, side="right")
    n = i1 - i0
    with np.errstate(divide="ignore", invalid="ignore"):
        hr = 60.0 * n / (cs[i1] - cs[i0])
    keep = n >= min_intervals
    for s, e in bad_segments:
        keep &= ~((t >= s) & (t <= e))
    return t[keep], hr[keep]


def _objectid_time(oid: str) -> datetime:
    """Invoxia session ids are MongoDB ObjectIds: the first 4 bytes are the creation time (used to order sessions)."""
    return datetime.fromtimestamp(int(oid[:8], 16), tz=timezone.utc)


def invoxia_sessions(root=C.INVOXIA_DIR):
    d = pd.read_csv(root / "dataset.csv")
    for r in d.itertuples():
        if not isinstance(r.ecg_pulses, str):
            continue
        yield {
            "dog_id": str(r.pet_id), "session_id": r._1, "session_start": _objectid_time(r._1), "duration_s": float(r.duration),
            "beats": np.array(ast.literal_eval(r.ecg_pulses), dtype=float),
            "bad": ast.literal_eval(r.bad_ecg) if isinstance(r.bad_ecg, str) else [],
            "segments_hr": ast.literal_eval(r.segments_hr) if isinstance(r.segments_hr, str) else [],
            "breed": r.breeds, "weight_kg": r.weight, "age_years": r.age,
        }


def _physiozoo_numbers(path) -> np.ndarray:
    """Numbers after the YAML-like header (second '---') of a PhysioZoo text file."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    marks = [i for i, line in enumerate(lines) if line.strip() == "---"]
    return np.array([float(x) for x in lines[marks[1] + 1:] if x.strip()], dtype=float)


def physiozoo_sessions(root=C.PHYSIOZOO_DIR):
    for rec in sorted(glob.glob(str(root / "wfdb_format" / "dog" / "Dog_*"))):
        name = os.path.basename(rec)
        with open(os.path.join(rec, f"{name}.hea"), encoding="utf-8") as f:
            _, _, fs, n = f.readline().split()[:4]
        fs, n = float(fs), int(n)
        peaks = _physiozoo_numbers(root / "text_format" / "dog" / name / f"peaks_{name}.txt")
        bad = []
        for qa in glob.glob(str(root / "text_format" / "dog" / name / "Data_Quality_*.txt")):
            with open(qa, encoding="utf-8") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2 and all(p.replace(".", "", 1).isdigit() for p in parts[:2]):
                        bad.append((float(parts[0]), float(parts[1])))
        yield {"dog_id": name, "session_id": name, "duration_s": n / fs, "beats": peaks / fs, "bad": bad}


def rri23_sessions(root=C.RRI23_DIR):
    """One stationary 5-minute segment per dog; the sheet has one column per dog (transposed w.r.t. its README)."""
    rri = pd.read_excel(root / "canine_RRI_data.xlsx", header=None)
    for j in range(1, rri.shape[1]):
        dog = str(rri.iloc[0, j])
        rr_ms = pd.to_numeric(rri.iloc[1:, j], errors="coerce").dropna().to_numpy(dtype=float)
        beats = np.concatenate([[0.0], np.cumsum(rr_ms / 1000.0)])
        yield {"dog_id": dog, "session_id": dog, "duration_s": float(beats[-1]), "beats": beats, "bad": []}


SOURCES = {"invoxia2023": invoxia_sessions, "physiozoo2018": physiozoo_sessions, "rri23dogs": rri23_sessions}


def build_source(name: str, out_dir=C.HR_OUT) -> pd.DataFrame:
    """Writes one Parquet per dog and returns the per-session table."""
    per_dog: dict[str, list[pd.DataFrame]] = {}
    sessions = []
    for s in SOURCES[name]():
        t, hr = beats_to_hr(s["beats"], s["bad"], start=0.0, end=s["duration_s"])
        per_dog.setdefault(s["dog_id"], []).append(pd.DataFrame({
            "session_id": s["session_id"], "t_s": t.astype(np.float32), "hr_bpm": hr.astype(np.float32)}))
        sessions.append({"source": name, "dog_id": s["dog_id"], "session_id": s["session_id"],
                         "session_start": s.get("session_start"), "duration_s": s["duration_s"], "valid_s": len(t),
                         **{k: s[k] for k in ("breed", "weight_kg", "age_years") if k in s}})
    target = out_dir / name
    target.mkdir(parents=True, exist_ok=True)
    order = pd.DataFrame(sessions).sort_values(["dog_id", "session_start" if name == "invoxia2023" else "session_id"])
    for dog, parts in per_dog.items():
        rank = {sid: i for i, sid in enumerate(order[order["dog_id"] == dog]["session_id"])}
        df = pd.concat(parts, ignore_index=True)
        df["session_order"] = df["session_id"].map(rank).astype(np.int16)
        df = df.sort_values(["session_order", "t_s"], ignore_index=True)
        df["session_id"] = df["session_id"].astype("category")
        df.to_parquet(target / f"{dog}.parquet", index=False)
    return order


def contiguous_sequences(t_s: np.ndarray, session: np.ndarray, length_s: int = C.HR_SEQUENCE_S, hop_s: int = C.HR_SEQUENCE_HOP_S) -> int:
    """How many gap-free sequences of `length_s` seconds (hop `hop_s`) fit in a series."""
    total = 0
    for sid in np.unique(session):
        ts = np.sort(t_s[session == sid])
        if len(ts) < length_s:
            continue
        breaks = np.flatnonzero(np.diff(ts) > 1.5)
        for run in np.split(ts, breaks + 1):
            if len(run) >= length_s:
                total += (len(run) - length_s) // hop_s + 1
    return total


def summarize(out_dir=C.HR_OUT) -> pd.DataFrame:
    rows = []
    for name in SOURCES:
        for path in sorted(glob.glob(str(out_dir / name / "*.parquet"))):
            df = pd.read_parquet(path)
            hr = df["hr_bpm"].to_numpy(dtype=float)
            rows.append({"source": name, "dog_id": os.path.basename(path)[:-8], "sessions": df["session_id"].nunique(),
                         "valid_hours": round(len(df) / 3600, 3), "hr_mean": hr.mean(), "hr_std": hr.std(),
                         "hr_p5": np.percentile(hr, 5), "hr_p95": np.percentile(hr, 95),
                         "sequences_60s": contiguous_sequences(df["t_s"].to_numpy(), df["session_id"].astype(str).to_numpy())})
    s = pd.DataFrame(rows)
    s.to_parquet(out_dir / "summary.parquet", index=False)
    return s


def validate_invoxia() -> dict:
    """Mean of the 1 Hz series over each segments_hr stretch vs. the reference value given by the dataset."""
    err, n_seg = [], 0
    for s in invoxia_sessions():
        t, hr = beats_to_hr(s["beats"], s["bad"], start=0.0, end=s["duration_s"])
        for seg in s["segments_hr"]:
            n_seg += 1
            m = (t >= seg["deb"]) & (t < seg["fin"])
            if m.sum() >= 0.8 * (seg["fin"] - seg["deb"]):
                err.append(hr[m].mean() - seg["value"])
    e = np.abs(np.array(err))
    return {"segments": n_seg, "compared": int(len(e)), "mae_bpm": round(float(e.mean()), 2),
            "median_ae_bpm": round(float(np.median(e)), 2), "p95_ae_bpm": round(float(np.percentile(e, 95)), 2),
            "share_within_5_bpm": round(float((e <= 5).mean()), 3)}


def corrupt_beats(beats: np.ndarray, rng: np.random.Generator, missed: float, extra: float, jitter_s: float) -> np.ndarray:
    """Simulated detector errors: dropped beats, spurious beats between two real ones and timing jitter."""
    keep = rng.random(len(beats)) >= missed
    b = beats[keep]
    n_extra = int(round(extra * len(beats)))
    idx = rng.integers(0, len(b) - 1, n_extra)
    spurious = b[idx] + rng.uniform(0.2, 0.8, n_extra) * (b[idx + 1] - b[idx])
    b = np.sort(np.concatenate([b, spurious]))
    return b + rng.normal(0, jitter_s, len(b))


def validate_physiozoo(missed=0.02, extra=0.01, jitter_s=0.005, seed=C.SEED) -> dict:
    """Series from the hand-corrected peaks (reference) vs. series from the same peaks with simulated detector errors."""
    rng = np.random.default_rng(seed)
    err, cover = [], []
    for s in physiozoo_sessions():
        t_ref, hr_ref = beats_to_hr(s["beats"], s["bad"], start=0.0, end=s["duration_s"])
        t_c, hr_c = beats_to_hr(corrupt_beats(s["beats"], rng, missed, extra, jitter_s), s["bad"], start=0.0, end=s["duration_s"])
        common, i_ref, i_c = np.intersect1d(t_ref, t_c, return_indices=True)
        err.append(hr_c[i_c] - hr_ref[i_ref])
        cover.append(len(common) / max(1, len(t_ref)))
    e = np.abs(np.concatenate(err))
    return {"dogs": len(cover), "corruption": {"missed": missed, "extra": extra, "jitter_s": jitter_s},
            "mae_bpm": round(float(e.mean()), 2), "median_ae_bpm": round(float(np.median(e)), 2),
            "p95_ae_bpm": round(float(np.percentile(e, 95)), 2), "coverage": round(float(np.mean(cover)), 3)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-validation", action="store_true")
    args = ap.parse_args()
    for name in SOURCES:
        build_source(name)
    summary = summarize()
    report = {name: {"dogs": int((summary.source == name).sum()), "valid_hours": round(float(summary[summary.source == name].valid_hours.sum()), 1),
                     "sequences_60s": int(summary[summary.source == name].sequences_60s.sum()),
                     "dog_hr_mean_range": [round(float(summary[summary.source == name].hr_mean.min()), 1), round(float(summary[summary.source == name].hr_mean.max()), 1)]}
              for name in SOURCES}
    if not args.skip_validation:
        report["validation"] = {"invoxia_segments_hr": validate_invoxia(), "physiozoo_corrupted_peaks": validate_physiozoo()}
    (C.HR_OUT / "validation.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
