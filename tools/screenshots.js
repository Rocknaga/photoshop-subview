'use strict';
// README の画面写真を撮る（docs/images/）。npm run shots
// テストの画面の通し（test/ui-smoke.js）と同じく、Chromium で index.html を開き、photoshop / uxp を代わりの部品にする。
// 資料の絵は、ここで描いて作る（著作権の心配がないように。写真やほかの人の絵は使わない）。
// 本物の Photoshop の中とは、文字の形やボタンの見た目が少し違う。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');

// ---------------------------------------------------------------- 資料の絵を描く
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, fn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x / w, y / h, x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = clamp(c[0]); raw[o + 1] = clamp(c[1]); raw[o + 2] = clamp(c[2]);
    }
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// なめらかな乱れ（1 次元）。山の稜線に使う
function noise1(x, seed) {
  const h = (i) => { const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return s - Math.floor(s); };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}
const fbm = (x, seed) => { let v = 0, a = 0.5, f = 1; for (let o = 0; o < 5; o++) { v += a * noise1(x * f, seed + o); a *= 0.5; f *= 2.1; } return v; };

// 夕方の山と湖
function landscape() {
  const W = 1200, H = 760, horizon = 0.62;
  const skyTop = [38, 62, 128], skyLow = [246, 168, 112], sun = [255, 236, 190];
  const ridges = [
    { base: 0.40, amp: 0.20, freq: 3.0, seed: 1, col: [120, 104, 150] },
    { base: 0.48, amp: 0.16, freq: 4.5, seed: 7, col: [82, 70, 112] },
    { base: 0.56, amp: 0.10, freq: 7.0, seed: 13, col: [44, 46, 70] },
  ];
  const scene = (u, v) => {
    const t = v / horizon;
    let c = mix(skyTop, skyLow, Math.pow(t, 1.6));
    const d = Math.hypot((u - 0.68) * (W / H), v - 0.47);
    c = mix(c, sun, Math.max(smooth(0.055, 0.045, d), 0.55 * Math.exp(-d * 9)));
    for (const r of ridges) {
      const top = r.base + (fbm(u * r.freq, r.seed) - 0.5) * r.amp;
      if (v > top) {
        const depth = (v - top) / Math.max(0.01, horizon - top);
        c = mix(r.col, [r.col[0] * 0.7, r.col[1] * 0.75, r.col[2] * 0.85], Math.min(1, depth));
      }
    }
    return c;
  };
  return png(W, H, (u, v) => {
    if (v < horizon) return scene(u, v);
    // 湖: 上の景色を写して、さざ波で揺らし、少し暗く青くする
    const dv = v - horizon;
    const ripple = Math.sin(v * 900) * 0.004 * (dv * 8);
    const c = scene(u + ripple, horizon - dv * 1.05);
    let w = mix(c, [24, 40, 70], 0.25 + dv * 1.4);
    // 手前の岸
    const shore = 0.9 + (fbm(u * 6, 21) - 0.5) * 0.08;
    if (v > shore) w = mix([30, 44, 32], [14, 22, 16], (v - shore) * 8);
    return w;
  });
}

