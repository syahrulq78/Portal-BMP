// Converts docx chapters to HTML book reader pages
// Usage: node convert.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// We use Node's built-in zip via a manual reader approach
// docx = ZIP file containing word/document.xml
function readDocxXml(filePath) {
  const buf = fs.readFileSync(filePath);
  // Find Central Directory to locate files
  // Use a simple approach: search for 'word/document.xml' local file header
  const marker = Buffer.from('word/document.xml');
  let pos = -1;
  for (let i = 0; i < buf.length - marker.length; i++) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
      // Local file header signature
      const fnLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const fname = buf.slice(i + 30, i + 30 + fnLen).toString('utf8');
      if (fname === 'word/document.xml') {
        const compression = buf.readUInt16LE(i + 8);
        const compressedSize = buf.readUInt32LE(i + 18);
        const dataStart = i + 30 + fnLen + extraLen;
        const compressedData = buf.slice(dataStart, dataStart + compressedSize);
        if (compression === 0) return compressedData.toString('utf8');
        if (compression === 8) return zlib.inflateRawSync(compressedData).toString('utf8');
        throw new Error('Unknown compression: ' + compression);
      }
    }
  }
  throw new Error('word/document.xml not found in: ' + filePath);
}

function xmlToHtml(xmlStr) {
  const paragraphs = [];

  // Extract all <w:p> blocks (non-greedy, handle both <w:p> and <w:p ...>)
  const pRegex = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
  let pMatch;

  while ((pMatch = pRegex.exec(xmlStr)) !== null) {
    const pContent = pMatch[1];

    // ── Detect heading via pStyle (standard Word styles) ──
    let styleType = 'normal';
    const styleMatch = /<w:pStyle\s+w:val="([^"]+)"/.exec(pContent);
    if (styleMatch) {
      const s = styleMatch[1].toLowerCase();
      if (s.includes('heading1') || s === 'title') styleType = 'h1';
      else if (s.includes('heading2')) styleType = 'h2';
      else if (s.includes('heading3')) styleType = 'h3';
      else if (s.includes('heading4')) styleType = 'h4';
      else if (s.includes('list') || s.includes('bullet')) styleType = 'li';
    }

    // ── Detect heading via direct formatting (sz + color + bold) ──
    // These books use direct formatting instead of named styles
    if (styleType === 'normal') {
      // Get max font size in paragraph (sz is in half-points)
      const szVals = [...pContent.matchAll(/w:sz w:val="(\d+)"/g)].map(m => parseInt(m[1]));
      const maxSz = szVals.length ? Math.max(...szVals) : 0;

      // Get dominant color
      const colorM = /w:color w:val="([0-9A-Fa-f]{6})"/.exec(pContent);
      const color = colorM ? colorM[1].toUpperCase() : '';

      // Check bold
      const hasBold = /<w:b\/>/.test(pContent) || /<w:b w:val="1"/.test(pContent) || /<w:bCs\/>/.test(pContent);

      // Rule: very large title (28pt+ = sz 56+), bold, navy
      if (maxSz >= 40 && hasBold && (color === '1B3A6B' || color === '000000' || color === '')) {
        styleType = 'h1';
      }
      // Rule: section heading (13pt+ = sz 26+), bold, navy
      else if (maxSz >= 25 && hasBold && (color === '1B3A6B' || color === '2C3E50' || color === '')) {
        styleType = 'h2';
      }
      // Rule: sub-section (11pt+ = sz 22+), bold, gold OR bold navy at smaller size
      else if (maxSz >= 22 && hasBold && (color === 'C9A84C' || color === 'D4A500' || color === 'E8B84B')) {
        // Skip pure "BAB N" labels (short, standalone)
        styleType = 'h3';
      }
      // Rule: list indent
      else if (/<w:numPr>/.test(pContent)) {
        styleType = 'li';
      }
    }

    // ── Extract text runs ──
    const runs = [];
    const rRegex = /<w:r[ >]([\s\S]*?)<\/w:r>/g;
    let rMatch;
    while ((rMatch = rRegex.exec(pContent)) !== null) {
      const rContent = rMatch[1];
      const isBold = /<w:b\/>/.test(rContent) || /<w:b w:val="1"/.test(rContent);
      const isItalic = /<w:i\/>/.test(rContent) || /<w:i w:val="1"/.test(rContent);

      let text = '';
      const tMatch = /<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g;
      let tM;
      while ((tM = tMatch.exec(rContent)) !== null) text += tM[1];

      if (text) {
        let w = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (isBold && styleType === 'normal') w = `<strong>${w}</strong>`;
        if (isItalic && styleType === 'normal') w = `<em>${w}</em>`;
        runs.push(w);
      }
    }

    // Handle hyperlinks
    const hlRegex = /<w:hyperlink[^>]*>([\s\S]*?)<\/w:hyperlink>/g;
    let hlM;
    while ((hlM = hlRegex.exec(pContent)) !== null) {
      const tMatch2 = /<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g;
      let tm;
      while ((tm = tMatch2.exec(hlM[1])) !== null) {
        if (tm[1]) runs.push(tm[1].replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
      }
    }

    const text = runs.join('').trim();
    if (!text) continue;

    // Skip pure "BAB N" short labels — they'll be shown via chap-badge already
    if (styleType === 'h3' && /^BAB\s+\d+$/i.test(text)) continue;

    if (styleType === 'h1') paragraphs.push(`<h1>${text}</h1>`);
    else if (styleType === 'h2') paragraphs.push(`<h2>${text}</h2>`);
    else if (styleType === 'h3') paragraphs.push(`<h3>${text}</h3>`);
    else if (styleType === 'h4') paragraphs.push(`<h4>${text}</h4>`);
    else if (styleType === 'li') paragraphs.push(`<li>${text}</li>`);
    else paragraphs.push(`<p>${text}</p>`);
  }

  // Wrap consecutive <li> in <ul>
  let html = paragraphs.join('\n');
  html = html.replace(/(<li>[^\n]*\n?)+/g, m => `<ul>\n${m}</ul>\n`);

  return html;
}

