"""Leave-one-dog-out folds of src.behavior_eval: no dog is ever trained or early-stopped on and evaluated."""
import pytest

pytest.importorskip("tensorflow")

from src.behavior_eval import fold_split  # noqa: E402


def test_the_held_out_dog_is_never_trained_on_nor_used_to_stop():
    every, val = list(range(16, 30)), [18, 21, 25]
    for dog in every:
        train, v = fold_split(dog, every, val)
        assert dog not in train and dog not in v
        assert not set(train) & set(v)
        assert sorted(train + v + [dog]) == every


def test_a_validation_dog_held_out_leaves_the_others_for_early_stopping():
    train, v = fold_split(21, list(range(16, 30)), [18, 21, 25])
    assert v == [18, 25] and 21 not in train