// 机の上の球（明暗の練習によくある資料）
function spheres() {
  const W = 1000, H = 760, light = norm([-0.55, -0.65, 0.52]);
  const balls = [
    { x: 0.30, y: 0.56, r: 0.17, col: [208, 62, 54] },
    { x: 0.62, y: 0.60, r: 0.13, col: [56, 150, 160] },
    { x: 0.80, y: 0.46, r: 0.08, col: [232, 188, 70] },
  ];
  const table = 0.66;
  return png(W, H, (u, v) => {
    const a = W / H, px = u * a;
    let c = v < table ? mix([96, 92, 104], [150, 142, 140], v / table) : mix([186, 160, 130], [120, 98, 80], (v - table) / (1 - table));
    // 机に落ちる影
    if (v >= table - 0.02) {
      for (const b of balls) {
        const sx = (b.x + 0.12 * b.r / 0.17) * a, sy = b.y + b.r * 0.92;
        const e = Math.hypot((px - sx) / (b.r * a * 1.25 / a), (v - sy) / (b.r * 0.32));
        c = mix(c, [c[0] * 0.45, c[1] * 0.42, c[2] * 0.45], smooth(1.1, 0.4, e) * 0.85);
      }
    }
    for (const b of balls) {
      const dx = (px - b.x * a) / b.r, dy = (v - b.y) / b.r, rr = dx * dx + dy * dy;
      if (rr <= 1) {
        const n = [dx, dy, Math.sqrt(1 - rr)];
        const lam = Math.max(0, dot(n, light));
        const refl = 0.18 * Math.max(0, n[1]) ; // 机からの照り返し
        const half = norm([light[0], light[1], light[2] + 1]);
        const spec = Math.pow(Math.max(0, dot(n, half)), 60);
        const k = 0.12 + 0.9 * lam + refl;
        c = [b.col[0] * k + 255 * spec, b.col[1] * k + 250 * spec, b.col[2] * k + 245 * spec];
        // ふちを少しなめらかに
        if (rr > 0.97) c = mix(c, [60, 56, 60], (rr - 0.97) / 0.03 * 0.5);
      }
    }
    return c;
  });
}
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// 夜の街並み
function city() {
  const W = 900, H = 1200;
  const bld = [];
  let x = 0, s = 3;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  while (x < 1) { const w = 0.08 + rnd() * 0.12; bld.push({ x0: x, x1: x + w, top: 0.25 + rnd() * 0.4, hue: rnd() }); x += w + 0.01; }
  return png(W, H, (u, v) => {
    let c = mix([10, 14, 40], [70, 40, 90], Math.pow(v, 1.3));
    const m = Math.hypot((u - 0.22) * 0.75, v - 0.14);
    if (m < 0.05) c = [236, 232, 214];
    else c = mix(c, [120, 120, 150], 0.35 * Math.exp(-m * 12));
    for (const b of bld) {
      if (u >= b.x0 && u < b.x1 && v >= b.top) {
        c = mix([22, 24, 40], [34, 30, 52], b.hue);
        const wx = ((u - b.x0) * W) % 18, wy = ((v - b.top) * H) % 26;
        const lit = Math.sin(Math.floor((u - b.x0) * W / 18) * 12.9 + Math.floor((v - b.top) * H / 26) * 78.2 + b.hue * 50) > 0.1;
        if (wx > 5 && wx < 13 && wy > 8 && wy < 18 && lit && v < 0.95) c = mix([255, 200, 110], [255, 238, 180], b.hue);
      }
    }
    if (v > 0.95) c = mix([16, 16, 24], [8, 8, 12], (v - 0.95) * 20);
    return c;
  });
}

// ---------------------------------------------------------------- パネルを開く
function bundle() {
  const files = ['lib/inflate.js', 'lib/png.js', 'lib/jpeg.js', 'lib/imageops.js', 'lib/view.js', 'lib/ps.js', 'main.js'];
  let out = 'var __mods = {}, __cache = {};\n';
  for (const f of files) {
    const id = './' + f.replace(/\.js$/, '');
    out += `__mods[${JSON.stringify(id)}] = function (module, exports, require) {\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}\n};\n`;
  }
  out += `
function __req(from) {
  return function (name) {
    if (name === 'photoshop') return window.__ps;
    if (name === 'uxp') return window.__uxp;
    var base = from.split('/').slice(0, -1);
    var parts = name.split('/');
    for (var i = 0; i < parts.length; i++) { if (parts[i] === '.') continue; if (parts[i] === '..') base.pop(); else base.push(parts[i]); }
    var id = base.join('/');
    if (__cache[id]) return __cache[id].exports;
    var m = { exports: {} }; __cache[id] = m;
    __mods[id](m, m.exports, __req(id));
    return m.exports;
  };
}
__req('./x')('./main');
`;
  return out;
}

