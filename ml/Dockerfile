# Training image for the GPU (RTX 3060 through Docker Desktop + WSL2). Same Python and pinned packages as ml/.venv, with
# TensorFlow's CUDA libraries from pip. The repository is mounted at /work, never copied: the datasets stay on disk.
#   docker build -t perros-ml ml
#   docker run --rm --gpus all -v "<repo>:/work" -w /work/ml perros-ml python -m src.train_behavior
FROM python:3.13-slim
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt "tensorflow[and-cuda]==2.21.0" \
 && pip install --no-cache-dir --no-deps tensorflowjs==4.22.0
# TensorFlow finds most CUDA libraries from the pip wheels by itself, but not cuSOLVER: list every wheel's lib folder.
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.13/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.13/site-packages/nvidia/cuda_cupti/lib:/usr/local/lib/python3.13/site-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.13/site-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.13/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.13/site-packages/nvidia/cufft/lib:/usr/local/lib/python3.13/site-packages/nvidia/curand/lib:/usr/local/lib/python3.13/site-packages/nvidia/cusolver/lib:/usr/local/lib/python3.13/site-packages/nvidia/cusparse/lib:/usr/local/lib/python3.13/site-packages/nvidia/nccl/lib:/usr/local/lib/python3.13/site-packages/nvidia/nvjitlink/lib
ENV TF_CPP_MIN_LOG_LEVEL=2 PYTHONUNBUFFERED=1
WORKDIR /work/ml
