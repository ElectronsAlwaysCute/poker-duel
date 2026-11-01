$ErrorActionPreference = 'Stop'
# ============================================================================
# Poker Duel Android APK build (manual assemble: aapt2 + javac + d8 + apksigner)
# Requirements: JDK17 + Android SDK build-tools 34.0.0 / platforms;android-34
# Usage: powershell -ExecutionPolicy Bypass -File android\build.ps1
# Output: android\dist\poker-duel-v<versionName>.apk (self-signed)
# Note: assets are inserted manually with forward-slash paths because
#       aapt2 -A on Windows may store backslashes, which breaks file:// loading.
# ============================================================================
$root = 'D:\GAME\poker-duel'
$androidDir = Join-Path $root 'android'
$pack = Join-Path $root 'tools\tmp-v28\android-pack'
$jdkHome = Join-Path $pack 'jdk17'
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$sdk = Join-Path $localAppData 'Android\Sdk'
$buildTools = Join-Path $sdk 'build-tools\34.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
$versionName = '1.0'

$env:JAVA_HOME = $jdkHome
$env:Path = "$jdkHome\bin;$buildTools;$env:Path"

foreach ($p in @($androidJar, (Join-Path $buildTools 'aapt2.exe'), (Join-Path $buildTools 'd8.bat'), (Join-Path $buildTools 'zipalign.exe'), (Join-Path $buildTools 'apksigner.bat'), (Join-Path $jdkHome 'bin\javac.exe'))) {
  if (-not (Test-Path $p)) { throw ("missing build dependency: " + $p) }
}

$genDir = Join-Path $androidDir 'build\gen'
$classesDir = Join-Path $androidDir 'build\classes'
$dexDir = Join-Path $androidDir 'build\dex'
$distDir = Join-Path $androidDir 'dist'
$assetsDir = Join-Path $androidDir 'assets'
$keystoreDir = Join-Path $androidDir 'keystore'
foreach ($d in @($genDir, $classesDir, $dexDir, $distDir, $keystoreDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

Write-Output "$(Get-Date -Format o) step1 copy game assets -> assets/"
if (Test-Path $assetsDir) { Remove-Item $assetsDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
Copy-Item (Join-Path $root 'index.html') $assetsDir -Force
foreach ($item in @('js', 'css', 'music', 'sfx')) {
  Copy-Item (Join-Path $root $item) $assetsDir -Recurse -Force
}

# Android host overlay (authority.html + lan_authority.js) -> assets/host/
$hostOverlay = Join-Path $androidDir 'host-overlay'
if (Test-Path $hostOverlay) {
  $hostAssets = Join-Path $assetsDir 'host'
  New-Item -ItemType Directory -Force -Path $hostAssets | Out-Null
  Get-ChildItem $hostOverlay -File | ForEach-Object { Copy-Item $_.FullName $hostAssets -Force }
}

Write-Output "$(Get-Date -Format o) step2 generate launcher icon"
$iconDir = Join-Path $androidDir 'res\mipmap-xxxhdpi'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$iconPath = Join-Path $iconDir 'ic_launcher.png'
if (-not (Test-Path $iconPath)) {
  Add-Type -AssemblyName System.Drawing
  $size = 192
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 11, 15, 26))
  $g.FillRectangle($bgBrush, 0, 0, $size, $size)
  $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 212, 175, 55), 6)
  $g.DrawEllipse($ringPen, 14, 14, $size - 28, $size - 28)
  $font = New-Object System.Drawing.Font('Segoe UI Symbol', 96, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 240, 245))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString([char]0x2660, $font, $fgBrush, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $fmt)
  $bmp.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ("icon: " + $iconPath)
}

