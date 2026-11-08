# Subview for Photoshop

[日本語](README.md) | English

A Photoshop panel that works like the **Sub View** palette in CLIP STUDIO PAINT.
Line up your reference images, look at them **zoomed, rotated, flipped, in grayscale, or with exposure and color adjustments**, and **pick colors straight into your foreground color**.

- Requires **Photoshop 2024 (25.0) or later** on Windows (tested with Photoshop 2025 and 2026)
- Never goes online (the plugin does not request network access)
- Only reads the image files you open; it never writes to them

## Install

1. Download **`subview.ccx`** from the [Releases](../../releases/latest) page
2. **Double-click** `subview.ccx`. Creative Cloud opens and asks for confirmation — click **Install**
   (you will see a warning because the plugin is not distributed through the Adobe Marketplace)
3. Start Photoshop (restart it if it was running) and open the panel from **Plugins → サブビュー (Subview)**

If you leave the panel open when you quit Photoshop, it comes back in the same place next time.

**To update**, double-click the new `subview.ccx` the same way.
**To uninstall**, remove Subview from **Manage plugins** in the Creative Cloud desktop app.

> The panel's labels are in Japanese. The table below gives the English meaning of each button.

## How to use

Add images with **＋ファイル** (*+File*: PNG / JPEG) or **＋キャンバス** (*+Canvas*: a snapshot of the open document).
Then drag to pan, use the wheel to zoom, and **Alt+click** to put the color under the cursor into your foreground color.

| Action | How |
| --- | --- |
| Add images | **＋ファイル** (*+File*, PNG / JPEG, multiple allowed) / **＋キャンバス** (*+Canvas*). New images go **right after the current one** and are shown immediately |
| Next / previous | ‹ › buttons, `←` `→`, or click the strip at the bottom |
| Zoom | Mouse wheel (around the cursor), ＋ −, the zoom **slider**, `+` `-`, **Ctrl+click** to zoom in, **Ctrl+Alt+click** to zoom out |
| Type a zoom level | Type e.g. `150` in the zoom box and press Enter |
| Fit / 100% | **全体** (*Fit*) and **100%** buttons, `0` `1`. **Double-click** the image to go back to Fit at any time |
| Pan | Drag |
| Rotate | The angle **slider** (snaps near 0°, ±90°, 180°), **⟲ ⟳** for 15° steps (`R`, `Shift+R`), **0°** button to reset |
| Flip / grayscale | **左右** (*flip horizontal*, `H`), **上下** (*flip vertical*, `V`), **白黒** (*grayscale*, `G`, values only). Flips act on the screen even when rotated |
| Adjustments | Click **調整** (*Adjust*) and choose from **＋ 調整を足す…** (*+ Add adjustment*, see below). Stack as many as you like; **●／○** toggles one off to compare, **▲** moves it up, **×** removes it |
| Pick a color | **Alt+click** at any time. Turn on **スポイト** (*Eyedropper*, `I`) to pick with a plain click. The color under the cursor is previewed before you pick |
| Sample size | **1px / 3×3 / 5×5** button (averaging helps with halftones and noise) |
| Reuse a color | Click a swatch at the bottom (up to 12) |
| Reorder | **Drag sideways** in the strip, or `Ctrl+←` `Ctrl+→` |
| Remove from the list | **外す** (*Remove*; the file itself is untouched). **Ctrl+click** items in the strip to mark several, then remove them together |
| Reset a slider | **Double-click** the angle, zoom or adjustment slider |

- Keys work only after you click the panel once (so they don't clash with Photoshop's shortcuts)
- Rotation, zoom and adjustments are remembered per image, and the list comes back when you restart Photoshop (canvas snapshots are not kept)
- Adjustments and grayscale only change **how the image looks**. The eyedropper always picks the original color

### Adjustments (modeled on Lightroom's Basic panel)

