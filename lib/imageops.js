'use strict';
// 画素の処理（縮小・回転・反転・明度だけの表示・スポイト）。Photoshop に依存しない純粋な関数だけを置く。
const { isPng, decodePng } = require('./png');
const { isJpeg, decodeJpeg } = require('./jpeg');

function sniff(bytes) {
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  if (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53) return 'psd';
  return 'unknown';
}

// 復号せずに縦横だけ読む（一覧に先に出すため）
function probeSize(bytes) {
  const t = sniff(bytes);
  if (t === 'png') {
    const u = (p) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    return { type: t, width: u(16), height: u(20) };
  }
  if (t === 'jpeg') {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const m = bytes[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      const len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: t, height: (bytes[p + 5] << 8) | bytes[p + 6], width: (bytes[p + 7] << 8) | bytes[p + 8] };
      }
      p += 2 + len;
    }
  }
  return { type: t, width: 0, height: 0 };
}

function decodeImage(bytes) {
  const t = sniff(bytes);
  if (t === 'png') return decodePng(bytes);
  if (t === 'jpeg') return decodeJpeg(bytes);
  throw new Error(t === 'unknown' ? 'この形式は読めません' : `${t.toUpperCase()} は直接は読めません（PNG か JPEG にしてください）`);
}

// 長辺を max に収める面積平均の縮小。RGBA → RGBA。
function downscale(img, max) {
  const { width: w, height: h, data } = img;
  const s = Math.max(w, h) / max;
  if (s <= 1) return img;
  const nw = Math.max(1, Math.round(w / s)), nh = Math.max(1, Math.round(h / s));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * w) / nw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let q = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, q += 4) {
          const al = data[q + 3];
          r += data[q] * al; g += data[q + 1] * al; b += data[q + 2] * al; a += al; n++;
        }
      }
      const o = (y * nw + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: nw, height: nh, data: out };
}

// 表示の向き。rot は時計回りの角度（何度でもよい）。flip / flipV は**画面の上での**左右・上下反転（回転の後にかける）。
// 回転の前にかけると、90° 回したときに「左右反転」が上下に効いてしまう（CLIP STUDIO のサブビューは画面の上で返す）。
// 90° の倍数は画素がずれないように別に解く。それ以外は外接する四角に収める（はみ出した隅は背景）。
const normRot = (rot) => ((Math.round(rot || 0) % 360) + 360) % 360;

// 表示上の位置 (fx, fy)（0〜1）から、元画像の位置（0〜1）へ戻す。w, h は元画像の大きさ（90° の倍数なら要らない）。
// 斜めのときは、外接する四角の隅（絵の外）で 0〜1 をはみ出した値が返る。
function viewToSource(fx, fy, rot, flip, flipV = false, w = 1, h = 1) {
  if (flip) fx = 1 - fx;
  if (flipV) fy = 1 - fy;
  const r = normRot(rot);
  switch (r) {
    case 0: return [fx, fy];
    case 90: return [fy, 1 - fx];
    case 180: return [1 - fx, 1 - fy];
    case 270: return [1 - fy, fx];
  }
  const [ow, oh] = orientedSize(w, h, r);
  const t = (r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const X = (fx - 0.5) * ow, Y = (fy - 0.5) * oh;
  return [(X * c + Y * s) / w + 0.5, (-X * s + Y * c) / h + 0.5];
}

// viewToSource の逆（回転したときに、見ていた場所を窓の真ん中に保つため）
function sourceToView(u, v, rot, flip, flipV = false, w = 1, h = 1) {
  const r = normRot(rot);
  let fx, fy;
  switch (r) {
    case 0: fx = u; fy = v; break;
    case 90: fx = 1 - v; fy = u; break;
    case 180: fx = 1 - u; fy = 1 - v; break;
    case 270: fx = v; fy = 1 - u; break;
    default: {
      const [ow, oh] = orientedSize(w, h, r);
      const t = (r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const x = (u - 0.5) * w, y = (v - 0.5) * h;
      fx = (x * c - y * s) / ow + 0.5; fy = (x * s + y * c) / oh + 0.5;
    }
  }
  if (flip) fx = 1 - fx;
  if (flipV) fy = 1 - fy;
  return [fx, fy];
}

// 向きを変えたあとの大きさ（斜めなら外接する四角）
function orientedSize(w, h, rot) {
  const r = normRot(rot);
  if (r % 180 === 0) return [w, h];
  if (r % 90 === 0) return [h, w];
  const t = (r * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  return [w * c + h * s, w * s + h * c];
}

// sRGB → 明度（輝度を保った灰色）。値の確認用。
const LIN = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } return t; })();
function linToSrgb8(y) {
  const c = y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}
