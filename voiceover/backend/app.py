"""
Voice Over App - Backend (F5-TTS, fine-tune Bahasa Indonesia)
=============================================================

Server FastAPI yang menjalankan model open-source F5-TTS dengan checkpoint
fine-tune bahasa Indonesia untuk:
  1. Menyimpan sampel suara (referensi cloning) + transkrip opsional.
  2. Menghasilkan voice over berbahasa Indonesia dari teks memakai suara
     hasil cloning (zero-shot).

Model default: 'Eempostor/F5-TTS-INDO-FINETUNE-V2' (dari Hugging Face).
Bisa diganti lewat variabel lingkungan (lihat di bawah).

Jalankan:
    pip install -r requirements.txt
    python app.py            # atau: uvicorn app:app --host 0.0.0.0 --port 8000

Variabel lingkungan (opsional):
    F5_REPO        repo Hugging Face model (default di atas)
    F5_CKPT_FILE   nama file checkpoint di repo (default: dideteksi otomatis)
    F5_VOCAB_FILE  nama file vocab di repo    (default: dideteksi otomatis)
    F5_MODEL       arsitektur dasar: F5TTS_Base (default) atau F5TTS_v1_Base
"""

import io
import os
import re
import json
import uuid
import wave
import struct
import tempfile
import subprocess
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Konfigurasi
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "data" / "voices"      # sampel suara referensi
OUTPUT_DIR = BASE_DIR / "data" / "outputs"     # hasil voice over
VOICES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

F5_REPO = os.environ.get("F5_REPO", "Eempostor/F5-TTS-INDO-FINETUNE-V2")
F5_MODEL = os.environ.get("F5_MODEL", "F5TTS_Base")

# ---------------------------------------------------------------------------
# Pemuatan model (lazy, sekali saja)
# ---------------------------------------------------------------------------
_f5 = None
_device = None
_loaded_info = {}


def _pick_ckpt(files):
    cands = [f for f in files if f.endswith((".safetensors", ".pt"))]
    if not cands:
        raise HTTPException(status_code=500, detail="Checkpoint model tidak ditemukan di repo.")
    # Prioritaskan .safetensors, lalu nama yang mengandung 'last', lalu angka terbesar.
    safet = [f for f in cands if f.endswith(".safetensors")] or cands
    last = [f for f in safet if "last" in f.lower()]
    if last:
        return last[0]

    def step(f):
        m = re.search(r"(\d+)", os.path.basename(f))
        return int(m.group(1)) if m else -1

    return sorted(safet, key=step)[-1]


def _pick_vocab(files):
    for f in files:
        if os.path.basename(f).lower() == "vocab.txt":
            return f
    for f in files:
        if f.endswith("vocab.txt"):
            return f
    return None


def get_f5():
    """Muat model F5-TTS sekali dan simpan di memori."""
    global _f5, _device, _loaded_info
    if _f5 is not None:
        return _f5

    import torch
    from huggingface_hub import hf_hub_download, list_repo_files
    from f5_tts.api import F5TTS

    files = list_repo_files(F5_REPO)
    ckpt_name = os.environ.get("F5_CKPT_FILE") or _pick_ckpt(files)
    vocab_name = os.environ.get("F5_VOCAB_FILE") or _pick_vocab(files)

    print(f"[voiceover] Mengunduh checkpoint: {F5_REPO}/{ckpt_name}")
    ckpt_path = hf_hub_download(F5_REPO, ckpt_name)
    vocab_path = hf_hub_download(F5_REPO, vocab_name) if vocab_name else ""

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[voiceover] Memuat F5-TTS ({F5_MODEL}) di perangkat: {_device}")
    try:
        _f5 = F5TTS(model=F5_MODEL, ckpt_file=ckpt_path,
                    vocab_file=vocab_path or "", device=_device)
    except TypeError:
        # Kompatibilitas versi lama yang memakai nama argumen 'model_type'.
        _f5 = F5TTS(model_type=F5_MODEL, ckpt_file=ckpt_path,
                    vocab_file=vocab_path or "", device=_device)

    _loaded_info = {"repo": F5_REPO, "ckpt": ckpt_name,
                    "vocab": vocab_name, "arch": F5_MODEL}
    print("[voiceover] Model siap.", _loaded_info)
    return _f5


# ---------------------------------------------------------------------------
# Util audio & metadata
# ---------------------------------------------------------------------------
def _ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


