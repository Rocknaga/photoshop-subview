# サブビューを Photoshop に「正式に入れる」（Photoshop を起動するたびに自動で読み込まれる）。
# UXP Developer Tool の Load は、その Photoshop を閉じるまでしか効かない。毎回読み込み直す手間をなくすため、
# パネルに要るファイルだけを .ccx（中身は zip）に詰め、Adobe のインストーラ（UPIA）で入れる。
# 直したら、もう一度これを流す（前の版を外してから入れ直す）。外すだけなら -Remove。
#
# 使いかた: npm run install:ps      外す: npm run install:ps -- -Remove
# このファイルは BOM 付き UTF-8 で保存する（無いと PowerShell 5 が Shift_JIS として読み、日本語で崩れる）
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$upia = 'C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
if (-not (Test-Path $upia)) { throw "Adobe のプラグインインストーラが見つかりません（Creative Cloud を入れ直す）: $upia" }

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$name = $manifest.name

# 前の版を外す（入っていなければ何もしない）。同じ版の番号のままだと、外さずに入れ直そうとして断られる
Write-Host "前の版を外します: $name"
& $upia /remove $name | Out-Host
if ($Remove) { Write-Host '外しました。'; exit 0 }

# パネルに要るものだけを詰める（テスト・node_modules・説明書は入れない）
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$ccx = Join-Path $dist 'subview.ccx'
if (Test-Path $ccx) { Remove-Item $ccx }
$files = @('manifest.json', 'index.html', 'main.js', 'styles.css') +
  (Get-ChildItem (Join-Path $root 'lib') -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length + 1) }) +
  (Get-ChildItem (Join-Path $root 'icons') -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length + 1) })

# Compress-Archive（PowerShell 5）は中の名前を「\」区切りで書く。UXP はそれだと lib/ の中を見つけられないので、
# .NET の ZipFile で「/」区切りにして自分で詰める
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($ccx, 'Create')
try {
  foreach ($rel in $files) {
    $full = Join-Path $root $rel
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, ($rel -replace '\\', '/'), 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
Write-Host "詰めました: $ccx（$($files.Count) 個）"

Write-Host 'Photoshop に入れます'
& $upia /install $ccx | Out-Host
& $upia /list all | Out-Host
