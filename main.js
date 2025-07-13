// main.js for 蓝牙心率监测器
// 包含设备蓝牙模拟、心率数据采集、设置保存（IndexedDB）、webhook 自动触发、UI 控制等核心功能

///////////////////// IndexedDB 持久化存储 /////////////////////
const DB_NAME = 'HRMonitorDB';
const DB_VERSION = 1;
let db = null;

function openDb(cb) {
  if (db) return cb && cb();
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('configs'))
      db.createObjectStore('configs', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('history'))
      db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('webhooks'))
      db.createObjectStore('webhooks', { keyPath: 'id', autoIncrement: true });
  };
  req.onsuccess = (e) => { db = e.target.result; cb && cb(); };
  req.onerror = (e) => { alert('数据库打开失败'); };
}

function saveConfig(key, value, cb) {
  openDb(() => {
    const tx = db.transaction('configs', 'readwrite');
    tx.objectStore('configs').put({ key, value });
    tx.oncomplete = () => cb && cb();
  });
}
function loadConfig(key, cb) {
  openDb(() => {
    const tx = db.transaction('configs');
    const req = tx.objectStore('configs').get(key);
    req.onsuccess = () => cb(req.result ? req.result.value : null);
  });
}
function saveHistory(session, cb) {
  openDb(() => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').add(session);
    tx.oncomplete = () => cb && cb();
  });
}
function loadHistory(cb) {
  openDb(() => {
    const tx = db.transaction('history');
    const cursor = tx.objectStore('history').openCursor();
    const arr = [];
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        arr.push(c.value);
        c.continue();
      } else {
        cb(arr);
      }
    };
  });
}
function deleteHistory(ids, cb) {
  openDb(() => {
    const tx = db.transaction('history', 'readwrite');
    ids.forEach(id => tx.objectStore('history').delete(id));
    tx.oncomplete = () => cb && cb();
  });
}
function saveWebhooks(array, cb) {
  openDb(() => {
    const tx = db.transaction('webhooks', 'readwrite');
    const store = tx.objectStore('webhooks');
    store.clear().onsuccess = () => {
      array.forEach(wh => {
        // 兼容从官方同步、导入等场景，自动补 id，已有 id 则 put 更新，无 id 用 add
        if (!wh.id) wh.id = Date.now() + Math.random();
        store.put(wh);
      });
    };
    tx.oncomplete = () => cb && cb();
  });
}
function loadWebhooks(cb) {
  openDb(() => {
    const tx = db.transaction('webhooks');
    const cursor = tx.objectStore('webhooks').openCursor();
    const arr = [];
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        arr.push(c.value);
        c.continue();
      } else {
        cb(arr);
      }
    };
  });
}
///////////////////// BLE设备与心率采集（模拟） /////////////////////
// 为演示方便，此处用虚拟设备和定时生成随机心率值
let fakeConnected = false;
let heartRateTimer = null;

document.getElementById('scanBtn').onclick = async function () {
  if (!navigator.bluetooth) {
    alert('此浏览器不支持 Web 蓝牙');
    return;
  }
  document.getElementById('scanStatus').innerText = '正在扫描并连接...';
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service']
    });
    document.getElementById('scanStatus').innerText = '正在连接...';
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const characteristic = await service.getCharacteristic('heart_rate_measurement');
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      const value = event.target.value;
      let bpm = 0;
      if (value.getUint8(0) & 0x01) {
        bpm = value.getUint16(1, true);
      } else {
        bpm = value.getUint8(1);
      }
      showHeartRate(bpm);
      triggerAllWebhooks('heart_rate_updated', { bpm });
    });
    document.getElementById('disconnectBtn').disabled = false;
    document.getElementById('scanStatus').innerText = '已连接: ' + (device.name || 'BLE设备');
    triggerAllWebhooks('connected', {});
    sessionStart();
    // 记住断开事件
    device.addEventListener('gattserverdisconnected', () => {
      let lastBpm = 0;
      if (heartRateSession && heartRateSession.data.length) {
        lastBpm = heartRateSession.data[heartRateSession.data.length - 1].bpm;
      }
      document.getElementById('scanStatus').innerText = '未连接';
      document.getElementById('disconnectBtn').disabled = true;
      triggerAllWebhooks('disconnected', { bpm: lastBpm });
      sessionEnd();
    });
    window.__currentBleDevice = device;
    window.__currentBleServer = server;
  } catch (e) {
    document.getElementById('scanStatus').innerText = '扫描/连接失败: ' + e;
  }
};
document.getElementById('disconnectBtn').onclick = function () {
  let lastBpm = 0;
  if (heartRateSession && heartRateSession.data.length) {
    lastBpm = heartRateSession.data[heartRateSession.data.length - 1].bpm;
  }
  document.getElementById('scanStatus').innerText = '未连接';
  document.getElementById('disconnectBtn').disabled = true;
  triggerAllWebhooks('disconnected', { bpm: lastBpm });
  sessionEnd();
};
// 注释/停用虚拟心率采集流
function startHeartRateStream() {}
function stopHeartRateStream() {}

