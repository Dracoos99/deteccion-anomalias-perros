"""Heart-rate sequences for the physiological model. Pure numpy, no TensorFlow.

- Series: the 1 Hz output of hr_series.py (<source>/<dog>.parquet with session_id, t_s, hr_bpm).
- Split: by dog, stratified by source (70/15/15, fixed seed): no dog appears in two sets.
- Baseline and normalization: z-score per dog, (hr - mean) / max(std, 1 bpm), as dogs.baseline in production.
  Training dogs use all their data. Validation and test dogs take their baseline from their first 20 % of seconds
  (sessions in order) and are evaluated only on the rest.
- Sequences: 60 contiguous seconds, hop 10 s.
- Injection: the catalog formula hr' = hr * (1 +/- m * ramp) of src/inject.py, the same the simulator applies.
- Activity study (Shimamura et al., 2026): R-R series of 4 dogs before (PRE), during (DARA) and after (POST) an
  animal-assisted activity, turned into 1 Hz HR with the same procedure as hr_series.py.
"""
from __future__ import annotations

import csv
import glob
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import config as C
from .hr_series import beats_to_hr
from .inject import Injection, apply_hr

SOURCES = ("invoxia2023", "physiozoo2018", "rri23dogs")


@dataclass
class DogSeries:
    key: str                    # "<source>/<dog>"
    source: str
    hr: np.ndarray              # bpm, 1 Hz, in (session, t) order
    run_id: np.ndarray          # contiguous run of whole seconds (a new run at every gap or session change)
    baseline: tuple[float, float] = (0.0, 1.0)   # (mean, std) used for the z-score
    eval_from: int = 0          # first index usable for evaluation (after the baseline part)
    extra: dict = field(default_factory=dict)


def load_series(root=C.HR_OUT, sources=SOURCES) -> list[DogSeries]:
    out = []
    for src in sources:
        for path in sorted(glob.glob(str(root / src / "*.parquet"))):
            df = pd.read_parquet(path).sort_values(["session_id", "t_s"])
            if df.empty:
                continue
            t = df["t_s"].to_numpy(np.int64)
            s = pd.factorize(df["session_id"])[0]
            new_run = np.r_[True, (np.diff(t) != 1) | (np.diff(s) != 0)]
            dog = path.replace("\\", "/").rsplit("/", 1)[1].removesuffix(".parquet")
            out.append(DogSeries(f"{src}/{dog}", src, df["hr_bpm"].to_numpy(np.float32), np.cumsum(new_run) - 1))
    return out


def split_by_dog(dogs: list[DogSeries], shares=C.PHYSIO_SPLIT, seed: int = C.SEED) -> dict[str, list[str]]:
    """Fixed split by dog, stratified by source so every set has dogs of every source."""
    rng = np.random.default_rng(seed)
    split = {"train": [], "val": [], "test": []}
    for src in sorted({d.source for d in dogs}):
        keys = sorted(d.key for d in dogs if d.source == src)
        rng.shuffle(keys)
        n = len(keys)
        n_val = max(1, round(n * shares[1]))
        n_test = max(1, round(n * shares[2]))
        split["val"] += keys[:n_val]
        split["test"] += keys[n_val:n_val + n_test]
        split["train"] += keys[n_val + n_test:]
    return {k: sorted(v) for k, v in split.items()}


def set_baselines(dogs: list[DogSeries], split: dict[str, list[str]], share: float = C.PHYSIO_BASELINE_SHARE) -> None:
    train = set(split["train"])
    for d in dogs:
        cut = 0 if d.key in train else int(round(len(d.hr) * share))
        ref = d.hr if cut == 0 else d.hr[:cut]
        d.baseline = (float(ref.mean()), float(max(ref.std(), C.HR_SD_FLOOR)))
        d.eval_from = cut


def zscore(hr: np.ndarray, baseline: tuple[float, float]) -> np.ndarray:
    return ((hr - baseline[0]) / max(baseline[1], C.HR_SD_FLOOR)).astype(np.float32)


def sequence_starts(run_id: np.ndarray, start_from: int = 0, length: int = C.HR_SEQUENCE_S, hop: int = C.HR_SEQUENCE_HOP_S) -> np.ndarray:
    """Start indices of windows of `length` contiguous seconds, every `hop` seconds inside each run."""
    starts = []
    idx = np.arange(len(run_id))
    for r in np.unique(run_id):
        pos = idx[run_id == r]
        pos = pos[pos >= start_from]
        if len(pos) < length:
            continue
        # A run is contiguous by construction: pos is a consecutive range.
        starts.extend(range(pos[0], pos[-1] - length + 2, hop))
    return np.asarray(starts, dtype=np.int64)


