'use strict';
// 表示の幾何（拡大・移動）。画面に依存しない純粋な計算だけ。
//
// 状態 v = { ppo, cx, cy }
//   ppo … 元画像 1 画素あたりの画面の画素数。null なら「全体を表示」（窓の大きさに追従）
//   cx, cy … 窓の中心に来る位置（向きを変えたあとの画像上で 0〜1）
// W, H … 向きを変えたあとの元画像の大きさ（縮小して表示していても元の大きさで数える）

const ZOOM_STEPS = [0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
const MIN = 0.02, MAX = 32;

function fitScale(W, H, vw, vh, margin = 8) {
  if (!W || !H) return 1;
  return Math.max(MIN, Math.min((vw - margin * 2) / W, (vh - margin * 2) / H));
}

function scaleOf(v, W, H, vw, vh) {
  return v.ppo == null ? fitScale(W, H, vw, vh) : v.ppo;
}

// 画像の置き場所（窓の左上からの位置と大きさ）
function layout(v, W, H, vw, vh) {
  const s = scaleOf(v, W, H, vw, vh);
  const cx = v.ppo == null ? 0.5 : v.cx, cy = v.ppo == null ? 0.5 : v.cy;
  const w = W * s, h = H * s;
  return { left: vw / 2 - cx * w, top: vh / 2 - cy * h, width: w, height: h, scale: s };
}

// 窓の中の位置 (px, py) を画像上の 0〜1 へ。画像の外なら null。
function pointToFraction(v, W, H, vw, vh, px, py) {
  const L = layout(v, W, H, vw, vh);
  const fx = (px - L.left) / L.width, fy = (py - L.top) / L.height;
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
  return [fx, fy];
}

// 画面上の (px, py) を動かさずに倍率を newScale にする
function zoomAt(v, W, H, vw, vh, newScale, px = vw / 2, py = vh / 2) {
  const L = layout(v, W, H, vw, vh);
  const s = Math.max(MIN, Math.min(MAX, newScale));
  const fx = (px - L.left) / L.width, fy = (py - L.top) / L.height; // カーソル下の画像位置
  const w = W * s, h = H * s;
  // 新しい配置で fx が px に来るように中心を決める
  const left = px - fx * w, top = py - fy * h;
  return clampCenter({ ppo: s, cx: (vw / 2 - left) / w, cy: (vh / 2 - top) / h }, W, H, vw, vh);
}

// 段階ずつの拡大縮小（ホイール・ボタン）。dir は +1 / -1
function stepZoom(v, W, H, vw, vh, dir, px, py) {
  const s = scaleOf(v, W, H, vw, vh);
  let next;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > s * 1.001) || MAX;
  else next = [...ZOOM_STEPS].reverse().find((z) => z < s / 1.001) || MIN;
  // 全体表示より小さくはしない（迷子にならないように）
  const fit = fitScale(W, H, vw, vh);
  if (dir < 0 && next < fit && s > fit * 1.001) next = fit;
  if (dir < 0 && next < fit) return { ppo: null, cx: 0.5, cy: 0.5 };
  return zoomAt(v, W, H, vw, vh, next, px, py);
}

function pan(v, W, H, vw, vh, dx, dy) {
  const L = layout(v, W, H, vw, vh);
  const base = v.ppo == null ? { ppo: L.scale, cx: 0.5, cy: 0.5 } : v;
  return clampCenter({ ppo: base.ppo, cx: base.cx - dx / L.width, cy: base.cy - dy / L.height }, W, H, vw, vh);
}

// 画像が窓から完全に出てしまわないようにする（少なくとも 48px は残す）
function clampCenter(v, W, H, vw, vh, keep = 48) {
  const w = W * v.ppo, h = H * v.ppo;
  const lim = (c, size, view) => {
    const k = Math.min(keep, size);
    const lo = (k - view / 2) / size; // 画像の左端が窓の右端から k より内側
    const hi = (view / 2 + size - k) / size; // 画像の右端が窓の左端から k より内側
    return Math.max(lo, Math.min(hi, c));
  };
  return { ppo: v.ppo, cx: lim(v.cx, w, vw), cy: lim(v.cy, h, vh) };
}

function percent(v, W, H, vw, vh) {
  return Math.round(scaleOf(v, W, H, vw, vh) * 100);
}

module.exports = { ZOOM_STEPS, fitScale, layout, pointToFraction, zoomAt, stepZoom, pan, clampCenter, percent };