function stubs(files) {
  return `
  window.__files = ${JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])))};
  window.__pick = Object.keys(window.__files);
  const b64 = (s) => { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  class SolidColor { constructor() { this.rgb = { red: 0, green: 0, blue: 0 }; } }
  window.__ps = {
    app: {
      SolidColor, _fg: null,
      set foregroundColor(c) { this._fg = [c.rgb.red, c.rgb.green, c.rgb.blue]; },
      get foregroundColor() { return this._fg; },
      get activeDocument() { return null; },
      get documents() { return []; },
    },
    core: { executeAsModal: async (fn) => fn({}) },
    imaging: {},
    action: { addNotificationListener() {}, removeNotificationListener() {} },
  };
  const entry = (name) => ({ name, read: async () => b64(window.__files[name]).buffer });
  window.__uxp = {
    storage: {
      formats: { binary: 'binary' },
      localFileSystem: {
        getFileForOpening: async () => window.__pick.map(entry),
        createPersistentToken: async (e) => 'tok:' + e.name,
        getEntryForPersistentToken: async (t) => entry(t.slice(4)),
      },
    },
    entrypoints: { setup() {} },
  };`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const files = { '夕方の山.png': landscape(), '球の明暗.png': spheres(), '夜の街.png': city() };
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="styles.css">', `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>`)
    .replace('src="icons/dropper.png"', `src="data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'icons', 'dropper.png')).toString('base64')}"`)
    .replace('<script src="main.js"></script>', `<script>${stubs(files)}</script><script>${bundle()}</script>`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 300, height: 640 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.route('http://panel.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('http://panel.local/');

  const waitShown = () => page.waitForFunction(() => getComputedStyle(document.getElementById('busy')).display === 'none' && document.getElementById('img').style.display === 'block');
  const settle = async () => { await waitShown(); await page.waitForTimeout(250); };
  const slide = (sel, v) => page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, v]);
  const imgBox = () => page.locator('#img').boundingBox();
  const altClick = async (fx, fy) => {
    const b = await imgBox();
    await page.keyboard.down('Alt');
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
    await page.keyboard.up('Alt');
    await page.waitForTimeout(600); // ダブルクリック扱いにならないよう間をあける
  };
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name) }); console.log('撮りました:', path.join('docs', 'images', name)); };

  // 1. 3 枚足して、山を出し、色を拾う
  await page.click('#e-file');
  await settle();
  await page.keyboard.press('ArrowLeft'); // 足すと最後の 1 枚が出るので、最初の山へ戻す
  await page.keyboard.press('ArrowLeft');
  await settle();
  for (const [fx, fy] of [[0.5, 0.05], [0.66, 0.5], [0.2, 0.42], [0.45, 0.55], [0.3, 0.8], [0.5, 0.97]]) await altClick(fx, fy);
  await page.mouse.move(5, 5);
  await shot('main.png');

  // 2. 調整レイヤー: 露光量を下げ、色温度を上げ、自然な彩度を足す
  await page.click('#adjBtn');
  for (const [kind, v] of [['exposure', 0.7], ['temp', 45], ['vibrance', 60]]) {
    await page.selectOption('#adj-add', kind);
    await slide('#adj-list .adj-row:first-child .adj-range', v);
    await settle();
  }
  await page.waitForTimeout(400);
  await shot('adjust.png');
  await page.click('#adjBtn'); // 閉じる（調整は残る）
  await settle();

  // 3. 球: 白黒で明暗を見る。スポイトを点けてカーソル下の色を出す
  await page.keyboard.press('ArrowRight');
  await settle();
  await page.click('#gray');
  await settle();
  await page.click('#picker');
  const b = await imgBox();
  await page.mouse.move(b.x + b.width * 0.24, b.y + b.height * 0.62);
  await page.waitForTimeout(300);
  await shot('gray.png');
  await page.click('#picker');
  await page.click('#gray');
  await settle();

  // 4. 街: 傾けて、拡大して、左右反転
  await page.keyboard.press('ArrowRight');
  await settle();
  await slide('#angle', -20);
  await settle();
  await page.click('#flip');
  await settle();
  await page.fill('#zoomv', '32');
  await page.press('#zoomv', 'Enter');
  await settle();
  await page.mouse.move(5, 5);
  await shot('rotate.png');

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
