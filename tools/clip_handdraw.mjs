/* =========================================================================
 * tools/clip_handdraw.mjs —— 手绘边界入库工具（方案B配套）
 * -------------------------------------------------------------------------
 * 用途：把地图页面「绘制边界」导出的手绘 GeoJSON，裁剪贴合到区县边界内，
 *       生成标准乡镇边界文件 data/{adcode}/{code}.json，并更新 data/index.json。
 *
 * 用法：
 *   node tools/clip_handdraw.mjs <手绘GeoJSON路径> <区县adcode> <街道名> <code> [centerLng,centerLat]
 *
 * 示例：
 *   node tools/clip_handdraw.mjs hand-draw.json 340102 磨店街道 340102990000
 *   node tools/clip_handdraw.mjs hand-draw.json 340102 磨店街道 340102990000 117.366095,31.954867
 *
 * 幂等：若 index.json 已存在同名街道条目则覆盖更新，不重复添加。
 * ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from './node_modules/polygon-clipping/dist/polygon-clipping.esm.js';

const [handFile, adcode, name, code, centerArg] = process.argv.slice(2);
if (!handFile || !adcode || !name || !code) {
  console.error('用法: node tools/clip_handdraw.mjs <手绘GeoJSON> <区县adcode> <街道名> <code> [centerLng,centerLat]');
  process.exit(1);
}
if (!/^\d{6}$/.test(adcode)) {
  console.error('adcode 必须是 6 位数字');
  process.exit(1);
}

const BASE = path.join(import.meta.dirname, '..', 'data');
const handPath = path.resolve(handFile);

/* ---------- 几何工具 ---------- */
function geoToPolygon(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return null;
}
function toGeo(polys) {
  return { type: 'MultiPolygon', coordinates: polys.map(p => p.map(ring => ring.map(pt => [pt[0], pt[1]]))) };
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}
function geoArea(g) {
  let total = 0;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) total += ringArea(p[0]) - p.slice(1).reduce((s, r) => s + ringArea(r), 0);
  return total;
}
function geoCenter(g) {
  // 几何外接框中心（简易）
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const ring of p) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/* ---------- 读取手绘文件（页面导出的 FeatureCollection） ---------- */
let hand;
try {
  hand = JSON.parse(fs.readFileSync(handPath, 'utf8'));
} catch (e) {
  console.error('读取手绘文件失败:', e.message);
  process.exit(1);
}
const handFeat = hand.type === 'FeatureCollection' ? hand.features[0] : hand;
const handGeo = handFeat.geometry;
const handPoly = geoToPolygon(handGeo);
if (!handPoly) {
  console.error('手绘几何必须是 Polygon / MultiPolygon');
  process.exit(1);
}

/* ---------- 读取区县边界 ---------- */
const districtFile = path.join(BASE, 'districts', adcode + '.json');
let dGeo;
try {
  dGeo = JSON.parse(fs.readFileSync(districtFile, 'utf8')).features[0].geometry;
} catch (e) {
  console.error('读取区县边界失败:', districtFile, e.message);
  process.exit(1);
}
const dPoly = geoToPolygon(dGeo);

/* ---------- 求交裁剪 ---------- */
const aHand = geoArea(handGeo);
let inter;
try {
  inter = polygonClipping.intersection(handPoly, dPoly);
} catch (e) {
  console.error('求交失败:', e.message);
  process.exit(1);
}
if (!inter.length) {
  console.error('裁剪结果为空：手绘范围完全在区县外，请检查手绘位置');
  process.exit(1);
}
const interGeo = toGeo(inter);
const aInter = geoArea(interGeo);
const pct = aHand ? (aInter / aHand * 100) : 100;
if (pct < 60) console.warn(`注意：裁剪后仅保留 ${pct.toFixed(1)}% 面积，手绘范围可能大部分落在区县外`);

/* ---------- 生成入库文件 ---------- */
const outFile = path.join(BASE, adcode, code + '.json');
const outData = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: interGeo,
    properties: { name: name, code: code }
  }]
};
fs.writeFileSync(outFile, JSON.stringify(outData));
console.log(`已写入: ${path.relative(process.cwd(), outFile)}`);

/* ---------- 更新 index.json ---------- */
const idxFile = path.join(BASE, 'index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
const center = centerArg
  ? centerArg.split(',').map(Number)
  : geoCenter(interGeo);
const list = idx[adcode] || (idx[adcode] = []);
const existing = list.find(t => t.name === name);
if (existing) {
  existing.code = code;
  existing.center = center;
  console.log(`index.json: 更新已有条目「${name}」code=${code}`);
} else {
  list.push({ code: code, name: name, center: center });
  console.log(`index.json: 新增条目「${name}」code=${code} center=${center.join(',')}`);
}
fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));

/* ---------- 报告 ---------- */
const pCount = inter.length;
const vCount = inter.reduce((s, p) => s + p[0].length, 0);
console.log('--- 完成 ---');
console.log(`裁剪后: ${pCount} 个多边形 / ${vCount} 个顶点`);
console.log(`面积保留: ${pct.toFixed(1)}%（手绘 ${aHand.toFixed(5)} → 入库 ${aInter.toFixed(5)}）`);
console.log('本地部署后需刷新 data/index.json 缓存（线上无需处理）。');
