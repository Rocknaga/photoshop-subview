'use strict';
// 画像の読み書きのテスト。期待値は Pillow で復号した画素（fixtures/*.rgba）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { activeAdj, decodeImage, downscale, renderRGB, viewToSource, sourceToView, orientedSize, sampleColor, base64, toHex, lightness } = require('../lib/imageops');
const { encodePngRGB, decodePng } = require('../lib/png');
const { inflateRaw } = require('../lib/inflate');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok', name); }
  catch (e) { fail++; console.log('  NG', name, '\n    ', e.message); }
}
const FX = path.join(__dirname, 'fixtures');

// 許容差: PNG は一致、JPEG は IDCT・色変換の実装差ぶん
const tol = { png: 1, jpg: 6 };
for (const f of fs.readdirSync(FX).filter((f) => /\.(png|jpg)$/.test(f))) {
  test(`復号 ${f}`, () => {
    const img = decodeImage(new Uint8Array(fs.readFileSync(path.join(FX, f))));
    const ref = new Uint8Array(fs.readFileSync(path.join(FX, f + '.rgba')));
    assert.strictEqual(img.width, 203);
    assert.strictEqual(img.height, 157);
    let worst = 0, sum = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(ref[i] - img.data[i]);
      sum += d; if (d > worst) worst = d;
    }
    const mean = sum / ref.length;
    const lim = f.endsWith('.png') ? tol.png : tol.jpg;
    // JPEG は平均差で見る（色差の間引きの戻し方で輪郭だけずれるため）
    if (f.endsWith('.png')) assert.ok(worst <= lim, `最大差 ${worst}`);
    else assert.ok(mean <= 0.6 && worst <= 80, `平均差 ${mean.toFixed(2)} 最大差 ${worst}`);
  });
}

test('inflate: zlib の全圧縮段階で元に戻る', () => {
  const src = Buffer.alloc(300000);
  for (let i = 0; i < src.length; i++) src[i] = (i * 31 + (i >> 7)) & 255 & (i % 13 ? 255 : 0);
  for (const level of [0, 1, 6, 9]) {
    const z = zlib.deflateRawSync(src, { level });
    const out = inflateRaw(new Uint8Array(z), 0);
    assert.ok(Buffer.from(out).equals(src), `level ${level}`);
  }
  // 固定ハフマン（小さい入力）
  const small = Buffer.from('サブビュー subview subview subview');
  assert.ok(Buffer.from(inflateRaw(new Uint8Array(zlib.deflateRawSync(small)))).equals(small));
});

test('PNG 書き出し: zlib と自前の両方で読み戻せる', () => {
  const w = 300, h = 250; // 1 ブロック 65535 を跨ぐ大きさ
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) & 255;
  const png = encodePngRGB(rgb, w, h);
  const back = decodePng(png);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    if (back.data[j] !== rgb[i] || back.data[j + 1] !== rgb[i + 1] || back.data[j + 2] !== rgb[i + 2]) throw new Error('不一致 ' + i);
  }
  fs.writeFileSync(path.join(require('os').tmpdir(), 'subview-enc.png'), png);
});

test('縮小: 長辺が指定値になり、透明部分の色が混ざらない', () => {
  const img = { width: 4, height: 2, data: new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255,
    255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255]) };
  const d = downscale(img, 2);
  assert.strictEqual(d.width, 2); assert.strictEqual(d.height, 1);
  assert.deepStrictEqual(Array.from(d.data.subarray(0, 4)), [255, 0, 0, 128]);
});

// 左上だけ赤い 3x2 の画像で向きを確かめる
const tiny = { width: 3, height: 2, data: new Uint8Array(3 * 2 * 4).fill(255) };
tiny.data.set([255, 0, 0, 255], 0); // (0,0) 赤
tiny.data.set([0, 0, 255, 255], (1 * 3 + 2) * 4); // (2,1) 青
const px = (r, x, y) => Array.from(r.data.subarray((y * r.width + x) * 3, (y * r.width + x) * 3 + 3));

test('向き: 90°・180°・270°・左右反転', () => {
  let r = renderRGB(tiny, { rot: 90 });
  assert.deepStrictEqual([r.width, r.height], [2, 3]);
  assert.deepStrictEqual(px(r, 1, 0), [255, 0, 0]); // 左上 → 右上
  r = renderRGB(tiny, { rot: 180 });
  assert.deepStrictEqual(px(r, 2, 1), [255, 0, 0]);
  r = renderRGB(tiny, { rot: 270 });
  assert.deepStrictEqual(px(r, 0, 2), [255, 0, 0]);
  r = renderRGB(tiny, { flip: true });
  assert.deepStrictEqual(px(r, 2, 0), [255, 0, 0]);
  assert.deepStrictEqual(px(r, 0, 1), [0, 0, 255]);
});

