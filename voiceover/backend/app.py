"""
Voice Over App - Backend (XTTS-v2 voice cloning)
=================================================

Server FastAPI yang menjalankan model open-source XTTS-v2 (Coqui) untuk:
  1. Menyimpan sampel suara (voice cloning reference).
  2. Menghasilkan voice over dari teks memakai suara hasil cloning.

Jalankan:
    pip install -r requirements.txt
    python app.py            # atau: uvicorn app:app --host 0.0.0.0 --port 8000

Catatan lisensi: XTTS-v2 memakai Coqui Public Model License (CPML) yang
bersifat NON-KOMERSIAL. Baca README sebelum dipakai untuk keperluan resmi.
"""

import io
import os
import re
import uuid
import wave
import struct
import tempfile
import subprocess
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Menyetujui lisensi model XTTS secara non-interaktif agar unduhan otomatis
# tidak menggantung menunggu input "y". Dengan ini Anda menyatakan setuju
# pada Coqui Public Model License (CPML). Lihat README.
os.environ.setdefault("COQUI_TOS_AGREED", "1")

# ---------------------------------------------------------------------------
# Konfigurasi
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "data" / "voices"      # sampel suara referensi
OUTPUT_DIR = BASE_DIR / "data" / "outputs"     # hasil voice over
VOICES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_NAME = os.environ.get("XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")

# Bahasa yang DIDUKUNG RESMI oleh XTTS-v2. "id" (Indonesia) tidak termasuk;
# lihat catatan di README untuk alternatif bahasa Indonesia.
SUPPORTED_LANGUAGES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "pl": "Polish", "tr": "Turkish",
    "ru": "Russian", "nl": "Dutch", "cs": "Czech", "ar": "Arabic",
    "zh-cn": "Chinese", "ja": "Japanese", "hu": "Hungarian", "ko": "Korean",
    "hi": "Hindi",
}

# ---------------------------------------------------------------------------
# Pemuatan model (lazy, sekali saja)
# ---------------------------------------------------------------------------
_tts = None
_device = None


def get_tts():
    """Muat model XTTS sekali dan simpan di memori."""
    global _tts, _device
    if _tts is not None:
        return _tts

    import torch
    from TTS.api import TTS

    # Workaround untuk torch >= 2.6 yang default weights_only=True saat load.
    try:
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import XttsAudioConfig, XttsArgs
        from TTS.config.shared_configs import BaseDatasetConfig
        torch.serialization.add_safe_globals(
            [XttsConfig, XttsAudioConfig, BaseDatasetConfig, XttsArgs]
        )
    except Exception:
        pass

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[voiceover] Memuat model {MODEL_NAME} di perangkat: {_device}")
    _tts = TTS(MODEL_NAME).to(_device)
    print("[voiceover] Model siap.")
    return _tts


# ---------------------------------------------------------------------------
# Util audio
# ---------------------------------------------------------------------------
def _ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


def to_wav(src_bytes: bytes, dst_path: Path):
    """Simpan byte audio apa pun menjadi WAV mono 22050 Hz.

    Jika file sudah WAV yang valid, dipakai apa adanya. Jika format lain
    (mp3/m4a/ogg/webm), dikonversi dengan ffmpeg bila tersedia.
    """
    # Coba baca langsung sebagai WAV.
    try:
        with wave.open(io.BytesIO(src_bytes), "rb") as w:
            _ = w.getnframes()
        dst_path.write_bytes(src_bytes)
        return
    except (wave.Error, EOFError, struct.error):
        pass

    if not _ffmpeg_available():
        raise HTTPException(
            status_code=400,
            detail=("Format audio bukan WAV dan ffmpeg tidak ditemukan di server. "
                    "Unggah file WAV, atau pasang ffmpeg di server."),
        )

    with tempfile.NamedTemporaryFile(delete=False, suffix=".input") as tmp:
        tmp.write(src_bytes)
        tmp_path = tmp.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ac", "1", "-ar", "22050",
             str(dst_path)],
            capture_output=True, check=True,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Gagal mengonversi audio: {e.stderr.decode('utf-8', 'ignore')[:400]}",
        )
    finally:
        os.unlink(tmp_path)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "suara"


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
app = FastAPI(title="Voice Over App (XTTS)", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # untuk portal statis; batasi di produksi bila perlu
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SynthRequest(BaseModel):
    text: str
    voice_id: str
    language: str = "en"
    speed: float = 1.0


@app.get("/api/health")
def health():
    import torch
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "model_loaded": _tts is not None,
        "cuda": torch.cuda.is_available(),
        "languages": SUPPORTED_LANGUAGES,
    }


@app.get("/api/voices")
def list_voices():
    voices = []
    for p in sorted(VOICES_DIR.glob("*.wav")):
        meta = p.with_suffix(".txt")
        label = meta.read_text(encoding="utf-8").strip() if meta.exists() else p.stem
        voices.append({"id": p.stem, "label": label})
    return {"voices": voices}


@app.post("/api/voices")
async def add_voice(name: str = Form(...), file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) < 1000:
        raise HTTPException(status_code=400, detail="File audio terlalu kecil/kosong.")

    voice_id = f"{slugify(name)}-{uuid.uuid4().hex[:6]}"
    wav_path = VOICES_DIR / f"{voice_id}.wav"
    to_wav(raw, wav_path)
    (VOICES_DIR / f"{voice_id}.txt").write_text(name.strip(), encoding="utf-8")
    return {"id": voice_id, "label": name.strip()}


@app.delete("/api/voices/{voice_id}")
def delete_voice(voice_id: str):
    wav_path = VOICES_DIR / f"{voice_id}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail="Suara tidak ditemukan.")
    wav_path.unlink(missing_ok=True)
    (VOICES_DIR / f"{voice_id}.txt").unlink(missing_ok=True)
    return {"deleted": voice_id}


@app.post("/api/synthesize")
def synthesize(req: SynthRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Teks kosong.")
    if len(text) > 5000:
        raise HTTPException(status_code=400, detail="Teks maksimal 5000 karakter per proses.")

    if req.language not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(f"Bahasa '{req.language}' tidak didukung XTTS-v2. "
                    f"Pilihan: {', '.join(SUPPORTED_LANGUAGES)}."),
        )

    wav_path = VOICES_DIR / f"{req.voice_id}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail="Sampel suara tidak ditemukan. Simpan dulu.")

    tts = get_tts()
    out_id = uuid.uuid4().hex
    out_path = OUTPUT_DIR / f"{out_id}.wav"

    try:
        tts.tts_to_file(
            text=text,
            speaker_wav=str(wav_path),
            language=req.language,
            file_path=str(out_path),
            speed=max(0.5, min(2.0, float(req.speed))),
            split_sentences=True,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal menghasilkan audio: {e}")

    return {"audio_url": f"/api/audio/{out_id}", "id": out_id}


@app.get("/api/audio/{out_id}")
def get_audio(out_id: str):
    # sanitasi: hanya heksadesimal
    if not re.fullmatch(r"[0-9a-f]+", out_id):
        raise HTTPException(status_code=400, detail="ID tidak valid.")
    out_path = OUTPUT_DIR / f"{out_id}.wav"
    if not out_path.exists():
        raise HTTPException(status_code=404, detail="Audio tidak ditemukan.")
    return FileResponse(out_path, media_type="audio/wav",
                        filename=f"voiceover-{out_id[:8]}.wav")


# Sajikan frontend statis bila folder ada (opsional, satu server untuk semuanya).
_frontend = BASE_DIR.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