Write-Output "$(Get-Date -Format o) step3 aapt2 compile res"
$resZip = Join-Path $androidDir 'build\res.zip'
& (Join-Path $buildTools 'aapt2.exe') compile --dir (Join-Path $androidDir 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Output "$(Get-Date -Format o) step4 aapt2 link"
$unsigned = Join-Path $androidDir 'build\unsigned.apk'
& (Join-Path $buildTools 'aapt2.exe') link -o $unsigned -I $androidJar --manifest (Join-Path $androidDir 'AndroidManifest.xml') -R $resZip --java $genDir --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Output "$(Get-Date -Format o) clean build/classes + dex (avoid stale removed classes)"
if (Test-Path $classesDir) { Get-ChildItem $classesDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $dexDir) { Get-ChildItem $dexDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output "$(Get-Date -Format o) step5 javac"
$javaFiles = @()
$rFile = Get-ChildItem -Path $genDir -Filter 'R.java' -Recurse | Select-Object -First 1
if (-not $rFile) { throw 'R.java not generated' }
$javaFiles += $rFile.FullName
$javaFiles += @(Get-ChildItem (Join-Path $androidDir 'src') -Filter '*.java' -Recurse | ForEach-Object { $_.FullName })
& (Join-Path $jdkHome 'bin\javac.exe') -source 1.8 -target 1.8 -encoding UTF-8 -classpath $androidJar -d $classesDir @javaFiles
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Output "$(Get-Date -Format o) step6 d8 -> classes.dex"
$classFiles = @(Get-ChildItem -Path $classesDir -Filter '*.class' -Recurse | ForEach-Object { $_.FullName })
& (Join-Path $buildTools 'd8.bat') --lib $androidJar --min-api 23 --output $dexDir @classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Output "$(Get-Date -Format o) step7 add classes.dex + assets (forward slashes)"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
function Add-ZipEntry($zip, $entryName, $filePath) {
  $old = $zip.GetEntry($entryName)
  if ($old) { $old.Delete() }
  $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
  $inStream = [System.IO.File]::OpenRead($filePath)
  $outStream = $entry.Open()
  $inStream.CopyTo($outStream)
  $outStream.Close(); $inStream.Close()
}
Add-ZipEntry $zip 'classes.dex' (Join-Path $dexDir 'classes.dex')
$assetFiles = @(Get-ChildItem -Path $assetsDir -Recurse -File)
foreach ($f in $assetFiles) {
  $rel = $f.FullName.Substring($assetsDir.Length + 1).Replace('\', '/')
  Add-ZipEntry $zip ('assets/' + $rel) $f.FullName
}
$zip.Dispose()

Write-Output "$(Get-Date -Format o) step8 zipalign"
$aligned = Join-Path $androidDir 'build\aligned.apk'
& (Join-Path $buildTools 'zipalign.exe') -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Write-Output "$(Get-Date -Format o) step9 keystore + apksigner"
$keystore = Join-Path $keystoreDir 'pokerduel-release.keystore'
if (-not (Test-Path $keystore)) {
  & (Join-Path $jdkHome 'bin\keytool.exe') -genkeypair -v -keystore $keystore -alias pokerduel -keyalg RSA -keysize 2048 -validity 10000 -storepass pokerduel -keypass pokerduel -dname "CN=Poker Duel, OU=Game, O=PokerDuel, L=Local, ST=Local, C=CN"
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
$finalApk = Join-Path $distDir ("poker-duel-v{0}.apk" -f $versionName)
if (Test-Path $finalApk) { Remove-Item $finalApk -Force }
& (Join-Path $buildTools 'apksigner.bat') sign --ks $keystore --ks-pass pass:pokerduel --key-pass pass:pokerduel --out $finalApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Write-Output "$(Get-Date -Format o) step10 verify + sha256"
& (Join-Path $buildTools 'aapt2.exe') dump badging $finalApk
$hash = (Get-FileHash $finalApk -Algorithm SHA256).Hash
$size = (Get-Item $finalApk).Length
Write-Output ("APK: " + $finalApk)
Write-Output ("SIZE: " + $size)
Write-Output ("SHA256: " + $hash)
Write-Output "$(Get-Date -Format o) BUILD DONE"
