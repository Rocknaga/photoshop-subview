'use strict';
// サブビュー（Photoshop 用 UXP パネル）
// 資料を並べ、拡大・移動・反転・回転・白黒・調整レイヤーで見ながら、スポイトで描画色に入れる。
// 素材の出どころは 2 つ: 手元のファイル／いまのキャンバス。

const img = require('./lib/imageops');
const { encodePngRGB } = require('./lib/png');
const V = require('./lib/view');
const PS = require('./lib/ps');

let uxp = null;
try { uxp = require('uxp'); } catch (_) { uxp = null; }

const WORK_MAX = 2560; // スポイトと変換表示に使う作業用の大きさ
const RENDER_MAX_JPEG = 2048; // 変換して出すときの上限（PS の JPEG 符号化が使えるとき）
const RENDER_MAX_PNG = 1400; // 同（無圧縮 PNG に落ちたとき。重くなりすぎないように）
const DIRECT_MAX_BYTES = 15 * 1024 * 1024; // これより大きい元ファイルは縮小してから出す
const QUICK_MAX = 480; // 角度のつまみを動かしている間に描く大きさ
const KEEP_WORK = 6; // 復号した画素を持っておく件数
const STORE_KEY = 'subview.state.v1';

// ---------------------------------------------------------------- 保存
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 無視 */ } },
  remove(k) { try { localStorage.removeItem(k); } catch (_) { /* 無視 */ } },
};

// ---------------------------------------------------------------- 状態
const state = {
  items: [], // {uid, src:'file'|'canvas', name, token?, docId?, rot, flip, flipV, gray, view, follow}
  // rot は時計回りの角度（0〜359）。flip / flipV は画面の上での左右・上下反転
  index: -1,
  tool: 'hand',
  radius: 1, // スポイトの平均（0=1px, 1=3x3, 2=5x5）
  swatches: [],
  last: null, // 最後に拾った色
};
// 画面だけで持つもの（保存しない）
const rt = new Map(); // uid → {bytes?, srcUrl?, W, H, work?, thumbUrl?, renderKey?, renderUrl?, loading?, error?}
let uidSeq = 1;

const $ = (id) => document.getElementById(id);
const cur = () => state.items[state.index] || null;
const rtOf = (it) => { if (!rt.has(it.uid)) rt.set(it.uid, {}); return rt.get(it.uid); };

function save() {
  const items = state.items.filter((it) => it.src !== 'canvas').map((it) => ({
    src: it.src, name: it.name, token: it.token,
    rot: it.rot, flip: it.flip, flipV: it.flipV, gray: it.gray, view: it.view, adj: it.adj,
  }));
  const index = Math.max(0, items.findIndex((x) => cur() && x.token === cur().token));
  store.set(STORE_KEY, JSON.stringify({
    items, index, radius: state.radius, swatches: state.swatches,
  }));
}

function restore() {
  try {
    const s = JSON.parse(store.get(STORE_KEY) || 'null');
    if (!s) return;
    state.items = (s.items || []).filter((it) => it.src === 'file').map((it) => ({ ...it, uid: uidSeq++, view: it.view || { ppo: null, cx: 0.5, cy: 0.5 }, adj: Array.isArray(it.adj) ? it.adj : [] }));
    state.index = state.items.length ? Math.min(s.index || 0, state.items.length - 1) : -1;
    if (typeof s.radius === 'number') state.radius = s.radius;
    state.swatches = Array.isArray(s.swatches) ? s.swatches.slice(0, 12) : [];
  } catch (_) { /* 壊れていたら空から */ }
}

// ---------------------------------------------------------------- お知らせ
let statusTimer = null;
function say(msg, ms = 4000) {
  $('status').textContent = msg || '';
  clearTimeout(statusTimer);
  if (msg && ms) statusTimer = setTimeout(() => { $('status').textContent = ''; }, ms);
}
function busy(on) { $('busy').style.display = on ? 'block' : 'none'; }

const idle = () => new Promise((r) => setTimeout(r, 16));
const mimeOf = (bytes) => (img.sniff(bytes) === 'png' ? 'image/png' : 'image/jpeg');
const dataUrl = (bytes) => `data:${mimeOf(bytes)};base64,${img.base64(bytes)}`;

async function encodeForDisplay(rgb) {
  if (PS.available()) {
    try { return 'data:image/jpeg;base64,' + (await PS.encodeJpegBase64(rgb.data, rgb.width, rgb.height)); } catch (_) { /* PNG へ */ }
  }
  return dataUrl(encodePngRGB(rgb.data, rgb.width, rgb.height));
}
const renderMax = () => (PS.available() ? RENDER_MAX_JPEG : RENDER_MAX_PNG);

// ---------------------------------------------------------------- 読み込み
async function readBytes(it) {
  if (it.src === 'file') {
    const fs = uxp.storage.localFileSystem;
    const entry = await fs.getEntryForPersistentToken(it.token);
    const buf = await entry.read({ format: uxp.storage.formats.binary });
    return new Uint8Array(buf);
  }
  throw new Error('読み込み元が不明です');
}

// 表示に要るもの（元の大きさと、出せる絵）をそろえる
async function ensureShown(it) {
  const r = rtOf(it);
  if (r.srcUrl || r.work || r.error) return r;
  if (r.loading) return r.loading;
  r.loading = (async () => {
    try {
      if (it.src === 'canvas') {
        await captureInto(it);
        return r;
      }
      const bytes = await readBytes(it);
      const p = img.probeSize(bytes);
      if (p.type !== 'png' && p.type !== 'jpeg') throw new Error(p.type === 'psd' ? 'PSD は直接読めません（PNG か JPEG に書き出してください）' : 'PNG・JPEG 以外は読めません');
      r.bytes = bytes;
      r.W = p.width; r.H = p.height;
      if (bytes.length <= DIRECT_MAX_BYTES) r.srcUrl = dataUrl(bytes);
      else await ensureWork(it); // 大きすぎるものは縮小して出す
      return r;
    } catch (e) {
      r.error = e.message || String(e);
      return r;
    } finally {
      r.loading = null;
    }
  })();
  return r.loading;
}

// スポイトと変換表示に使う画素（復号は重いので必要になってから・裏で）
async function ensureWork(it) {
  const r = rtOf(it);
  if (r.work) return r.work;
  if (r.decoding) return r.decoding;
  r.decoding = (async () => {
    await idle();
    if (it.src === 'canvas') { await captureInto(it); return r.work; }
    const bytes = r.bytes || (await readBytes(it));
    const full = img.decodeImage(bytes);
    r.work = img.downscale(full, WORK_MAX);
    if (!r.W) { r.W = full.width; r.H = full.height; }
    r.bytes = null; // 元のバイト列は持ち続けない（画素を捨てたら読み直す）
    trimWork(it);
    if (!r.thumbUrl) makeThumb(it).catch(() => {});
    return r.work;
  })();
  try { return await r.decoding; } finally { r.decoding = null; }
}

