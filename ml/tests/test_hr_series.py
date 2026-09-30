"""Tests of the beat -> 1 Hz heart-rate procedure (src/hr_series.py)."""
import numpy as np

from src.hr_series import beats_to_hr, contiguous_sequences, corrupt_beats


def test_constant_rate_is_recovered():
    beats = np.arange(0, 60, 0.75)  # 80 bpm
    t, hr = beats_to_hr(beats, start=0, end=59)
    assert len(t) > 50
    np.testing.assert_allclose(hr, 80.0, rtol=1e-9)


def test_mean_rr_keeps_sinus_arrhythmia_rate():
    # Alternating 0.5 s / 1.0 s intervals: true rate = 60 / 0.75 = 80 bpm (a median would give 60 or 120).
    rr = np.tile([0.5, 1.0], 60)
    beats = np.concatenate([[0], np.cumsum(rr)])
    _, hr = beats_to_hr(beats, window_s=6.0)
    assert abs(np.median(hr) - 80.0) < 3


def test_prefilter_drops_impossible_intervals():
    beats = np.array([0, 1, 2, 2.1, 3, 4, 5, 6, 7, 8])  # 0.1 s interval = 600 bpm: dropped
    t, hr = beats_to_hr(beats, window_s=4.0)
    assert np.all(hr <= 300)
    assert np.all(hr >= 20)


def test_bad_segments_are_excluded():
    beats = np.arange(0, 100, 1.0)  # 60 bpm
    t, hr = beats_to_hr(beats, bad_segments=[(40, 60)], start=0, end=99)
    assert not np.any((t >= 40) & (t <= 60))
    np.testing.assert_allclose(hr, 60.0)


def test_gaps_without_beats_are_left_out():
    beats = np.concatenate([np.arange(0, 30, 1.0), np.arange(50, 80, 1.0)])
    t, _ = beats_to_hr(beats, start=0, end=79)
    assert not np.any((t > 33) & (t < 47))


def test_too_few_beats_returns_empty():
    t, hr = beats_to_hr([0.0, 1.0])
    assert len(t) == 0 and len(hr) == 0


def test_contiguous_sequences_counts_gap_free_runs():
    t = np.concatenate([np.arange(0, 120), np.arange(200, 250)]).astype(float)  # 120 s run + 50 s run
    s = np.array(["a"] * len(t))
    assert contiguous_sequences(t, s, length_s=60, hop_s=10) == 7  # (120 - 60) // 10 + 1


def test_corrupt_beats_changes_counts_as_requested():
    rng = np.random.default_rng(0)
    beats = np.arange(0, 1000, 1.0)
    c = corrupt_beats(beats, rng, missed=0.1, extra=0.05, jitter_s=0.0)
    assert 930 < len(c) < 970  # about -10 % + 5 %
