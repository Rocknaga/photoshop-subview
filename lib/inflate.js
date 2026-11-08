'use strict';
// zlib / DEFLATE の伸長（RFC 1950 / 1951）。UXP には zlib が無いので自前で持つ。
// 表引き方式: 符号長の最大 15 ビットぶんの表を作り、1 回の参照で記号と長さを得る。

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// 符号長の並びから表を作る。表の要素は (記号 << 4) | 長さ。
function buildTable(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  if (maxLen === 0) maxLen = 1;
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  const size = 1 << maxLen;
  const table = new Int32Array(size).fill(-1);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let c = next[len]++;
    // ビット順を反転（DEFLATE は LSB から読む）
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    const v = (sym << 4) | len;
    for (let i = r; i < size; i += 1 << len) table[i] = v;
  }
  return { table, bits: maxLen, mask: size - 1 };
}

let FIXED_LIT = null, FIXED_DIST = null;
function fixedTables() {
  if (!FIXED_LIT) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_LIT = buildTable(l);
    FIXED_DIST = buildTable(new Uint8Array(30).fill(5));
  }
  return [FIXED_LIT, FIXED_DIST];
}

// data: Uint8Array（生の DEFLATE 列）。sizeHint があれば出力をその大きさで確保する。
function inflateRaw(data, sizeHint) {
  let out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(1024, data.length * 4));
  let op = 0;
  let ip = 0, bitbuf = 0, bitcnt = 0;

  const need = (n) => {
    while (bitcnt < n) {
      const b = ip < data.length ? data[ip] : 0;
      ip++;
      bitbuf |= b << bitcnt;
      bitcnt += 8;
    }
  };
  const bits = (n) => {
    if (n === 0) return 0;
    need(n);
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const sym = (t) => {
    need(t.bits);
    const v = t.table[bitbuf & t.mask];
    if (v < 0) throw new Error('inflate: 不正な符号');
    const len = v & 15;
    bitbuf >>>= len; bitcnt -= len;
    return v >> 4;
  };
  const grow = (n) => {
    if (op + n <= out.length) return;
    let sz = out.length * 2;
    while (sz < op + n) sz *= 2;
    const o = new Uint8Array(sz); o.set(out.subarray(0, op)); out = o;
  };

  let last = 0;
  while (!last) {
    if (ip > data.length + 4) throw new Error('inflate: データが途中で終わっています');
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      ip -= bitcnt >> 3; // 先読みしすぎた丸ごとのバイトを返してからバイト境界へ
      bitbuf = 0; bitcnt = 0;
      const len = data[ip] | (data[ip + 1] << 8);
      ip += 4;
      grow(len);
      out.set(data.subarray(ip, ip + len), op);
      ip += len; op += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      [lit, dist] = fixedTables();
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clt = buildTable(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const s = sym(clt);
        if (s < 16) lens[i++] = s;
        else if (s === 16) { const p = lens[i - 1]; let r = 3 + bits(2); while (r--) lens[i++] = p; }
        else if (s === 17) { i += 3 + bits(3); }
        else { i += 11 + bits(7); }
      }
      lit = buildTable(lens.subarray(0, hlit));
      dist = buildTable(lens.subarray(hlit));
    } else {
      throw new Error('inflate: 未知のブロック種別');
    }
    for (;;) {
      const s = sym(lit);
      if (s < 256) { if (op >= out.length) grow(1); out[op++] = s; continue; }
      if (s === 256) break;
      const li = s - 257;
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = sym(dist);
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      if (d > op) throw new Error('inflate: 距離が範囲外');
      grow(len);
      let from = op - d;
      for (let i = 0; i < len; i++) out[op++] = out[from++];
    }
  }
  return op === out.length ? out : out.subarray(0, op);
}

function inflateZlib(data, sizeHint) {
  if ((data[0] & 0x0f) !== 8) throw new Error('zlib: 圧縮方式が deflate ではありません');
  return inflateRaw(data.subarray(2), sizeHint);
}

module.exports = { inflateRaw, inflateZlib };
