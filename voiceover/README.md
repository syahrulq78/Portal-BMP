# 🎙️ Voice Over Studio (F5-TTS Bahasa Indonesia)

Aplikasi voice over dengan **voice cloning open-source berbahasa Indonesia**.
Anda memberi 10–30 detik sampel suara, mengetik naskah, dan aplikasi
menghasilkan audio voice over **dalam bahasa Indonesia** dengan suara hasil
cloning tersebut (zero-shot, tanpa training).

Mesin: [F5-TTS](https://github.com/SWivid/F5-TTS) dengan checkpoint fine-tune
Bahasa Indonesia [`Eempostor/F5-TTS-INDO-FINETUNE-V2`](https://huggingface.co/Eempostor/F5-TTS-INDO-FINETUNE-V2).

Bagian dari Portal BMP.

---

## ⚠️ Baca dulu: etika & izin

Cloning suara hanya boleh untuk **suara Anda sendiri** atau **narator yang
sudah memberi izin**. Meniru suara orang tanpa izin bisa melanggar hukum dan
etika. Pengguna bertanggung jawab penuh atas suara yang di-cloning.

---

## Struktur

```
voiceover/
├── backend/            # Server Python (FastAPI + F5-TTS)
│   ├── app.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   └── index.html      # Antarmuka web (bisa di-hosting statis)
├── colab/
│   └── f5tts_indo_voiceover_colab.ipynb   # Jalankan gratis di GPU Colab
└── README.md
```

Arsitektur: frontend statis (bisa ditaruh di Portal BMP / GitHub Pages)
memanggil backend F5-TTS lewat HTTP. Backend butuh Python dan **sebaiknya GPU**
(di CPU bisa jalan tapi sangat lambat).

---

## Cara pakai

### Opsi A — Google Colab (paling mudah, gratis, ada GPU)

1. Buka `colab/f5tts_indo_voiceover_colab.ipynb` di [Google Colab](https://colab.research.google.com/).
2. **Runtime → Change runtime type → T4 GPU**.
3. Jalankan semua sel. Salin URL `https://xxxx.trycloudflare.com` yang muncul.
4. Buka `frontend/index.html`, klik **⚙️ Server**, tempel URL tadi, **Hubungkan**.
5. Rekam/unggah sampel suara (isi transkripnya) → Simpan → tulis naskah →
   **Buat Voice Over**.

> Sesi Colab gratis berhenti setelah beberapa jam / idle. Untuk pemakaian
> rutin, gunakan server sendiri (Opsi B/C).

### Opsi B — Server sendiri (lokal / VPS berGPU)

```bash
cd voiceover/backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# (opsional, untuk GPU) pasang torch versi CUDA sesuai https://pytorch.org
python app.py           # server jalan di http://localhost:8000
```

### Opsi C — Docker

```bash
cd voiceover
docker build -t voiceover -f backend/Dockerfile .
docker run --gpus all -p 8000:8000 voiceover     # tanpa --gpus untuk CPU
```

---

## Tips kualitas

- **Sampel suara**: 10–30 detik, jernih, satu orang, tanpa musik/noise latar.
- **Isi transkrip sampel** (kalimat persis yang diucapkan). Ini opsional, tapi
  membuat hasil jauh lebih presisi. Kalau dikosongkan, sistem mentranskrip
  otomatis (lebih lambat & kadang kurang tepat).
- Naskah panjang otomatis dipecah oleh F5-TTS; beri tanda baca yang benar.
- Proses **pertama** lebih lama karena checkpoint diunduh & dimuat ke memori.

---

## API backend (ringkas)

| Method | Endpoint | Fungsi |
|---|---|---|
| GET | `/api/health` | Status server, GPU, info model |
| GET | `/api/voices` | Daftar suara tersimpan |
| POST | `/api/voices` | Simpan sampel (`name`, `ref_text`, `file`) |
| DELETE | `/api/voices/{id}` | Hapus suara |
| POST | `/api/synthesize` | Buat audio (`text`, `voice_id`, `speed`) |
| GET | `/api/audio/{id}` | Ambil/unduh hasil WAV |

---

## Mengganti / mengatur model

Semua lewat variabel lingkungan (opsional):

| Variabel | Fungsi | Default |
|---|---|---|
| `F5_REPO` | Repo Hugging Face model | `Eempostor/F5-TTS-INDO-FINETUNE-V2` |
| `F5_CKPT_FILE` | Nama file checkpoint di repo | deteksi otomatis |
| `F5_VOCAB_FILE` | Nama file vocab di repo | deteksi otomatis |
| `F5_MODEL` | Arsitektur dasar | `F5TTS_v1_Base` |

Default `F5TTS_v1_Base` sudah terbukti menghasilkan suara jelas untuk
checkpoint `f5_tts_indo_v2.pt`. Jika suatu saat hasilnya noise setelah ganti
checkpoint, coba `F5_MODEL=F5TTS_Base`. Anda juga bisa memakai checkpoint
F5-TTS Indonesia lain lewat `F5_REPO`.

Cek `GET /api/health` untuk melihat model yang benar-benar termuat.

---

## Lisensi & tanggung jawab

- Kode aplikasi ini bebas Anda gunakan/ubah.
- Model dan checkpoint pihak ketiga tunduk pada lisensi masing-masing di
  Hugging Face. Periksa lisensinya sebelum penggunaan komersial.
- Pengguna wajib memastikan ada **izin** atas suara yang di-cloning.