def to_wav(src_bytes: bytes, dst_path: Path):
    """Simpan byte audio apa pun menjadi WAV mono 24000 Hz."""
    try:
        with wave.open(io.BytesIO(src_bytes), "rb") as w:
            _ = w.getnframes()
        # Sudah WAV valid; tetap normalkan lewat ffmpeg bila ada agar mono 24k.
        if not _ffmpeg_available():
            dst_path.write_bytes(src_bytes)
            return
    except (wave.Error, EOFError, struct.error):
        if not _ffmpeg_available():
            raise HTTPException(
                status_code=400,
                detail=("Format audio bukan WAV dan ffmpeg tidak ada di server. "
                        "Unggah WAV atau pasang ffmpeg."),
            )

    with tempfile.NamedTemporaryFile(delete=False, suffix=".input") as tmp:
        tmp.write(src_bytes)
        tmp_path = tmp.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ac", "1", "-ar", "24000",
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


def _meta_path(voice_id: str) -> Path:
    return VOICES_DIR / f"{voice_id}.json"


def read_meta(voice_id: str) -> dict:
    p = _meta_path(voice_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"label": voice_id, "ref_text": ""}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
app = FastAPI(title="Voice Over App (F5-TTS Indonesia)", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SynthRequest(BaseModel):
    text: str
    voice_id: str
    speed: float = 1.0
    remove_silence: bool = True


@app.get("/api/health")
def health():
    import torch
    return {
        "status": "ok",
        "engine": "F5-TTS",
        "repo": F5_REPO,
        "model_loaded": _f5 is not None,
        "loaded_info": _loaded_info,
        "cuda": torch.cuda.is_available(),
        "language": "id",
    }


@app.get("/api/voices")
def list_voices():
    voices = []
    for p in sorted(VOICES_DIR.glob("*.wav")):
        m = read_meta(p.stem)
        voices.append({"id": p.stem, "label": m.get("label", p.stem),
                       "has_ref_text": bool(m.get("ref_text"))})
    return {"voices": voices}


@app.post("/api/voices")
async def add_voice(name: str = Form(...), ref_text: str = Form(""),
                    file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) < 1000:
        raise HTTPException(status_code=400, detail="File audio terlalu kecil/kosong.")

    voice_id = f"{slugify(name)}-{uuid.uuid4().hex[:6]}"
    to_wav(raw, VOICES_DIR / f"{voice_id}.wav")
    _meta_path(voice_id).write_text(
        json.dumps({"label": name.strip(), "ref_text": ref_text.strip()},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    return {"id": voice_id, "label": name.strip(), "has_ref_text": bool(ref_text.strip())}


@app.delete("/api/voices/{voice_id}")
def delete_voice(voice_id: str):
    wav_path = VOICES_DIR / f"{voice_id}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail="Suara tidak ditemukan.")
    wav_path.unlink(missing_ok=True)
    _meta_path(voice_id).unlink(missing_ok=True)
    return {"deleted": voice_id}


@app.post("/api/synthesize")
def synthesize(req: SynthRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Teks kosong.")
    if len(text) > 5000:
        raise HTTPException(status_code=400, detail="Teks maksimal 5000 karakter per proses.")

    wav_path = VOICES_DIR / f"{req.voice_id}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail="Sampel suara tidak ditemukan. Simpan dulu.")

    ref_text = read_meta(req.voice_id).get("ref_text", "")

    f5 = get_f5()
    out_id = uuid.uuid4().hex
    out_path = OUTPUT_DIR / f"{out_id}.wav"

    try:
        # ref_text kosong -> F5-TTS otomatis mentranskrip sampel (butuh ASR).
        f5.infer(
            ref_file=str(wav_path),
            ref_text=ref_text or "",
            gen_text=text,
            file_wave=str(out_path),
            speed=max(0.3, min(2.0, float(req.speed))),
            remove_silence=bool(req.remove_silence),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal menghasilkan audio: {e}")

    return {"audio_url": f"/api/audio/{out_id}", "id": out_id}


@app.get("/api/audio/{out_id}")
def get_audio(out_id: str):
    if not re.fullmatch(r"[0-9a-f]+", out_id):
        raise HTTPException(status_code=400, detail="ID tidak valid.")
    out_path = OUTPUT_DIR / f"{out_id}.wav"
    if not out_path.exists():
        raise HTTPException(status_code=404, detail="Audio tidak ditemukan.")
    return FileResponse(out_path, media_type="audio/wav",
                        filename=f"voiceover-{out_id[:8]}.wav")


# Sajikan frontend statis bila folder ada.
_frontend = BASE_DIR.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
