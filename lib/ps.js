'use strict';
// Photoshop との接点はこのファイルだけに置く。Node（テスト）では ps が null になり、各関数は使えない旨を投げる。
let ps = null;
try { ps = require('photoshop'); } catch (_) { ps = null; }

const available = () => !!ps;
const need = () => { if (!ps) throw new Error('Photoshop の外では使えません'); };

// 描画色を設定する。PS 23 以降は状態の変更に executeAsModal が要る。
async function setForeground([r, g, b]) {
  need();
  const { app, core } = ps;
  await core.executeAsModal(async () => {
    const c = new app.SolidColor();
    c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b;
    app.foregroundColor = c;
  }, { commandName: 'サブビュー: 描画色を設定' });
}

function activeDocument() {
  if (!ps) return null;
  try { return ps.app.activeDocument || null; } catch (_) { return null; }
}

// いま開いている書類を画像として写す（表示されている全レイヤーの合成）。
// maxSide に収まる大きさで受け取るので、大きな書類でも軽い。
async function captureDocument(docId, maxSide = 2048) {
  need();
  const { app, core, imaging } = ps;
  let result = null;
  await core.executeAsModal(async () => {
    const doc = docId ? app.documents.find((d) => d.id === docId) : app.activeDocument;
    if (!doc) throw new Error('書類が開かれていません');
    const dw = Number(doc.width), dh = Number(doc.height);
    const opt = { documentID: doc.id, componentSize: 8, applyAlpha: true, colorSpace: 'RGB' };
    if (Math.max(dw, dh) > maxSide) opt.targetSize = dw >= dh ? { width: maxSide } : { height: maxSide };
    const got = await imaging.getPixels(opt);
    const id = got.imageData;
    try {
      const raw = await id.getData({ chunky: true });
      const { width, height, components } = id;
      const data = new Uint8Array(width * height * 4);
      for (let i = 0, j = 0; i < width * height; i++, j += components) {
        data[i * 4] = raw[j];
        data[i * 4 + 1] = components >= 3 ? raw[j + 1] : raw[j];
        data[i * 4 + 2] = components >= 3 ? raw[j + 2] : raw[j];
        data[i * 4 + 3] = components === 4 || components === 2 ? raw[j + components - 1] : 255;
      }
      result = { id: doc.id, name: doc.title || doc.name || '書類', width, height, data, fullWidth: dw, fullHeight: dh };
    } finally {
      id.dispose();
    }
  }, { commandName: 'サブビュー: キャンバスを写す' });
  return result;
}

// RGB を JPEG の base64 にする（Photoshop の符号化を借りる。PNG より桁違いに小さい）。
async function encodeJpegBase64(rgb, width, height) {
  need();
  const { imaging } = ps;
  if (!imaging || !imaging.createImageDataFromBuffer || !imaging.encodeImageData) throw new Error('imaging API がありません');
  const id = await imaging.createImageDataFromBuffer(rgb, {
    width, height, components: 3, chunky: true, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1',
  });
  try {
    const out = await imaging.encodeImageData({ imageData: id, base64: true });
    return typeof out === 'string' ? out : String(out);
  } finally {
    id.dispose();
  }
}

// 書類が変わったら呼ぶ（筆を置いた・取り消した・書類を切り替えた）。戻り値で解除。
function onDocumentChanged(cb) {
  if (!ps || !ps.action || !ps.action.addNotificationListener) return () => {};
  const events = ['historyStateChanged', 'select', 'open', 'close', 'make', 'delete'];
  const fn = (name) => { try { cb(name); } catch (_) { /* 握りつぶす */ } };
  ps.action.addNotificationListener(events, fn);
  return () => { try { ps.action.removeNotificationListener(events, fn); } catch (_) { /* 無視 */ } };
}

module.exports = { available, setForeground, activeDocument, captureDocument, encodeJpegBase64, onDocumentChanged };