const GRAY_LUT = (() => { const t = new Uint8Array(4096); for (let i = 0; i < 4096; i++) t[i] = linToSrgb8(i / 4095); return t; })();

// 調整レイヤー。adj は下から順に [{kind, value, on}]（Photoshop の調整レイヤーと同じく、下のものから先にかける）。
// 項目・幅・考え方は Lightroom の「基本補正」に合わせる（利用者の指定）。消えているもの・0 のものは飛ばす。
// 計算は光の量のまま（リニア）で行い、途中では 1 を超えてもよい（露光量で飛ばしたあとハイライトで戻せるように）。
// 明るさを変える項目は、明るさ（輝度）に曲線をかけ、その比で RGB をそろえて伸び縮みさせる（色味を変えない）。最後に 0〜1 に収める
const ADJ_SPEC = {
  exposure: { name: '露光量', min: -5, max: 5, step: 0.05, digits: 2 },
  contrast: { name: 'コントラスト', min: -100, max: 100, step: 1 },
  highlights: { name: 'ハイライト', min: -100, max: 100, step: 1 },
  shadows: { name: 'シャドウ', min: -100, max: 100, step: 1 },
  whites: { name: '白レベル', min: -100, max: 100, step: 1 },
  blacks: { name: '黒レベル', min: -100, max: 100, step: 1 },
  temp: { name: '色温度', min: -100, max: 100, step: 1 },
  tint: { name: '色かぶり補正', min: -100, max: 100, step: 1 },
  vibrance: { name: '自然な彩度', min: -100, max: 100, step: 1 },
  saturation: { name: '彩度', min: -100, max: 100, step: 1 },
  lightness: { name: '明度', min: -100, max: 100, step: 1, legacy: true }, // 前の版で足したものを読むためだけ
};

function activeAdj(adj) {
  return (Array.isArray(adj) ? adj : []).filter((a) => a && a.on !== false && ADJ_SPEC[a.kind] && Number(a.value)).map((a) => {
    const sp = ADJ_SPEC[a.kind];
    const x = Math.max(sp.min, Math.min(sp.max, Number(a.value)));
    return { kind: a.kind, v: a.kind === 'exposure' ? x : x / 100 };
  });
}