///////////////////// 心率展示与 session/历史 /////////////////////
const bpmNumber = document.getElementById('bpmNumber');
const heartAnim = document.getElementById('heartAnim');
let heartChart = null, chartData = [];
const maxPoints = 90;

function initChart() {
  const ctx = document.getElementById('realtimeChart').getContext('2d');
  heartChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{ label: '心率', data: [], borderColor: '#e02e50', backgroundColor: 'rgba(224,46,80,0.10)', tension: 0.3, pointRadius: 0 }]
    },
    options: {
      animation: false,
      scales: { x: { display: false }, y: { min: 20, max: 200, ticks: { stepSize: 20 } } },
      plugins: { legend: { display: false } }
    }
  });
}
initChart();

let heartRateSession = { device: '虚拟心率计', start: null, end: null, data: [] };

function showHeartRate(bpm) {
  bpmNumber.innerText = bpm;
  heartAnim.classList.remove('stopped');
  // 实时同步网页标题
  document.title = `${bpm} | 蓝牙心率监测器`;
  if (heartChart) {
    if (heartChart.data.labels.length >= maxPoints) {
      heartChart.data.labels.shift();
      heartChart.data.datasets[0].data.shift();
    }
    const t = new Date().toLocaleTimeString();
    heartChart.data.labels.push(t);
    heartChart.data.datasets[0].data.push(bpm);
    heartChart.update();
  }
  if (sessionRecording()) {
    heartRateSession.data.push({ t: Date.now(), bpm });
  }
  updateFloatingWindow(bpm);
}

function sessionStart() {
  heartRateSession = {
    device: '虚拟心率计',
    start: new Date(),
    end: null,
    data: []
  }
}
function sessionEnd() {
  if (sessionRecording() && heartRateSession.data.length) {
    heartRateSession.end = new Date();
    saveHistory(heartRateSession, () => { });
  }
}
function sessionRecording() {
  return document.getElementById('recEnable').checked;
}

///////////////////// 悬浮窗联动 /////////////////////
const floatBox = document.getElementById('ble-floating');
const floatHeart = document.getElementById('floatHeart');
const floatBpm = document.getElementById('floatBpm');
function updateFloatingWindow(bpm) {
  if (!document.getElementById('floatEnable').checked) return;
  floatBox.style.display = 'block';
  floatBpm.textContent = document.getElementById('floatShowText').checked ? bpm : '';
  floatHeart.style.display = document.getElementById('floatShowIcon').checked ? 'inline-block' : 'none';
  floatBox.style.background = hex2rgba(
    document.getElementById('floatBgColor').value,
    Number(document.getElementById('floatAlpha').value)
  );
  floatBox.style.borderColor = document.getElementById('floatBorderColor').value;
  floatBox.style.borderRadius = document.getElementById('floatRadius').value + 'px';
  floatBox.style.color = document.getElementById('floatTextColor').value;
  floatBox.style.fontSize = document.getElementById('floatSize').value + 'px';
  floatHeart.style.width = floatHeart.style.height = document.getElementById('floatIconSize').value + 'px';
}

