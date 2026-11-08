'use strict';
// JPEG の復号（ベースライン・プログレッシブ、グレー／YCbCr／RGB／CMYK／YCCK）。RGBA 8bit を返す。
// UXP の canvas は画素を読めないため、スポイトのために自前で復号する。

const ZZ = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]);

// 逆 DCT 用の係数表 COS[x*8+u] = C(u)/2 * cos((2x+1)uπ/16)
const COS = (() => {
  const t = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      t[x * 8 + u] = (cu / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return t;
})();

function isJpeg(b) { return b[0] === 0xff && b[1] === 0xd8; }

function buildHuffman(counts, symbols) {
  // 正準符号: 長さごとの最大符号と値の位置
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1];
    k += counts[l - 1];
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  // 8 ビットの先読み表（短い符号を一度で引く）
  const look = new Int32Array(256).fill(-1);
  code = 0; k = 0;
  for (let l = 1; l <= 8; l++) {
    for (let i = 0; i < counts[l - 1]; i++, k++, code++) {
      const shift = 8 - l;
      for (let j = 0; j < 1 << shift; j++) look[(code << shift) | j] = (symbols[k] << 4) | l;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, symbols, look };
}

function decodeJpeg(bytes) {
  if (!isJpeg(bytes)) throw new Error('JPEG ではありません');
  const qt = [];
  const hdc = [], hac = [];
  let frame = null, progressive = false, restart = 0;
  let adobe = null, jfif = false;
  let p = 2;

  const u16 = () => { const v = (bytes[p] << 8) | bytes[p + 1]; p += 2; return v; };

  // ---- ビット読み ----
  let bitbuf = 0, bitcnt = 0, hitMarker = false;
  const resetBits = () => { bitbuf = 0; bitcnt = 0; hitMarker = false; };
  const fill = () => {
    while (bitcnt <= 24) {
      let b = 0;
      if (!hitMarker && p < bytes.length) {
        b = bytes[p];
        if (b === 0xff) {
          const n = bytes[p + 1];
          if (n === 0) p += 2;
          else { hitMarker = true; b = 0; }
        } else p++;
      }
      bitbuf = (bitbuf << 8) | b;
      bitcnt += 8;
    }
  };
  const bit = () => {
    if (bitcnt === 0) fill();
    bitcnt--;
    return (bitbuf >>> bitcnt) & 1;
  };
  const receive = (n) => {
    if (n === 0) return 0;
    if (bitcnt < n) fill();
    bitcnt -= n;
    return (bitbuf >>> bitcnt) & ((1 << n) - 1);
  };
  const extend = (v, n) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decodeH = (t) => {
    if (bitcnt < 16) fill();
    const v = t.look[(bitbuf >>> (bitcnt - 8)) & 255];
    if (v >= 0) { bitcnt -= v & 15; return v >> 4; }
    let code = (bitbuf >>> (bitcnt - 8)) & 255;
    bitcnt -= 8;
    for (let l = 9; l <= 16; l++) {
      code = (code << 1) | ((bitbuf >>> --bitcnt) & 1);
      if (code <= t.maxcode[l]) return t.symbols[t.valptr[l] + code - t.mincode[l]];
    }
    throw new Error('JPEG: 不正なハフマン符号');
  };

  // ---- 走査（スキャン）の復号 ----
  function decodeScan(comps, ss, se, ah, al) {
    let eobrun = 0;
    const single = comps.length === 1;

    const decodeBaseline = (c, blk) => {
      const t = decodeH(c.dcTable);
      c.pred += extend(receive(t), t);
      blk[0] = c.pred;
      for (let k = 1; k < 64;) {
        const rs = decodeH(c.acTable);
        const s = rs & 15, r = rs >> 4;
        if (s === 0) { if (r < 15) break; k += 16; continue; }
        k += r;
        if (k > 63) break;
        blk[ZZ[k]] = extend(receive(s), s);
        k++;
      }
    };
    const dcFirst = (c, blk) => {
      const t = decodeH(c.dcTable);
      c.pred += extend(receive(t), t);
      blk[0] = c.pred * (1 << al);
    };
    const dcRefine = (c, blk) => { if (bit()) blk[0] |= 1 << al; };
    const acFirst = (c, blk) => {
      if (eobrun > 0) { eobrun--; return; }
      for (let k = ss; k <= se; k++) {
        const rs = decodeH(c.acTable);
        const s = rs & 15, r = rs >> 4;
        if (s) {
          k += r;
          if (k > 63) break;
          blk[ZZ[k]] = extend(receive(s), s) * (1 << al);
        } else if (r === 15) k += 15;
        else {
          eobrun = (1 << r) - 1;
          if (r) eobrun += receive(r);
          break;
        }
      }
    };
    const acRefine = (c, blk) => {
      const p1 = 1 << al, m1 = -1 << al;
      let k = ss;
      if (eobrun <= 0) {
        for (; k <= se; k++) {
          const rs = decodeH(c.acTable);
          let r = rs >> 4, s = rs & 15;
          if (s) s = bit() ? p1 : m1;
          else if (r !== 15) {
            eobrun = 1 << r;
            if (r) eobrun += receive(r);
            break;
          }
          while (k <= se) {
            const z = ZZ[k];
            if (blk[z] !== 0) {
              if (bit() && (blk[z] & p1) === 0) blk[z] += blk[z] >= 0 ? p1 : m1;
            } else {
              if (--r < 0) break;
            }
            k++;
          }
          if (s && k <= 63) blk[ZZ[k]] = s;
        }
      }
      if (eobrun > 0) {
        for (; k <= se; k++) {
          const z = ZZ[k];
          if (blk[z] !== 0 && bit() && (blk[z] & p1) === 0) blk[z] += blk[z] >= 0 ? p1 : m1;
        }
        eobrun--;
      }
    };

    let fn;
    if (!progressive) fn = decodeBaseline;
    else if (ss === 0) fn = ah === 0 ? dcFirst : dcRefine;
    else fn = ah === 0 ? acFirst : acRefine;

    const blockAt = (c, row, col) => c.coef.subarray((row * c.bpl + col) * 64, (row * c.bpl + col + 1) * 64);

    let total, mcusPerLine;
    if (single) {
      const c = comps[0];
      mcusPerLine = Math.ceil(c.compW / 8);
      total = mcusPerLine * Math.ceil(c.compH / 8);
    } else {
      mcusPerLine = frame.mcuX;
      total = frame.mcuX * frame.mcuY;
    }

    comps.forEach((c) => { c.pred = 0; });
    resetBits();
    for (let m = 0; m < total; m++) {
      if (restart && m > 0 && m % restart === 0) {
        // 再開マーカー: 境界を捨てて RSTn を飛ばし、予測値を初期化
        resetBits();
        while (p < bytes.length - 1 && !(bytes[p] === 0xff && bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7)) p++;
        p += 2;
        comps.forEach((c) => { c.pred = 0; });
        eobrun = 0;
      }
      if (single) {
        const c = comps[0];
        fn(c, blockAt(c, (m / mcusPerLine) | 0, m % mcusPerLine));
      } else {
        const my = (m / mcusPerLine) | 0, mx = m % mcusPerLine;
        for (const c of comps) {
          for (let v = 0; v < c.v; v++) {
            for (let h = 0; h < c.h; h++) fn(c, blockAt(c, my * c.v + v, mx * c.h + h));
          }
        }
      }
    }
    // 次のマーカーまで進める
    while (p < bytes.length - 1 && !(bytes[p] === 0xff && bytes[p + 1] !== 0 && !(bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7))) p++;
  }

  // ---- マーカーの読み取り ----
  while (p < bytes.length) {
    if (bytes[p] !== 0xff) { p++; continue; }
    const m = bytes[p + 1];
    p += 2;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { if (m === 0xff) p--; continue; }
    if (m === 0xd9) break;
    const len = u16();
    const end = p + len - 2;
    if (m === 0xdb) { // DQT
      while (p < end) {
        const pq = bytes[p] >> 4, tq = bytes[p] & 15;
        p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) t[ZZ[i]] = pq ? u16() : bytes[p++];
        qt[tq] = t;
      }
    } else if (m === 0xc4) { // DHT
      while (p < end) {
        const tc = bytes[p] >> 4, th = bytes[p] & 15;
        p++;
        const counts = bytes.subarray(p, p + 16);
        p += 16;
        let n = 0;
        for (let i = 0; i < 16; i++) n += counts[i];
        const syms = bytes.slice(p, p + n);
        p += n;
        (tc === 0 ? hdc : hac)[th] = buildHuffman(counts, syms);
      }
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) { // SOF
      progressive = m === 0xc2;
      p++; // 精度
      const height = u16(), width = u16();
      const n = bytes[p++];
      const comps = [];
      for (let i = 0; i < n; i++) {
        comps.push({ id: bytes[p], h: bytes[p + 1] >> 4, v: bytes[p + 1] & 15, tq: bytes[p + 2] });
        p += 3;
      }
      const maxH = Math.max(...comps.map((c) => c.h)), maxV = Math.max(...comps.map((c) => c.v));
      const mcuX = Math.ceil(width / (8 * maxH)), mcuY = Math.ceil(height / (8 * maxV));
      for (const c of comps) {
        c.compW = Math.ceil((width * c.h) / maxH);
        c.compH = Math.ceil((height * c.v) / maxV);
        c.bpl = mcuX * c.h;
        c.bpc = mcuY * c.v;
        c.coef = new Int16Array(c.bpl * c.bpc * 64);
      }
      frame = { width, height, comps, maxH, maxV, mcuX, mcuY };
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('JPEG: 未対応の形式（可逆・算術符号）');
    } else if (m === 0xdd) { // DRI
      restart = u16();
    } else if (m === 0xee) { // APP14 Adobe
      if (bytes[p] === 0x41 && bytes[p + 1] === 0x64 && bytes[p + 2] === 0x6f && bytes[p + 3] === 0x62) adobe = { transform: bytes[p + 11] };
    } else if (m === 0xe0) {
      if (bytes[p] === 0x4a && bytes[p + 1] === 0x46 && bytes[p + 2] === 0x49 && bytes[p + 3] === 0x46) jfif = true;
    } else if (m === 0xda) { // SOS
      if (!frame) throw new Error('JPEG: SOF より前に SOS');
      const n = bytes[p++];
      const comps = [];
      for (let i = 0; i < n; i++) {
        const c = frame.comps.find((x) => x.id === bytes[p]);
        c.dcTable = hdc[bytes[p + 1] >> 4];
        c.acTable = hac[bytes[p + 1] & 15];
        comps.push(c);
        p += 2;
      }
      const ss = bytes[p], se = bytes[p + 1], ah = bytes[p + 2] >> 4, al = bytes[p + 2] & 15;
      p += 3;
      decodeScan(comps, ss, se, ah, al);
      continue;
    }
    p = end;
  }
  if (!frame) throw new Error('JPEG: 画像の情報がありません');

  // ---- 逆量子化・逆 DCT して各成分の面を作る ----
  const planes = frame.comps.map((c) => {
    const q = qt[c.tq];
    const pw = c.bpl * 8;
    const plane = new Uint8Array(pw * c.bpc * 8);
    const tmp = new Float32Array(64);
    const blk = new Float32Array(64);
    for (let by = 0; by < c.bpc; by++) {
      for (let bx = 0; bx < c.bpl; bx++) {
        const off = (by * c.bpl + bx) * 64;
        let ac = false;
        for (let i = 0; i < 64; i++) { const v = c.coef[off + i]; blk[i] = v * q[i]; if (i && v) ac = true; }
        if (!ac) {
          // 交流成分が無いブロックは一色で埋める（平坦な部分が多い資料で効く）
          let r = Math.round(blk[0] / 8 + 128);
          r = r < 0 ? 0 : r > 255 ? 255 : r;
          for (let y = 0; y < 8; y++) plane.fill(r, (by * 8 + y) * pw + bx * 8, (by * 8 + y) * pw + bx * 8 + 8);
          continue;
        }
        // 行方向
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            let s = 0;
            for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * blk[y * 8 + u];
            tmp[y * 8 + x] = s;
          }
        }
        // 列方向
        for (let x = 0; x < 8; x++) {
          for (let y = 0; y < 8; y++) {
            let s = 0;
            for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
            let r = Math.round(s + 128);
            plane[(by * 8 + y) * pw + bx * 8 + x] = r < 0 ? 0 : r > 255 ? 255 : r;
          }
        }
      }
    }
    return { plane, pw };
  });

  // ---- 色変換 ----
  const { width, height, comps, maxH, maxV } = frame;
  const out = new Uint8Array(width * height * 4);
  const nc = comps.length;
  const transform = adobe ? adobe.transform : nc === 3 ? (jfif || !(comps[0].id === 82 && comps[1].id === 71) ? 1 : 0) : 0;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const sample = new Array(nc);
  const sx = comps.map((c) => c.h / maxH), sy = comps.map((c) => c.v / maxV);
  // 間引かれた成分は画素中心をそろえて線形補間で戻す（libjpeg の fancy upsampling 相当）
  const full = comps.map((c) => c.h === maxH && c.v === maxV);
  const cw = comps.map((c) => c.compW), chh = comps.map((c) => c.compH);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let i = 0; i < nc; i++) {
        const pl = planes[i];
        if (full[i]) { sample[i] = pl.plane[y * pl.pw + x]; continue; }
        let fx = (x + 0.5) * sx[i] - 0.5, fy = (y + 0.5) * sy[i] - 0.5;
        if (fx < 0) fx = 0; if (fy < 0) fy = 0;
        let x0 = fx | 0, y0 = fy | 0;
        const x1 = Math.min(x0 + 1, cw[i] - 1), y1 = Math.min(y0 + 1, chh[i] - 1);
        const ax = fx - x0, ay = fy - y0;
        const P = pl.plane, W = pl.pw;
        const top = P[y0 * W + x0] * (1 - ax) + P[y0 * W + x1] * ax;
        const bot = P[y1 * W + x0] * (1 - ax) + P[y1 * W + x1] * ax;
        sample[i] = top * (1 - ay) + bot * ay;
      }
      const q = (y * width + x) * 4;
      let r, g, b;
      if (nc === 1) { r = g = b = sample[0]; }
      else if (nc === 3) {
        if (transform) {
          const Y = sample[0], cb = sample[1] - 128, cr = sample[2] - 128;
          r = clamp(Math.round(Y + 1.402 * cr));
          g = clamp(Math.round(Y - 0.344136 * cb - 0.714136 * cr));
          b = clamp(Math.round(Y + 1.772 * cb));
        } else { r = sample[0]; g = sample[1]; b = sample[2]; }
      } else {
        // CMYK（Adobe は値を反転して書く）
        let c0 = sample[0], c1 = sample[1], c2 = sample[2];
        const k = sample[3];
        if (transform === 2) {
          const Y = c0, cb = c1 - 128, cr = c2 - 128;
          c0 = clamp(Math.round(Y + 1.402 * cr));
          c1 = clamp(Math.round(Y - 0.344136 * cb - 0.714136 * cr));
          c2 = clamp(Math.round(Y + 1.772 * cb));
        }
        if (adobe) { r = Math.round((c0 * k) / 255); g = Math.round((c1 * k) / 255); b = Math.round((c2 * k) / 255); }
        else { r = Math.round(((255 - c0) * (255 - k)) / 255); g = Math.round(((255 - c1) * (255 - k)) / 255); b = Math.round(((255 - c2) * (255 - k)) / 255); }
      }
      out[q] = r; out[q + 1] = g; out[q + 2] = b; out[q + 3] = 255;
    }
  }
  return { width, height, data: out };
}

module.exports = { isJpeg, decodeJpeg };
