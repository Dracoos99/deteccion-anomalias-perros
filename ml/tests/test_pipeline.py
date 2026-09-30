"""Unit tests of the label and window rules. Run from ml/:.venv/Scripts/python -m pytest"""
import numpy as np
import pandas as pd
import pytest

from src import config as C
from src.preprocess import resolve_labels, saturation_mask
from src.splits import split_dogs
from src.windows import STATUS, window_status

SIT, TROT, PLAY = C.CLASSES.index("sit"), C.CLASSES.index("trot"), C.CLASSES.index("play")


def test_resolve_labels_any_column_and_ambiguity():
    b = pd.DataFrame({
        "Behavior_1": ["Sitting", "Panting", "<undefined>", "Playing", "Sitting", "Eating"],
        "Behavior_2": ["<undefined>", "Trotting", "<undefined>", "Trotting", "Sitting", "<undefined>"],
        "Behavior_3": ["<undefined>", "<undefined>", "<undefined>", "<undefined>", "<undefined>", "<undefined>"],
    }, dtype="string")
    assert resolve_labels(b).tolist() == [SIT, TROT, C.UNLABELED, C.AMBIGUOUS, SIT, C.UNLABELED]


def test_saturation_mask_uses_full_scale():
    imu = np.array([[15.99, 0, 0, 0, 0, 0], [0, -16.0, 0, 0, 0, 0], [0, 0, 0, 0, 1999.0, 0], [15.9, 0, 0, 1998.9, 0, 0]], np.float32)
    assert saturation_mask(imu).tolist() == [True, True, True, False]


def _status(label, sat=None, t=None, win=4, hop=2):
    label = np.asarray(label, np.int8)
    sat = np.zeros(len(label), bool) if sat is None else np.asarray(sat, bool)
    t = np.arange(len(label)) / C.IMU_HZ if t is None else np.asarray(t, float)
    starts, lab, st = window_status(label, sat, t, win, hop)
    return starts.tolist(), lab.tolist(), [STATUS[s] for s in st]


def test_window_status_rules():
    u, a = C.UNLABELED, C.AMBIGUOUS
    starts, lab, st = _status([SIT] * 4 + [TROT] * 2 + [u] * 4 + [a] * 4)
    assert starts == [0, 2, 4, 6, 8, 10]
    assert st == ["clean", "mixed", "mixed", "unlabeled", "mixed", "ambiguous"]
    assert lab[0] == SIT


def test_window_status_saturation_and_gap_take_precedence():
    sat = [False] * 8
    sat[5] = True
    assert _status([SIT] * 8, sat=sat)[2] == ["clean", "saturated", "saturated"]
    t = np.arange(8) / C.IMU_HZ
    t[4:] += 1.0  # a 1 s hole between samples 3 and 4: the window starting at 4 does not cross it
    assert _status([SIT] * 8, t=t)[2] == ["clean", "gap", "clean"]


def test_short_recording_has_no_windows():
    assert _status([SIT] * 3) == ([], [], [])


def test_window_samples_bounds():
    assert C.window_samples(2.0, 0.5) == (200, 100)
    assert C.window_samples(5.0, 0.5) == (500, 250)
    with pytest.raises(ValueError):
        C.window_samples(1.0)


def test_split_by_dog_is_disjoint_and_reproducible():
    dogs = list(range(100, 145))
    s1, s2 = split_dogs(dogs), split_dogs(list(reversed(dogs)))
    assert s1 == s2
    assert (len(s1["train"]), len(s1["val"]), len(s1["test"])) == (31, 7, 7)
    assert set(s1["train"]).isdisjoint(s1["val"]) and set(s1["train"]).isdisjoint(s1["test"]) and set(s1["val"]).isdisjoint(s1["test"])
    assert sorted(s1["train"] + s1["val"] + s1["test"]) == dogs
