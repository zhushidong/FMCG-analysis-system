/* 预演验证：裁剪后的磨店边界与瑶海区再求交，面积应不变（顶点全部在区内） */
import fs from 'node:fs';
import polygonClipping from './node_modules/polygon-clipping/dist/polygon-clipping.esm.js';

const out = JSON.parse(fs.readFileSync('data/340102/340102990000.json', 'utf8')).features[0].geometry;
const dist = JSON.parse(fs.readFileSync('data/districts/340102.json', 'utf8')).features[0].geometry;

function geoToPolygon(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return null;
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

const aOut = geoArea(out);
const inter = polygonClipping.intersection(geoToPolygon(out), geoToPolygon(dist));
const aInter = inter.reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((x, r) => x + ringArea(r), 0), 0);
const ratio = aOut ? (aInter / aOut * 100) : 0;
console.log('入库面积:', aOut.toFixed(6), ' 与区县再求交面积:', aInter.toFixed(6), ' 保留率:', ratio.toFixed(2) + '%');
if (ratio > 99.999) {
  console.log('验证通过 ✔ 裁剪后所有顶点均落在瑶海区内');
  process.exit(0);
} else {
  console.log('验证失败 ✘ 仍有顶点在区县外');
  process.exit(1);
}