// 手前と前後だけ画素を持ち、ほかは捨てる（メモリを食わないように）
function trimWork(keepIt) {
  const keep = new Set();
  for (let d = -2; d <= 3; d++) { const it = state.items[state.index + d]; if (it) keep.add(it.uid); }
  keep.add(keepIt.uid);
  let n = 0;
  for (const it of state.items) {
    const r = rt.get(it.uid);
    if (!r || !r.work) continue;
    n++;
    if (!keep.has(it.uid) && n > KEEP_WORK && it.src !== 'canvas') { r.work = null; r.renderUrl = null; r.renderKey = null; }
  }
}

// 並びのサムネイルを裏で 1 枚ずつ用意する（並びを見ただけで探せるように）
let thumbRunning = false;
async function fillThumbs() {
  if (thumbRunning) return;
  thumbRunning = true;
  try {
    for (;;) {
      const it = state.items.find((x) => { const r = rt.get(x.uid); return !(r && (r.thumbUrl || r.thumbFailed)); });
      if (!it) break;
      const r = rtOf(it);
      try {
        if (r.work) {
          await makeThumb(it);
        } else if (it.src === 'file') {
          const bytes = await readBytes(it);
          await idle();
          const t = img.downscale(img.decodeImage(bytes), 112);
          r.thumbUrl = await encodeForDisplay(img.renderRGB(t, { bg: [38, 38, 38] }));
          r.thumbW = t.width; r.thumbH = t.height;
        } else {
          r.thumbFailed = true;
        }
      } catch (_) { r.thumbFailed = true; }
      drawStrip();
      await idle();
    }
  } finally { thumbRunning = false; }
}

async function makeThumb(it) {
  const r = rtOf(it);
  if (r.thumbUrl || !r.work) return;
  const t = img.downscale(r.work, 112);
  r.thumbUrl = await encodeForDisplay(img.renderRGB(t, { bg: [38, 38, 38] }));
  r.thumbW = t.width; r.thumbH = t.height;
  drawStrip();
}

async function captureInto(it) {
  const r = rtOf(it);
  const cap = await PS.captureDocument(it.docId, WORK_MAX);
  it.docId = cap.id;
  it.name = cap.name;
  r.work = cap;
  r.W = cap.fullWidth || cap.width; r.H = cap.fullHeight || cap.height;
  r.srcUrl = null;
  r.renderKey = null; r.renderUrl = null;
  r.thumbUrl = null; r.thumbFailed = false;
  r.error = null;
  makeThumb(it).catch(() => {});
}

// ---------------------------------------------------------------- 表示
// 調整レイヤーは効いているものだけを鍵に入れる（目を消した・0 のものは描き直しの理由にならない）
const adjKey = (it) => img.activeAdj(it.adj).map((a) => a.kind[0] + a.v).join(',');
function variantKey(it) { return `${it.rot}|${it.flip ? 1 : 0}|${it.flipV ? 1 : 0}|${it.gray ? 1 : 0}|${adjKey(it)}`; }
const plain = (it) => !it.rot && !it.flip && !it.flipV && !it.gray && !adjKey(it);

// quick は角度のつまみを動かしている間。小さく描いて手に付いてくるようにし、離したら描き直す
// （2048px を斜めに描くと 1 回に数百ミリ秒かかり、つまみが止まって見える）
async function displayUrl(it, quick = false) {
  const r = rtOf(it);
  if (plain(it) && r.srcUrl) return r.srcUrl;
  const key = variantKey(it);
  if (r.renderUrl && r.renderKey === key) return r.renderUrl;
  if (quick && r.quickUrl && r.quickKey === key) return r.quickUrl;
  const work = await ensureWork(it);
  const src = img.downscale(work, quick ? QUICK_MAX : renderMax());
  const rgb = img.renderRGB(src, { rot: it.rot, flip: it.flip, flipV: it.flipV, gray: it.gray, adj: it.adj, bg: [38, 38, 38] });
  const url = await encodeForDisplay(rgb);
  if (quick) { r.quickUrl = url; r.quickKey = key; } else { r.renderUrl = url; r.renderKey = key; }
  return url;
}

function orientedDims(it) {
  const r = rtOf(it);
  return img.orientedSize(r.W || 1, r.H || 1, it.rot);
}
function stageSize() {
  const s = $('stage');
  return [s.clientWidth || 300, s.clientHeight || 300];
}

let showSeq = 0;
async function show({ quick = false, keepPane = false } = {}) {
  const it = cur();
  const seq = ++showSeq;
  drawBars();
  if (!quick) drawStrip();
  if (!quick && !keepPane) drawAdj();
  const im = $('img');
  if (!it) ensureWheel(false); // 空のときは外す（案内のボタンを押せるように）
  if (!it) {
    im.style.display = 'none';
    $('empty').style.display = 'flex';
    $('name').style.display = 'none';
    return;
  }
  $('empty').style.display = 'none';
  $('name').textContent = it.name || '';
  $('name').style.display = 'block';
  busy(true);
  try {
    const r = await ensureShown(it);
    if (seq !== showSeq) return;
    if (r.error) { im.style.display = 'none'; say(r.error, 0); return; }
    const url = await displayUrl(it, quick);
    if (seq !== showSeq) return;
    if (im.getAttribute('src') !== url) im.setAttribute('src', url);
    im.style.display = 'block';
    place();
    if (quick) return;
    prefetch();
    setTimeout(fillThumbs, 600);
  } catch (e) {
    if (seq === showSeq) say(e.message || String(e), 0);
  } finally {
    if (seq === showSeq) busy(false);
  }
}

// 画像の位置と大きさを窓に合わせる（窓の大きさが変わったときも呼ぶ）
function place() {
  const it = cur();
  ensureWheel(!!it);
  if (!it) return;
  const [W, H] = orientedDims(it);
  const [vw, vh] = stageSize();
  const L = V.layout(it.view, W, H, vw, vh);
  const s = $('img').style;
  s.left = Math.round(L.left) + 'px';
  s.top = Math.round(L.top) + 'px';
  s.width = Math.max(1, Math.round(L.width)) + 'px';
  s.height = Math.max(1, Math.round(L.height)) + 'px';
  const pct = V.percent(it.view, W, H, vw, vh);
  // 打ち込んでいる最中の欄は書き換えない（Enter の前に数字が戻ってしまう）
  if (document.activeElement !== $('zoomv')) $('zoomv').value = `${pct}%`;
  $('zoomr').value = String(zoomToSlider(L.scale));
  setSel('fit', it.view.ppo == null); // 全体表示中は「全体」が点く
}

