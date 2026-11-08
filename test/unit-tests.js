'use strict';
// 表示の幾何の単体テスト
const assert = require('assert');
const V = require('../lib/view');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok', name); }
  catch (e) { fail++; console.log('  NG', name, '\n    ', e.message); }
}

(async () => {
  const W = 1000, H = 500, vw = 300, vh = 400;

  await test('全体表示は余白 8px を残して窓に収まる', () => {
    const L = V.layout({ ppo: null }, W, H, vw, vh);
    assert.ok(Math.abs(L.width - 284) < 0.01);
    assert.ok(Math.abs(L.left - 8) < 0.01);
  });

  await test('カーソル位置を動かさずに拡大する', () => {
    const v0 = { ppo: null, cx: 0.5, cy: 0.5 };
    const px = 200, py = 210;
    const f0 = V.pointToFraction(v0, W, H, vw, vh, px, py);
    const v1 = V.zoomAt(v0, W, H, vw, vh, 1, px, py);
    const f1 = V.pointToFraction(v1, W, H, vw, vh, px, py);
    assert.ok(Math.abs(f0[0] - f1[0]) < 1e-9 && Math.abs(f0[1] - f1[1]) < 1e-9);
  });

  await test('段階縮小で全体より小さくなったら全体表示に戻る', () => {
    let v = { ppo: 1, cx: 0.5, cy: 0.5 };
    for (let i = 0; i < 20; i++) v = V.stepZoom(v, W, H, vw, vh, -1);
    assert.strictEqual(v.ppo, null);
    v = V.stepZoom(v, W, H, vw, vh, 1);
    assert.ok(v.ppo > V.fitScale(W, H, vw, vh));
  });

  await test('移動しても画像が窓から消えない（48px は残る）', () => {
    let v = { ppo: 1, cx: 0.5, cy: 0.5 };
    v = V.pan(v, W, H, vw, vh, -100000, 100000);
    const L = V.layout(v, W, H, vw, vh);
    assert.ok(L.left + L.width >= 48 - 0.01, '右端が残る');
    assert.ok(L.top <= vh - 48 + 0.01, '上端が残る');
  });

  await test('画像の外は null', () => {
    assert.strictEqual(V.pointToFraction({ ppo: null }, W, H, vw, vh, 2, 2), null);
  });

  console.log(`\nunit: ${pass} ok / ${fail} NG`);
  process.exitCode = fail ? 1 : 0;
})();