///////////////////// 历史记录表渲染/管理 /////////////////////
document.getElementById('reloadHistBtn').onclick = renderHistoryTable;
document.getElementById('batchDeleteBtn').onclick = batchDeleteHistory;
function renderHistoryTable() {
  loadHistory(arr => {
    const tbody = document.getElementById('historyTbody');
    tbody.innerHTML = '';
    arr.forEach(sess => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="checkbox" data-id="${sess.id}"/></td>
        <td>${sess.device}</td>
        <td>${new Date(sess.start).toLocaleString()}<br/>${new Date(sess.end).toLocaleString()}</td>
        <td><button class="btn" data-x="detailbtn">详情</button></td>`;
      // 绑定详情按钮事件
      tr.querySelector('[data-x="detailbtn"]').onclick = () => showHistoryDetail(sess);
      tbody.appendChild(tr);
    });
  });
}
function batchDeleteHistory() {
  // 删除所有选中的，并刷新
  const checks = document.querySelectorAll('#historyTbody input[type="checkbox"]:checked');
  const ids = Array.from(checks).map(x => Number(x.dataset.id));
  if (!ids.length) return;
  deleteHistory(ids, renderHistoryTable);
}

///////////////////// Webhook 配置与触发 =================//
let webhooksCache = [];
function initWebhooks() {
  loadWebhooks(arr => {
    webhooksCache = arr;
    renderWebhookList();
  });
}
function renderWebhookList() {
  const listDiv = document.getElementById('webhookList');
  listDiv.innerHTML = '';
  if (!webhooksCache.length) {
    listDiv.innerHTML = '<div style="color:#bbb;">暂无Webhook配置</div>';
    return;
  }
  webhooksCache.forEach((wh, idx) => {
    const card = document.createElement('div');
    card.style = "border:1px solid #e02e50ba;margin:7px 0;padding:7px 13px;border-radius:6px; background:#fafbfc;position:relative;";
    card.innerHTML = `
      <input type="checkbox" ${wh.enabled ? 'checked':''} data-x="en" style="vertical-align:-2px;"/>
      <b>${wh.name || '(未命名)'}</b> <span style="font-size:.85em;color:#555;">[${(wh.triggers||[]).join(',')}]</span>
      <span style="margin-left:1.2em;color:#e02e50;">${wh.url}</span>
      <button class="btn" data-x="edit" style="float:right;">编辑</button>
      <button class="btn" data-x="del" style="float:right;margin-right:6px;">删除</button>
      <button class="btn" data-x="test" style="float:right;margin-right:6px;">测试</button>
      <br><small>Body:</small> <span style="word-break:break-all;">${wh.body||''}</span>
      <br><small>Headers:</small> <span style="word-break:break-all;">${wh.headers||''}</span>
    `;
    card.querySelector('[data-x="edit"]').onclick = () => showWebhookEditor(idx);
    card.querySelector('[data-x="del"]').onclick = () => { webhooksCache.splice(idx, 1); saveWebhooks(webhooksCache, renderWebhookList); };
    card.querySelector('[data-x="test"]').onclick = () => testWebhook(idx);
    card.querySelector('[data-x="en"]').onchange = (e) => { webhooksCache[idx].enabled = e.target.checked; saveWebhooks(webhooksCache, () => {}); };
    listDiv.appendChild(card);
  });
}
let editingIdx = null;
document.getElementById('addWebhookBtn').onclick = () => showWebhookEditor();
document.getElementById('cancelEditWebhookBtn').onclick = () =>
  document.getElementById('webhookEditor').style.display = 'none';
document.getElementById('saveWebhookBtn').onclick = saveWebhookEdit;

function showWebhookEditor(idx) {
  editingIdx = idx;
  const wh = typeof idx === 'number' ? webhooksCache[idx] : {};
  document.getElementById('webhookEditor').style.display = 'block';
  document.getElementById('whName').value = wh?.name || '';
  document.getElementById('whTrigger').value = (wh?.triggers?.[0]) || 'heart_rate_updated';
  document.getElementById('whUrl').value = wh?.url || '';
  document.getElementById('whBody').value = wh?.body || '';
  document.getElementById('whHeaders').value = wh?.headers || '';
}
function saveWebhookEdit() {
  const name = document.getElementById('whName').value.trim();
  const trigger = document.getElementById('whTrigger').value;
  const url = document.getElementById('whUrl').value.trim();
  const body = document.getElementById('whBody').value.trim();
  const headers = document.getElementById('whHeaders').value.trim();
  if (!name || !url) { alert('必须填写名称和URL'); return; }
  const wh = {
    enabled: true, name, url, triggers: [trigger], body, headers
  };
  if (editingIdx !== null && editingIdx >= 0) {
    wh.id = webhooksCache[editingIdx].id; // 保持ID
    webhooksCache[editingIdx] = wh;
  } else {
    wh.id = Date.now() + Math.random();
    webhooksCache.push(wh);
  }
  document.getElementById('webhookEditor').style.display = 'none';
  saveWebhooks(webhooksCache, renderWebhookList);
}
document.getElementById('testWebhookBtn').onclick = function () {
  const idx = webhooksCache.findIndex(w => w.enabled);
  if (idx === -1) return alert('无已启用Webhook');
  testWebhook(idx);
};
function testWebhook(idx) {
  triggerWebhook(webhooksCache[idx], { bpm: 88 });
  alert('已模拟发送，检查目标服务端');
}
// Webhook 官方同步
document.getElementById('pullWebhooksBtn').onclick = function () {
  fetch('https://raw.githubusercontent.com/ccc007ccc/HeartRateMonitor/main/config_webhook.json').then(resp => resp.json())
    .then(arr => {
      if (!Array.isArray(arr)) throw new Error('返回格式有误');
      arr.forEach(wh => wh.enabled = !!wh.enabled);
      saveWebhooks(arr, () => { webhooksCache = arr; renderWebhookList(); });
      alert('已同步官方Webhook预设');
    })
    .catch(e => alert('同步失败:' + e));
};
// 自动触发事件型 webhook
function triggerAllWebhooks(eventType, valueObj) {
  if (!Array.isArray(webhooksCache)) return;
  webhooksCache.forEach(wh => {
    if (wh.enabled && Array.isArray(wh.triggers) && wh.triggers.includes(eventType)) {
      triggerWebhook(wh, valueObj || {});
    }
  });
}
function triggerWebhook(wh, valueObj) {
  if (!wh || !wh.url) return;
  let url = wh.url, body = wh.body, headers = {};
  if (valueObj) {
    Object.keys(valueObj).forEach(k => {
      url = url.replaceAll(`{${k}}`, valueObj[k]);
      if (body) body = body.replaceAll(`{${k}}`, valueObj[k]);
    });
  }
  try {
    if (wh.headers) {
      headers = JSON.parse(wh.headers);
      if (valueObj) {
        Object.keys(valueObj).forEach(k => {
          Object.keys(headers).forEach(hk => {
            if (typeof headers[hk] === 'string') headers[hk] = headers[hk].replaceAll(`{${k}}`, valueObj[k]);
          });
        });
      }
    }
  } catch (e) { alert('Headers格式错误'); return; }
  fetch(url, { method: 'POST', headers, body });
}

///////////////////// 设置项及其持久化 /////////////////////
[
  ['recEnable', 'recEnable', 'checked'],
  ['heartAnimEnable', 'heartAnimEnable', 'checked'],
  ['autoReconnectEnable', 'autoReconnectEnable', 'checked'],
  ['autoConnectCk', 'autoConnect', 'checked']
].forEach(([elId, key, prop]) => {
  const el = document.getElementById(elId);
  // 加载配置
  loadConfig(key, val => {
    if (typeof val === 'boolean' || val === '1' || val === '0')
      el[prop] = (val == 1) || (val === true) || (val === 'true');
  });
  // 保存配置
  el.onchange = () => saveConfig(key, el[prop]);
});

///////////////////// 工具方法与页面初始化 /////////////////////
function hex2rgba(hex, alpha) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
}
// 悬浮窗相关 input 联动
[
  'floatTextColor', 'floatBgColor', 'floatBorderColor', 'floatAlpha',
  'floatRadius', 'floatSize', 'floatIconSize', 'floatShowIcon', 'floatShowText', 'floatEnable'
].forEach(id => {
  document.getElementById(id).oninput =
    document.getElementById(id).onchange =
    () => updateFloatingWindow('--');
});

function showHistoryDetail(sess) {
  const modal = document.getElementById('historyChartModal');
  const title = document.getElementById('histModalTitle');
  const chartBox = document.getElementById('historyChart');
  title.textContent = `${sess.device} ${new Date(sess.start).toLocaleString()} ~ ${new Date(sess.end).toLocaleString()}`;
  // 准备数据
  const bpmArr = sess.data || [];
  const labels = bpmArr.map(r => new Date(r.t).toLocaleTimeString());
  const bpms = bpmArr.map(r => r.bpm);
  // 构建 Chart.js 实例
  // 如已存在，则销毁
  if (window.histChart && typeof window.histChart.destroy === "function") window.histChart.destroy();
  window.histChart = new Chart(chartBox.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{ label: '心率', data: bpms, borderColor: '#e02e50', backgroundColor: 'rgba(224,46,80,0.13)', tension: 0.3, pointRadius: 2 }]
    },
    options: {
      animation: false,
      scales: { x: { display: true }, y: { min: 20, max: 200, ticks: { stepSize: 20 } } },
      plugins: { legend: { display: false } }
    }
  });
  modal.style.display = 'flex';
}
document.getElementById('closeHistModal').onclick = function () {
  document.getElementById('historyChartModal').style.display = 'none';
};
// 页面初始化过程
window.onload = function () {
  renderHistoryTable();
  initWebhooks();
  // 其余设置已在各控件自动加载
};