// 倍率のつまみは対数で並べる（5% から 1600% まで。直線だと 100% より下がほとんど使えない）
const Z_LO = Math.log(0.05), Z_HI = Math.log(16);
function zoomToSlider(sc) { return Math.round(((Math.log(Math.max(0.05, Math.min(16, sc))) - Z_LO) / (Z_HI - Z_LO)) * 1000); }
function sliderToZoom(t) { return Math.exp(Z_LO + (Number(t) / 1000) * (Z_HI - Z_LO)); }

// 角度は -180〜180 で見せる（359° より -1° のほうが分かる）
const signedRot = (r) => (r > 180 ? r - 360 : r);

// 前後の画像を先に読んでおく（送ったときに待たせない）
let prefetchTimer = null;
function prefetch() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(async () => {
    for (const d of [1, -1, 2]) {
      const it = state.items[state.index + d];
      if (!it || it.src === 'canvas') continue;
      try { await ensureShown(it); if (!plain(it)) await displayUrl(it); else await ensureWork(it); } catch (_) { /* 無視 */ }
    }
    // 手前の画像の画素も用意しておく（スポイトを最初の 1 回から待たせない）
    const it = cur();
    if (it) ensureWork(it).catch(() => {});
  }, 250);
}

// 切り替えボタンの「点いている」を見せる。Photoshop の中では selected 属性だけだと見た目がほとんど変わらないので、
// 色を直接付ける（スポイトが点いたままだと、クリックのたびに描画色が変わってしまう）
function setSel(id, on) {
  const el = $(id);
  if (on) el.setAttribute('selected', ''); else el.removeAttribute('selected');
  el.style.backgroundColor = on ? '#2680eb' : '';
  el.style.color = on ? '#ffffff' : '';
}

function drawBars() {
  const it = cur();
  $('pos').textContent = state.items.length ? `${state.index + 1} / ${state.items.length}` : '0 / 0';
  setSel('flip', it && it.flip);
  setSel('flipv', it && it.flipV);
  setSel('gray', it && it.gray);
  setSel('rot0', it && it.rot); // 回っている間は「0°」ボタンが角度を出して点く
  $('rot0').textContent = `${it ? signedRot(it.rot) : 0}°`;
  if (it && document.activeElement !== $('angle')) $('angle').value = String(signedRot(it.rot));
  setSel('picker', state.tool === 'picker');
  setSel('follow', it && it.follow);
  $('follow').style.display = it && it.src === 'canvas' ? 'block' : 'none';
  $('remove').textContent = marked.size ? `${marked.size} 枚外す` : '外す';
  $('stage').className = cursorClass();
  if (!it) $('zoomv').value = '—';
}

function drawStrip() {
  const strip = $('strip');
  strip.innerHTML = '';
  state.items.forEach((it, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell' + (i === state.index ? ' current' : '') + (marked.has(it.uid) ? ' marked' : '') + (it.uid === dragUid ? ' dragging' : '');
    cell.setAttribute('data-i', String(i));
    const r = rt.get(it.uid);
    const url = r && (r.thumbUrl || null);
    if (url) {
      const im = document.createElement('img');
      im.setAttribute('draggable', 'false');
      const [W, H] = [r.thumbW || r.W || 1, r.thumbH || r.H || 1];
      const s = Math.min(56 / W, 56 / H);
      im.style.width = Math.round(W * s) + 'px'; im.style.height = Math.round(H * s) + 'px';
      im.style.left = Math.round((56 - W * s) / 2) + 'px'; im.style.top = Math.round((56 - H * s) / 2) + 'px';
      im.setAttribute('src', url);
      cell.appendChild(im);
    } else {
      const l = document.createElement('div');
      l.className = 'lbl';
      l.textContent = it.name || '';
      cell.appendChild(l);
    }
    const tag = { canvas: '写' }[it.src];
    if (tag) { const t = document.createElement('div'); t.className = 'tag'; t.textContent = tag; cell.appendChild(t); }
    if (marked.has(it.uid)) { const m = document.createElement('div'); m.className = 'mark'; m.textContent = '✓'; cell.appendChild(m); }
    strip.appendChild(cell);
  });
}

function drawSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  state.swatches.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'sw';
    d.style.backgroundColor = `rgb(${c[0]},${c[1]},${c[2]})`;
    d.title = '#' + img.toHex(c);
    d.addEventListener('click', () => applyColor(c, false));
    box.appendChild(d);
  });
}

function drawRadius() { $('radius').textContent = ['1px', '3×3', '5×5'][state.radius]; }

function showColor(c, live) {
  $('chip').style.backgroundColor = c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'transparent';
  $('hex').textContent = c ? `${live ? '…' : ''}#${img.toHex(c)}  L*${img.lightness(c)}` : '';
}

// ---------------------------------------------------------------- 操作
function go(i) {
  if (!state.items.length) return;
  state.index = Math.max(0, Math.min(state.items.length - 1, i));
  const r = rt.get(cur().uid);
  if (r && r.error) r.error = null; // つながらなかったものは開き直したときにもう一度試す
  save();
  show();
}

// 足したものは今の画像のすぐ後ろに入れて、すぐ出す（CLIP STUDIO と同じ。いちばん後ろだと、並びが長いと探しに行くことになる）
function addItems(list, { select = true } = {}) {
  const at = state.index < 0 ? state.items.length : state.index + 1;
  const made = list.map((it) => ({ rot: 0, flip: false, flipV: false, gray: false, adj: [], view: { ppo: null, cx: 0.5, cy: 0.5 }, follow: false, ...it, uid: uidSeq++ }));
  state.items.splice(at, 0, ...made);
  if (select && made.length) state.index = at;
  save();
  show();
  return at;
}

// 並びの中で今の画像を前後へ動かす（Ctrl＋← →）。ドラッグが効かないときの逃げ道でもある
function moveCurrent(d) {
  const i = state.index, j = i + d;
  if (i < 0 || j < 0 || j >= state.items.length) return;
  moveItem(i, j);
}
function moveItem(from, to) {
  if (from === to) return;
  const curUid = cur() && cur().uid;
  const [it] = state.items.splice(from, 1);
  state.items.splice(to, 0, it);
  state.index = Math.max(0, state.items.findIndex((x) => x.uid === curUid));
  save();
  drawBars();
  drawStrip();
}

