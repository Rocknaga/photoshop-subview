'use strict';
// PNG の読み書き。読みは全色形式・全ビット深度・Adam7 に対応し、RGBA 8bit に揃える。
// 書きは表示用（RGB 8bit）。UXP に deflate が無いので無圧縮ブロックで出す。
const { inflateZlib } = require('./inflate');

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(b) {
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;
  return true;
}

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error('PNG ではありません');
  let p = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  let idatLen = 0;
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const d = bytes.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') {
      w = u32(d, 0); h = u32(d, 4); depth = d[8]; ctype = d[9]; interlace = d[12];
    } else if (type === 'PLTE') palette = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') { idat.push(d); idatLen += d.length; }
    else if (type === 'IEND') break;
  }
  if (!w || !h) throw new Error('PNG: IHDR がありません');
  const z = new Uint8Array(idatLen);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }

  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans) throw new Error('PNG: 未知の色形式 ' + ctype);
  const bpp = Math.max(1, (chans * depth) >> 3); // フィルタ用のバイト数
  const rowBytes = (pw) => Math.ceil((pw * chans * depth) / 8);

  // 期待する伸長後の大きさ
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let total = 0;
  const dims = passes.map(([x0, y0, dx, dy]) => {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw > 0 && ph > 0) total += ph * (1 + rowBytes(pw));
    return [pw, ph];
  });
  const raw = inflateZlib(z, total);

  const out = new Uint8Array(w * h * 4);
  const maxv = (1 << depth) - 1;
  let tGray = -1, tR = -1, tG = -1, tB = -1;
  if (trns && ctype === 0) tGray = (trns[0] << 8) | trns[1];
  if (trns && ctype === 2) { tR = (trns[0] << 8) | trns[1]; tG = (trns[2] << 8) | trns[3]; tB = (trns[4] << 8) | trns[5]; }

  let rp = 0;
  passes.forEach(([x0, y0, dx, dy], pi) => {
    const [pw, ph] = dims[pi];
    if (pw <= 0 || ph <= 0) return;
    const rb = rowBytes(pw);
    let prev = new Uint8Array(rb);
    let cur = new Uint8Array(rb);
    for (let y = 0; y < ph; y++) {
      const ft = raw[rp++];
      for (let i = 0; i < rb; i++) {
        const x = raw[rp++];
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        switch (ft) {
          case 0: v = x; break;
          case 1: v = x + a; break;
          case 2: v = x + b; break;
          case 3: v = x + ((a + b) >> 1); break;
          case 4: {
            const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
            v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: throw new Error('PNG: 未知のフィルタ ' + ft);
        }
        cur[i] = v & 255;
      }
      // 1 行を画素に展開
      const oy = y0 + y * dy;
      if (depth === 8 && (ctype === 6 || (ctype === 2 && !trns))) {
        // よくある形式は速い道を通す
        for (let xi = 0, si = 0; xi < pw; xi++) {
          const q = (oy * w + x0 + xi * dx) * 4;
          out[q] = cur[si++]; out[q + 1] = cur[si++]; out[q + 2] = cur[si++];
          out[q + 3] = ctype === 6 ? cur[si++] : 255;
        }
        const t = prev; prev = cur; cur = t;
        continue;
      }
      for (let xi = 0; xi < pw; xi++) {
        const ox = x0 + xi * dx;
        const q = (oy * w + ox) * 4;
        const s = (k) => { // k 番目のサンプル（元の値）
          if (depth === 8) return cur[xi * chans + k];
          if (depth === 16) { const j = (xi * chans + k) * 2; return (cur[j] << 8) | cur[j + 1]; }
          const bit = (xi * chans + k) * depth;
          return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
        };
        const to8 = (v) => depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxv);
        let r, g, bl, al = 255;
        if (ctype === 0) { const v = s(0); r = g = bl = to8(v); if (v === tGray) al = 0; }
        else if (ctype === 2) {
          const R = s(0), G = s(1), B = s(2);
          r = to8(R); g = to8(G); bl = to8(B);
          if (R === tR && G === tG && B === tB) al = 0;
        } else if (ctype === 3) {
          const ix = s(0);
          r = palette ? palette[ix * 3] : 0; g = palette ? palette[ix * 3 + 1] : 0; bl = palette ? palette[ix * 3 + 2] : 0;
          if (trns && ix < trns.length) al = trns[ix];
        } else if (ctype === 4) { r = g = bl = to8(s(0)); al = to8(s(1)); }
        else { r = to8(s(0)); g = to8(s(1)); bl = to8(s(2)); al = to8(s(3)); }
        out[q] = r; out[q + 1] = g; out[q + 2] = bl; out[q + 3] = al;
      }
      const t = prev; prev = cur; cur = t;
    }
  });
  return { width: w, height: h, data: out };
}

// ---- 書き出し（RGB 8bit・無圧縮 deflate）----

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// rgb: Uint8Array（w*h*3）
function encodePngRGB(rgb, w, h) {
  const rowLen = w * 3 + 1;
  const rawLen = rowLen * h;
  const nBlocks = Math.max(1, Math.ceil(rawLen / 65535));
  const zLen = 2 + rawLen + nBlocks * 5 + 4;
  const total = 8 + (12 + 13) + (12 + zLen) + 12;
  const out = new Uint8Array(total);
  let p = 0;
  const w32 = (v) => { out[p++] = (v >>> 24) & 255; out[p++] = (v >>> 16) & 255; out[p++] = (v >>> 8) & 255; out[p++] = v & 255; };
  const chunk = (type, writeBody, len) => {
    w32(len);
    const s = p;
    for (let i = 0; i < 4; i++) out[p++] = type.charCodeAt(i);
    writeBody();
    w32(crc32(out, s, p));
  };
  SIG.forEach((b) => { out[p++] = b; });
  chunk('IHDR', () => { w32(w); w32(h); out[p++] = 8; out[p++] = 2; out[p++] = 0; out[p++] = 0; out[p++] = 0; }, 13);
  chunk('IDAT', () => {
    out[p++] = 0x78; out[p++] = 0x01;
    let a = 1, b = 0; // adler32
    let remain = rawLen, row = 0, col = 0; // col: 行内の位置（0 はフィルタ種別のバイト）
    while (remain > 0) {
      const n = Math.min(65535, remain);
      remain -= n;
      out[p++] = remain === 0 ? 1 : 0;
      out[p++] = n & 255; out[p++] = n >> 8;
      out[p++] = ~n & 255; out[p++] = (~n >> 8) & 255;
      for (let i = 0; i < n; i++) {
        const v = col === 0 ? 0 : rgb[row * w * 3 + col - 1];
        out[p++] = v;
        a += v; if (a >= 65521) a -= 65521;
        b += a; if (b >= 65521) b -= 65521;
        if (++col === rowLen) { col = 0; row++; }
      }
    }
    w32(((b << 16) | a) >>> 0);
  }, zLen);
  chunk('IEND', () => {}, 0);
  return out;
}

module.exports = { isPng, decodePng, encodePngRGB, crc32 };
