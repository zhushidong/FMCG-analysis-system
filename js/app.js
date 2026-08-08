/* =========================================================================
 * 合肥市区县-街道地图 —— 主逻辑
 * -------------------------------------------------------------------------
 * 模块职责：
 *   - App 命名空间：集中管理状态与地图实例
 *   - 地图初始化（合肥市默认视图）
 *   - 顶栏/面板交互（重置、打印、手机抽屉）
 * 阶段规划：
 *   阶段1 地图初始化 + 响应式布局
 *   阶段2 区县边界高亮 + 飞行
 *   阶段3 街道二级选择 + 定位
 *   阶段4 地图点击反向选中 + 打印打磨
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------- 全局命名空间 ---------- */
  window.App = {
    cfg: window.HEFEI_MAP_CONFIG || {},
    map: null,            // AMap 地图实例
    districtPolygons: [], // 当前区县高亮多边形
    currentDistrict: null,// 当前选中区县
    streetList: [],       // 当前区县的街道列表（高德查询 + 本地索引合并）
    streetPolygons: [],   // 街道边界多边形（有边界数据时）
    streetMarkers: [],    // 街道中心标记 + 名称标签
    currentStreet: null,  // 当前选中街道
    localTownIndex: {},   // 本地乡镇边界索引 data/index.json（code → 边界文件）
    /* --- 性能缓存（避免重复网络请求，切换秒开） --- */
    districtBoundaryCache: {}, // adcode → 区县边界 GeoJSON（本地文件或 DataV）
    streetListCache: {},       // adcode → 街道列表（高德查询结果，同一区县只查一次）
    streetBoundaryCache: {},   // 街道 code → 边界 GeoJSON（选过的街道只 fetch 一次）
    /* --- 合肥市默认遮罩（方案B：打开页面只显示合肥市） --- */
    cityMask: null,            // 遮罩多边形（合肥以外区域压暗）
    cityOutline: null,         // 合肥市边界轮廓线（蓝色描边）
    cityBoundaryCache: null,   // 合肥市边界 GeoJSON（遮罩数据缓存，避免重复请求）
    regionLabel: null          // 当前区域名称标签（合肥市 / 区县名 / 街道名）
  };

  var cfg = window.App.cfg;

  /* ---------- DOM 引用 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    map: $('map'),
    district: $('sel-district'),
    street: $('sel-street'),
    btnReset: $('btn-reset'),
    btnPrint: $('btn-print'),
    panel: $('panel'),
    btnOpenPanel: $('btn-open-panel'),
    btnClosePanel: $('btn-close-panel')
  };

  /* =========================================================
   * 1. 地图初始化：合肥市默认视图
   * ========================================================= */
  function initMap() {
    if (!window.AMap) { return; } // 脚本加载失败时，index.html 已给出错误提示

    App.map = new AMap.Map('map', {
      center: cfg.cityCenter,
      zoom: cfg.cityZoom,
      zooms: [5, 20],          // 允许缩放到街道级
      viewMode: '2D',
      showBuildingBlock: false,
      mapStyle: 'amap://styles/normal', // 高德标准路网
      resizeEnable: true
    });

    // 缩放控件
    App.map.addControl(new AMap.Scale());
    App.map.addControl(new AMap.ToolBar({ position: 'RB' }));

    // 默认视图：合肥市遮罩（只显示合肥市，其他区域压暗）
    loadCityMask();
  }

  /* =========================================================
   * 2. 等待 AMap 就绪（动态注入的脚本是异步的，不能假设立即可用）
   * ========================================================= */
  function waitForAMap(callback, timeoutMs) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (window.AMap) {
        clearInterval(timer);
        callback();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        el.map.innerHTML = '<div class="map-error">高德地图加载超时：请检查网络或 Key 配置</div>';
      }
    }, 200);
  }

  /* =========================================================
   * 2.5 合肥市默认遮罩（方案B）
   *    打开页面：只显示合肥市辖区，市外区域压暗。
   *    实现：一个覆盖全球的矩形多边形，合肥市边界作为"洞"（内环），
   *    再叠加一条合肥市边界轮廓线；选择区县后移除遮罩，重置后恢复。
   * ========================================================= */

  // 世界范围矩形（作为遮罩外环，覆盖任何缩放级别下的可见区域）
  var WORLD_RING = [[-180, 90], [180, 90], [180, -90], [-180, -90], [-180, 90]];

  // 加载合肥市边界并绘制遮罩 + 轮廓
  function loadCityMask() {
    // 已加载过 → 直接重新绘制（数据复用，零网络请求）
    if (App.cityBoundaryCache) {
      drawCityMask(App.cityBoundaryCache);
      return;
    }
    fetch('data/districts/340100.json')
      .then(function (r) { return r.json(); })
      .then(function (geo) {
        var feature = geo.features && geo.features[0];
        if (!feature || !feature.geometry) { throw new Error('无有效边界'); }
        App.cityBoundaryCache = feature;
        drawCityMask(feature);
      })
      .catch(function (e) {
        console.warn('合肥市边界加载失败（遮罩未启用）：', e.message);
      });
  }

  // 用合肥市边界 feature 绘制遮罩 + 轮廓
  function drawCityMask(feature) {
    var rings = geoToRings(feature.geometry);
    if (!rings.length) { return; }

    // 1) 遮罩：全球矩形 + 合肥边界作为洞（洞不填充 → 合肥区域透出）
    App.cityMask = new AMap.Polygon({
      map: App.map,
      path: [WORLD_RING].concat(rings),
      strokeColor: '#215EFF',
      strokeWeight: 2,
      strokeOpacity: 0,
      fillColor: '#0b1424',
      fillOpacity: 0.5,
      bubble: true
    });

    // 2) 合肥市边界轮廓线（独立描边，清晰可见）
    App.cityOutline = new AMap.Polygon({
      map: App.map,
      path: rings,
      strokeColor: '#215EFF',
      strokeWeight: 3,
      strokeOpacity: 0.95,
      fillColor: '#215EFF',
      fillOpacity: 0.06,
      bubble: true,
      cursor: 'pointer'
    });

    // 视野对准合肥市
    App.map.setFitView([App.cityOutline], false, [50, 50, 50, 50], 9.5);

    // 显示"合肥市"名称标签（用数据自带的几何中心）
    var c = (feature.properties && feature.properties.center) || cfg.cityCenter;
    showRegionLabel(feature.properties.name || '合肥市', c);
  }

  // 移除遮罩（选择区县进入探索模式时调用）
  function clearCityMask() {
    if (App.cityMask) { App.map.remove(App.cityMask); App.cityMask = null; }
    if (App.cityOutline) { App.map.remove(App.cityOutline); App.cityOutline = null; }
  }

  /* ---------- 区域名称标签（图上显示当前区域名） ---------- */

  // 在指定中心显示区域名称（合肥市 / 区县名 / 街道名），自动替换旧标签
  function showRegionLabel(text, position) {
    if (App.regionLabel) { App.map.remove(App.regionLabel); }
    App.regionLabel = new AMap.Text({
      text: text,
      position: position,
      offset: new AMap.Pixel(0, 0),
      style: {
        'background-color': 'rgba(255,255,255,.94)',
        'border': '2px solid #215EFF',
        'border-radius': '8px',
        'padding': '6px 20px',
        'color': '#215EFF',
        'font-size': '22px',
        'font-weight': 'bold',
        'white-space': 'nowrap',
        'box-shadow': '0 2px 8px rgba(0,0,0,.15)'
      },
      zIndex: 130
    });
    App.map.add(App.regionLabel);
  }

  // 清除区域名称标签
  function clearRegionLabel() {
    if (App.regionLabel) { App.map.remove(App.regionLabel); App.regionLabel = null; }
  }

  /* =========================================================
   * 3. 区县下拉初始化（静态数据填充）
   * ========================================================= */
  function initDistrictSelect() {
    var opts = '<option value="">— 请选择区县 —</option>';
    cfg.districts.forEach(function (d) {
      opts += '<option value="' + d.adcode + '" data-name="' + d.name + '">' + d.name + '</option>';
    });
    el.district.innerHTML = opts;
  }

  /* =========================================================
   * 4. 区县边界加载 + 高亮
   *    优先阿里云 DataV GeoJSON；失败时回退到高德 DistrictSearch
   * ========================================================= */

  // GeoJSON 的 MultiPolygon/Polygon 坐标 → 高德路径（ring）数组
  function geoToRings(geometry) {
    var rings = [];
    if (!geometry) { return rings; }
    if (geometry.type === 'Polygon') {
      geometry.coordinates.forEach(function (ring) { rings.push(ring); });
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) { rings.push(ring); });
      });
    }
    return rings;
  }

  // 高亮显示区县边界（半透明填充 + 边框），并飞行到该区县
  function highlightDistrict(feature, districtName) {
    clearDistrictHighlight();
    var rings = geoToRings(feature.geometry);
    if (!rings.length) { return; }

    rings.forEach(function (ring) {
      var poly = new AMap.Polygon({
        map: App.map,
        path: ring,
        strokeColor: '#215EFF',   // 边框：蓝色
        strokeWeight: 3,
        strokeOpacity: 0.9,
        fillColor: '#215EFF',
        fillOpacity: 0.15,        // 半透明填充
        bubble: true,
        cursor: 'pointer'
      });
      App.districtPolygons.push(poly);
    });

    // 飞行到区县范围（maxZoom 限制避免过度放大，padding 留出边距）
    App.map.setFitView(App.districtPolygons, false, [50, 50, 50, 50], 13);

    // 显示区县名称标签（用数据自带的几何中心）
    var c = (feature.properties && feature.properties.center) || App.map.getCenter();
    showRegionLabel(districtName, c);
  }

  // 清除当前区县高亮
  function clearDistrictHighlight() {
    App.districtPolygons.forEach(function (p) { App.map.remove(p); });
    App.districtPolygons = [];
  }

  // 区县边界加载（本地文件 → DataV → 高德，逐级回退，全部带缓存）
  function loadDistrictBoundary(district) {
    var adcode = district.adcode;
    // 1. 命中缓存：直接高亮
    if (App.districtBoundaryCache[adcode]) {
      highlightDistrict(App.districtBoundaryCache[adcode], district.name);
      return;
    }
    // 2. 本地文件 data/districts/{adcode}.json（部署后与页面同源，无外部依赖）
    fetch('data/districts/' + adcode + '.json')
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (geo) {
        var feature = geo.features && geo.features[0];
        if (!feature || !feature.geometry) { throw new Error('本地边界无有效数据'); }
        App.districtBoundaryCache[adcode] = feature;
        highlightDistrict(feature, district.name);
      })
      .catch(function (e) {
        console.warn('本地区县边界缺失，回退 DataV：', e.message);
        loadBoundaryFromDatav(district, function () {
          loadBoundaryFromDistrictSearch(district);
        });
      });
  }

  // 方式二：拉取阿里云 DataV GeoJSON 边界（本地缺失时的网络兜底）
  function loadBoundaryFromDatav(district, fallback) {
    var url = cfg.datavBoundaryUrl.replace('{adcode}', district.adcode);
    fetch(url)
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (geo) {
        var feature = geo.features && geo.features[0];
        if (!feature || !feature.geometry) { throw new Error('GeoJSON 无有效边界'); }
        App.districtBoundaryCache[district.adcode] = feature;
        highlightDistrict(feature, district.name);
      })
      .catch(function (e) {
        console.warn('DataV 边界加载失败，回退高德查询：', e.message);
        fallback();
      });
  }

  // 方式二：回退到高德 DistrictSearch（extensions=all 返回边界点串）
  function loadBoundaryFromDistrictSearch(district) {
    var ds = new AMap.DistrictSearch({ level: 'district', extensions: 'all' });
    ds.search(district.adcode, function (status, result) {
      if (status !== 'complete' || !result.districtList || !result.districtList.length) {
        alert('区县边界加载失败：' + district.name);
        return;
      }
      var item = result.districtList[0];
      var rings = parseBoundary(item.boundary);
      if (!rings.length) {
        // 高德无边界数据时，退而求其次：定位到区县中心
        App.map.setCenter(item.center);
        App.map.setZoom(11);
        return;
      }
      var geo = { geometry: { type: 'MultiPolygon', coordinates: rings.map(function (r) { return [r]; }) } };
      highlightDistrict(geo, district.name);
    });
  }

  // 区县选中入口
  function onDistrictSelected(adcode) {
    if (!adcode) {
      // 切回"请选择区县"：清空街道 + 恢复合肥市遮罩
      clearStreetLayer();
      el.street.innerHTML = '<option value="">— 先选择区县 —</option>';
      el.street.disabled = true;
      App.currentDistrict = null;
      loadCityMask();
      return;
    }
    var district = null;
    cfg.districts.forEach(function (d) {
      if (d.adcode === adcode) { district = d; }
    });
    if (!district) { return; }
    App.currentDistrict = district;
    // 进入区县探索模式：移除全市遮罩，展示区县边界
    clearCityMask();
    clearStreetLayer();
    loadDistrictBoundary(district);
    loadStreets(district);
  }

  /* =========================================================
   * 5. 街道 / 乡镇二级选择
   *    数据来源（两层）：
   *      1) 本地边界文件 data/{adcode}/{code}.json（民政12位代码，约91%乡镇）
   *      2) 高德 DistrictSearch 补齐全部乡镇名称+中心点（无边界）
   *    表现：有边界 → 橙色多边形高亮；无边界 → 中心标记 + 名称标签
   * ========================================================= */

  // 高德边界点串（多环用 | 分隔，点对用 ; 分隔，经纬度用 , 分隔）→ 路径数组
  function parseBoundary(boundaryStr) {
    var rings = [];
    (boundaryStr || '').split('|').forEach(function (polyStr) {
      var ring = polyStr.split(';').filter(Boolean).map(function (pt) {
        var xy = pt.split(',');
        return [parseFloat(xy[0]), parseFloat(xy[1])];
      });
      if (ring.length) { rings.push(ring); }
    });
    return rings;
  }

  // 查询区县下的街道/乡镇列表并填充下拉
  // 策略：本地 index.json 立即渲染（name/center/code 全量，零等待）；
  //       高德 DistrictSearch 后台补齐本地缺失的街道（异步，失败/超时不影响使用）
  function loadStreets(district) {
    var adcode = district.adcode;
    if (App.streetListCache[adcode]) {
      fillStreetSelect(App.streetListCache[adcode]);
      return;
    }
    var localList = App.localTownIndex[adcode] || [];
    // 1) 本地立即渲染（91% 乡镇有边界 code，其余无 code 但 name/center 可用）
    var merged = localList.map(function (l) {
      return { name: l.name, center: l.center, code: l.code };
    });
    App.streetListCache[adcode] = merged;
    fillStreetSelect(merged);

    // 2) 高德后台补齐（本地缺失的街道，如源站无数据的 13 个乡镇）
    var ds = new AMap.DistrictSearch({ level: 'street', extensions: 'all', timeout: 8000 });
    ds.search(adcode, function (status, result) {
      var amapList = [];
      if (status === 'complete' && result.districtList && result.districtList.length) {
        amapList = result.districtList[0].districtList || [];
      }
      if (!amapList.length) { return; } // 高德无数据/超时：保持本地列表
      // 追加高德独有街道（本地没有的）
      var seen = {};
      merged.forEach(function (s) { seen[s.name] = true; });
      var added = false;
      amapList.forEach(function (a) {
        if (!seen[a.name]) {
          merged.push({ name: a.name, center: a.center, code: null });
          seen[a.name] = true;
          added = true;
        }
      });
      if (added) {
        App.streetListCache[adcode] = merged;
        fillStreetSelect(merged);
      }
    });
  }

  // 用街道列表填充下拉框
  function fillStreetSelect(list) {
    App.streetList = list;
    var opts = '<option value="">— 请选择街道/乡镇 —</option>';
    list.forEach(function (s, i) {
      // options[0] 为提示项，街道 i 的 value=i（与 streetList 索引对齐）
      opts += '<option value="' + i + '">' + s.name + '</option>';
    });
    el.street.innerHTML = opts;
    el.street.disabled = false;
  }

  // 清除街道图层（多边形 + 标记 + 标签）
  function clearStreetLayer() {
    App.streetPolygons.forEach(function (p) { App.map.remove(p); });
    App.streetMarkers.forEach(function (m) { App.map.remove(m); });
    App.streetPolygons = [];
    App.streetMarkers = [];
    App.currentStreet = null;
  }

  // 街道选中处理
  function onStreetSelected(index) {
    clearStreetLayer();
    if (index === '' ) { return; }
    var street = App.streetList[parseInt(index, 10)];
    if (!street) { return; }
    App.currentStreet = street;

    // 本地有边界文件 → 多边形高亮 + 名称标签；否则 → 中心标记兜底（自带名称标签）
    if (street.code && App.currentDistrict) {
      loadStreetBoundary(street);
    } else {
      clearRegionLabel();
      showStreetMarker(street);
    }
  }

  // 从本地 data/ 目录加载街道边界 GeoJSON 并高亮（按 code 缓存，重复选择零请求）
  function loadStreetBoundary(street) {
    if (App.streetBoundaryCache[street.code]) {
      drawStreetBoundary(App.streetBoundaryCache[street.code]);
      return;
    }
    var url = 'data/' + App.currentDistrict.adcode + '/' + street.code + '.json';
    fetch(url)
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (geo) {
        var feature = geo.features && geo.features[0];
        if (!feature || !feature.geometry) { throw new Error('无有效边界'); }
        App.streetBoundaryCache[street.code] = feature;
        drawStreetBoundary(feature);
      })
      .catch(function () {
        // 边界文件缺失 → 中心标记兜底
        showStreetMarker(street);
      });
  }

  // 绘制街道边界多边形（橙色）并框选到该街道
  function drawStreetBoundary(feature) {
    var rings = geoToRings(feature.geometry);
    if (!rings.length) { return; }
    rings.forEach(function (ring) {
      var poly = new AMap.Polygon({
        map: App.map,
        path: ring,
        strokeColor: '#FF6B00',
        strokeWeight: 2.5,
        strokeOpacity: 0.9,
        fillColor: '#FF6B00',
        fillOpacity: 0.18,
        bubble: true,
        cursor: 'pointer'
      });
      App.streetPolygons.push(poly);
    });
    App.map.setFitView(App.streetPolygons, false, [50, 50, 50, 50], 16);

    // 显示街道名称标签（用高德返回的中心点）
    var c = (App.currentStreet && App.currentStreet.center) || App.map.getCenter();
    showRegionLabel(App.currentStreet.name, c);
  }

  // 中心标记 + 名称标签（无边界数据时的兜底展示）
  function showStreetMarker(street) {
    var marker = new AMap.Marker({
      position: street.center,
      title: street.name,
      anchor: 'bottom-center'
    });
    var label = new AMap.Text({
      text: street.name,
      position: street.center,
      offset: new AMap.Pixel(0, -34),
      style: {
        'background-color': 'rgba(255,255,255,.92)',
        'border': '1.5px solid #FF6B00',
        'border-radius': '4px',
        'padding': '3px 10px',
        'color': '#d35400',
        'font-size': '13px',
        'font-weight': 'bold',
        'white-space': 'nowrap'
      },
      zIndex: 120
    });
    App.map.add(marker);
    App.map.add(label);
    App.streetMarkers = [marker, label];
    App.map.setZoomAndCenter(14, street.center, false, 500);
  }



  /* =========================================================
   * 6. 布局交互
   * ========================================================= */

  // 手机端：抽屉展开 / 收起
  function openPanel() {
    el.panel.classList.add('open');
    el.btnOpenPanel.hidden = true;
  }
  function closePanel() {
    el.panel.classList.remove('open');
    el.btnOpenPanel.hidden = false;
  }

  // 重置到全市视图（恢复合肥市遮罩）
  function resetView() {
    clearDistrictHighlight();
    clearStreetLayer();
    App.currentDistrict = null;
    el.street.innerHTML = '<option value="">— 先选择区县 —</option>';
    el.street.disabled = true;
    loadCityMask();
  }

  // 打印
  function printPage() {
    // 短暂等待地图渲染稳定后调用打印
    setTimeout(function () { window.print(); }, 300);
  }

  /* =========================================================
   * 7. 事件绑定
   * ========================================================= */
  function bindEvents() {
    el.btnReset.addEventListener('click', resetView);
    el.btnPrint.addEventListener('click', printPage);
    el.btnOpenPanel.addEventListener('click', openPanel);
    el.btnClosePanel.addEventListener('click', closePanel);
    // 手机端点击标题条也可展开
    el.panel.querySelector('.panel-head').addEventListener('click', openPanel);

    // 区县选择 → 加载边界并飞行
    el.district.addEventListener('change', function () {
      onDistrictSelected(this.value);
    });

    // 街道选择 → 高亮/标记并定位
    el.street.addEventListener('change', function () {
      onStreetSelected(this.value);
    });

    // 窗口尺寸变化时通知地图重算（响应式布局切换）
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (App.map) { App.map.resize(); }
      }, 150);
    });
  }

  /* =========================================================
   * 8. 启动
   * ========================================================= */
  function init() {
    initDistrictSelect();
    bindEvents();
    // 预加载本地乡镇边界索引（选区县时避免等待）
    fetch('data/index.json')
      .then(function (r) { return r.json(); })
      .then(function (idx) { App.localTownIndex = idx; })
      .catch(function () { /* 索引缺失时仅用高德中心标记兜底 */ });
    // AMap 脚本为动态注入，就绪后再初始化地图
    waitForAMap(initMap, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
