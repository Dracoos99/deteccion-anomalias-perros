"""Tests of the behavioral model v2: causal smoothing over the deployed stream of
non-overlapping windows, and the flat ensemble that averages the members."""
import numpy as np
import pandas as pd
import pytest

tf = pytest.importorskip("tensorflow")

from src.ensemble_behavior import flat_ensemble, smooth_sequence  # noqa: E402
from src.train_behavior import build_model  # noqa: E402
from src.tfsetup import keras  # noqa: E402

STEP = 200   # 2 s windows at 100 Hz, 50 % overlap in the index (hop 100)


def stream(starts, file="a.parquet", dog=1):
    return pd.DataFrame({"dog_id": dog, "file": file, "start": starts, "status": "clean"})


def onehot(i, p=0.9):
    v = np.full(7, (1 - p) / 6, np.float32)
    v[i] = p
    return v


def test_without_smoothing_keeps_every_window_of_both_phases():
    meta = stream([0, 100, 200, 300, 400])
    probs = np.stack([onehot(i % 7) for i in range(5)])
    out, rows = smooth_sequence(probs, meta, 0, STEP)
    assert sorted(rows.tolist()) == [0, 1, 2, 3, 4]
    assert np.allclose(out, probs[rows])


def test_smoothing_is_causal_within_a_phase_and_restarts_at_gaps():
    # Phase 0: starts 0, 200, 400 (consecutive), then 1000 (gap) restarts the average.
    meta = stream([0, 200, 400, 1000])
    probs = np.stack([onehot(2), onehot(2), onehot(0, 0.6), onehot(0, 0.6)])
    out, rows = smooth_sequence(probs, meta, 6, STEP)
    by_row = dict(zip(rows.tolist(), out))
    assert by_row[2].argmax() == 2              # one doubtful window does not flip a lying dog
    assert by_row[3].argmax() == 0              # after a gap nothing is carried over
    assert np.allclose(by_row[0], probs[0])     # the first window of a stream is itself


def test_streams_of_different_recordings_never_mix():
    meta = pd.concat([stream([0, 200], "a.parquet"), stream([0, 200], "b.parquet")], ignore_index=True)
    probs = np.stack([onehot(2), onehot(2), onehot(5), onehot(5)])
    out, rows = smooth_sequence(probs, meta, 20, STEP)
    by_row = dict(zip(rows.tolist(), out))
    assert by_row[2].argmax() == 5 and np.allclose(by_row[2], probs[2])


def test_flat_ensemble_reproduces_the_average_of_its_members():
    members = []
    for seed in (1, 2):
        keras.utils.set_random_seed(seed)
        members.append(build_model(200))
    x = np.random.default_rng(0).normal(size=(4, 200, 6)).astype(np.float32)
    ens = flat_ensemble(members, 200)
    expected = np.mean([m.predict(x, verbose=0) for m in members], axis=0)
    assert np.allclose(ens.predict(x, verbose=0), expected, atol=1e-5)
    assert not any(type(layer).__name__ in ("Sequential", "Functional") for layer in ens.layers)
