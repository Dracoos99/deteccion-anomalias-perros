"""TensorFlow settings shared by training and export. Import this module before tensorflow.

- Keras 2 (tf_keras): the TF.js layers format loads Keras 2 configs; Keras 3 configs are not supported by tfjs 4.x.
- oneDNN custom ops off and op determinism on, so a run with the same seed gives the same model (RNF-05).
"""
import os

os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import tensorflow as tf  # noqa: E402
import tf_keras as keras  # noqa: E402


def seed_everything(seed: int) -> None:
    keras.utils.set_random_seed(seed)
    tf.config.experimental.enable_op_determinism()


def load_tfjs_keras_converter():
    """Keras → TF.js converter of the official `tensorflowjs` package without running its package __init__, which
    imports jax, tensorflow_hub and tensorflow_decision_forests (the last one has no Windows build). The Keras path only
    needs h5py, numpy, six and three small internal modules. Install with: pip install tensorflowjs==4.22.0 --no-deps"""
    import importlib.util
    import sys
    import types
    from pathlib import Path

    spec = importlib.util.find_spec("tensorflowjs")
    if spec is None:
        raise ImportError("Falta tensorflowjs: pip install tensorflowjs==4.22.0 --no-deps")
    root = Path(spec.submodule_search_locations[0])
    for name, path in (("tensorflowjs", root), ("tensorflowjs.converters", root / "converters")):
        if name not in sys.modules or not hasattr(sys.modules[name], "__path__"):
            mod = types.ModuleType(name)
            mod.__path__ = [str(path)]
            sys.modules[name] = mod
    from tensorflowjs.converters import keras_h5_conversion
    return keras_h5_conversion
