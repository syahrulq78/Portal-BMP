# Image untuk backend voice cloning F5-TTS (fine-tune Bahasa Indonesia).
# Untuk GPU: jalankan dengan `docker run --gpus all ...` dan pakai base image
# CUDA (mis. nvidia/cuda) bila perlu. Base python di bawah cukup untuk CPU
# (lambat) atau host yang sudah menyediakan driver GPU + torch CUDA.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
