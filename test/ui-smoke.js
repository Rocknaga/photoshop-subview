'use strict';
// 画面の通しテスト。Chromium で index.html を開き、photoshop / uxp をスタブに差し替え、
// UXP 固有の描画差は実機で確かめること（README）。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.log('playwright が無いので UI テストを飛ばします（NODE_PATH を確認）');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');

// ---- CommonJS を 1 本にまとめる（UXP の require の代わり）
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
    if (name === 'photoshop') { if (!window.__ps) throw new Error('no ps'); return window.__ps; }
    if (name === 'uxp') { if (!window.__uxp) throw new Error('no uxp'); return window.__uxp; }
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

// ---- 画素がはっきりした PNG（左半分が赤、右半分が青、下 1/4 が緑）
function png(w, h, fn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const c = fn(x, y); raw.set(c, y * (w * 3 + 1) + 1 + x * 3); }
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : require('../lib/png').crc32(td, 0, td.length));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [220, 30, 30], BLUE = [30, 60, 220], GREEN = [40, 180, 60];
const halves = png(400, 200, (x, y) => (y >= 150 ? GREEN : x < 200 ? RED : BLUE));
const jpgBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'prog.jpg'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok', name); }
  catch (e) { fail++; console.log('  NG', name, '\n    ', e.message.split('\n').slice(0, 4).join('\n     ')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 320, height: 620 } });
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));


  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="styles.css">', `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>`)
    .replace('<script src="main.js"></script>', '<script>/*BUNDLE*/</script>');

  const stubs = `
  window.__log = [];
  window.__files = { 'halves.png': ${JSON.stringify(Array.from(halves))}, 'prog.jpg': ${JSON.stringify(Array.from(jpgBytes))} };
  window.__pick = ['halves.png'];
  window.__notify = null;
  window.__canvasColor = [250, 200, 10];
  class SolidColor { constructor() { this.rgb = { red: 0, green: 0, blue: 0 }; } }
  window.__ps = {
    app: {
      SolidColor,
      _fg: null,
      set foregroundColor(c) { this._fg = [c.rgb.red, c.rgb.green, c.rgb.blue]; window.__log.push('fg'); },
      get foregroundColor() { return this._fg; },
      get activeDocument() { return { id: 7, title: 'ラフ.psd', width: 800, height: 400 }; },
      get documents() { return [this.activeDocument]; },
    },
    core: { executeAsModal: async (fn) => { window.__log.push('modal'); return fn({}); } },
    imaging: {
      getPixels: async (opt) => {
        window.__log.push('getPixels:' + JSON.stringify(opt.targetSize || null));
        const w = 80, h = 40, d = new Uint8Array(w * h * 3);
        for (let i = 0; i < w * h; i++) { const x = i % w; const c = x < 40 ? window.__canvasColor : [0, 0, 0]; d.set(c, i * 3); }
        return { imageData: { width: w, height: h, components: 3, getData: async () => d, dispose() {} } };
      },
    },
    action: { addNotificationListener: (evs, fn) => { window.__notify = fn; }, removeNotificationListener() {} },
  };
  const entry = (name) => ({ name, read: async () => new Uint8Array(window.__files[name]).buffer });
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
  const full = html.replace('<script>/*BUNDLE*/</script>', `<script>${stubs}</script><script>${bundle()}</script>`);

  await page.route('http://panel.local/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: full }));
  await page.goto('http://panel.local/');

  const stageBox = async () => page.locator('#stage').boundingBox();
  const imgBox = async () => page.locator('#img').boundingBox();
  const fg = () => page.evaluate(() => window.__ps.app._fg);
  const text = (sel) => page.locator(sel).textContent();
  // range のつまみを動かしたことにする（離したときの change まで）
  const slide = (sel, v) => page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, v]);
  const waitShown = () => page.waitForFunction(() => getComputedStyle(document.getElementById('busy')).display === 'none' && document.getElementById('img').style.display === 'block');

  await test('最初は案内が出ていて、ボタンから足せる', async () => {
    assert.ok(await page.locator('#empty').isVisible());
    assert.strictEqual(await text('#pos'), '0 / 0');
  });

  await test('ファイルを足すと表示され、全体に収まる', async () => {
    await page.click('#e-file');
    await waitShown();
    const s = await stageBox(), b = await imgBox();
    assert.ok(b.width <= s.width && b.height <= s.height, `${b.width}x${b.height} in ${s.width}x${s.height}`);
    assert.ok(Math.abs(b.width / b.height - 2) < 0.02, '縦横比');
    assert.strictEqual(await text('#pos'), '1 / 1');
    assert.strictEqual(await page.locator('#fit[selected]').count(), 1);
    assert.ok((await page.getAttribute('#img', 'src')).startsWith('data:image/png'));
  });

  await test('Alt＋クリックで左半分の赤を描画色に入れる', async () => {
    const b = await imgBox();
    await page.keyboard.down('Alt');
    await page.mouse.click(b.x + b.width * 0.25, b.y + b.height * 0.3);
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => window.__ps.app._fg);
    assert.deepStrictEqual(await fg(), RED);
    assert.ok((await text('#hex')).includes('DC1E1E'));
    assert.strictEqual(await page.locator('#swatches .sw').count(), 1);
  });

  await test('反転すると同じ場所で青を拾う（向きを戻して拾っている）', async () => {
    await page.click('#flip');
    await waitShown();
    await page.waitForFunction(() => !document.getElementById('img').getAttribute('src').startsWith('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAADI') || true);
    const b = await imgBox();
    await page.click('#picker');
    await page.mouse.click(b.x + b.width * 0.25, b.y + b.height * 0.3);
    await page.waitForFunction(() => window.__ps.app._fg && window.__ps.app._fg[2] > 200);
    assert.deepStrictEqual(await fg(), BLUE);
    assert.strictEqual(await page.locator('#flip[selected]').count(), 1);
  });

  await test('回転して下の緑の帯を拾える', async () => {
    await page.click('#flip'); // 反転を戻す
    await waitShown();
    await slide('#angle', 90); // 時計回り 90°: 下の帯は左へ来る
    await waitShown();
    const b = await imgBox();
    assert.ok(b.height > b.width, '縦長になる');
    await page.mouse.click(b.x + b.width * 0.1, b.y + b.height * 0.5);
    await page.waitForFunction(() => window.__ps.app._fg && window.__ps.app._fg[1] > 150);
    assert.deepStrictEqual(await fg(), GREEN);
    await page.click('#rot0'); // 0° に戻す
    assert.strictEqual(await text('#rot0'), '0°');
    await waitShown();
    await page.click('#picker'); // スポイトを切る
  });

  const IO = require('../lib/imageops');
  const altClick = async (x, y) => { await page.keyboard.down('Alt'); await page.mouse.click(x, y); await page.keyboard.up('Alt'); };

  await test('自由な角度: 30° で外接する大きさになり、中の色は合い、隅では拾わない', async () => {
    await slide('#angle', 30);
    await waitShown();
    assert.strictEqual(await text('#rot0'), '30°');
    assert.strictEqual(await page.locator('#rot0[selected]').count(), 1, '回っている間は 0° ボタンが点く');
    const b = await imgBox();
    const [ow, oh] = IO.orientedSize(400, 200, 30);
    assert.ok(Math.abs(b.width / b.height - ow / oh) < 0.02, `縦横比 ${b.width / b.height}`);
    for (const [u, v, want] of [[0.25, 0.3, RED], [0.75, 0.3, BLUE], [0.5, 0.9, GREEN]]) {
      const [fx, fy] = IO.sourceToView(u, v, 30, false, false, 400, 200);
      await page.evaluate(() => { window.__ps.app._fg = null; });
      await altClick(b.x + fx * b.width, b.y + fy * b.height);
      await page.waitForFunction(() => window.__ps.app._fg);
      assert.deepStrictEqual(await fg(), want, `(${u}, ${v})`);
    }
    await page.evaluate(() => { window.__ps.app._fg = null; });
    await altClick(b.x + 3, b.y + 3);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('画像の外'));
    assert.strictEqual(await fg(), null, '隅（絵の外）の色は拾わない');
  });

  await test('⟳ ⟲ は 15° ずつ（半端な角度からは 15° の目に乗る）。つまみは 90° の近くで止まる', async () => {
    await page.click('#rot');
    assert.strictEqual(await text('#rot0'), '45°');
    await page.click('#rotl'); await page.click('#rotl'); await page.click('#rotl'); await page.click('#rotl');
    assert.strictEqual(await text('#rot0'), '-15°');
    await slide('#angle', 88);
    assert.strictEqual(await text('#rot0'), '90°');
    await waitShown();
    const b = await imgBox();
    assert.ok(b.height > b.width, '90° は縦長');
    await page.click('#rot0');
    assert.strictEqual(await text('#rot0'), '0°');
    assert.strictEqual(await page.locator('#rot0[selected]').count(), 0);
    await waitShown();
  });

  await test('拡大して見ている場所は、傾けても窓の真ん中に残る', async () => {
    const s = await stageBox();
    await page.click('#z100'); // 等倍
    const b0 = await imgBox();
    const u0 = (s.x + s.width / 2 - b0.x) / b0.width, v0 = (s.y + s.height / 2 - b0.y) / b0.height;
    await slide('#angle', 40);
    await waitShown();
    const b1 = await imgBox();
    const [u1, v1] = IO.viewToSource((s.x + s.width / 2 - b1.x) / b1.width, (s.y + s.height / 2 - b1.y) / b1.height, 40, false, false, 400, 200);
    assert.ok(Math.abs(u1 - u0) < 0.02 && Math.abs(v1 - v0) < 0.02, `${u0},${v0} → ${u1},${v1}`);
    await page.click('#rot0');
    await page.click('#fit');
    await waitShown();
  });

  await test('上下反転: 上の赤があった所で下の緑を拾う', async () => {
    await page.click('#flipv');
    await waitShown();
    assert.strictEqual(await page.locator('#flipv[selected]').count(), 1);
    const b = await imgBox();
    await page.evaluate(() => { window.__ps.app._fg = null; });
    await altClick(b.x + b.width * 0.25, b.y + b.height * 0.1);
    await page.waitForFunction(() => window.__ps.app._fg);
    assert.deepStrictEqual(await fg(), GREEN);
    await page.click('#flipv');
    await waitShown();
  });

  await test('明度表示は灰色になる（拾う色は元の色のまま）', async () => {
    await page.click('#gray');
    await waitShown();
    const b = await imgBox();
    // 表示の画素を読む
    const px = await page.evaluate(async () => {
      const im = document.getElementById('img');
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      return Array.from(g.getImageData(10, 10, 1, 1).data);
    });
    assert.strictEqual(px[0], px[1]); assert.strictEqual(px[1], px[2]);
    await page.keyboard.down('Alt');
    await page.mouse.click(b.x + b.width * 0.75, b.y + b.height * 0.3);
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => window.__ps.app._fg[2] > 200);
    assert.deepStrictEqual(await fg(), BLUE);
    await page.click('#gray');
    await waitShown();
  });

  // 表示している絵の、横 fx・縦 fy の位置の画素
  const shownPx = (fx, fy) => page.evaluate(([fx, fy]) => {
    const im = document.getElementById('img');
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    return Array.from(g.getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data).slice(0, 3);
  }, [fx, fy]);

  const addAdj = (kind) => page.selectOption('#adj-add', kind);
  // つまみを離したあとの描き直しは裏で走るので、少し待ってから見る
  const settled = async () => { await page.waitForTimeout(300); await waitShown(); };

  await test('調整レイヤー: 一覧は Lightroom の基本補正の並び。露光量は ±5.00 で、上げると明るくなる。拾う色は元の色のまま', async () => {
    assert.strictEqual(await page.locator('#adjpane.open').count(), 0, '初めは閉じている');
    await page.click('#adjBtn');
    assert.strictEqual(await page.locator('#adjpane.open').count(), 1);
    const names = await page.locator('#adj-add option').allTextContents();
    assert.deepStrictEqual(names, ['＋ 調整を足す…', '露光量', 'コントラスト', 'ハイライト', 'シャドウ', '白レベル', '黒レベル', '色温度', '色かぶり補正', '自然な彩度', '彩度']);
    await addAdj('exposure');
    assert.strictEqual(await page.inputValue('#adj-add'), '', '選んだら一覧は元に戻る（続けて足せる）');
    assert.strictEqual(await page.locator('#adj-list .adj-row').count(), 1);
    assert.strictEqual(await text('#adj-list .adj-name'), '露光量');
    assert.deepStrictEqual(await page.evaluate(() => { const r = document.querySelector('#adj-list .adj-range'); return [r.min, r.max, r.step]; }), ['-5', '5', '0.05']);
    await slide('#adj-list .adj-range', 5);
    await settled();
    // Lightroom と同じく色味は残る（赤は白にならず、明るい赤〜桃色になる）
    const p5 = await shownPx(0.25, 0.3);
    assert.ok(p5[0] === 255 && p5[1] > 120 && p5[1] === p5[2], `露光量 +5 で明るくなる: ${p5}`);
    assert.strictEqual(await text('#adj-list .adj-v'), '+5.00');
    assert.strictEqual(await text('#adjBtn'), '調整 1', '効いている数がボタンに出る');
    const b = await imgBox();
    await page.evaluate(() => { window.__ps.app._fg = null; });
    await altClick(b.x + b.width * 0.25, b.y + b.height * 0.3);
    await page.waitForFunction(() => window.__ps.app._fg);
    assert.deepStrictEqual(await fg(), RED, '拾うのは元の赤');
  });

  await test('調整レイヤー: 目で止める・彩度を足して重ねる・▲で順番・×で消す', async () => {
    await page.click('#adj-list .adj-eye');
    await settled();
    assert.deepStrictEqual(await shownPx(0.25, 0.3), RED, '止めると元の見え方');
    assert.strictEqual(await page.locator('#adj-list .adj-row.off').count(), 1);
    assert.strictEqual(await text('#adjBtn'), '調整');
    await page.click('#adj-list .adj-eye'); // 戻す
    await slide('#adj-list .adj-range', -1.5); // 露光量 -1.5
    assert.strictEqual(await text('#adj-list .adj-v'), '-1.50');
    await addAdj('saturation');
    // 新しいものはいちばん上に入る
    assert.deepStrictEqual(await page.locator('#adj-list .adj-name').allTextContents(), ['彩度', '露光量']);
    await slide('#adj-list .adj-row:first-child .adj-range', -100);
    await settled();
    let p = await shownPx(0.25, 0.3);
    assert.ok(p[0] === p[1] && p[1] === p[2], `彩度 -100 で灰色: ${p}`);
    // 露光量を上へ（後からかける）
    await page.click('#adj-list .adj-row:nth-child(2) .adj-up');
    assert.deepStrictEqual(await page.locator('#adj-list .adj-name').allTextContents(), ['露光量', '彩度']);
    await waitShown();
    await page.click('#adj-list .adj-row:first-child .adj-del');
    assert.deepStrictEqual(await page.locator('#adj-list .adj-name').allTextContents(), ['彩度']);
    // ほかの項目も足せて、幅は ±100
    await addAdj('highlights');
    assert.deepStrictEqual(await page.evaluate(() => { const r = document.querySelector('#adj-list .adj-range'); return [r.min, r.max]; }), ['-100', '100']);
    await page.click('#adj-list .adj-row:first-child .adj-del');
    await page.click('#adj-list .adj-del');
    await settled();
    assert.deepStrictEqual(await shownPx(0.25, 0.3), RED, '全部消すと元の見え方');
    assert.strictEqual(await page.locator('#adj-list .adj-row.dim').count(), 1, '空のときは案内が出る');
    await page.click('#adjBtn');
    assert.strictEqual(await page.locator('#adjpane.open').count(), 0);
  });

  await test('ホイールでカーソル位置を中心に拡大、全体で戻る', async () => {
    const b0 = await imgBox();
    const cx = b0.x + b0.width * 0.8, cy = b0.y + b0.height * 0.5;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    const b1 = await imgBox();
    assert.ok(b1.width > b0.width * 1.5, '拡大している');
    // カーソル下の位置（画像の 80%）が動いていない
    const f = (cx - b1.x) / b1.width;
    assert.ok(Math.abs(f - 0.8) < 0.02, `位置 ${f}`);
    assert.strictEqual(await page.locator('#fit[selected]').count(), 0);
    await page.click('#fit');
    const b2 = await imgBox();
    assert.ok(Math.abs(b2.width - b0.width) < 2);
  });

  await test('Photoshop のホイール（見えない箱のスクロール）でも、カーソル位置を中心に拡大縮小する', async () => {
    await page.click('#fit');
    // 直前のクリックのあと 0.5 秒は受け口が外れている（clickPause）。戻るのを待ってから回す（待たないとたまに落ちる）
    await page.waitForSelector('#wheel', { state: 'attached' });
    const b0 = await imgBox();
    const cx = b0.x + b0.width * 0.25, cy = b0.y + b0.height * 0.5;
    await page.mouse.move(cx, cy);
    // UXP は wheel を渡さず箱をスクロールさせるだけ。それを再現する（上へ 1 目盛り = scrollTop が 100 減る）
    await page.evaluate(() => { const s = document.getElementById('wheel'); s.scrollTop = s.scrollTop - 100; });
    await page.waitForFunction(() => document.querySelector('#fit[selected]') === null);
    const b1 = await imgBox();
    assert.ok(b1.width > b0.width * 1.2, '拡大している');
    const f = (cx - b1.x) / b1.width;
    assert.ok(Math.abs(f - 0.25) < 0.02, `位置 ${f}`);
    assert.strictEqual(await page.evaluate(() => document.getElementById('wheel').scrollTop), 10000, '真ん中へ戻っている');
    await page.evaluate(() => { const s = document.getElementById('wheel'); s.scrollTop = s.scrollTop + 300; });
    await page.waitForFunction(() => document.querySelector('#fit[selected]') !== null);
  });

  await test('点いている切り替えボタンは色で分かる', async () => {
    const bg = () => page.evaluate(() => document.getElementById('flip').style.backgroundColor);
    assert.strictEqual(await bg(), '');
    await page.click('#flip');
    assert.ok((await bg()).length > 0, '色が付く');
    await page.click('#flip');
    assert.strictEqual(await bg(), '');
    await waitShown();
  });

  // Photoshop では押し下げ（pointerdown）が届かず、「押したまま動いた」と「離した」だけが来る。それを再現する
  const uxpGesture = (points, opt = {}) => page.evaluate(([points, opt]) => {
    const el = document.getElementById('wheel') || document.getElementById('stage');
    const ev = (type, [x, y], buttons) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, buttons, button: 0, pointerId: 1, altKey: !!opt.alt }));
    points.forEach((p) => ev('pointermove', p, 1));
    ev('pointerup', points[points.length - 1], 0);
  }, [points, opt]);

  await test('押し下げが届かなくても（Photoshop の動き）、ドラッグで動き、クリックで色を拾う', async () => {
    await page.click('#fit');
    const b0 = await imgBox();
    const cx = b0.x + b0.width * 0.5, cy = b0.y + b0.height * 0.5;
    await uxpGesture([[cx, cy], [cx - 10, cy], [cx - 25, cy], [cx - 40, cy]]);
    const b1 = await imgBox();
    assert.ok(Math.abs((b1.x - b0.x) + 40) < 2, `左へ 40px 動く: ${b1.x - b0.x}`);
    await page.click('#fit');
    // 動かさずに離しただけ ＝ クリック。Alt なら色を拾う
    await page.evaluate(() => { window.__ps.app._fg = null; });
    const b2 = await imgBox();
    await page.evaluate(([x, y]) => {
      (document.getElementById('wheel') || document.getElementById('stage')).dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, buttons: 0, button: 0, pointerId: 1, altKey: true }));
    }, [b2.x + b2.width * 0.25, b2.y + b2.height * 0.3]);
    await page.waitForFunction(() => window.__ps.app._fg);
    assert.deepStrictEqual(await fg(), RED);
    // ダブルクリック: 1 回目は受け口に吸われて「離した」だけが来る。直後は受け口を外すので、2 回目は絵の面に直に届く
    await page.click('#z100');
    await page.waitForTimeout(600); // 100% ボタンの前のクリックで外れた受け口が戻るのを待つ
    assert.strictEqual(await page.locator('#fit[selected]').count(), 0);
    assert.ok(await page.evaluate(() => !!document.getElementById('wheel')), '受け口が戻っている');
    await page.evaluate(([x, y]) => {
      document.getElementById('wheel').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, buttons: 0, button: 0, pointerId: 1 }));
    }, [b2.x + b2.width * 0.5, b2.y + b2.height * 0.5]);
    assert.ok(await page.evaluate(() => !document.getElementById('wheel')), 'クリックの直後は受け口を外す');
    await page.mouse.click(b2.x + b2.width * 0.5, b2.y + b2.height * 0.5); // 2 回目（押し下げも届く）
    assert.strictEqual(await page.locator('#fit[selected]').count(), 1, 'ダブルクリックで全体表示');
    await page.waitForTimeout(600);
    assert.ok(await page.evaluate(() => !!document.getElementById('wheel')), '0.5 秒たつと受け口が戻る（ホイールが効く）');
  });

  await test('Alt を押している間は、絵の上のカーソルがスポイトの形になる', async () => {
    const cls = () => page.evaluate(() => document.getElementById('stage').className);
    const cursor = () => page.evaluate(() => getComputedStyle(document.getElementById('wheel') || document.getElementById('stage')).cursor);
    assert.strictEqual(await cls(), '');
    await page.keyboard.down('Alt');
    assert.strictEqual(await cls(), 'picker');
    assert.ok((await cursor()).includes('url('), 'スポイトの絵（見えない受け口の上でも）');
    await page.keyboard.up('Alt');
    assert.strictEqual(await cls(), '');
    // パネルにキーが来ないときも、マウスの合図に付いてくる Alt で分かる
    const b = await imgBox();
    await page.evaluate(([x, y]) => {
      (document.getElementById('wheel') || document.getElementById('stage')).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons: 0, altKey: true }));
    }, [b.x + 10, b.y + 10]);
    assert.strictEqual(await cls(), 'picker');
    await page.evaluate(([x, y]) => {
      (document.getElementById('wheel') || document.getElementById('stage')).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons: 0, altKey: false }));
    }, [b.x + 12, b.y + 10]);
    assert.strictEqual(await cls(), '');
  });

  await test('Alt を押している間は、スポイトの絵がマウスの先に付いて動く（Photoshop はカーソルの形を変えられない）', async () => {
    const shown = () => page.evaluate(() => document.getElementById('dropper').style.display);
    const s = await stageBox();
    await page.mouse.move(s.x + 100, s.y + 80);
    assert.strictEqual(await shown(), 'none');
    await page.keyboard.down('Alt');
    assert.strictEqual(await shown(), 'block');
    await page.mouse.move(s.x + 140, s.y + 90);
    const d = await page.locator('#dropper').boundingBox();
    // 絵の左下の先が、マウスの位置に来る
    assert.ok(Math.abs(d.x + 2 - (s.x + 140)) < 2 && Math.abs(d.y + 22 - (s.y + 90)) < 2, `${d.x},${d.y}`);
    await page.keyboard.up('Alt');
    assert.strictEqual(await shown(), 'none');
    // スポイトを点けている間も出る。窓から出たら隠れる
    await page.click('#picker');
    await page.mouse.move(s.x + 120, s.y + 60);
    assert.strictEqual(await shown(), 'block');
    await page.mouse.move(s.x + 120, s.y - 30);
    assert.strictEqual(await shown(), 'none', '窓の外では隠れる');
    await page.click('#picker');
  });

  await test('つまみはダブルクリックで初めの値に戻る（角度 0°・倍率は全体）', async () => {
    await slide('#angle', 50);
    await waitShown();
    assert.strictEqual(await text('#rot0'), '50°');
    await page.locator('#angle').dblclick();
    await page.waitForTimeout(450);
    assert.strictEqual(await text('#rot0'), '0°');
    assert.strictEqual(await page.inputValue('#angle'), '0');
    await waitShown();
    await page.click('#z100');
    assert.strictEqual(await page.locator('#fit[selected]').count(), 0);
    await page.locator('#zoomr').dblclick();
    await page.waitForTimeout(450);
    assert.strictEqual(await page.locator('#fit[selected]').count(), 1, '全体表示に戻る');
  });

  await test('倍率: 数字を打ち込む・つまみ・Ctrl＋クリックで拡大／Ctrl＋Alt＋クリックで縮小', async () => {
    await page.fill('#zoomv', '200');
    await page.press('#zoomv', 'Enter');
    let b = await imgBox();
    assert.ok(Math.abs(b.width - 800) < 2, `200% は 800px: ${b.width}`);
    assert.strictEqual(await page.inputValue('#zoomv'), '200%');
    const t100 = Math.round(((Math.log(1) - Math.log(0.05)) / (Math.log(16) - Math.log(0.05))) * 1000);
    await slide('#zoomr', t100);
    b = await imgBox();
    assert.ok(Math.abs(b.width - 400) < 4, `つまみで 100%: ${b.width}`);
    await page.click('#fit');
    const b0 = await imgBox();
    const cx = b0.x + b0.width * 0.7, cy = b0.y + b0.height * 0.5;
    const fg0 = await fg();
    await page.keyboard.down('Control');
    await page.mouse.click(cx, cy);
    await page.keyboard.up('Control');
    const b1 = await imgBox();
    assert.ok(b1.width > b0.width * 1.2, 'Ctrl＋クリックで拡大');
    assert.ok(Math.abs((cx - b1.x) / b1.width - 0.7) < 0.02, 'クリックした所を中心に');
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    await page.mouse.click(cx, cy);
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    const b2 = await imgBox();
    assert.ok(b2.width < b1.width, 'Ctrl＋Alt＋クリックで縮小');
    assert.deepStrictEqual(await fg(), fg0, '色は拾わない');
    await page.click('#fit');
  });

  await test('ドラッグで移動、ダブルクリックはいつでも全体表示（全体のときに押しても全体のまま）', async () => {
    const b00 = await imgBox();
    await page.mouse.dblclick(b00.x + b00.width * 0.3, b00.y + b00.height * 0.5);
    assert.strictEqual(await page.locator('#fit[selected]').count(), 1, '全体のまま（等倍へは飛ばない）');
    await page.click('#z100');
    let z = await page.inputValue('#zoomv');
    assert.strictEqual(z, '100%');
    const b1 = await imgBox();
    assert.ok(Math.abs(b1.width - 400) < 2, '等倍は元の 400px');
    const fgBefore = await page.evaluate(() => window.__log.filter((x) => x === 'fg').length);
    await page.mouse.move(150, 200); await page.mouse.down(); await page.mouse.move(100, 200, { steps: 5 }); await page.mouse.up();
    const b2 = await imgBox();
    assert.ok(Math.abs((b2.x - b1.x) + 50) < 2, `横に 50px 動く: ${b2.x - b1.x}`);
    assert.strictEqual(await page.evaluate(() => window.__log.filter((x) => x === 'fg').length), fgBefore, 'ドラッグで色は拾わない');
    const s = await stageBox();
    await page.mouse.dblclick(s.x + 20, s.y + 20);
    assert.strictEqual(await page.locator('#fit[selected]').count(), 1);
  });

  await test('複数足して ← → と並びで送れる。JPEG（プログレッシブ）も出る', async () => {
    await page.evaluate(() => { window.__pick = ['prog.jpg', 'halves.png']; });
    await page.click('#addFile');
    await waitShown();
    assert.strictEqual(await text('#pos'), '2 / 3');
    assert.ok((await page.getAttribute('#img', 'src')).startsWith('data:image/jpeg'));
    await page.click('#next');
    assert.strictEqual(await text('#pos'), '3 / 3');
    await page.click('#stage', { position: { x: 5, y: 5 } }); // 窓にフォーカス
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.strictEqual(await text('#pos'), '1 / 3');
    assert.strictEqual(await page.locator('#strip .cell').count(), 3);
    await page.locator('#strip .cell').nth(1).click();
    assert.strictEqual(await text('#pos'), '2 / 3');
    await waitShown();
    // JPEG でもスポイトが効く
    const b = await imgBox();
    await page.keyboard.down('Alt');
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => window.__log.filter((x) => x === 'fg').length >= 5);
  });

  await test('並び: 横へドラッグで並べ替え（見ている画像が付いていく）・Ctrl＋← → でも動く', async () => {
    await page.locator('#strip .cell').nth(0).click();
    await waitShown();
    assert.strictEqual(await text('#name'), 'halves.png');
    const c0 = await page.locator('#strip .cell').nth(0).boundingBox();
    const c2 = await page.locator('#strip .cell').nth(2).boundingBox();
    await page.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2);
    await page.mouse.down();
    await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.strictEqual(await text('#pos'), '3 / 3', '見ていた画像が 3 番目へ');
    assert.strictEqual(await page.locator('#strip .cell.dragging').count(), 0);
    await page.locator('#strip .cell').nth(0).click();
    await waitShown();
    assert.strictEqual(await text('#name'), 'prog.jpg', '並べ替えで先頭が入れ替わる');
    await page.click('#stage', { position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+ArrowRight');
    assert.strictEqual(await text('#pos'), '2 / 3', 'Ctrl＋→ で後ろへ（元の並びに戻る）');
  });

  await test('キャンバスを写すと「写」で並び、描くたびに写し直す（追従）', async () => {
    await page.click('#addCanvas');
    await waitShown();
    assert.strictEqual(await text('#pos'), '3 / 4', '今の画像（2 枚目）のすぐ後ろに入る');
    assert.ok(await page.locator('#follow').isVisible());
    assert.strictEqual(await page.locator('#follow[selected]').count(), 1);
    const logs = await page.evaluate(() => window.__log.filter((x) => x.startsWith('getPixels')).length);
    const b = await imgBox();
    assert.ok(Math.abs(b.width / b.height - 2) < 0.05, 'キャンバスの縦横比');
    await page.keyboard.down('Alt');
    await page.mouse.click(b.x + b.width * 0.2, b.y + b.height * 0.5);
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => window.__ps.app._fg[0] === 250);
    // 書類が変わった知らせ → しばらくして写し直す
    await page.evaluate(() => { window.__canvasColor = [0, 255, 255]; window.__notify('historyStateChanged'); window.__notify('historyStateChanged'); });
    await page.waitForFunction((n) => window.__log.filter((x) => x.startsWith('getPixels')).length === n + 1, logs, { timeout: 4000 });
    await page.waitForTimeout(300);
    await page.keyboard.down('Alt');
    await page.mouse.click(b.x + b.width * 0.2, b.y + b.height * 0.5);
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => window.__ps.app._fg[1] === 255);
    // 追従を切ると写し直さない
    await page.click('#follow');
    await page.evaluate(() => window.__notify('historyStateChanged'));
    await page.waitForTimeout(1300);
    assert.strictEqual(await page.evaluate(() => window.__log.filter((x) => x.startsWith('getPixels')).length), logs + 1);
  });


  await test('外す: 並びから消える（元はそのまま）', async () => {
    await page.click('#remove');
    assert.strictEqual(await text('#pos'), '3 / 3', '同じ位置（ここでは最後）の画像が出る');
    assert.ok((await text('#status')).includes('元のファイルはそのまま'));
  });

  await test('開き直しても並び・向き・拾った色が残る（キャンバスは残さない）', async () => {
    await page.locator('#strip .cell').nth(0).click();
    await page.click('#flip');
    await waitShown();
    // 調整レイヤーも画像ごとに残る
    await page.click('#adjBtn');
    await addAdj('vibrance');
    await slide('#adj-list .adj-range', 30);
    await page.click('#adjBtn');
    await waitShown();
    await page.waitForTimeout(700);
    const sw = await page.locator('#swatches .sw').count();
    await page.reload();
    await page.waitForFunction(() => document.getElementById('pos').textContent !== '0 / 0');
    assert.strictEqual(await text('#pos'), '1 / 3');
    await waitShown();
    assert.strictEqual(await page.locator('#flip[selected]').count(), 1);
    assert.strictEqual(await text('#adjBtn'), '調整 1', '調整レイヤーが戻る');
    assert.strictEqual(await page.locator('#swatches .sw').count(), sw);
    // 色見本を押すと描画色に戻る
    await page.evaluate(() => { window.__ps.app._fg = null; });
    await page.locator('#swatches .sw').first().click();
    await page.waitForFunction(() => window.__ps.app._fg);
  });

  await test('開き直すと、開いていない画像も並びにサムネイルが付く', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#strip .cell img').length === document.querySelectorAll('#strip .cell').length, null, { timeout: 8000 });
  });


  await test('Ctrl＋クリックで印を付け、「外す」でまとめて外す', async () => {
    const n = await page.locator('#strip .cell').count();
    await page.keyboard.down('Control');
    await page.locator('#strip .cell').nth(1).click();
    await page.locator('#strip .cell').nth(2).click();
    await page.keyboard.up('Control');
    assert.strictEqual(await page.locator('#strip .cell.marked').count(), 2);
    assert.strictEqual(await text('#remove'), '2 枚外す');
    await page.click('#remove');
    assert.strictEqual(await page.locator('#strip .cell').count(), n - 2);
    assert.strictEqual(await page.locator('#strip .cell.marked').count(), 0);
    assert.strictEqual(await text('#remove'), '外す');
    assert.ok((await text('#status')).includes('2 枚を並びから外しました'));
  });

  await page.setViewportSize({ width: 240, height: 420 });
  await test('細いパネルでも置き直される（全体表示が窓に追従）', async () => {
    await page.click('#fit');
    await page.waitForTimeout(400);
    const s = await stageBox(), b = await imgBox();
    assert.ok(b.width <= s.width + 1, `${b.width} <= ${s.width}`);
    const bars = await page.evaluate(() => Array.from(document.querySelectorAll('.bar')).map((e) => e.scrollWidth - e.clientWidth));
    console.log('     (横はみ出し px:', bars.join(','), ')');
    // 足した 2 段（倍率・角度）は、細いパネルでもはみ出さない
    assert.ok(bars[1] <= 1 && bars[2] <= 1, `倍率 ${bars[1]}px・角度 ${bars[2]}px はみ出し`);
    // 調整レイヤーの行（名前のいちばん長い「色かぶり補正」）も、細いパネルではみ出さない
    await page.click('#adjBtn');
    await page.selectOption('#adj-add', 'tint');
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#adjpane .adj-row, #adjpane .bar')).map((e) => e.scrollWidth - e.clientWidth));
    assert.ok(rows.every((x) => x <= 1), `調整の行のはみ出し ${rows}`);
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'subview-adj-narrow.png') });
    await page.click('#adj-list .adj-del');
    await page.click('#adjBtn');
  });

  await page.screenshot({ path: path.join(require('os').tmpdir(), 'subview-narrow.png') });
  await page.setViewportSize({ width: 320, height: 620 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(require('os').tmpdir(), 'subview-panel.png') });
  await browser.close();
  console.log(`\nui: ${pass} ok / ${fail} NG`);
  process.exitCode = fail ? 1 : 0;
})();
