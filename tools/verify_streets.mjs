/* 验证：裁剪入库后的街道边界干净性（与肥东县及其他街道零重叠、顶点全在瑶海区内） */
import fs from 'node:fs';
import polygonClipping from './node_modules/polygon-clipping/dist/polygon-clipping.esm.js';

const B = 'D:/Agent工作空间/Opencode/hefei-map/data';
function load(f) { return JSON.parse(fs.readFileSync(f, 'utf8')).features[0].geometry; }
function geoToPoly(g) { return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
function ringArea(ring) { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]; } return Math.abs(a) / 2; }
function area(g) { let t = 0; const ps = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const p of ps) t += ringArea(p[0]) - p.slice(1).reduce((s, r) => s + ringArea(r), 0); return t; }
function overlapPct(g1, g2) {
  const inter = polygonClipping.intersection(geoToPoly(g1), geoToPoly(g2));
  const aInter = inter.reduce((s, p) => s + ringArea(p[0]), 0);
  return aInter / area(g1) * 100;
}

const files = {
  '340173001000': '七里塘街道',
  '340173002000': '磨店街道',
  '340173003000': '三十头街道',
  '340173400000': '瑶海区工业园',
  '340173401000': '站北社区'
};
const yaohai = load(`${B}/districts/340102.json`);
const feidong = load(`${B}/districts/340122.json`);
const geos = {};
for (const c of Object.keys(files)) geos[c] = load(`${B}/340102/${c}.json`);

console.log('--- 1. 每个街道裁剪后 vs 肥东县重叠（应为 0%）---');
for (const c of Object.keys(files)) {
  console.log(`${files[c]}: ${overlapPct(geos[c], feidong).toFixed(2)}%`);
}

console.log('--- 2. 街道两两重叠（应为 0%）---');
const cs = Object.keys(files);
for (let i = 0; i < cs.length; i++) {
  for (let j = i + 1; j < cs.length; j++) {
    const p = overlapPct(geos[cs[i]], geos[cs[j]]);
    if (p > 0.01) console.log(`${files[cs[i]]} ∩ ${files[cs[j]]}: ${p.toFixed(2)}%（异常）`);
  }
}
console.log('两两重叠检查完成');

console.log('--- 3. 顶点全在瑶海区内（面积保留应 100%）---');
for (const c of Object.keys(files)) {
  const p = overlapPct(geos[c], yaohai);
  console.log(`${files[c]}: ${p.toFixed(2)}%`);
}