// 印（Ctrl＋クリック）が付いていれば、印のものをまとめて外す。無ければ今の画像だけ
const marked = new Set(); // uid。保存しない（開き直したら印は消える）
function removeCurrent() {
  const it = cur();
  if (!it) return;
  const many = marked.size > 0;
  const gone = many ? state.items.filter((x) => marked.has(x.uid)) : [it];
  const curUid = it.uid;
  const keepIndex = state.index;
  for (const x of gone) rt.delete(x.uid);
  state.items = state.items.filter((x) => !gone.includes(x));
  marked.clear();
  // 今の画像が残っていればそのまま、外れたら同じ位置（無ければひとつ前）を出す
  const still = state.items.findIndex((x) => x.uid === curUid);
  state.index = still >= 0 ? still : Math.min(keepIndex, state.items.length - 1);
  if (!state.items.length) state.index = -1;
  save();
  show();
  say(many ? `${gone.length} 枚を並びから外しました（元のファイルはそのまま）` : `「${it.name}」を並びから外しました（元のファイルはそのまま）`);
}

function toggleMark(i) {
  const it = state.items[i];
  if (!it) return;
  if (marked.has(it.uid)) marked.delete(it.uid); else marked.add(it.uid);
  drawStrip();
  drawBars();
  if (marked.size) say(`${marked.size} 枚に印。「外す」でまとめて外します（Ctrl＋クリックで印を外す）`, 5000);
}

function toggle(prop) {
  const it = cur();
  if (!it) return;
  it[prop] = !it[prop];
  // 反転は画面の上でかかるので、見ていた場所は窓の中で鏡写しになるだけ
  if (prop === 'flip' && it.view.ppo != null) it.view = { ...it.view, cx: 1 - it.view.cx };
  if (prop === 'flipV' && it.view.ppo != null) it.view = { ...it.view, cy: 1 - it.view.cy };
  save();
  show();
}

// 角度を変える。拡大して見ているときは、窓の真ん中にあった場所を真ん中に保つ（CLIP STUDIO と同じ。
// 全体に戻すと、細部を見ながら傾きを合わせられない）。全体表示のときは全体表示のまま（傾けても全部見える）
function setAngle(deg) {
  const it = cur();
  if (!it) return false;
  const next = img.normRot(deg);
  if (next === it.rot) return false;
  const r = rtOf(it);
  const w = r.W || 1, h = r.H || 1;
  if (it.view.ppo != null) {
    const [W0, H0] = orientedDims(it);
    const [vw, vh] = stageSize();
    const L = V.layout(it.view, W0, H0, vw, vh);
    const [u, v] = img.viewToSource((vw / 2 - L.left) / L.width, (vh / 2 - L.top) / L.height, it.rot, it.flip, it.flipV, w, h);
    const [cx, cy] = img.sourceToView(u, v, next, it.flip, it.flipV, w, h);
    it.rot = next;
    const [W1, H1] = orientedDims(it);
    it.view = V.clampCenter({ ppo: it.view.ppo, cx, cy }, W1, H1, vw, vh);
  } else {
    it.rot = next;
  }
  return true;
}
function rotateTo(deg) {
  if (!setAngle(deg)) { drawBars(); return; }
  save();
  show();
}
// ボタンとキーは 15° ずつ。半端な角度からでも 15° の目に乗せる
function rotateBy(step) {
  const it = cur();
  if (!it) return;
  const a = signedRot(it.rot);
  rotateTo(step > 0 ? Math.floor(a / 15) * 15 + 15 : Math.ceil(a / 15) * 15 - 15);
}
// つまみは 0°・±90°・180° の近く（3° 以内）で止める（真っすぐに戻したいときに合わせやすく）
function snapAngle(a) {
  const n = Math.round(a / 90) * 90;
  return Math.abs(a - n) <= 3 ? n : Math.round(a);
}

// つまみを動かしている間は小さく描き、追いつかない分は飛ばす（最後の角度だけ描く）
let angleBusy = false, angleWant = null;
async function dragAngle(a) {
  angleWant = a;
  if (angleBusy) return;
  angleBusy = true;
  try {
    while (angleWant != null) {
      const v = angleWant;
      angleWant = null;
      if (setAngle(v)) await show({ quick: true });
      await idle();
    }
  } finally { angleBusy = false; }
}
async function endAngle(a) {
  angleWant = null;
  while (angleBusy) await idle();
  setAngle(a);
  save();
  show();
}

function zoomStep(dir, px, py) {
  const it = cur();
  if (!it) return;
  const [W, H] = orientedDims(it);
  const [vw, vh] = stageSize();
  it.view = V.stepZoom(it.view, W, H, vw, vh, dir, px, py);
  place();
  saveSoon();
}
function zoomTo(ppo) {
  const it = cur();
  if (!it) return;
  if (ppo == null) it.view = { ppo: null, cx: 0.5, cy: 0.5 };
  else {
    const [W, H] = orientedDims(it);
    const [vw, vh] = stageSize();
    it.view = V.zoomAt(it.view, W, H, vw, vh, ppo);
  }
  place();
  saveSoon();
}

let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }

async function applyColor(c, remember = true) {
  state.last = c;
  showColor(c);
  if (remember) {
    state.swatches = [c, ...state.swatches.filter((s) => img.toHex(s) !== img.toHex(c))].slice(0, 12);
    drawSwatches();
    saveSoon();
  }
  if (!PS.available()) { say(`#${img.toHex(c)}（Photoshop の外なので描画色には入れていません）`); return; }
  try {
    await PS.setForeground(c);
    say(`描画色 #${img.toHex(c)}  L*${img.lightness(c)}`);
  } catch (e) {
    say('描画色を変えられませんでした: ' + (e.message || e) + '（描画中や書類が無いときは失敗します）', 6000);
  }
}

// 窓の中の位置の色（表示の向きを戻して元画像から拾う）
function colorAt(px, py) {
  const it = cur();
  if (!it) return null;
  const r = rtOf(it);
  if (!r.work) return null;
  const [W, H] = orientedDims(it);
  const [vw, vh] = stageSize();
  const f = V.pointToFraction(it.view, W, H, vw, vh, px, py);
  if (!f) return null;
  const [u, v] = img.viewToSource(f[0], f[1], it.rot, it.flip, it.flipV, r.W || 1, r.H || 1);
  if (u < 0 || v < 0 || u > 1 || v > 1) return null; // 傾けたときの隅（絵の外）
  return img.sampleColor(r.work, u, v, state.radius);
}

async function pickAt(px, py) {
  const it = cur();
  if (!it) return;
  const r = rtOf(it);
  if (!r.work) {
    busy(true);
    try { await ensureWork(it); } catch (e) { say(e.message || String(e)); return; } finally { busy(false); }
  }
  const c = colorAt(px, py);
  if (!c) { say('画像の外です'); return; }
  await applyColor(c);
}

