"""Pipeline parameters. Change them here, never inline, so every run is reproducible (RNF-05)."""
import os
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
RAW_DIR = ML_DIR / "data" / "raw"
PROCESSED_DIR = ML_DIR / "data" / "processed"

SEED = 42

# --- Vehkaoja et al. (2022), Data in Brief 40, 107822 -------------------------------------------
VEHKAOJA_CSV = RAW_DIR / "vehkaoja2022" / "DogMoveData_csv_format" / "DogMoveData.csv"
VEHKAOJA_DOGINFO = RAW_DIR / "vehkaoja2022" / "DogInfo.csv"
# D1: collar. "Back" (harness) only for the sensitivity analysis: VEHKAOJA_SENSOR=Back python -m src.preprocess ...
SENSOR = os.environ.get("VEHKAOJA_SENSOR", "Neck")
if SENSOR not in ("Neck", "Back"):
    raise ValueError(f"VEHKAOJA_SENSOR must be Neck or Back, got {SENSOR}")
VEHKAOJA_OUT = PROCESSED_DIR / "vehkaoja" / SENSOR.lower()

IMU_HZ = 100
# Channel names of the CSV upload format. Source columns are mapped by header name, never by position:
# Data_description.txt lists ANeck_y as the x-axis and ANeck_x as the y-axis, while the CSV header is x, y, z.
IMU_CHANNELS = ("acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z")
SOURCE_COLUMNS = {
    "acc_x": f"A{SENSOR}_x", "acc_y": f"A{SENSOR}_y", "acc_z": f"A{SENSOR}_z",
    "gyr_x": f"G{SENSOR}_x", "gyr_y": f"G{SENSOR}_y", "gyr_z": f"G{SENSOR}_z",
}
BEHAVIOR_COLUMNS = ("Behavior_1", "Behavior_2", "Behavior_3")

# Same order as shared/types.ts BEHAVIORS and results.behaviorProbs[7].
CLASSES = ("sit", "stand", "lie", "trot", "walk", "play", "sniff")
ACTIVE_CLASSES = ("trot", "walk", "play", "sniff")   # counted as movement; the rest are still postures
# D2: the project class comes from any of the three Behavior columns.
LABEL_MAP = {
    "Sitting": "sit", "Standing": "stand", "Lying chest": "lie", "Trotting": "trot",
    "Walking": "walk", "Playing": "play", "Sniffing": "sniff",
}
UNLABELED = -1   # no project class (other behaviours or no annotation): held-out data for novelty calibration
AMBIGUOUS = -2   # two project classes at the same time: discarded

# Sensor full scale of the ActiGraph GT9X Link: ±16 g and ±2000 °/s.
SAT_ACC_G = 15.99
SAT_GYR_DPS = 1999.0
# A jump in t_sec larger than this breaks the 100 Hz grid; windows across it are rejected.
MAX_SAMPLE_GAP_S = 1.5 / IMU_HZ

# --- Windows ---------------------------------------------------------------------
WINDOW_S = 2.0
WINDOW_S_RANGE = (2.0, 5.0)
OVERLAP = 0.5

# --- Heart rate ------------------------------------------------------------
INVOXIA_DIR = RAW_DIR / "invoxia2023"
PHYSIOZOO_DIR = RAW_DIR / "physiozoo2018"
RRI23_DIR = RAW_DIR / "rri23dogs"
HR_OUT = PROCESSED_DIR / "hr"
HR_RR_RANGE_S = (60 / 300, 60 / 20)  # prefilter: 20-300 bpm
HR_WINDOW_S = 5.0                    # centred window for 60 / mean(R-R)
HR_MIN_INTERVALS = 3
HR_SEQUENCE_S = 60                   # 60 s sequences for the autoencoder
HR_SEQUENCE_HOP_S = 10
# --- Physiological model ---------------------------------------------------------------
AAA4_DIR = RAW_DIR / "aaa4dogs" / "Repository" / "Repository"   # Shimamura et al. (2026): 4 dogs, activity study
HR_SD_FLOOR = 1.0                    # bpm, same floor as the engine (shared/engine.ts)
PHYSIO_BASELINE_SHARE = 0.2          # validation and test dogs: baseline from their first 20 % of data, evaluated on the rest
PHYSIO_SPLIT = (0.70, 0.15, 0.15)    # by dog, stratified by source

# --- Simulator export ------------------------------------------------------
SIM_OUT = PROCESSED_DIR / "sim"

# --- Splits by dog ----------------------------------------------------------------------
SPLIT_FRACTIONS = {"train": 0.70, "val": 0.15, "test": 0.15}


def window_samples(window_s: float = WINDOW_S, overlap: float = OVERLAP) -> tuple[int, int]:
    """Window length and hop in samples."""
    lo, hi = WINDOW_S_RANGE
    if not lo <= window_s <= hi:
        raise ValueError(f"window_s must be within {lo}-{hi} s (RF-01), got {window_s}")
    if not 0 <= overlap < 1:
        raise ValueError(f"overlap must be in [0, 1), got {overlap}")
    win = round(window_s * IMU_HZ)
    return win, max(1, round(win * (1 - overlap)))
