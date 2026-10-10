"""Tests of anomaly injection (src/inject.py), window features (src/features.py) and the activity rule (src/activity.py)."""
import json

import numpy as np
import pytest

from src import config as C
from src.activity import balanced_accuracy, fit_threshold, window_intensity
from src.features import window_features
from src.inject import FIXTURE_PATH, Injection, apply_hr, apply_imu, apply_temp, catalog, ramp, validate


def test_catalog_covers_the_anomaly_types_of_section_10():
    # The six anomalies of the dog and the collar taken off, a problem of the sensor.
    assert set(catalog()["types"]) == {"activity_drop", "immobility", "tachycardia", "bradycardia", "fever", "hypothermia", "collar_off"}
    assert catalog()["types"]["collar_off"]["signal"] == "sensor"
    assert catalog()["types"]["activity_drop"]["min"] == 0.4 and catalog()["types"]["activity_drop"]["max"] == 0.7  #


def test_validate_rejects_out_of_range_values():
    with pytest.raises(ValueError):
        validate("activity_drop", 0.9, 60)
    with pytest.raises(ValueError):
        validate("fever", 1.5, 0)
    with pytest.raises(ValueError):
        validate("sneezing", 1.0, 60)
    assert Injection("fever", 1.5, 25).blocks() == 3


def test_activity_drop_scales_movement_but_keeps_posture():
    rng = np.random.default_rng(0)
    block = rng.normal(0, 0.3, (1000, 6)) + [0, 0, 1, 0, 0, 0]
    out = apply_imu(block, Injection("activity_drop", 0.6, 600), 0)
    np.testing.assert_allclose(out.mean(axis=0), block.mean(axis=0), atol=1e-12)
    np.testing.assert_allclose(out.std(axis=0), 0.4 * block.std(axis=0), rtol=1e-9)


def test_hr_and_temp_ramps():
    np.testing.assert_allclose(ramp([0, 15, 30, 60], 30), [0, 0.5, 1, 1])
    hr = apply_hr([100.0] * 3, Injection("tachycardia", 0.5, 600), [0, 15, 30])
    np.testing.assert_allclose(hr, [100, 125, 150])
    assert apply_hr([80.0], Injection("bradycardia", 0.25, 600), [100])[0] == pytest.approx(60.0)
    assert apply_temp(38.5, Injection("fever", 2.0, 600), 120) == pytest.approx(40.5)
    assert apply_temp(38.5, Injection("hypothermia", 1.0, 600), 60) == pytest.approx(38.0)
    # A transform leaves the other signals untouched
    assert apply_temp(38.5, Injection("tachycardia", 0.5, 600), 60) == 38.5


def test_fixture_matches_current_implementation():
    f = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    for name, case in f["anomalies"].items():
        inj = Injection(case["injection"]["type"], case["injection"]["magnitude"], case["injection"]["durationS"])
        signal = inj.spec["signal"]
        if signal == "imu":
            got = apply_imu(np.array(case["input"]), inj, case["offsetS"])
        elif signal == "hr":
            got = apply_hr(case["input"], inj, np.arange(case["offsetS"], case["offsetS"] + len(case["input"])))
        else:
            got = apply_temp(case["input"], inj, case["offsetS"])
        np.testing.assert_allclose(got, case["expected"], rtol=0, atol=1e-12, err_msg=name)
    w = np.array(f["intensity"]["window"])[None]
    assert window_intensity(w)[0] == pytest.approx(f["intensity"]["expectedG"], abs=1e-12)


def test_intensity_is_zero_for_a_still_sensor_and_orientation_free():
    still = np.tile([0.0, 0.0, 1.0, 0.0, 0.0, 0.0], (1, 200, 1))
    assert window_intensity(still)[0] == pytest.approx(0.0)
    rng = np.random.default_rng(1)
    w = rng.normal(0, 0.2, (1, 200, 6))
    rotated = w.copy()
    rotated[:, :, [0, 1]] = w[:, :, [1, 0]]  # swapping axes does not change the magnitude
    assert window_intensity(w)[0] == pytest.approx(window_intensity(rotated)[0])


def test_fit_threshold_separates_two_groups():
    x = np.concatenate([np.full(50, 0.05), np.full(50, 0.3)])
    y = np.concatenate([np.zeros(50, bool), np.ones(50, bool)])
    thr, ba = fit_threshold(x, y)
    assert 0.05 <= thr < 0.3 and ba == 1.0
    assert balanced_accuracy(y, np.ones(100, bool)) == 0.5


def test_window_features_shapes_and_known_frequency():
    t = np.arange(200) / C.IMU_HZ
    raw = np.zeros((2, 200, 6))
    raw[0, :, 0] = 0.5 * np.sin(2 * np.pi * 4 * t)  # 4 Hz on acc_x
    raw[0, :, 2] = 1.0
    raw[1, :, 2] = 1.0                              # still sensor
    z = raw.copy()
    f = window_features(z, raw)
    assert f.shape == (2, 98)
    assert not f.isna().any().any()
    assert f.loc[1, "acc_norm_std"] == pytest.approx(0.0)
    assert f.loc[0, "acc_norm_domfreq"] == pytest.approx(8.0, abs=0.5)  # |sin| folds 4 Hz into 8 Hz in the magnitude