// ---- ファイル
async function addFiles() {
  if (!uxp) { say('Photoshop の外では使えません'); return; }
  const fs = uxp.storage.localFileSystem;
  let files;
  try {
    files = await fs.getFileForOpening({ allowMultiple: true, types: ['png', 'jpg', 'jpeg'] });
  } catch (e) { say('ファイルを開けませんでした: ' + (e.message || e)); return; }
  if (!files) return;
  if (!Array.isArray(files)) files = [files];
  if (!files.length) return;
  const list = [];
  for (const f of files) {
    try {
      const token = await fs.createPersistentToken(f);
      list.push({ src: 'file', name: f.name, token });
    } catch (e) { say(`「${f.name}」: ${e.message || e}`); }
  }
  addItems(list);
  if (list.length > 1) say(`${list.length} 枚を足しました（← → で送れます）`);
}

// ---- キャンバス
async function addCanvas() {
  if (!PS.available()) { say('Photoshop の外では使えません'); return; }
  const doc = PS.activeDocument();
  if (!doc) { say('書類が開かれていません'); return; }
  const it = { src: 'canvas', name: doc.title || doc.name || 'キャンバス', docId: doc.id, follow: true };
  addItems([it]);
  say('キャンバスを写しました。「追従」が点いている間は描くたびに写し直します。反転・明度で狂いと値を確かめられます', 7000);
}

let followTimer = null, followBusy = false, followAgain = false;
function onPsChange() {
  const it = cur();
  if (!it || it.src !== 'canvas' || !it.follow || !panelVisible) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(refollow, 900); // 描いている最中に何度も写さない
}
async function refollow() {
  const it = cur();
  if (!it || it.src !== 'canvas' || !it.follow) return;
  if (followBusy) { followAgain = true; return; }
  followBusy = true;
  try {
    await captureInto(it);
    if (cur() === it) {
      const url = await displayUrl(it);
      $('img').setAttribute('src', url);
      $('img').style.display = 'block';
      place();
    }
  } catch (e) {
    // 描画中など Photoshop が手を離せないときは少し後でもう一度
    if (/modal|busy|モーダル/i.test(String(e && e.message))) { followTimer = setTimeout(refollow, 1500); }
  } finally {
    followBusy = false;
    if (followAgain) { followAgain = false; onPsChange(); }
  }
}

