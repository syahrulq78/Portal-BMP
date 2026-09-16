# 🎙️ Voice Over Studio (XTTS-v2)

Aplikasi voice over dengan **voice cloning open-source** memakai model
[Coqui XTTS-v2](https://github.com/idiap/coqui-ai-TTS). Anda memberi 15–60 detik
sampel suara, lalu mengetik naskah, dan aplikasi menghasilkan audio voice over
dengan suara hasil cloning tersebut.

Bagian dari Portal BMP.

---

## ⚠️ Baca dulu: dua hal penting

1. **Bahasa Indonesia belum didukung resmi oleh XTTS-v2.** Bahasa yang
   didukung: Inggris, Spanyol, Prancis, Jerman, Italia, Portugis, Polandia,
   Turki, Rusia, Belanda, Ceko, Arab, Mandarin, Jepang, Hungaria, Korea, Hindi.
   Untuk teks Indonesia, hasil bisa terdengar beraksen. Lihat
   [Alternatif untuk bahasa Indonesia](#alternatif-untuk-bahasa-indonesia).

2. **Etika & izin.** Cloning suara hanya boleh untuk **suara Anda sendiri**
   atau **narator yang sudah memberi izin**. Meniru suara orang tanpa izin bisa
   melanggar hukum dan etika. Model XTTS-v2 juga berlisensi **CPML
   (non-komersial)** — tidak untuk dijual/dikomersialkan.

---

## Struktur

```
voiceover/
├── backend/            # Server Python (FastAPI + XTTS)
│   ├── app.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   └── index.html      # Antarmuka web (bisa di-hosting statis)
├── colab/
│   └── xtts_voiceover_colab.ipynb   # Jalankan gratis di GPU Colab
└── README.md
```

Arsitektur: frontend statis (bisa ditaruh di Portal BMP / GitHub Pages)
memanggil backend XTTS lewat HTTP. Backend butuh Python + sebaiknya **GPU**
(di CPU bisa jalan tapi sangat lambat).

---

## Cara pakai

### Opsi A — Google Colab (paling mudah, gratis, ada GPU)

1. Buka `colab/xtts_voiceover_colab.ipynb` di [Google Colab](https://colab.research.google.com/).
2. **Runtime → Change runtime type → T4 GPU**.
3. Jalankan semua sel. Salin URL `https://xxxx.trycloudflare.com` yang muncul.
4. Buka `frontend/index.html` (dobel klik atau hosting), klik **⚙️ Server**,
   tempel URL tadi, klik **Hubungkan**.
5. Rekam/unggah sampel suara → Simpan → tulis naskah → **Buat Voice Over**.

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

Buka `http://localhost:8000` (backend juga menyajikan frontend), atau buka
`frontend/index.html` lalu arahkan ke `http://localhost:8000`.

### Opsi C — Docker

```bash
cd voiceover
docker build -t voiceover -f backend/Dockerfile .
docker run --gpus all -p 8000:8000 voiceover     # tanpa --gpus untuk CPU
```

---

## API backend (ringkas)

| Method | Endpoint | Fungsi |
|---|---|---|
| GET | `/api/health` | Status server, GPU, daftar bahasa |
| GET | `/api/voices` | Daftar suara tersimpan |
| POST | `/api/voices` | Simpan sampel (`name`, `file`) |
| DELETE | `/api/voices/{id}` | Hapus suara |
| POST | `/api/synthesize` | Buat audio (`text`, `voice_id`, `language`, `speed`) |
| GET | `/api/audio/{id}` | Ambil/unduh hasil WAV |

---

## Tips kualitas

- Sampel suara: 15–60 detik, jernih, satu orang, tanpa musik/noise latar.
- Naskah panjang otomatis dipecah per kalimat; beri tanda baca yang benar.
- Proses **pertama** lebih lama karena model diunduh & dimuat ke memori.

---

## Alternatif untuk bahasa Indonesia

XTTS-v2 tidak resmi mendukung Indonesia. Jika hasil Indonesia kurang natural,
pertimbangkan mengganti mesin di backend dengan yang lebih cocok:

- **[F5-TTS](https://github.com/SWivid/F5-TTS)** — ada model komunitas
  bahasa Indonesia, kualitas cloning bagus.
- **[Fish Speech](https://github.com/fishaudio/fish-speech)** — multibahasa,
  mendukung banyak bahasa termasuk Indonesia.
- **[OpenVoice v2](https://github.com/myshell-ai/OpenVoice)** — cloning warna
  suara di atas mesin TTS lain.

Struktur API di `app.py` sudah dipisah rapi, jadi mengganti bagian
`get_tts()` + `synthesize()` ke salah satu mesin di atas relatif mudah. Beri
tahu saya kalau ingin dibuatkan versi yang benar-benar mendukung bahasa
Indonesia.

---

## Lisensi & tanggung jawab

- Kode aplikasi ini bebas Anda gunakan/ubah.
- Model **XTTS-v2 berlisensi CPML (non-komersial)** — patuhi ketentuannya.
- Pengguna bertanggung jawab penuh memastikan ada **izin** atas suara yang
  di-cloning.