def raw_sequences(d: DogSeries, evaluation: bool) -> np.ndarray:
    """60-value HR windows (bpm) of one dog; for evaluation, only after its baseline part."""
    st = sequence_starts(d.run_id, d.eval_from if evaluation else 0)
    return np.stack([d.hr[s:s + C.HR_SEQUENCE_S] for s in st]) if len(st) else np.empty((0, C.HR_SEQUENCE_S), np.float32)


def normal_set(dogs: list[DogSeries], keys: list[str], evaluation: bool) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """z-scored sequences (n, 60) plus the raw ones and the dog of each."""
    by = {d.key: d for d in dogs}
    zs, raw, who = [], [], []
    for k in keys:
        r = raw_sequences(by[k], evaluation)
        if len(r):
            raw.append(r)
            zs.append(zscore(r, by[k].baseline))
            who += [k] * len(r)
    return (np.concatenate(zs) if zs else np.empty((0, C.HR_SEQUENCE_S), np.float32),
            np.concatenate(raw) if raw else np.empty((0, C.HR_SEQUENCE_S), np.float32), who)


def inject_sequences(raw: np.ndarray, kind: str, magnitude: float, onset: bool) -> np.ndarray:
    """Applies the catalog anomaly to every sequence: sustained (ramp finished) or at its onset (ramp inside)."""
    inj = Injection(kind, magnitude, 3600)
    offsets = np.arange(C.HR_SEQUENCE_S, dtype=np.float64) + (0.0 if onset else float(inj.spec["rampS"]))
    return np.stack([apply_hr(r, inj, offsets) for r in raw]).astype(np.float32)


def rule_score(z: np.ndarray) -> np.ndarray:
    """The provisional rule: |z| of the 60 s mean heart rate."""
    return np.abs(z.mean(axis=1))


# ── Activity study (4 dogs) ───────────────────────────────────────────────────────────────────────────────────

def load_activity_study(root=C.AAA4_DIR) -> list[DogSeries]:
    """One series per dog, session and phase (PRE, DARA = during the activity, POST), 1 Hz."""
    with open(root / "_RRI_data.csv", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    dogs, sessions, phases = rows[0], rows[1], rows[2]
    out = []
    for j in range(len(dogs)):
        col = np.array([float(r[j]) for r in rows[3:] if j < len(r) and r[j].strip()], dtype=np.float64)
        # NaN marks a stretch excluded by Kubios, of unknown length: every valid stretch is its own segment.
        cuts = np.flatnonzero(np.isnan(col))
        hrs, runs, next_run = [], [], 0
        for seg in np.split(col, cuts):
            seg = seg[~np.isnan(seg)]
            if len(seg) < 2:
                continue
            t, hr = beats_to_hr(np.cumsum(seg))
            if not len(t):
                continue
            run = np.cumsum(np.r_[True, np.diff(t) != 1]) - 1 + next_run
            next_run = int(run[-1]) + 1
            hrs.append(hr.astype(np.float32))
            runs.append(run)
        if not hrs:
            continue
        dog = dogs[j].replace("dog", "").strip()
        out.append(DogSeries(f"aaa4dogs/{dog}/{sessions[j]}/{phases[j]}", "aaa4dogs", np.concatenate(hrs), np.concatenate(runs),
                             extra={"dog": dog, "session": sessions[j], "phase": phases[j]}))
    return out


def activity_study_sets(series: list[DogSeries]) -> dict[str, np.ndarray]:
    """z-scored sequences per phase, each dog normalized with its PRE phases (its own resting reference)."""
    base = {}
    for dog in {s.extra["dog"] for s in series}:
        pre = np.concatenate([s.hr for s in series if s.extra["dog"] == dog and s.extra["phase"] == "PRE"])
        base[dog] = (float(pre.mean()), float(max(pre.std(), C.HR_SD_FLOOR)))
    out: dict[str, list[np.ndarray]] = {}
    for s in series:
        r = raw_sequences(s, evaluation=False)
        if len(r):
            out.setdefault(s.extra["phase"], []).append(zscore(r, base[s.extra["dog"]]))
    return {k: np.concatenate(v) for k, v in out.items()}