test('スポイトの座標: 表示上の位置から元画像の同じ画素を拾う（全 8 通り）', () => {
  for (const rot of [0, 90, 180, 270]) {
    for (const flip of [false, true]) {
      const r = renderRGB(tiny, { rot, flip });
      for (let y = 0; y < r.height; y++) {
        for (let x = 0; x < r.width; x++) {
          const [u, v] = viewToSource((x + 0.5) / r.width, (y + 0.5) / r.height, rot, flip);
          const c = sampleColor(tiny, u, v, 0);
          assert.deepStrictEqual(c, px(r, x, y), `rot ${rot} flip ${flip} @${x},${y}`);
        }
      }
    }
  }
});

test('上下反転も、表示上の位置から元の同じ画素を拾う（回転と組み合わせた 8 通り）', () => {
  for (const rot of [0, 90, 180, 270]) {
    for (const flip of [false, true]) {
      const r = renderRGB(tiny, { rot, flip, flipV: true });
      for (let y = 0; y < r.height; y++) {
        for (let x = 0; x < r.width; x++) {
          const [u, v] = viewToSource((x + 0.5) / r.width, (y + 0.5) / r.height, rot, flip, true);
          assert.deepStrictEqual(sampleColor(tiny, u, v, 0), px(r, x, y), `rot ${rot} flip ${flip} @${x},${y}`);
        }
      }
    }
  }
});

test('反転は画面の上でかかる: 90° 回しても「左右」は左右が入れ替わる', () => {
  const a = renderRGB(tiny, { rot: 90 }), b = renderRGB(tiny, { rot: 90, flip: true });
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) assert.deepStrictEqual(px(b, x, y), px(a, a.width - 1 - x, y));
  }
});

test('斜めの角度: 外接する大きさで描き、隅は背景・真ん中は元の色。拾う位置も合う', () => {
  // 左が赤・右が青の 40x20
  const W = 40, H = 20, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) d.set((i % W) < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  const src = { width: W, height: H, data: d };
  const bg = [38, 38, 38];
  const r = renderRGB(src, { rot: 30, bg });
  const [ow, oh] = orientedSize(W, H, 30);
  assert.deepStrictEqual([r.width, r.height], [Math.round(ow), Math.round(oh)]);
  assert.deepStrictEqual(px(r, 0, 0), bg, '隅は絵の外');
  for (const flip of [false, true]) {
    for (const flipV of [false, true]) {
      const rr = renderRGB(src, { rot: 30, flip, flipV, bg });
      // 元の左寄り・右寄りの点が、表示のどこに来るかを逆算して、その画素の色を見る
      for (const [u, want] of [[0.25, [255, 0, 0]], [0.75, [0, 0, 255]]]) {
        const [fx, fy] = sourceToView(u, 0.5, 30, flip, flipV, W, H);
        const got = px(rr, Math.floor(fx * rr.width), Math.floor(fy * rr.height));
        assert.deepStrictEqual(got, want, `flip ${flip} flipV ${flipV} u ${u}`);
        const [u2, v2] = viewToSource(fx, fy, 30, flip, flipV, W, H);
        assert.ok(Math.abs(u2 - u) < 1e-9 && Math.abs(v2 - 0.5) < 1e-9, '行って戻ると同じ場所');
      }
    }
  }
  // 隅は 0〜1 の外になる（スポイトが絵の外を拾わないように）
  const [cu, cv] = viewToSource(0.01, 0.01, 30, false, false, W, H);
  assert.ok(cu < 0 || cu > 1 || cv < 0 || cv > 1);
});

// 1 画素だけ描いて調整をかける
const one = (c, adj, opt = {}) => Array.from(renderRGB({ width: 1, height: 1, data: new Uint8Array([...c, 255]) }, { adj, ...opt }).data);
const G = (x) => [x, x, x];

