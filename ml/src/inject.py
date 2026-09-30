"""Anomaly injection for offline evaluation. The catalog lives in shared/anomaly-catalog.json and the
simulator applies the same transforms (shared/anomalies.ts); shared/fixtures/cross-language.json keeps both equal.

ramp(o) = min(1, o / rampS) for a value o seconds after the injection starts (1 when rampS is 0).
  imu  (activity_drop, immobility): per block and channel, x' = mean + (1 - m * ramp) * (x - mean)
  hr   (tachycardia / bradycardia):  hr' = hr * (1 +/- m * ramp)
  temp (fever / hypothermia):        temp' = temp +/- m * ramp

Usage (from ml/):.venv/Scripts/python -m src.inject   # rewrites shared/fixtures/cross-language.json
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

SHARED_DIR = Path(__file__).resolve().parents[2] / "shared"
CATALOG_PATH = SHARED_DIR / "anomaly-catalog.json"
FIXTURE_PATH = SHARED_DIR / "fixtures" / "cross-language.json"


@lru_cache(maxsize=1)
def catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Injection:
    type: str
    magnitude: float
    duration_s: float

    def __post_init__(self):
        validate(self.type, self.magnitude, self.duration_s)

    @property
    def spec(self) -> dict:
        return catalog()["types"][self.type]

    def blocks(self) -> int:
        """Number of 10 s blocks covered."""
        return math.ceil(self.duration_s / catalog()["blockSeconds"])


def validate(kind: str, magnitude: float, duration_s: float) -> None:
    types = catalog()["types"]
    if kind not in types:
        raise ValueError(f"unknown anomaly type {kind!r}; expected one of {sorted(types)}")
    spec = types[kind]
    if not spec["min"] <= magnitude <= spec["max"]:
        raise ValueError(f"{kind}: magnitude {magnitude} outside [{spec['min']}, {spec['max']}] {spec['unit']}")
    if not 0 < duration_s <= catalog()["maxDurationS"]:
        raise ValueError(f"{kind}: duration {duration_s} s outside (0, {catalog()['maxDurationS']}]")


def ramp(offset_s, ramp_s: float):
    o = np.asarray(offset_s, dtype=np.float64)
    return np.ones_like(o) if ramp_s <= 0 else np.clip(o / ramp_s, 0.0, 1.0)


def apply_imu(block: np.ndarray, inj: Injection, offset_s: float) -> np.ndarray:
    """block: (n, 6) in g and °/s. offset_s: seconds since the injection started, at the block start."""
    if inj.spec["signal"] != "imu":
        return block
    x = np.asarray(block, dtype=np.float64)
    mean = x.mean(axis=0, keepdims=True)
    return mean + (1.0 - inj.magnitude * float(ramp(offset_s, inj.spec["rampS"]))) * (x - mean)


def apply_hr(values, inj: Injection, offsets_s) -> np.ndarray:
    """values: HR (bpm) at 1 Hz; offsets_s: seconds since the injection started for each value."""
    v = np.asarray(values, dtype=np.float64)
    if inj.spec["signal"] != "hr":
        return v
    sign = 1.0 if inj.type == "tachycardia" else -1.0
    return v * (1.0 + sign * inj.magnitude * ramp(offsets_s, inj.spec["rampS"]))


def apply_temp(value: float, inj: Injection, offset_s: float) -> float:
    if inj.spec["signal"] != "temp":
        return value
    sign = 1.0 if inj.type == "fever" else -1.0
    return float(value + sign * inj.magnitude * float(ramp(offset_s, inj.spec["rampS"])))


def write_fixture() -> dict:
    """Deterministic cases that the TypeScript tests (simulator/test) must reproduce exactly."""
    from .activity import window_intensity

    rng = np.random.default_rng(7)
    imu = np.round(rng.normal(0, 0.2, (8, 6)) + [0, 0, 1, 0, 0, 0], 6)
    hr = [60.0, 62.0, 61.0, 63.0, 64.0, 65.0, 63.0, 62.0, 61.0, 60.0]
    window = np.round(np.column_stack([np.sin(np.arange(200) / 7) * 0.3, rng.normal(0, 0.05, 200), 1 + rng.normal(0, 0.1, 200),
                                       rng.normal(0, 20, (200, 3))]), 6)
    cases = {
        "imu_activity_drop": {"injection": {"type": "activity_drop", "magnitude": 0.5, "durationS": 600}, "offsetS": 0,
                              "input": imu.tolist(), "expected": apply_imu(imu, Injection("activity_drop", 0.5, 600), 0).tolist()},
        "imu_immobility": {"injection": {"type": "immobility", "magnitude": 0.97, "durationS": 1800}, "offsetS": 50,
                           "input": imu.tolist(), "expected": apply_imu(imu, Injection("immobility", 0.97, 1800), 50).tolist()},
        "hr_tachycardia_ramp": {"injection": {"type": "tachycardia", "magnitude": 0.4, "durationS": 600}, "offsetS": 20,
                                "input": hr, "expected": apply_hr(hr, Injection("tachycardia", 0.4, 600), np.arange(20, 30)).tolist()},
        "hr_bradycardia": {"injection": {"type": "bradycardia", "magnitude": 0.3, "durationS": 120}, "offsetS": 60,
                           "input": hr, "expected": apply_hr(hr, Injection("bradycardia", 0.3, 120), np.arange(60, 70)).tolist()},
        "temp_fever_ramp": {"injection": {"type": "fever", "magnitude": 1.5, "durationS": 3600}, "offsetS": 60,
                            "input": 38.6, "expected": apply_temp(38.6, Injection("fever", 1.5, 3600), 60)},
        "temp_hypothermia": {"injection": {"type": "hypothermia", "magnitude": 2.0, "durationS": 3600}, "offsetS": 600,
                             "input": 38.4, "expected": apply_temp(38.4, Injection("hypothermia", 2.0, 3600), 600)},
    }
    fixture = {
        "generatedBy": "ml/src/inject.py (write_fixture)",
        "anomalies": cases,
        "intensity": {"window": window.tolist(), "expectedG": float(window_intensity(window[None])[0])},
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=1), encoding="utf-8", newline="\n")
    return fixture


if __name__ == "__main__":
    f = write_fixture()
    print(f"wrote {FIXTURE_PATH} with {len(f['anomalies'])} anomaly cases")
