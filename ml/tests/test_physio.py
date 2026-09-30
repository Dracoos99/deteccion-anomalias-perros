"""Tests of the physiological pipeline: src/physio_data.py and the metrics of src/train_physio.py."""
import csv

import numpy as np
import pytest

from src import config as C
from src import physio_data as P


def dog(key: str, source: str, hr, runs=None) -> P.DogSeries:
    hr = np.asarray(hr, dtype=np.float32)
    return P.DogSeries(key, source, hr, np.zeros(len(hr), dtype=np.int64) if runs is None else np.asarray(runs))


def test_split_is_by_dog_disjoint_and_stratified_by_source():
    dogs = [dog(f"{s}/{i}", s, [70.0] * 60) for s in ("a", "b") for i in range(20)]
    split = P.split_by_dog(dogs, seed=1)
    sets = [set(v) for v in split.values()]
    assert sum(len(s) for s in sets) == 40
    assert not (sets[0] & sets[1]) and not (sets[0] & sets[2]) and not (sets[1] & sets[2])
    for name in ("train", "val", "test"):
        assert {k.split("/")[0] for k in split[name]} == {"a", "b"}
    assert len(split["val"]) == len(split["test"]) == 6   # 15 % of 20 per source
    assert P.split_by_dog(dogs, seed=1) == split           # fixed seed


def test_baselines_use_all_training_data_and_the_first_20_percent_otherwise():
    hr = np.r_[np.full(20, 60.0), np.full(80, 100.0)]
    train, other = dog("s/t", "s", hr), dog("s/v", "s", hr)
    P.set_baselines([train, other], {"train": ["s/t"], "val": ["s/v"], "test": []})
    assert train.eval_from == 0
    assert train.baseline[0] == pytest.approx(92.0)
    assert other.eval_from == 20
    assert other.baseline == (pytest.approx(60.0), C.HR_SD_FLOOR)   # constant part: the std floor of 1 bpm


def test_sequences_are_contiguous_and_start_after_the_baseline_part():
    runs = np.r_[np.zeros(100, int), np.ones(50, int), np.full(70, 2)]
    starts = P.sequence_starts(runs, start_from=0, length=60, hop=10)
    assert list(starts) == [0, 10, 20, 30, 40, 150, 160]   # run 1 (50 s) is too short
    assert list(P.sequence_starts(runs, start_from=30, length=60, hop=10)) == [30, 40, 150, 160]
    d = dog("s/x", "s", np.arange(220, dtype=float), runs)
    d.eval_from = 150
    seqs = P.raw_sequences(d, evaluation=True)
    assert seqs.shape == (2, 60)
    assert np.all(np.diff(seqs, axis=1) == 1)


def test_zscore_and_rule_score():
    z = P.zscore(np.array([[70.0, 80.0, 90.0]]), (70.0, 10.0))
    assert np.allclose(z, [[0, 1, 2]])
    assert P.rule_score(z)[0] == pytest.approx(1.0)
    assert np.allclose(P.zscore(np.array([71.0]), (70.0, 0.1)), [1.0])   # std floor


def test_injection_follows_the_catalog_formula():
    raw = np.full((2, 60), 80.0, dtype=np.float32)
    sustained = P.inject_sequences(raw, "tachycardia", 0.4, onset=False)
    assert np.allclose(sustained, 80 * 1.4)
    onset = P.inject_sequences(raw, "bradycardia", 0.3, onset=True)
    ramp = np.minimum(1, np.arange(60) / 30)   # rampS = 30 s in shared/anomaly-catalog.json
    assert np.allclose(onset[0], 80 * (1 - 0.3 * ramp), atol=1e-4)


def test_activity_study_splits_segments_at_excluded_stretches(tmp_path):
    rr = [0.5] * 150 + ["NaN"] + [0.5] * 150            # 2 beats per second: 120 bpm
    rows = [["dog 1", "dog 1"], ["S1", "S1"], ["PRE", "DARA"]] + [[str(v), str(v)] for v in rr]
    with open(tmp_path / "_RRI_data.csv", "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    series = P.load_activity_study(tmp_path)
    assert [s.extra["phase"] for s in series] == ["PRE", "DARA"]
    s = series[0]
    assert len(np.unique(s.run_id)) == 2                  # one run per valid stretch
    assert np.allclose(s.hr, 120, atol=0.5)
    sets = P.activity_study_sets(series)
    assert set(sets) == {"PRE", "DARA"}
    assert sets["PRE"].shape[1] == C.HR_SEQUENCE_S


def test_simulator_export_marks_every_new_stretch():
    from src.export_sim import contiguous_breaks   # noqa: PLC0415
    t = np.array([0, 1, 2, 5, 6, 0, 1, 2])
    session = np.array([0, 0, 0, 0, 0, 1, 1, 1])
    assert contiguous_breaks(t, session) == [3, 5]   # a gap of 3 s and a new session
    assert contiguous_breaks(np.arange(5), np.zeros(5, int)) == []


def test_auroc_and_f1_known_values():
    from src.train_physio import auroc, f1_at   # noqa: PLC0415 - imports TensorFlow
    assert auroc(np.array([0.0, 1.0]), np.array([2.0, 3.0])) == 1.0
    assert auroc(np.array([2.0, 3.0]), np.array([0.0, 1.0])) == 0.0
    assert auroc(np.array([1.0, 1.0]), np.array([1.0, 1.0])) == 0.5   # ties count half
    assert auroc(np.array([0.0, 2.0]), np.array([1.0, 3.0])) == 0.75
    # 2 anomalies above 1.5 of 3, 1 normal above: tp 2, fp 1, fn 1
    assert f1_at(np.array([0.0, 2.0]), np.array([1.0, 2.0, 3.0]), 1.5) == pytest.approx(4 / 6)
    assert f1_at(np.array([0.0]), np.array([0.0]), 1.0) == 0.0


def test_autoencoder_architecture_matches_section_8_3():
    pytest.importorskip("tensorflow")
    from src.train_physio import build_model   # noqa: PLC0415
    m = build_model()
    assert m.input_shape == (None, 60, 1)
    assert m.output_shape == (None, 60, 1)
    assert [type(layer).__name__ for layer in m.layers] == ["InputLayer", "LSTM", "RepeatVector", "LSTM", "TimeDistributed"]
    assert m.layers[1].units == 32 and m.layers[3].units == 32