test('調整（Lightroom 式）: 露光量は 1 段で光が 2 倍（リニア）。0 や止めたものは効かない', () => {
  // 中間の灰色 128（リニア 0.216）を +1 段 → 0.432 → sRGB でおよそ 175
  assert.ok(Math.abs(one(G(128), [{ kind: 'exposure', value: 1 }])[0] - 175) <= 1);
  assert.ok(Math.abs(one(G(128), [{ kind: 'exposure', value: -1 }])[0] - 93) <= 1);
  assert.deepStrictEqual(one(G(128), [{ kind: 'exposure', value: 5 }]), [255, 255, 255]);
  const C = [200, 100, 50];
  assert.deepStrictEqual(one(C, [{ kind: 'exposure', value: 0 }, { kind: 'contrast', value: 80, on: false }]), C);
  assert.strictEqual(activeAdj([{ kind: 'exposure', value: 0 }, { kind: 'contrast', value: 80, on: false }, { kind: 'nope', value: 5 }]).length, 0);
  // 幅の外は端で止める（露光量は ±5、ほかは ±100）
  assert.deepStrictEqual(activeAdj([{ kind: 'exposure', value: 9 }, { kind: 'contrast', value: 300 }]).map((a) => a.v), [5, 1]);
});

test('調整（Lightroom 式）: コントラストは中間を軸にした S 字で、黒・白・中間の灰色は動かさない', () => {
  for (const v of [100, -100]) {
    assert.deepStrictEqual(one(G(0), [{ kind: 'contrast', value: v }]), G(0));
    assert.deepStrictEqual(one(G(255), [{ kind: 'contrast', value: v }]), G(255));
    assert.ok(Math.abs(one(G(128), [{ kind: 'contrast', value: v }])[0] - 128) <= 1);
  }
  assert.ok(one(G(220), [{ kind: 'contrast', value: 100 }])[0] > 220 && one(G(40), [{ kind: 'contrast', value: 100 }])[0] < 40);
  assert.ok(one(G(220), [{ kind: 'contrast', value: -100 }])[0] < 220 && one(G(40), [{ kind: 'contrast', value: -100 }])[0] > 40);
});

test('調整（Lightroom 式）: ハイライトは明るい所だけ、シャドウは暗い所だけ。白・黒レベルは端を動かす', () => {
  assert.ok(one(G(220), [{ kind: 'highlights', value: -100 }])[0] < 200, 'ハイライト - で明るい所が下がる');
  assert.strictEqual(one(G(40), [{ kind: 'highlights', value: -100 }])[0], 40, '暗い所は動かない');
  assert.strictEqual(one(G(255), [{ kind: 'highlights', value: 60 }])[0], 255, '上げても白そのものは動かない');
  assert.ok(one(G(40), [{ kind: 'shadows', value: 100 }])[0] > 60, 'シャドウ + で暗い所が上がる');
  assert.strictEqual(one(G(220), [{ kind: 'shadows', value: 100 }])[0], 220, '明るい所は動かない');
  assert.ok(one(G(220), [{ kind: 'whites', value: 100 }])[0] > 250, '白レベル + で明るい所が白へ');
  assert.ok(one(G(40), [{ kind: 'blacks', value: -100 }])[0] < 20, '黒レベル - で暗い所が黒へ');
  assert.ok(Math.abs(one(G(128), [{ kind: 'whites', value: 100 }])[0] - 128) <= 1, '中間は動かない');
});

test('調整（Lightroom 式）: 明るさの曲線はどの幅でも明暗を入れ替えない（単調）', () => {
  for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks']) {
    for (const v of [-100, -50, 50, 100]) {
      let prev = -1;
      for (let x = 0; x < 256; x += 3) {
        const y = one(G(x), [{ kind: k, value: v }])[0];
        assert.ok(y >= prev, `${k} ${v} @${x}`);
        prev = y;
      }
    }
  }
});

