# =========================================================================
# 合肥市乡镇边界数据抓取脚本（开发期工具，一次性运行）
# -------------------------------------------------------------------------
# 数据来源：map.ruiduobao.com（公开免费行政区划矢量数据 API，无需凭证）
# 抓取结果：
#   data/{区县adcode}/{乡镇代码12位}.json   —— 乡镇 GeoJSON 边界
#   data/index.json                          —— 索引（区县 → 乡镇列表+中心点）
# 用法：powershell -ExecutionPolicy Bypass -File tools/fetch_towns.ps1
# 注意：本脚本是开发工具，页面运行时不依赖此站点（数据已本地化）。
# =========================================================================
$ErrorActionPreference = 'Stop'

$base = 'https://map.ruiduobao.com'
$year = 2023
$province = '安徽省'
$city = '合肥市'

# 区县（名称 + adcode）
$districts = @(
  @{ name = '瑶海区'; adcode = '340102' },
  @{ name = '庐阳区'; adcode = '340103' },
  @{ name = '蜀山区'; adcode = '340104' },
  @{ name = '包河区'; adcode = '340111' },
  @{ name = '长丰县'; adcode = '340121' },
  @{ name = '肥东县'; adcode = '340122' },
  @{ name = '肥西县'; adcode = '340123' },
  @{ name = '庐江县'; adcode = '340124' },
  @{ name = '巢湖市'; adcode = '340181' }
)

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'

# 小工具：带重试的 GET（返回 JSON 对象）
function Get-JsonWithRetry($url, $try = 3) {
  for ($i = 1; $i -le $try; $i++) {
    try { return Invoke-RestMethod $url -TimeoutSec 30 }
    catch {
      if ($i -eq $try) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

# 计算 GeoJSON bbox 中心（兼容 Polygon / MultiPolygon）
function Get-GeoCenter($geo) {
  $minx = 1e9; $miny = 1e9; $maxx = -1e9; $maxy = -1e9
  foreach ($f in $geo.features) {
    $g = $f.geometry
    if (-not $g) { continue }
    if ($g.type -eq 'Polygon') { $polys = @($g.coordinates) }
    else { $polys = $g.coordinates }
    foreach ($poly in $polys) {
      foreach ($ring in $poly) {
        foreach ($pt in $ring) {
          if ($pt[0] -lt $minx) { $minx = $pt[0] }
          if ($pt[0] -gt $maxx) { $maxx = $pt[0] }
          if ($pt[1] -lt $miny) { $miny = $pt[1] }
          if ($pt[1] -gt $maxy) { $maxy = $pt[1] }
        }
      }
    }
  }
  return @([Math]::Round(($minx + $maxx) / 2, 6), [Math]::Round(($miny + $maxy) / 2, 6))
}

# 统计
$totalTowns = 0
$totalBytes = 0
$failed = @()
$index = @{}

foreach ($d in $districts) {
  $distDir = Join-Path $dataDir $d.adcode
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null

  # 1. 乡镇列表
  $treeUrl = '{0}/api/tree/towns?province={1}&city={2}&county={3}&year={4}' -f `
    $base, [uri]::EscapeDataString($province), [uri]::EscapeDataString($city),
    [uri]::EscapeDataString($d.name), $year
  $tree = Get-JsonWithRetry $treeUrl
  $towns = @($tree.data)

  Write-Host "[$($d.name)] 乡镇数量: $($towns.Count)"
  $items = @()

  foreach ($t in $towns) {
    $outFile = Join-Path $distDir ($t.code + '.json')
    if (Test-Path $outFile) {
      # 已下载：读取已有文件算中心点，补充进索引（保证 index 完整）
      $content = [IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)
      $geo = $content | ConvertFrom-Json
      $center = Get-GeoCenter $geo
      $items += @{ code = $t.code; name = $t.name; center = $center }
      continue
    }

    # 2. 拿 GeoJSON 文件地址（个别乡镇无数据，跳过并记录，不中止）
    $envUrl = '{0}/getGsonDB?code={1}&year={2}' -f $base, $t.code, $year
    try { $env = Get-JsonWithRetry $envUrl } catch {
      $failed += "$($t.code):no-gson"; Write-Host "  !! $($t.name) getGsonDB 失败"; continue
    }
    $fp = $env.filepath
    if (-not $fp) {
      $failed += "$($t.code):no-filepath"; Write-Host "  !! $($t.name) 无 filepath"; continue
    }
    $fileUrl = if ($fp -like 'http*') { $fp } else { $base + $fp }
    try {
      $raw = (Invoke-WebRequest $fileUrl -UseBasicParsing -TimeoutSec 60).Content
    } catch {
      $failed += "$($t.code):download"; Write-Host "  !! $($t.name) 下载失败"; continue
    }
    if ($raw -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($raw) }
    else { $content = $raw.ToString() }

    # 3. 保存 GeoJSON
    [IO.File]::WriteAllText($outFile, $content, (New-Object Text.UTF8Encoding($false)))
    $totalBytes += $content.Length

    # 4. 中心点（bbox 中心）写入索引
    $geo = $content | ConvertFrom-Json
    $center = Get-GeoCenter $geo
    $items += @{ code = $t.code; name = $t.name; center = $center }
    $totalTowns++
    Start-Sleep -Milliseconds 200   # 温和限速，避免被源站限流
  }

  $index[$d.adcode] = $items
}

# 索引落盘
$indexJson = $index | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $dataDir 'index.json'), $indexJson, (New-Object Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "完成：乡镇 $totalTowns 个，数据 $( [Math]::Round($totalBytes / 1024) ) KB"
if ($failed.Count) { Write-Host "失败 $($failed.Count) 个: $($failed -join ', ')" }
