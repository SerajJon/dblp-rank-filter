/* DBLP 等级筛选器 — 弹窗 */
(function () {
  'use strict';

  const PRESETS = {
    all: '全部',
    top: '顶会顶刊',
    ab: 'B会 / 一区及以上',
    ccfAll: 'CCF 收录',
    cas1: '中科院一区',
    cas12: '一、二区',
  };

  const DEFAULT_STATE = {
    enabled: true,
    preset: 'ab',
    ccf: { A: 1, B: 1, C: 0, N: 0 },
    cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 },
    types: { journal: 1, conf: 1, preprint: 0 },
  };

  const RULES = {
    all: { ccf: { A: 1, B: 1, C: 1, N: 1 }, cas: { 1: 1, 2: 1, 3: 1, 4: 1, N: 1 }, types: { journal: 1, conf: 1, preprint: 1 } },
    top: { ccf: { A: 1, B: 0, C: 0, N: 0 }, cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 }, types: { journal: 1, conf: 1, preprint: 0 } },
    ab: { ccf: { A: 1, B: 1, C: 0, N: 0 }, cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 }, types: { journal: 1, conf: 1, preprint: 0 } },
    ccfAll: { ccf: { A: 1, B: 1, C: 1, N: 0 }, cas: { 1: 0, 2: 0, 3: 0, 4: 0, N: 0 }, types: { journal: 1, conf: 1, preprint: 0 } },
    cas1: { ccf: { A: 0, B: 0, C: 0, N: 0 }, cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 }, types: { journal: 1, conf: 0, preprint: 0 } },
    cas12: { ccf: { A: 0, B: 0, C: 0, N: 0 }, cas: { 1: 1, 2: 1, 3: 0, 4: 0, N: 0 }, types: { journal: 1, conf: 0, preprint: 0 } },
  };

  let state = Object.assign({}, DEFAULT_STATE);

  function render() {
    const box = document.getElementById('presets');
    box.textContent = '';
    for (const [k, label] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = state.preset === k ? 'on' : '';
      b.addEventListener('click', () => {
        state.preset = k;
        const r = RULES[k];
        if (r) {
          state.ccf = Object.assign({}, r.ccf);
          state.cas = Object.assign({}, r.cas);
          state.types = Object.assign({}, r.types);
        }
        state.fullMode = false;
        chrome.storage.local.set({ settings: state }, () => {
          render();
          applyToTab();
        });
      });
      box.appendChild(b);
    }
  }

  function applyToTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || !t.id) return;
      chrome.tabs.sendMessage(t.id, { type: 'drf:refresh' }, () => void chrome.runtime.lastError);
    });
  }

  chrome.storage.local.get('settings', (r) => {
    if (r && r.settings) {
      state = Object.assign({}, DEFAULT_STATE, r.settings);
      state.ccf = Object.assign({}, DEFAULT_STATE.ccf, r.settings.ccf || {});
      state.cas = Object.assign({}, DEFAULT_STATE.cas, r.settings.cas || {});
      state.types = Object.assign({}, DEFAULT_STATE.types, r.settings.types || {});
    }
    document.getElementById('enabled').checked = !!state.enabled;
    render();
  });

  document.getElementById('enabled').addEventListener('change', (e) => {
    state.enabled = e.target.checked;
    chrome.storage.local.set({ settings: state }, applyToTab);
  });

  document.getElementById('go').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://dblp.org/search?q=med%20vqa' });
  });

  // 数据规模信息
  fetch(chrome.runtime.getURL('src/data/ranks.json'))
    .then((r) => r.json())
    .then((d) => {
      const m = d.meta || {};
      document.getElementById('meta').textContent =
        '数据 ' + (m.version || '?') + '｜CCF 会议 ' + Object.keys(d.conf || {}).length +
        ' · CCF 期刊 ' + Object.keys(d.journal || {}).length +
        ' · 分区表期刊 ' + (d.cas || []).length;
    })
    .catch(() => {
      document.getElementById('meta').textContent = '数据文件读取失败';
    });
})();