test('調整（Lightroom 式）: 明るさの項目は色味を変えない（明るさの比で RGB をそろえて伸ばす）', () => {
  const [r, g, b] = one([180, 90, 45], [{ kind: 'shadows', value: 100 }]);
  const [r0, g0, b0] = [180, 90, 45];
  // sRGB では比は保たれないので、リニアに戻して比べる
  const lin = (x) => { const c = x / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  // 8 ビットに丸めるぶん、暗い値ほど比がぶれる。相対で 5% 以内
  const near = (x, y) => Math.abs(x / y - 1) < 0.05;
  assert.ok(near(lin(r) / lin(g), lin(r0) / lin(g0)) && near(lin(g) / lin(b), lin(g0) / lin(b0)), `${r},${g},${b}`);
});

test('調整（Lightroom 式）: 色温度 + で黄へ・色かぶり + でマゼンタへ。彩度 -100 で灰色、自然な彩度はくすんだ色ほど効く', () => {
  const t = one(G(128), [{ kind: 'temp', value: 100 }]);
  assert.ok(t[0] > 128 && t[2] < 128, '暖かく');
  const m = one(G(128), [{ kind: 'tint', value: 100 }]);
  assert.ok(m[1] < 128 && m[0] === 128, 'マゼンタ寄り（緑が減る）');
  const g = one([200, 100, 50], [{ kind: 'saturation', value: -100 }]);
  assert.ok(g[0] === g[1] && g[1] === g[2]);
  const dull = [150, 130, 120], vivid = [230, 40, 30];
  const spread = (c) => Math.max(...c) - Math.min(...c);
  const gainDull = spread(one(dull, [{ kind: 'vibrance', value: 100 }])) / spread(dull);
  const gainVivid = spread(one(vivid, [{ kind: 'vibrance', value: 100 }])) / spread(vivid);
  assert.ok(gainDull > gainVivid, `くすんだ色 ${gainDull} > 鮮やかな色 ${gainVivid}`);
});

test('調整: 下から順にかかる（露光量で飛ばしてもハイライトで戻せる）・白黒は調整の後', () => {
  const blown = one(G(200), [{ kind: 'exposure', value: 1 }]);
  const back = one(G(200), [{ kind: 'exposure', value: 1 }, { kind: 'highlights', value: -100 }]);
  assert.strictEqual(blown[0], 255, '露光量 +1 で飛ぶ');
  assert.ok(back[0] < 250, `ハイライト -100 で白の内側へ戻る: ${back[0]}`);
  // 飛んだ所どうしの明暗の差も戻る（同じ白に潰れていない）
  const back2 = one(G(170), [{ kind: 'exposure', value: 1 }, { kind: 'highlights', value: -100 }]);
  assert.ok(back2[0] < back[0]);
  assert.notDeepStrictEqual(one([200, 100, 50], [{ kind: 'contrast', value: 100 }, { kind: 'saturation', value: 100 }]),
    one([200, 100, 50], [{ kind: 'saturation', value: 100 }, { kind: 'contrast', value: 100 }]));
  const dark = one([200, 40, 40], [{ kind: 'exposure', value: -1 }], { gray: true });
  assert.ok(dark[0] === dark[1] && dark[0] < one([200, 40, 40], [], { gray: true })[0], '暗くしてから白黒');
  // 斜めの角度でもかかる
  const src = { width: 4, height: 4, data: new Uint8Array(64).fill(128) };
  const sk = renderRGB(src, { rot: 30, adj: [{ kind: 'exposure', value: 5 }], bg: [0, 0, 0] });
  const mid = (Math.floor(sk.height / 2) * sk.width + Math.floor(sk.width / 2)) * 3;
  assert.deepStrictEqual(Array.from(sk.data.subarray(mid, mid + 3)), [255, 255, 255]);
});

test('調整: 前の版の「明度」も読める（+100 で白・-100 で黒）', () => {
  assert.deepStrictEqual(one([200, 100, 50], [{ kind: 'lightness', value: 100 }]), [255, 255, 255]);
  assert.deepStrictEqual(one([200, 100, 50], [{ kind: 'lightness', value: -100 }]), [0, 0, 0]);
});

test('角度は何度で持っても同じ向きになる（-90 と 270、450 と 90）', () => {
  assert.deepStrictEqual(renderRGB(tiny, { rot: -90 }), renderRGB(tiny, { rot: 270 }));
  assert.deepStrictEqual(renderRGB(tiny, { rot: 450 }), renderRGB(tiny, { rot: 90 }));
});

test('明度表示: 同じ明るさの赤と緑は同じ灰色にならない（輝度で変換）', () => {
  const img = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };
  const r = renderRGB(img, { gray: true });
  assert.ok(r.data[3] > r.data[0], `緑 ${r.data[3]} > 赤 ${r.data[0]}`);
  assert.strictEqual(r.data[0], r.data[1]);
  assert.strictEqual(lightness([255, 255, 255]), 100);
  assert.strictEqual(lightness([0, 0, 0]), 0);
  assert.strictEqual(lightness([119, 119, 119]), 50);
});

test('スポイト: 透明は数えず、平均を取る', () => {
  const img = { width: 3, height: 1, data: new Uint8Array([0, 0, 0, 0, 200, 100, 0, 255, 100, 50, 0, 255]) };
  assert.deepStrictEqual(sampleColor(img, 0.1, 0.5, 0), null);
  assert.deepStrictEqual(sampleColor(img, 0.5, 0.5, 1), [150, 75, 0]);
  assert.strictEqual(toHex([255, 16, 0]), 'FF1000');
});

test('base64: Buffer と一致（端数 0/1/2）', () => {
  for (const n of [0, 1, 2, 3, 100, 27650, 27651, 27652]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37) & 255);
    assert.strictEqual(base64(b), Buffer.from(b).toString('base64'), `n=${n}`);
  }
});

console.log(`\ncodec: ${pass} ok / ${fail} NG`);
process.exitCode = fail ? 1 : 0;
