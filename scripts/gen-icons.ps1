# 生成 PWA / 安卓桌面「念」图标（行草：Liu Jian Mao Cao，与开屏一致）
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$fontPath = Join-Path $root 'assets\fonts\LiuJianMaoCao-Regular.ttf'
if (!(Test-Path $fontPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $fontPath) | Out-Null
  $url = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/liujianmaocao/LiuJianMaoCao-Regular.ttf'
  Write-Host "Downloading Liu Jian Mao Cao..."
  Invoke-WebRequest -Uri $url -OutFile $fontPath -UseBasicParsing
}
if (!(Test-Path $fontPath)) {
  throw "Missing font: $fontPath"
}

$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile($fontPath)
$nianFamily = $pfc.Families[0]

function Save-NianIcon {
  param(
    [int]$Size,
    [string]$OutFile,
    [switch]$Round,
    [double]$Inset = 0
  )
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [int]($Size * $Inset)
  $inner = $Size - 2 * $pad
  if ($inner -lt 8) { $inner = $Size; $pad = 0 }

  $p0 = [System.Drawing.Point]::new($pad, $pad)
  $p1 = [System.Drawing.Point]::new($pad + $inner, $pad + $inner)
  $c0 = [System.Drawing.Color]::FromArgb(255, 232, 213, 245)
  $c1 = [System.Drawing.Color]::FromArgb(255, 201, 160, 220)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p0, $p1, $c0, $c1)
  if ($Round) {
    $ellipse = New-Object System.Drawing.Drawing2D.GraphicsPath
    $ellipse.AddEllipse($pad, $pad, $inner, $inner)
    $g.FillPath($brush, $ellipse)
    $ellipse.Dispose()
  } else {
    $g.FillRectangle($brush, $pad, $pad, $inner, $inner)
  }
  $brush.Dispose()

  # 行草略松，字号比黑体略大一点才压得住画面
  $fontSize = [math]::Max(12, [int]($inner * 0.62))
  $font = New-Object System.Drawing.Font($nianFamily, $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'
  $sf.LineAlignment = 'Center'
  # 行草视觉重心略偏上，整体下移一点
  $rect = New-Object System.Drawing.RectangleF($pad, ($pad + $inner * 0.04), $inner, $inner)
  $g.DrawString([char]0x5FF5, $font, [System.Drawing.Brushes]::White, $rect, $sf)
  $font.Dispose()
  $g.Dispose()

  $dir = Split-Path $OutFile -Parent
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Created $OutFile"
}

$icons = Join-Path $root 'assets\icons'
Save-NianIcon -Size 192 -OutFile (Join-Path $icons 'icon-192.png')
Save-NianIcon -Size 512 -OutFile (Join-Path $icons 'icon-512.png')
Save-NianIcon -Size 180 -OutFile (Join-Path $icons 'apple-touch-icon.png')

$res = Join-Path $root 'android\app\src\main\res'
$densities = @(
  @{ name = 'mipmap-mdpi'; launcher = 48; foreground = 108 },
  @{ name = 'mipmap-hdpi'; launcher = 72; foreground = 162 },
  @{ name = 'mipmap-xhdpi'; launcher = 96; foreground = 216 },
  @{ name = 'mipmap-xxhdpi'; launcher = 144; foreground = 324 },
  @{ name = 'mipmap-xxxhdpi'; launcher = 192; foreground = 432 }
)
foreach ($d in $densities) {
  $dir = Join-Path $res $d.name
  Save-NianIcon -Size $d.launcher -OutFile (Join-Path $dir 'ic_launcher.png')
  Save-NianIcon -Size $d.launcher -OutFile (Join-Path $dir 'ic_launcher_round.png') -Round
  Save-NianIcon -Size $d.foreground -OutFile (Join-Path $dir 'ic_launcher_foreground.png') -Inset 0.18
}

$pfc.Dispose()
Write-Host 'Icons ready'