// 明るさの曲線（sRGB の値 p → p'）。p は 1 を超えることがある（露光量で白を超えた所）。
// どれも |k| ≤ 1 で単調（明暗が入れ替わらない）になる幅にしてある
const enc = (y) => (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
const dec = (p) => (p <= 0.04045 ? p / 12.92 : Math.pow((p + 0.055) / 1.055, 2.4));
// ハイライトを下げるときの行き先: 0.45 から上をなめらかに寝かせ、p = 2（白の約 5 倍の光）までを 1 の内側へ収める。
// 0.45 での傾きは 1 なので、つなぎ目に段が付かない（L は c(2) ≈ 1 になる値）
const KNEE = 0.45, KL = 0.6;
const knee = (p) => (p <= KNEE ? p : KNEE + KL * (1 - Math.exp(-(p - KNEE) / KL)));
const TONE = {
  // 真ん中を軸にした S 字。両端（0 と 1）は動かさない。白を超えた所はそのまま
  contrast: (p, k) => (p >= 1 ? p : p + k * (p - 0.5) * (1 - Math.abs(2 * p - 1))),
  // 上げるときは明るい所（0.45〜1）だけをふくらませる。下げるときは寝かせた曲線へ寄せる
  // （露光量で飛ばした所も戻せる。Lightroom のハイライトと同じ使いかた）。中間の灰色（0.5）はほぼ動かない
  highlights: (p, k) => (k < 0 ? p + -k * (knee(p) - p) : p <= KNEE || p >= 1 ? p : p + 0.17 * k * Math.sin((Math.PI * (p - KNEE)) / (1 - KNEE))),
  shadows: (p, k) => (p >= 0.55 ? p : p + 0.17 * k * Math.sin((Math.PI * p) / 0.55)),
  // いちばん明るい所・暗い所の位置を動かす（端ほど強く）。白を超えた所は同じだけずらす（傾きを 1 に保つ）
  whites: (p, k) => (p <= 0.5 ? p : p >= 1 ? p + 0.25 * k : p + 0.25 * k * ((p - 0.5) / 0.5) ** 2),
  blacks: (p, k) => (p >= 0.5 ? p : p + 0.25 * k * ((0.5 - p) / 0.5) ** 2),
};
// 明るさ（リニア）→ 曲線をかけた明るさ（リニア）の表。画素ごとに pow を呼ばないため。
// 0〜TONE_MAX（白の約 5 倍）を、暗い所ほど細かく刻む（平方根の目盛り。等間隔だと暗部に段が出る）
const TONE_N = 4096, TONE_MAX = 5;
function toneLut(kind, k) {
  const t = new Float32Array(TONE_N + 1);
  for (let i = 0; i <= TONE_N; i++) {
    const y = (i / TONE_N) ** 2 * TONE_MAX;
    const p2 = TONE[kind](enc(y), k);
    t[i] = p2 <= 0 ? 0 : dec(p2);
  }
  return t;
}
function toneAt(lut, y) {
  const x = Math.sqrt(Math.min(TONE_MAX, y) / TONE_MAX) * TONE_N;
  const i = Math.min(TONE_N - 1, Math.floor(x)), f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

function adjustRGB(data, ops, gray) {
  const prep = ops.map((op) => (TONE[op.kind] ? { ...op, lut: toneLut(op.kind, op.v) } : op));
  for (let i = 0, n = data.length; i < n; i += 3) {
    let r = LIN[data[i]], g = LIN[data[i + 1]], b = LIN[data[i + 2]];
    for (const op of prep) {
      const v = op.v;
      if (op.lut) {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const Y2 = toneAt(op.lut, Y);
        if (Y > 1e-6) { const m = Y2 / Y; r *= m; g *= m; b *= m; } else { r = g = b = Y2; }
      } else if (op.kind === 'exposure') {
        const m = Math.pow(2, v); r *= m; g *= m; b *= m;
      } else if (op.kind === 'temp') {
        // + で黄（暖かく）、- で青。赤と青を逆向きに最大 ±0.4 段
        r *= Math.pow(2, 0.4 * v); b *= Math.pow(2, -0.4 * v);
      } else if (op.kind === 'tint') {
        // + でマゼンタ、- で緑
        g *= Math.pow(2, -0.4 * v);
      } else if (op.kind === 'saturation' || op.kind === 'vibrance') {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let k = 1 + v;
        if (op.kind === 'vibrance') {
          // くすんだ色ほど強く効かせ、もう鮮やかな色はあまり動かさない
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const sat = mx > 0 ? (mx - mn) / mx : 0;
          k = 1 + v * (1 - sat);
        }
        r = Y + (r - Y) * k; g = Y + (g - Y) * k; b = Y + (b - Y) * k;
      } else if (op.kind === 'lightness') {
        if (v > 0) { r += (1 - Math.min(1, r)) * v; g += (1 - Math.min(1, g)) * v; b += (1 - Math.min(1, b)) * v; }
        else { r *= 1 + v; g *= 1 + v; b *= 1 + v; }
      }
      if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
    }
    if (gray) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = g = b = Math.min(1, y);
    }
    data[i] = GRAY_LUT[Math.round(Math.min(1, r) * 4095)];
    data[i + 1] = GRAY_LUT[Math.round(Math.min(1, g) * 4095)];
    data[i + 2] = GRAY_LUT[Math.round(Math.min(1, b) * 4095)];
  }
  return data;
}

// 表示用の RGB を作る。向きを変え、透明部分は bg に合成し、調整レイヤーをかけ、gray なら明度だけにする。
// 白黒は調整の後（調整した見え方の明暗を確かめるため）
function renderRGB(img, opts = {}) {
  const ops = activeAdj(opts.adj);
  if (!ops.length) return renderBase(img, opts);
  const out = renderBase(img, { ...opts, gray: false });
  adjustRGB(out.data, ops, !!opts.gray);
  return out;
}

function renderBase(img, { rot = 0, flip = false, flipV = false, gray = false, bg = [128, 128, 128] } = {}) {
  const { width: w, height: h, data } = img;
  const r0 = normRot(rot);
  if (r0 % 90 !== 0) return renderSkew(img, { rot: r0, flip, flipV, gray, bg });
  const [ow, oh] = orientedSize(w, h, r0);
  const out = new Uint8Array(ow * oh * 3);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      // 出力の画素中心 → 元の画素（反転は画面の上なので、先に出力側で返す）
      const px = flip ? ow - 1 - ox : ox, py = flipV ? oh - 1 - oy : oy;
      let sx, sy;
      switch (r0) {
        case 90: sx = py; sy = h - 1 - px; break;
        case 180: sx = w - 1 - px; sy = h - 1 - py; break;
        case 270: sx = w - 1 - py; sy = px; break;
        default: sx = px; sy = py;
      }
      const q = (sy * w + sx) * 4;
      const a = data[q + 3];
      let r = data[q], g = data[q + 1], b = data[q + 2];
      if (a < 255) {
        r = Math.round((r * a + bg[0] * (255 - a)) / 255);
        g = Math.round((g * a + bg[1] * (255 - a)) / 255);
        b = Math.round((b * a + bg[2] * (255 - a)) / 255);
      }
      const o = (oy * ow + ox) * 3;
      if (gray) {
        const y = 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
        r = g = b = GRAY_LUT[Math.min(4095, Math.round(y * 4095))];
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return { width: ow, height: oh, data: out };
}

// 斜めの角度。外接する四角に描き、近くの 4 画素を混ぜる（そのまま拾うと線がギザギザになる）。
// 透明度で重みを付けて混ぜる（付けないと、透けた縁の色が黒っぽくにじむ）。絵の外は背景の色
function renderSkew(img, { rot, flip, flipV, gray, bg }) {
  const { width: w, height: h, data } = img;
  const [fw, fh] = orientedSize(w, h, rot);
  const ow = Math.max(1, Math.round(fw)), oh = Math.max(1, Math.round(fh));
  const out = new Uint8Array(ow * oh * 3);
  const t = (rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      const X = (flip ? ow - 1 - ox : ox) + 0.5 - ow / 2, Y = (flipV ? oh - 1 - oy : oy) + 0.5 - oh / 2;
      const sx = X * c + Y * s + w / 2 - 0.5, sy = -X * s + Y * c + h / 2 - 0.5;
      let r = bg[0], g = bg[1], b = bg[2];
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 >= -1 && y0 >= -1 && x0 < w && y0 < h) {
        const ax = sx - x0, ay = sy - y0;
        let R = 0, G = 0, B = 0, A = 0;
        for (let k = 0; k < 4; k++) {
          const xx = x0 + (k & 1), yy = y0 + (k >> 1);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = (yy * w + xx) * 4;
          const wt = ((k & 1) ? ax : 1 - ax) * ((k >> 1) ? ay : 1 - ay) * data[q + 3];
          R += data[q] * wt; G += data[q + 1] * wt; B += data[q + 2] * wt; A += wt;
        }
        // A は 0〜255。外へ出かかった縁と透けた画素は、その分だけ背景を混ぜる
        if (A > 0) {
          const k = A / 255;
          r = Math.round(R / A * k + bg[0] * (1 - k));
          g = Math.round(G / A * k + bg[1] * (1 - k));
          b = Math.round(B / A * k + bg[2] * (1 - k));
        }
      }
      if (gray) {
        const y = 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
        r = g = b = GRAY_LUT[Math.min(4095, Math.round(y * 4095))];
      }
      const o = (oy * ow + ox) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return { width: ow, height: oh, data: out };
}

// スポイト。(u, v) は元画像上の 0〜1。radius は平均を取る半径（0 で 1 画素）。
// 透明な画素は数えない（全部透明なら null）。
function sampleColor(img, u, v, radius = 0) {
  const { width: w, height: h, data } = img;
  const cx = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
  const cy = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const q = (y * w + x) * 4;
      const a = data[q + 3];
      if (a === 0) continue;
      r += data[q] * a; g += data[q + 1] * a; b += data[q + 2] * a; n += a;
    }
  }
  if (!n) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function toHex([r, g, b]) {
  return [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// 明度（L*, 0〜100）。色を拾ったときに値の目安として出す。
function lightness([r, g, b]) {
  const y = 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
  const f = y > 216 / 24389 ? Math.cbrt(y) : (24389 / 27 * y + 16) / 116;
  return Math.round(116 * f - 16);
}

// UXP には btoa が無い環境があるので自前で持つ。
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  const parts = [];
  const CH = 0x3000 * 3; // 1 回の文字列連結を小さく保つ
  for (let s = 0; s < bytes.length; s += CH) {
    const e = Math.min(bytes.length, s + CH);
    let str = '';
    let i = s;
    for (; i + 2 < e; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      str += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < e) {
      const n = (bytes[i] << 16) | ((i + 1 < e ? bytes[i + 1] : 0) << 8);
      str += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < e ? B64[(n >> 6) & 63] : '=') + '=';
    }
    parts.push(str);
  }
  return parts.join('');
}

module.exports = { ADJ_SPEC, activeAdj, adjustRGB, sniff, probeSize, decodeImage, downscale, viewToSource, sourceToView, orientedSize, normRot, renderRGB, sampleColor, toHex, lightness, base64 };