// ---------------------------------------------------------------- 表示面のマウス
function wireStage() {
  const stage = $('stage');
  let down = null; // {x, y, view, moved, alt, id}
  let lastClick = 0;
  const pos = (e) => {
    const b = stage.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  const usePointer = typeof window.PointerEvent !== 'undefined';
  const DOWN = usePointer ? 'pointerdown' : 'mousedown';
  const MOVE = usePointer ? 'pointermove' : 'mousemove';
  const UP = usePointer ? 'pointerup' : 'mouseup';

  // Photoshop（UXP）では、ホイールの受け口（スクロールする見えない箱）が押し下げを吸い取り、
  // pointerdown も mousedown も来ない。来るのは「押したまま動いた」（buttons=1 の move）と「離した」だけ
  // （2026-10-13、PS 26.11 で記録して確認）。なので押し下げが無くても、最初の move か離したときに始まりとみなす
  const begin = (e) => {
    const it = cur();
    if (!it) return false;
    const [x, y] = pos(e);
    down = { x, y, view: { ...it.view }, moved: false, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, middle: e.button === 1 };
    try { if (e.pointerId != null) stage.setPointerCapture(e.pointerId); } catch (_) { /* 無視 */ }
    return true;
  };
  stage.addEventListener(DOWN, begin);
  stage.addEventListener(MOVE, (e) => {
    const [x, y] = pos(e);
    lastPos = [x, y];
    setAlt(!!e.altKey);
    drawDropper();
    const it = cur();
    if (!it) return;
    if (!down && (e.buttons & 1)) begin(e);
    if (down) {
      const dx = x - down.x, dy = y - down.y;
      if (!down.moved && Math.abs(dx) + Math.abs(dy) > 3) { down.moved = true; stage.className = 'panning'; }
      if (down.moved) {
        const [W, H] = orientedDims(it);
        const [vw, vh] = stageSize();
        it.view = V.pan(down.view, W, H, vw, vh, dx, dy);
        place();
      }
      return;
    }
    // スポイト中は、拾う前の色を見せる（決める前に確かめられる）
    if (state.tool === 'picker' || e.altKey) {
      const c = colorAt(x, y);
      if (c) showColor(c, true);
    }
  });
  const end = (e) => {
    if (!down && !begin(e)) return; // 押し下げが来ていないクリック（上の注）
    if (!down) return;
    const d = down;
    down = null;
    stage.className = cursorClass();
    if (d.moved) { saveSoon(); return; }
    const [x, y] = pos(e);
    const now = Date.now();
    // Ctrl＋クリックで拡大、Ctrl＋Alt＋クリックで縮小（CLIP STUDIO と同じ）。Alt だけなら色を拾うので、Ctrl を先に見る
    if (d.ctrl || e.ctrlKey || e.metaKey) { zoomStep(d.alt || e.altKey ? -1 : 1, x, y); lastClick = 0; return; }
    if (state.tool === 'picker' || d.alt || e.altKey) { pickAt(x, y); lastClick = 0; return; }
    // ダブルクリックの間隔は 400 ミリ秒まで。長くすると、別々のクリックが続いただけで全体に戻ってしまう
    if (now - lastClick < 400) {
      // ダブルクリックはいつでも全体表示に戻す（利用者の指定。迷子になったときの戻り道。
      // 前は「全体 ⇔ 等倍」の切り替えだったが、拡大中に押すと等倍へ飛んでしまい戻り道にならなかった）。等倍は 100% ボタンか 1
      lastClick = 0;
      zoomTo(null);
      return;
    }
    lastClick = now;
    // Photoshop（UXP）では、ホイールの受け口（見えないスクロール箱）がダブルクリックの 2 回目を丸ごと吸い取る
    // （2026-10-13 に記録して確認。ダブルクリック 1 回につき「離した」が 1 回しか届かない）。
    // なのでクリックの直後だけ受け口を外し、2 回目を絵の面で直に受ける。その間（0.5 秒）はホイールが効かない
    clickPause();
  };
  stage.addEventListener(UP, end);
  // dblclick はブラウザ用（Photoshop の中では一度も来なかった。2 回目は clickPause で受ける）。
  // ブラウザでは「離した」2 回と両方来るが、全体表示を 2 回しても同じなので構わない
  stage.addEventListener('dblclick', (e) => {
    if (!cur() || state.tool === 'picker' || e.altKey || e.ctrlKey || e.metaKey) return;
    lastClick = 0;
    zoomTo(null);
  });
  stage.addEventListener('dragstart', (e) => { if (e.preventDefault) e.preventDefault(); }); // 画像のドラッグ＆ドロップを始めさせない
  stage.addEventListener(usePointer ? 'pointercancel' : 'mouseleave', () => { if (down) { down = null; stage.className = cursorClass(); } });
  // 窓から出たらスポイトの絵を隠す（窓の端に取り残される）
  const leave = () => { lastPos = null; drawDropper(); };
  stage.addEventListener('pointerleave', leave);
  stage.addEventListener('mouseleave', leave);
  // ブラウザでは wheel が来る（受け口のスクロールは止める）
  stage.addEventListener('wheel', (e) => {
    if (!cur()) return;
    if (e.preventDefault) e.preventDefault();
    const [x, y] = pos(e);
    zoomStep(e.deltaY < 0 ? 1 : -1, x, y);
  });
}

// ---- ホイール
// Photoshop（UXP）では wheel イベントが来ない（2026-10-09、PS 26.11 で確認）。代わりに、スクロールできる見えない箱を
// 画像の上に重ね、その箱のスクロール量を拡大縮小に読み替える（1 目盛りでおよそ 100px 動く）。
// UXP の癖（同日に確認）:
//   - HTML に書いた箱・パネルの配置が決まる前に作った箱は、高さ 0 のままでスクロールしない → 窓に大きさが付いてから作る
//   - display を切り替えると高さ 0 に戻る → 隠すときは取り外し、要るときに作り直す
//   - opacity は効かない。背景なしでもスクロールは受け取れる
const WHEEL_MID = 10000;
let lastPos = null; // 最後にカーソルがあった位置（ホイールで寄せる中心）

let wheelPausedUntil = 0;
function clickPause() {
  const sink = $('wheel');
  if (!sink) return;
  wheelPausedUntil = Date.now() + 500;
  sink.remove();
  setTimeout(() => { if (Date.now() >= wheelPausedUntil) ensureWheel(!!cur()); }, 520);
}

function ensureWheel(want) {
  if (want && Date.now() < wheelPausedUntil) return; // クリックの直後は外したまま（clickPause）
  const stage = $('stage');
  let sink = $('wheel');
  if (!want || !stage.clientHeight) { if (sink && !want) sink.remove(); return; }
  if (sink && sink.clientHeight > 0) {
    if (Math.abs(sink.scrollTop - WHEEL_MID) >= 1) sink.scrollTop = WHEEL_MID;
    return;
  }
  if (sink) sink.remove(); // 高さ 0 のまま固まったものは作り直す
  sink = document.createElement('div');
  sink.id = 'wheel';
  sink.style.cssText = 'position:absolute;left:0;top:0;right:-24px;bottom:0;overflow-x:hidden;overflow-y:scroll';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:10px;height:20000px';
  sink.appendChild(inner);
  stage.insertBefore(sink, $('empty')); // 画像の上・案内（空のとき）の下
  sink.addEventListener('scroll', () => {
    const d = sink.scrollTop - WHEEL_MID;
    if (Math.abs(d) < 1) return;
    sink.scrollTop = WHEEL_MID; // 真ん中へ戻す（これで来る scroll は d = 0 なので無視される）
    if (!cur()) return;
    const n = Math.max(1, Math.min(3, Math.round(Math.abs(d) / 100)));
    const [x, y] = lastPos || [];
    for (let i = 0; i < n; i++) zoomStep(d < 0 ? 1 : -1, x, y);
  });
  setTimeout(() => { sink.scrollTop = WHEEL_MID; }, 0);
}

// 窓の大きさが変わったら置き直す（UXP では resize が来ないことがあるので見回る）
let lastSize = '';
let panelVisible = true;
function watchSize() {
  setInterval(() => {
    if (!panelVisible) return;
    const s = stageSize().join('x');
    if (s !== lastSize) { lastSize = s; place(); }
  }, 300);
}

// ---- カーソル
// スポイトを点けている間と、Alt を押している間は、絵の上のカーソルをスポイトの形にする
// （Alt＋クリックで色を拾うのに、押す前に「拾える状態か」が見えないと、手の形のままで不安になる）。
// Alt は、キーの知らせ（パネルにフォーカスがあるときだけ来る）と、マウスの合図に付いてくる altKey の両方で見る
let altHeld = false;
const cursorClass = () => (state.tool === 'picker' || altHeld ? 'picker' : '');
// Photoshop（UXP）のパネルは CSS の cursor を受け付けない（十字も絵も出ない。2026-10-13 に実機で確認）。
// なのでスポイトの絵をマウスの先に重ねて動かす。先（拾う所）は絵の左下 (2, 22)。ドラッグで動かしている間は出さない
const DROP_TIP = [2, 22];
function drawDropper() {
  const d = $('dropper');
  if (!d) return;
  const st = $('stage');
  const on = (state.tool === 'picker' || altHeld) && lastPos && cur() && st.className !== 'panning';
  d.style.display = on ? 'block' : 'none';
  if (on) { d.style.left = Math.round(lastPos[0] - DROP_TIP[0]) + 'px'; d.style.top = Math.round(lastPos[1] - DROP_TIP[1]) + 'px'; }
}
function setAlt(on) {
  if (altHeld === on) return;
  altHeld = on;
  const st = $('stage');
  if (st.className !== 'panning') st.className = cursorClass();
  drawDropper();
}
function wireAlt() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Alt') setAlt(true); });
  document.addEventListener('keyup', (e) => { if (e.key === 'Alt') setAlt(false); });
  window.addEventListener('blur', () => setAlt(false)); // 押したまま別の窓へ移ったとき、形が戻らなくなるのを防ぐ
}