function convertChapters(chapterFiles, bookTitle, outputFile, coverColor) {
  console.log(`\nConverting: ${bookTitle}`);

  const chapters = [];
  for (const [chapNum, chapTitle, filePath] of chapterFiles) {
    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP (not found): ${path.basename(filePath)}`);
      continue;
    }
    console.log(`  Reading: ${path.basename(filePath)}`);
    try {
      const xml = readDocxXml(filePath);
      const html = xmlToHtml(xml);
      chapters.push({ num: chapNum, title: chapTitle, html });
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      chapters.push({ num: chapNum, title: chapTitle, html: `<p><em>Konten tidak dapat dimuat: ${e.message}</em></p>` });
    }
  }

  buildReaderHtml(chapters, bookTitle, outputFile, coverColor);
  console.log(`  → Saved: ${outputFile}`);
}

function buildReaderHtml(chapters, bookTitle, outputFile, coverColor) {
  const chapNav = chapters.map((c, i) =>
    `<button class="cn" onclick="goChap(${i})" id="cn${i}">${c.num}</button>`
  ).join('');

  const chapSections = chapters.map((c, i) => `
<section class="chap" id="chap${i}" style="display:${i===0?'block':'none'}">
  <div class="chap-hdr" style="background:${coverColor}">
    <div class="chap-badge">${c.num}</div>
    <h1 class="chap-title">${c.title}</h1>
  </div>
  <div class="chap-body">
    ${c.html}
  </div>
</section>`).join('\n');

  const totalChaps = chapters.length;

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>${bookTitle}</title>
<style>
:root{
  --primary:${coverColor};
  --gold:#C5922A;--gold-pale:#FDF6E3;
  --navy:#1B3A6B;
  --cream:#FAFAF7;--border:#E2E8F0;
  --text:#1A1A1A;--muted:#64748B;
}
*{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--cream);color:var(--text);min-height:100vh}

/* TOPBAR */
.topbar{position:fixed;top:0;left:0;right:0;z-index:100;background:var(--primary);color:#fff;height:52px;display:flex;align-items:center;gap:10px;padding:0 14px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.tb-back{background:rgba(255,255,255,.2);border:none;color:#fff;width:34px;height:34px;border-radius:8px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;text-decoration:none}
.tb-back:hover{background:rgba(255,255,255,.3)}
.tb-title{font-size:14px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-progress{font-size:11px;color:rgba(255,255,255,.7);white-space:nowrap}

/* PROGRESS BAR */
.pbar{position:fixed;top:52px;left:0;height:3px;background:var(--gold);z-index:99;transition:width .3s}

/* CHAPTER NAV (scrollable) */
.cnav{position:fixed;top:52px;left:0;right:0;z-index:98;background:#fff;border-bottom:1px solid var(--border);padding:8px 10px;display:flex;gap:5px;overflow-x:auto;scrollbar-width:none}
.cnav::-webkit-scrollbar{display:none}
.cn{flex-shrink:0;background:var(--cream);border:1.5px solid var(--border);color:var(--muted);font-family:inherit;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;cursor:pointer;transition:all .15s}
.cn.active{background:var(--primary);border-color:var(--primary);color:#fff}
.cn:hover:not(.active){border-color:var(--primary);color:var(--primary)}

/* MAIN CONTENT */
.main{margin-top:88px;margin-bottom:72px}
.chap{max-width:680px;margin:0 auto}

/* CHAPTER HEADER */
.chap-hdr{padding:22px 18px 18px;color:#fff}
.chap-badge{display:inline-block;background:rgba(255,255,255,.2);color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:20px;letter-spacing:1px;margin-bottom:6px;text-transform:uppercase}
.chap-title{font-size:20px;font-weight:800;line-height:1.3}

/* BODY TEXT */
.chap-body{padding:18px 18px 8px;background:#fff}
.chap-body p{font-size:15px;line-height:1.85;color:var(--text);margin-bottom:14px;text-align:justify}
.chap-body h1{font-size:18px;font-weight:800;color:var(--navy);margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--gold)}
.chap-body h2{font-size:16px;font-weight:700;color:var(--navy);margin:20px 0 8px}
.chap-body h3{font-size:15px;font-weight:700;color:var(--primary);margin:16px 0 7px}
.chap-body h4{font-size:13.5px;font-weight:700;color:var(--muted);margin:13px 0 6px;text-transform:uppercase;letter-spacing:.4px}
.chap-body ul,.chap-body ol{margin:8px 0 16px;padding-left:0;list-style:none}
.chap-body li{font-size:14.5px;line-height:1.75;color:var(--text);padding:6px 0 6px 24px;position:relative;border-bottom:1px solid var(--border)}
.chap-body li:last-child{border-bottom:none}
.chap-body li::before{content:'▸';position:absolute;left:4px;color:var(--primary);font-size:11px;top:9px}
.chap-body strong{color:var(--navy);font-weight:700}
.chap-body em{color:var(--muted)}
.chap-body table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;overflow-x:auto;display:block}
.chap-body th{background:var(--primary);color:#fff;padding:8px 10px;text-align:left;font-size:12px}
.chap-body td{border:1px solid var(--border);padding:7px 10px;vertical-align:top}
.chap-body tr:nth-child(even) td{background:var(--gold-pale)}

/* BOTTOM NAV */
.bnav{position:fixed;bottom:0;left:0;right:0;z-index:100;background:#fff;border-top:1px solid var(--border);height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;box-shadow:0 -2px 8px rgba(0,0,0,.06)}
.bnav-btn{display:flex;align-items:center;gap:6px;background:none;border:1.5px solid var(--border);color:var(--navy);font-family:inherit;font-size:12.5px;font-weight:700;padding:9px 16px;border-radius:8px;cursor:pointer;transition:all .15s}
.bnav-btn:hover:not(:disabled){background:var(--primary);color:#fff;border-color:var(--primary)}
.bnav-btn:disabled{opacity:.3;cursor:default}
.bnav-count{font-size:12px;color:var(--muted)}

/* DARK MODE */
@media(prefers-color-scheme:dark){
  body{background:#0f172a;color:#e2e8f0}
  .cnav{background:#1e293b;border-color:#334155}
  .cn{background:#1e293b;border-color:#334155;color:#94a3b8}
  .chap-body{background:#1e293b}
  .chap-body p,.chap-body li{color:#e2e8f0}
  .chap-body h1,.chap-body h2,.chap-body strong{color:#93c5fd}
  .chap-body td{border-color:#334155}
  .chap-body tr:nth-child(even) td{background:#273549}
  .bnav{background:#1e293b;border-color:#334155}
  .bnav-btn{border-color:#334155;color:#93c5fd}
}
</style>
</head>
<body>

<div class="topbar">
  <a class="tb-back" href="index.html">←</a>
  <div class="tb-title">${bookTitle}</div>
  <div class="tb-progress" id="progress-text">1 / ${totalChaps}</div>
</div>
<div class="pbar" id="pbar" style="width:${Math.round(100/totalChaps)}%"></div>

<div class="cnav" id="cnav">
  ${chapNav}
</div>

<div class="main">
  ${chapSections}
</div>

<nav class="bnav">
  <button class="bnav-btn" id="btn-prev" onclick="prevChap()" disabled>← Sebelumnya</button>
  <span class="bnav-count" id="chap-count">Bab 1 dari ${totalChaps}</span>
  <button class="bnav-btn" id="btn-next" onclick="nextChap()">Berikutnya →</button>
</nav>

<script>
var current = 0;
var total = ${totalChaps};

function goChap(n) {
  if (n < 0 || n >= total) return;
  document.getElementById('chap' + current).style.display = 'none';
  document.getElementById('cn' + current).classList.remove('active');
  current = n;
  document.getElementById('chap' + current).style.display = 'block';
  document.getElementById('cn' + current).classList.add('active');
  // scroll chapter nav button into view
  var btn = document.getElementById('cn' + current);
  btn.scrollIntoView({behavior:'smooth', block:'nearest', inline:'center'});
  // update progress
  var pct = Math.round((current + 1) / total * 100);
  document.getElementById('pbar').style.width = pct + '%';
  document.getElementById('progress-text').textContent = (current + 1) + ' / ' + total;
  document.getElementById('chap-count').textContent = 'Bab ' + (current + 1) + ' dari ' + total;
  document.getElementById('btn-prev').disabled = current === 0;
  document.getElementById('btn-next').disabled = current === total - 1;
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function prevChap() { goChap(current - 1); }
function nextChap() { goChap(current + 1); }

// Init
document.getElementById('cn0').classList.add('active');
document.getElementById('btn-prev').disabled = true;
if (total <= 1) document.getElementById('btn-next').disabled = true;
</script>
</body>
</html>`;

  fs.writeFileSync(outputFile, html, 'utf8');
}

// ═══════════════════════════════════════
// BOOK DEFINITIONS
// ═══════════════════════════════════════

const BASE = 'G:\\Drive Saya';

// BOOK 1: Teknik Fotografi
const fotoBase = BASE + '\\BUKU\\TEKNIK FOTOGRAFI DENGAN KAMERA HP\\';
convertChapters([
  ['Pembuka', 'Kata Pengantar', fotoBase + '00-Pembuka-Foto-Keren-dari-Genggaman.docx'],
  ['Bab 1',  'Mengenal Kamera HP', fotoBase + 'Bab-1-Mengenal-Kamera-HP.docx'],
  ['Bab 2',  'Cahaya adalah Segalanya', fotoBase + 'Bab-2-Cahaya-adalah-Segalanya.docx'],
  ['Bab 3',  'Komposisi: Roh Sebuah Foto', fotoBase + 'Bab-3-Komposisi-Roh-Sebuah-Foto.docx'],
  ['Bab 4',  'Fokus, Eksposur & Kontrol Manual', fotoBase + 'Bab-4-Fokus-Eksposur-Kontrol-Manual.docx'],
  ['Bab 5',  'Foto Portrait yang Memukau', fotoBase + 'Bab-5-Foto-Portrait-yang-Memukau.docx'],
  ['Bab 6',  'Foto Lanskap dan Arsitektur', fotoBase + 'Bab-6-Foto-Lanskap-dan-Arsitektur.docx'],
  ['Bab 7',  'Foto Makanan dan Produk', fotoBase + 'Bab-7-Foto-Makanan-dan-Produk.docx'],
  ['Bab 8',  'Foto Bergerak', fotoBase + 'Bab-8-Foto-Bergerak.docx'],
  ['Bab 9',  'Editing Foto di HP', fotoBase + 'Bab-9-Editing-Foto-di-HP.docx'],
  ['Bab 10', 'Estetika Feed dan Peluang', fotoBase + 'Bab-10-Estetika-Feed-dan-Peluang.docx'],
  ['Bab 11', 'Tips Khusus Berdasarkan Situasi', fotoBase + 'Bab-11-Tips-Khusus-Berdasarkan-Situasi.docx'],
  ['Bab 12', 'Dari Hobi Menjadi Peluang', fotoBase + 'Bab-12-Dari-Hobi-Menjadi-Peluang.docx'],
  ['Lampiran', 'Lampiran', fotoBase + 'Lampiran-Foto-Keren-dari-Genggaman.docx'],
],
'Teknik Fotografi dengan Kamera HP',
'G:\\Drive Saya\\A MEDIA DAN PERS\\2026\\Aplikasi BMP\\buku-foto.html',
'#1B3A6B');

// BOOK 2: Teknik Sinematografi
const vidBase = BASE + '\\BUKU\\Teknik Sinematografi dengan Kamera HP\\';
convertChapters([
  ['Pembuka', 'Kata Pengantar', vidBase + 'Video-00-Pembuka.docx'],
  ['Bab 1',  'Mengenal Kamera Video HP', vidBase + 'Video-Bab-1-Mengenal-Kamera-Video-HP.docx'],
  ['Bab 2',  'Cahaya untuk Video', vidBase + 'Video-Bab-2-Cahaya-untuk-Video.docx'],
  ['Bab 3',  'Komposisi dan Framing', vidBase + 'Video-Bab-3-Komposisi-dan-Framing.docx'],
  ['Bab 4',  'Gerakan Kamera', vidBase + 'Video-Bab-4-Gerakan-Kamera.docx'],
  ['Bab 5',  'Stabilisasi', vidBase + 'Video-Bab-5-Stabilisasi.docx'],
  ['Bab 6',  'Audio', vidBase + 'Video-Bab-6-Audio.docx'],
  ['Bab 7',  'Shot List dan Bahasa Sinematik', vidBase + 'Video-Bab-7-Shot-List-dan-Bahasa-Sinematik.docx'],
  ['Bab 8',  'Video Portrait dan Wawancara', vidBase + 'Video-Bab-8-Video-Portrait-dan-Wawancara.docx'],
  ['Bab 9',  'Video Bergerak', vidBase + 'Video-Bab-9-Video-Bergerak.docx'],
  ['Bab 10', 'Log Color Profile', vidBase + 'Video-Bab-10-Log-Color-Profile.docx'],
  ['Bab 11', 'Format Konten Platform', vidBase + 'Video-Bab-11-Format-Konten-Platform.docx'],
  ['Bab 12', 'Dari Hobi Menjadi Profesi', vidBase + 'Video-Bab-12-Dari-Hobi-Menjadi-Profesi.docx'],
  ['Lampiran','Lampiran', vidBase + 'Video-Lampiran.docx'],
],
'Teknik Sinematografi dengan Kamera HP',
'G:\\Drive Saya\\A MEDIA DAN PERS\\2026\\Aplikasi BMP\\buku-video.html',
'#0A4D3C');

// BOOK 3: Edit CapCut
const ccBase = BASE + '\\BUKU\\EDIT SEPERTI PRO\\EDIT SEPERTI PRO-CAPCUT\\';
convertChapters([
  ['Bab 1',  'Pengantar Edit Seperti Pro', ccBase + 'EditSepertiPro_1.docx'],
  ['2.1', 'J-Cut & L-Cut', ccBase + 'EditSepertiPro_2-1_JCut_LCut.docx'],
  ['2.2', 'Beat vs Emotion', ccBase + 'EditSepertiPro_2-2_Beat_vs_Emotion.docx'],
  ['2.3', 'Rhythm Editing', ccBase + 'EditSepertiPro_2-3_RhythmEditing.docx'],
  ['2.4', 'Dead Space', ccBase + 'EditSepertiPro_2-4_DeadSpace.docx'],
  ['2.5', 'Jump Cut', ccBase + 'EditSepertiPro_2-5_JumpCut.docx'],
  ['2.6', 'Speed Ramp', ccBase + 'EditSepertiPro_2-6_SpeedRamp.docx'],
  ['3.1', 'Detail', ccBase + 'EditSepertiPro_3_1_Detail.docx'],
  ['3.2', 'Teknik', ccBase + 'EditSepertiPro_3_2.docx'],
  ['3.3', 'Lanjutan', ccBase + 'EditSepertiPro_3_3.docx'],
  ['3.4', 'Teal & Orange', ccBase + 'EditSepertiPro_3-4_TealOrange.docx'],
  ['3.5', 'Mood Grading', ccBase + 'EditSepertiPro_3-5_MoodGrading.docx'],
  ['3.6', 'Skin Tone', ccBase + 'EditSepertiPro_3-6_SkinTone.docx'],
  ['3.7', 'HSL Mastery', ccBase + 'EditSepertiPro_3-7_HSLMastery.docx'],
  ['4.1', 'Noise Reduction', ccBase + 'EditSepertiPro_4-1_NoiseReduction.docx'],
  ['4.2', 'Ducking', ccBase + 'EditSepertiPro_4-2_Ducking.docx'],
  ['4.3', 'Layering Audio', ccBase + 'EditSepertiPro_4-3_LayeringAudio.docx'],
  ['4.4', 'Lip Sync', ccBase + 'EditSepertiPro_4-4_LipSync.docx'],
  ['4.5', 'Desain Suara', ccBase + 'EditSepertiPro_4-5_DesainSuara.docx'],
  ['4.6', 'EQ & Kompressor', ccBase + 'EditSepertiPro_4-6_EQ_Kompressor.docx'],
  ['5.1', 'Color Grading 1', ccBase + 'EditSepertiPro_5_1.docx'],
  ['5.2', 'Color Grading 2', ccBase + 'EditSepertiPro_5_2.docx'],
  ['5.3', 'Color Grading 3', ccBase + 'EditSepertiPro_5_3.docx'],
  ['6.1', 'Cut Langsung', ccBase + 'EditSepertiPro_6-1_CutLangsung.docx'],
  ['6.2', 'Match Cut', ccBase + 'EditSepertiPro_6-2_MatchCut.docx'],
  ['6.3', 'Whip Pan & Zoom', ccBase + 'EditSepertiPro_6-3_WhipPanZoom.docx'],
  ['6.4', 'Objek Transisi', ccBase + 'EditSepertiPro_6-4_ObjekTransisi.docx'],
  ['6.5', 'Signature Transisi', ccBase + 'EditSepertiPro_6-5_SignatureTransisi.docx'],
  ['7.1', 'Green Screen', ccBase + 'EditSepertiPro_7-1_GreenScreen.docx'],
  ['7.2', 'Masking', ccBase + 'EditSepertiPro_7-2_Masking.docx'],
  ['7.3', 'Overlay & Texture', ccBase + 'EditSepertiPro_7-3_OverlayTexture.docx'],
  ['7.4', 'Glitch Effect', ccBase + 'EditSepertiPro_7-4_GlitchEffect.docx'],
  ['7.5', 'Freeze Echo', ccBase + 'EditSepertiPro_7-5_FreezEcho.docx'],
  ['7.6', 'Composite Shot', ccBase + 'EditSepertiPro_7-6_CompositeShot.docx'],
  ['8.1', 'AI Tools 1', ccBase + 'EditSepertiPro_8_1.docx'],
  ['8.2', 'AI Tools 2', ccBase + 'EditSepertiPro_8_2.docx'],
  ['8.3', 'AI Tools 3', ccBase + 'EditSepertiPro_8_3.docx'],
  ['8.4', 'AI Caption', ccBase + 'EditSepertiPro_8-4_AICaption.docx'],
  ['8.5', 'AI TTS', ccBase + 'EditSepertiPro_8-5_AITTS.docx'],
  ['8.6', 'AI Enhancement', ccBase + 'EditSepertiPro_8-6_AIEnhancement.docx'],
  ['9.1', 'Workflow Sistem', ccBase + 'EditSepertiPro_9-1_WorkflowSistem.docx'],
  ['9.2', 'Struktur Cerita', ccBase + 'EditSepertiPro_9-2_StrukturCerita.docx'],
  ['9.3', 'Audio Workflow', ccBase + 'EditSepertiPro_9-3_AudioWorkflow.docx'],
  ['9.4', 'Color Grading Workflow', ccBase + 'EditSepertiPro_9-4_ColorGradingWorkflow.docx'],
  ['9.5', 'Export & QC', ccBase + 'EditSepertiPro_9-5_ExportQC.docx'],
  ['10.1','Suara Visual', ccBase + 'EditSepertiPro_10-1_SuaraVisual.docx'],
  ['10.2','Belajar dari Karya', ccBase + 'EditSepertiPro_10-2_BelajarKarya.docx'],
  ['10.4','Feedback & Kritik', ccBase + 'EditSepertiPro_10-4_FeedbackKritik.docx'],
  ['10.5','Penutup', ccBase + 'EditSepertiPro_10-5_Penutup.docx'],
],
'Edit Seperti Pro — CapCut',
'G:\\Drive Saya\\A MEDIA DAN PERS\\2026\\Aplikasi BMP\\buku-capcut.html',
'#7C3AED');

// BOOK 4: Edit Canva
const cnvBase = BASE + '\\BUKU\\EDIT SEPERTI PRO\\CANVA\\';
convertChapters([
  ['1.1', 'Interface & Fitur Dasar', cnvBase + 'Bab1_Canva_1.1-1.2.docx'],
  ['1.3', 'Template, Elemen & Brand Kit', cnvBase + 'Bab1_Canva_1.3-1.5.docx'],
  ['2.1', 'Prinsip Desain Visual', cnvBase + 'Bab2_Canva_2.1-2.2.docx'],
  ['2.3', 'Tipografi & Palet Warna', cnvBase + 'Bab2_Canva_2.3-2.4.docx'],
  ['2.5', 'Layout Feeds & Stories', cnvBase + 'Bab2_Canva_2.5-2.6.docx'],
  ['3.1', 'Brand Identity Dasar', cnvBase + 'Bab3_Canva_3.1.docx'],
  ['3.2', 'Logo & Konsistensi Visual', cnvBase + 'Bab3_Canva_3.2-3.3.docx'],
  ['3.4', 'Media Kit & Press Materials', cnvBase + 'Bab3_Canva_3.4-3.5.docx'],
  ['3.6', 'Style Guide', cnvBase + 'Bab3_Canva_3.6.docx'],
  ['4.1', 'Infografis & Data Visual', cnvBase + 'Bab4_Canva_4.1-4.2.docx'],
  ['4.3', 'Presentasi & Slide Deck', cnvBase + 'Bab4_Canva_4.3-4.4.docx'],
  ['4.5', 'Desain Print & Digital', cnvBase + 'Bab4_Canva_4.5-4.6.docx'],
  ['4.7', 'Lanjutan', cnvBase + 'Bab4_Canva_4.7.docx'],
  ['5.1', 'Animasi & Video di Canva', cnvBase + 'Bab5_Canva_5.1.docx'],
  ['5.2', 'Animasi Lanjutan', cnvBase + 'Bab5_Canva_5.2-5.3.docx'],
  ['5.4', 'Efek Transisi & Motion', cnvBase + 'Bab5_Canva_5.4-5.5.docx'],
  ['5.6', 'Export', cnvBase + 'Bab5_Canva_5.6.docx'],
  ['7.1', 'Fitur Lanjutan 7.1', cnvBase + 'Bab7_Canva_7.1.docx'],
  ['7.2', 'Fitur Lanjutan 7.2', cnvBase + 'Bab7_Canva_7.2.docx'],
  ['7.3', 'Fitur Lanjutan 7.3', cnvBase + 'Bab7_Canva_7.3.docx'],
  ['7.4', 'Fitur Lanjutan 7.4', cnvBase + 'Bab7_Canva_7.4.docx'],
  ['7.5', 'Fitur Lanjutan 7.5', cnvBase + 'Bab7_Canva_7.5-7.6.docx'],
  ['10.1','Monetisasi', cnvBase + 'Bab10_Canva_10.1.docx'],
  ['10.2','Karir & Freelance', cnvBase + 'Bab10_Canva_10.2.docx'],
  ['10.3','Komunitas & Growth', cnvBase + 'Bab10_Canva_10.3.docx'],
  ['10.6','Penutup', cnvBase + 'Bab10_Canva_10.6_Penutup.docx'],
],
'Edit Seperti Pro — Canva',
'G:\\Drive Saya\\A MEDIA DAN PERS\\2026\\Aplikasi BMP\\buku-canva.html',
'#0369A1');

console.log('\nSelesai! Semua buku telah dikonversi.');
