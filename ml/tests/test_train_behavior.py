"""Tests of the training pieces of src/train_behavior.py (architecture, augmentation, metrics, novelty)."""
import numpy as np
import pytest

tf = pytest.importorskip("tensorflow")

from src.train_behavior import augment, build_model, classification_report, novelty_report  # noqa: E402


def test_architecture_matches_section_8_2():
    m = build_model(200)
    assert m.input_shape == (None, 200, 6)
    assert m.output_shape == (None, 7)
    names = [type(layer).__name__ for layer in m.layers]
    assert names == ["Conv1D", "BatchNormalization", "ReLU", "MaxPooling1D", "Conv1D", "BatchNormalization", "ReLU",
                     "Dropout", "LSTM", "Dense", "Dense"]
    assert m.count_params() == 81479


def test_augmentation_keeps_shape_and_changes_values():
    x = tf.constant(np.random.default_rng(0).normal(size=(200, 6)), dtype=tf.float32)
    xa, y = augment(x, tf.constant(3))
    assert xa.shape == (200, 6)
    assert int(y) == 3
    assert np.all(np.isfinite(xa.numpy()))
    assert not np.allclose(xa.numpy(), x.numpy())
    # Small perturbation: rotation of ±10°, scaling of ±10 % and noise of 0.05
    assert np.abs(xa.numpy() - x.numpy()).mean() < 0.5


def test_classification_report_values():
    y = np.array([0, 0, 1, 1, 3, 4, 5, 6])
    p = np.array([0, 1, 1, 1, 3, 4, 5, 2])
    r = classification_report(y, p)
    assert r["windows"] == 8
    assert r["accuracy"] == 0.75
    assert r["per_class"]["sit"]["recall"] == 0.5
    assert r["confusion_matrix"][6][2] == 1
    assert r["active_balanced_accuracy"] == pytest.approx(0.875)  # sniff → lie is the only activity error


def test_novelty_threshold_is_the_validation_quantile():
    rng = np.random.default_rng(1)
    confident = np.eye(7)[rng.integers(0, 7, 1000)] * 0.9 + 0.1 / 7
    vague = np.full((500, 7), 1 / 7)
    r = novelty_report(confident, confident, vague)
    assert r["test_unlabeled_flagged"] == 1.0
    assert r["auroc_clean_vs_unlabeled"] == pytest.approx(1.0)