// ---- 並び（下の帯）
// 押すと送る・Ctrl＋クリックで印・横へドラッグで並べ替え。押し下げは帯で受ける
// （並べ替えのたびに帯を描き直すので、こまの側で受けると途中で受け手が消える）
let dragUid = null;
function wireStrip() {
  const strip = $('strip');
  const usePointer = typeof window.PointerEvent !== 'undefined';
  const DOWN = usePointer ? 'pointerdown' : 'mousedown';
  const MOVE = usePointer ? 'pointermove' : 'mousemove';
  const UP = usePointer ? 'pointerup' : 'mouseup';
  let drag = null;
  const cellIndex = (t) => {
    for (; t && t !== strip; t = t.parentNode) {
      const v = t.getAttribute && t.getAttribute('data-i');
      if (v != null) return Number(v);
    }
    return -1;
  };
  // カーソルの横位置にいちばん近いこまの番号
  const slotAt = (x) => {
    const cells = strip.querySelectorAll('.cell');
    let best = -1, bd = Infinity;
    cells.forEach((c, i) => { const b = c.getBoundingClientRect(); const d = Math.abs(b.left + b.width / 2 - x); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  strip.addEventListener(DOWN, (e) => {
    const i = cellIndex(e.target);
    if (i < 0 || !state.items[i]) return;
    drag = { i, x: e.clientX, moved: false, ctrl: e.ctrlKey || e.metaKey };
    try { if (e.pointerId != null) strip.setPointerCapture(e.pointerId); } catch (_) { /* 無視 */ }
  });
  strip.addEventListener(MOVE, (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) > 6) {
      drag.moved = true;
      dragUid = state.items[drag.i].uid;
      drawStrip();
    }
    if (!drag.moved) return;
    const j = slotAt(e.clientX);
    if (j >= 0 && j !== drag.i) { moveItem(drag.i, j); drag.i = j; }
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) { dragUid = null; drawStrip(); return; }
    if (d.ctrl) toggleMark(d.i); else go(d.i);
  };
  strip.addEventListener(UP, end);
  // こまの絵をつかむと、ブラウザが絵のドラッグを始めて押し下げを取り消してしまう（並べ替えが途中で止まる）
  strip.addEventListener('dragstart', (e) => { if (e.preventDefault) e.preventDefault(); });
  strip.addEventListener(usePointer ? 'pointercancel' : 'mouseleave', () => { if (drag && drag.moved) { dragUid = null; drawStrip(); } drag = null; });
}

// ---- 調整レイヤー（明度・彩度）
// Photoshop の調整レイヤーと同じ並べ方: 配列の後ろ（画面では上）ほど後からかかる。画像ごとに持ち、元の画素は変えない。
// つまみを動かしている間は小さく描き（角度と同じ）、離したら描き直す。動かしている間は行を作り直さない
// （作り直すと、つかんでいるつまみが消えてドラッグが切れる）
const ADJ_SPEC = img.ADJ_SPEC;
const adjName = (kind) => (ADJ_SPEC[kind] ? ADJ_SPEC[kind].name : kind);
// 値の見せかた（Lightroom と同じ: 露光量は小数 2 桁、ほかは整数。+ を付ける）
const adjText = (a) => { const sp = ADJ_SPEC[a.kind] || {}; const v = Number(a.value) || 0; return (v > 0 ? '+' : '') + (sp.digits ? v.toFixed(sp.digits) : String(Math.round(v))); };
let adjSeq = 1;
let liveBusy = false, liveAgain = false;
async function liveShow() {
  if (liveBusy) { liveAgain = true; return; }
  liveBusy = true;
  try {
    do { liveAgain = false; await show({ quick: true }); await idle(); } while (liveAgain);
  } finally { liveBusy = false; }
}
async function settleShow() {
  while (liveBusy) await idle();
  save();
  await show({ keepPane: true });
  drawAdjBtn();
}

function drawAdjBtn() {
  const it = cur();
  const n = it ? img.activeAdj(it.adj).length : 0;
  $('adjBtn').textContent = n ? `調整 ${n}` : '調整';
  setSel('adjBtn', $('adjpane').classList.contains('open') || n > 0);
}

function selEl(el, on) {
  el.style.backgroundColor = on ? '#2680eb' : '';
  el.style.color = on ? '#ffffff' : '';
}

function drawAdj() {
  const list = $('adj-list');
  list.innerHTML = '';
  const it = cur();
  drawAdjBtn();
  if (!it) return;
  const adj = it.adj || (it.adj = []);
  if (!adj.length) {
    const e = document.createElement('div');
    e.className = 'adj-row dim small';
    e.textContent = 'まだありません。下の「＋明度」「＋彩度」で足します';
    list.appendChild(e);
    return;
  }
  // 上にあるもの（配列の後ろ）から並べる
  for (let i = adj.length - 1; i >= 0; i--) {
    const a = adj[i];
    const row = document.createElement('div');
    row.className = 'adj-row' + (a.on === false ? ' off' : '');
    row.setAttribute('data-adj', String(a.id));
    const eye = document.createElement('sp-action-button');
    eye.setAttribute('quiet', '');
    eye.className = 'adj-eye';
    eye.textContent = a.on === false ? '○' : '●';
    eye.title = '効かせる／止める（消さずに比べられる）';
    selEl(eye, a.on !== false);
    eye.addEventListener('click', () => { a.on = a.on === false; drawAdj(); settleShow(); });
    const name = document.createElement('span');
    name.className = 'adj-name';
    name.textContent = adjName(a.kind);
    name.title = adjName(a.kind);
    const sp = ADJ_SPEC[a.kind] || { min: -100, max: 100, step: 1 };
    const r = document.createElement('input');
    r.type = 'range'; r.className = 'slider adj-range';
    r.min = String(sp.min); r.max = String(sp.max); r.step = String(sp.step); r.value = String(a.value || 0);
    r.title = `${name.textContent}（ダブルクリックで 0）`;
    const v = document.createElement('span');
    v.className = 'adj-v num';
    const label = () => { v.textContent = adjText(a); };
    label();
    r.addEventListener('input', () => { a.value = Number(r.value); label(); drawAdjBtn(); liveShow(); });
    r.addEventListener('change', () => { a.value = Number(r.value); label(); drawAdjBtn(); settleShow(); });
    // ダブルクリックで 0 に戻す（ほかのつまみと同じ。UXP では dblclick が来ないことがあるので離した間隔でも見る）
    let last = 0;
    const zero = () => { a.value = 0; r.value = '0'; label(); settleShow(); };
    r.addEventListener('dblclick', zero);
    for (const t of ['pointerup', 'mouseup']) r.addEventListener(t, () => { const now = Date.now(); if (now - last < 350) { last = 0; zero(); } else last = now; });
    const up = document.createElement('sp-action-button');
    up.setAttribute('quiet', '');
    up.className = 'adj-up';
    up.textContent = '▲';
    up.title = '上へ（後からかかる）';
    if (i === adj.length - 1) up.style.visibility = 'hidden';
    up.addEventListener('click', () => { if (i < adj.length - 1) { [adj[i], adj[i + 1]] = [adj[i + 1], adj[i]]; drawAdj(); settleShow(); } });
    const del = document.createElement('sp-action-button');
    del.setAttribute('quiet', '');
    del.className = 'adj-del';
    del.textContent = '×';
    del.title = 'この調整レイヤーを消す';
    del.addEventListener('click', () => { adj.splice(i, 1); drawAdj(); settleShow(); });
    row.appendChild(eye); row.appendChild(name); row.appendChild(r); row.appendChild(v); row.appendChild(up); row.appendChild(del);
    list.appendChild(row);
  }
}

function addAdj(kind) {
  const it = cur();
  if (!it) { say('先に画像を足してください'); return; }
  (it.adj || (it.adj = [])).push({ id: adjSeq++, kind, value: 0, on: true });
  $('adjpane').classList.add('open');
  drawAdj();
  save();
  say(`${adjName(kind)}の調整レイヤーを足しました。つまみで強さを変えます（拾う色は元の色のまま）`);
}

function wireAdj() {
  $('adjBtn').addEventListener('click', () => {
    $('adjpane').classList.toggle('open');
    drawAdj();
    place(); // 表示面の高さが変わる
  });
  // 足す一覧は Lightroom の基本補正の並び（前の版の「明度」は読むだけで、ここには出さない）
  const sel = $('adj-add');
  const opts = [['', '＋ 調整を足す…'], ...Object.keys(ADJ_SPEC).filter((k) => !ADJ_SPEC[k].legacy).map((k) => [k, ADJ_SPEC[k].name])];
  sel.innerHTML = '';
  for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); }
  sel.value = '';
  sel.addEventListener('change', () => { const k = sel.value; sel.value = ''; if (k) addAdj(k); });
}