| Adjustment | Range | What it does |
| --- | --- | --- |
| 露光量 Exposure | -5.00 to +5.00 | Changes the amount of light. +1 doubles it. Colors are kept |
| コントラスト Contrast | ±100 | Widens or narrows the tonal spread without moving pure black, pure white or middle gray |
| ハイライト Highlights | ±100 | Bright areas only. Lowering it can recover areas blown out by Exposure |
| シャドウ Shadows | ±100 | Lifts or deepens dark areas only |
| 白レベル Whites / 黒レベル Blacks | ±100 | Moves the brightest / darkest points |
| 色温度 Temperature | ±100 | + toward yellow (warmer), - toward blue |
| 色かぶり補正 Tint | ±100 | + toward magenta, - toward green |
| 自然な彩度 Vibrance | ±100 | Affects muted colors most and leaves already-vivid colors mostly alone |
| 彩度 Saturation | ±100 | -100 is gray, +100 doubles it |

These follow Lightroom's approach but are an approximation, so the same values will not look exactly the same as in Lightroom.

### Keep your canvas beside you

**＋キャンバス** takes a snapshot of how the open document looks. With **追従** (*Follow*) on, it refreshes about a second after each stroke.

- With **左右** on, you can keep a **mirrored view** beside you without flipping the real canvas (great for spotting distortions)
- With **白黒** on, you can keep a **values-only view** beside you
- While working zoomed in, you can keep the whole composition in view

### Not supported

PSD, CLIP, TIFF and other formats cannot be opened directly (export to PNG or JPEG). Pasting from the clipboard and dragging files onto the panel are not supported (Photoshop panels cannot receive them).

## For developers

```
npm install
npm test            # decoders (checked against Pillow) and adjustment math: 41, view math: 5
npm run test:ui     # end-to-end UI tests in Chromium: 29 (photoshop / uxp are stubbed)
npm run install:ps  # install into Photoshop on this PC (uninstall: npm run install:ps -- -Remove)
npm run pack        # just build dist/subview.ccx for distribution
```

- To try changes live, install **UXP Developer Tool** from Creative Cloud, **Add Plugin** → pick this folder's `manifest.json`, **Load**, and **Reload** after edits
- No dependencies. PNG / JPEG decoding is built in (UXP has neither zlib nor canvas pixel access)
- `test:ui` uses playwright. If it says the browser is missing, run `npx playwright install chromium`
- The images in `test/fixtures/` were generated for testing

| File | Contents |
| --- | --- |
| `manifest.json` | UXP manifest v5, Photoshop 25.0+. File access is `request` (only files you pick) |
| `index.html` / `styles.css` | The panel. Colors follow Photoshop's brightness setting |
| `main.js` | Panel behavior (list, view, eyedropper, canvas, adjustments) |
| `lib/ps.js` | The only place that talks to Photoshop (foreground color, canvas capture, JPEG encoding, notifications) |
| `lib/view.js` | Zoom and pan math |
| `lib/imageops.js` | Downscaling, rotation, flips, grayscale, adjustments, color sampling |
| `lib/png.js` / `lib/inflate.js` / `lib/jpeg.js` | PNG (all types, Adam7, 16-bit) and JPEG (baseline, progressive, CMYK) decoders; PNG writer for display |
| `tools/install.ps1` | Packs a `.ccx` and installs it with Adobe's installer (UnifiedPluginInstallerAgent) |

### Quirks of Photoshop (UXP) panels we worked around

Found by testing in Photoshop; they differ from a normal browser.

- **No `wheel` events** → an invisible scroll box sits over the image and its scroll amount is turned into zoom
- That box **swallows pointer-down** (neither pointerdown nor mousedown arrives) → the first "moved with button held" or "released" event is treated as the start
- That box **also swallows the second click of a double-click** (no dblclick either) → the box is removed for 0.5 s after each click
- **CSS `cursor` has no effect** → an eyedropper image follows the mouse instead
- The `selected` attribute barely changes how a button looks → active buttons are colored directly
- With `\` separators inside the zip, UXP cannot find files under `lib/` (PowerShell 5's Compress-Archive writes them that way) → the package is built with .NET's ZipFile using `/`

## License

MIT ([LICENSE](LICENSE))