// ---------------------------------------------------------------- キー
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key;
    if (k === 'ArrowRight' && !e.ctrlKey) go(state.index + 1);
    else if (k === 'ArrowLeft' && !e.ctrlKey) go(state.index - 1);
    else if ((k === 'ArrowRight' || k === 'ArrowLeft') && e.ctrlKey) moveCurrent(k === 'ArrowRight' ? 1 : -1);
    else if (k === 'h' || k === 'H') toggle('flip');
    else if (k === 'v' || k === 'V') toggle('flipV');
    else if (k === 'g' || k === 'G') toggle('gray');
    else if (k === 'r') rotateBy(15);
    else if (k === 'R') rotateBy(e.shiftKey ? -15 : 15);
    else if (k === 'i' || k === 'I') setTool(state.tool === 'picker' ? 'hand' : 'picker');
    else if (k === '0') zoomTo(null);
    else if (k === '1') zoomTo(1);
    else if (k === '+' || k === '=') zoomStep(1);
    else if (k === '-') zoomStep(-1);
    else return;
    if (e.preventDefault) e.preventDefault();
  });
}

function setTool(t) {
  state.tool = t;
  drawBars();
  drawDropper();
  if (t === 'picker') {
    const it = cur();
    if (it) ensureWork(it).catch(() => {});
    say('クリックで描画色に入れます。拾う前に下の色見本で確かめられます（Alt＋クリックはいつでも使えます）', 5000);
  }
}

// ---------------------------------------------------------------- 起動
function wireButtons() {
  $('prev').addEventListener('click', () => go(state.index - 1));
  $('next').addEventListener('click', () => go(state.index + 1));
  $('flip').addEventListener('click', () => toggle('flip'));
  $('flipv').addEventListener('click', () => toggle('flipV'));
  $('rot').addEventListener('click', () => rotateBy(15));
  $('rotl').addEventListener('click', () => rotateBy(-15));
  $('rot0').addEventListener('click', () => rotateTo(0));
  // UXP の range が動かしている間に input を出すかは版による。change だけでも、離したときに描けば済む
  // つまみはダブルクリックで初めの値に戻す（角度は 0°、倍率は全体表示）。
  // 戻したあとに 1 回目・2 回目のクリックの change が遅れて来て値を上書きするので、少しの間それを無視する
  let sliderHold = 0;
  const resetOnDouble = (el, reset) => {
    let last = 0;
    const fire = () => {
      sliderHold = Date.now() + 400;
      reset();
      el.blur && el.blur();
    };
    el.addEventListener('dblclick', fire);
    // UXP では dblclick が来ないことがあるので、離した間隔でも見る
    for (const t of ['pointerup', 'mouseup']) {
      el.addEventListener(t, () => {
        const now = Date.now();
        if (now - last < 350) { last = 0; fire(); } else last = now;
      });
    }
  };
  const held = () => Date.now() < sliderHold;
  resetOnDouble($('angle'), () => { angleWant = null; $('angle').value = '0'; rotateTo(0); });
  resetOnDouble($('zoomr'), () => zoomTo(null));
  $('angle').addEventListener('input', (e) => { if (!held()) dragAngle(snapAngle(Number(e.target.value))); });
  $('angle').addEventListener('change', (e) => { if (!held()) endAngle(snapAngle(Number(e.target.value))); else { e.target.value = String(signedRot(cur() ? cur().rot : 0)); } });
  const zoomSlide = (e) => { if (!held()) zoomTo(sliderToZoom(e.target.value)); else place(); };
  $('zoomr').addEventListener('input', zoomSlide);
  $('zoomr').addEventListener('change', zoomSlide);
  // 倍率を打ち込む（「150」「150%」どちらでも）。読めない値なら元の表示に戻す
  const zoomTyped = () => {
    const n = parseFloat(String($('zoomv').value).replace(/[^0-9.]/g, ''));
    if (n > 0) zoomTo(Math.max(0.02, Math.min(32, n / 100)));
    $('zoomv').blur();
    place();
  };
  $('zoomv').addEventListener('change', zoomTyped);
  $('zoomv').addEventListener('keydown', (e) => { if (e.key === 'Enter') zoomTyped(); else if (e.key === 'Escape') { $('zoomv').blur(); place(); } });
  $('gray').addEventListener('click', () => toggle('gray'));
  wireAdj();
  $('picker').addEventListener('click', () => setTool(state.tool === 'picker' ? 'hand' : 'picker'));
  $('fit').addEventListener('click', () => zoomTo(null));
  $('z100').addEventListener('click', () => zoomTo(1));
  $('zin').addEventListener('click', () => zoomStep(1));
  $('zout').addEventListener('click', () => zoomStep(-1));
  $('radius').addEventListener('click', () => {
    // スポイトの範囲を切り替える（1 画素 → 3×3 → 5×5）。ノイズや網点の多い資料では平均が効く
    state.radius = (state.radius + 1) % 3;
    drawRadius();
    say(`スポイトの範囲: ${['1 画素', '3×3 の平均', '5×5 の平均'][state.radius]}`);
    saveSoon();
  });
  $('addFile').addEventListener('click', addFiles);
  $('e-file').addEventListener('click', addFiles);
  $('addCanvas').addEventListener('click', addCanvas);
  $('e-canvas').addEventListener('click', addCanvas);
  $('remove').addEventListener('click', removeCurrent);
  $('follow').addEventListener('click', () => {
    const it = cur();
    if (!it || it.src !== 'canvas') return;
    it.follow = !it.follow;
    drawBars();
    if (it.follow) refollow();
    say(it.follow ? '描くたびに写し直します' : '写し直しを止めました（いまの状態のまま見られます）');
  });
}

function init() {
  restore();
  wireButtons();
  wireStage();
  wireStrip();
  wireAlt();
  wireKeys();
  watchSize();
  drawSwatches();
  drawRadius();
  PS.onDocumentChanged(onPsChange);
  show();
}

if (uxp && uxp.entrypoints) {
  uxp.entrypoints.setup({
    panels: {
      subview: {
        show() { panelVisible = true; place(); },
        hide() { panelVisible = false; },
      },
    },
  });
}
init();
