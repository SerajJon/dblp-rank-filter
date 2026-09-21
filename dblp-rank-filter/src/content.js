/**
 * DBLP 等级筛选器 — 内容脚本
 *
 * 在 DBLP 搜索结果页做三件事：
 *   1. 给每条结果标注 CCF 等级 / 中科院分区
 *   2. 提供筛选面板（按等级、分区、类型、年份、关键词）
 *   3. 「全量筛选」：绕过分页，通过 DBLP 官方 API 拉取全部命中再筛选
 */
(function () {
  'use strict';

  if (window.__DRF_CONTENT_LOADED__) return;
  window.__DRF_CONTENT_LOADED__ = true;

  const Engine = window.DRFEngine;

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  const PRESETS = {
    all: {
      label: '全部',
      tip: '不做任何等级过滤（含未收录）',
      ccf: { A: 1, B: 1, C: 1, N: 1 },
      cas: { 1: 1, 2: 1, 3: 1, 4: 1, N: 1 },
      types: { journal: 1, conf: 1, preprint: 1 },
    },
    top: {
      label: '顶会顶刊',
      tip: 'CCF-A 类，或中科院一区',
      ccf: { A: 1, B: 0, C: 0, N: 0 },
      cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 },
      types: { journal: 1, conf: 1, preprint: 0 },
    },
    ab: {
      label: 'B会 / 一区及以上',
      tip: 'CCF-A/B 类会议期刊，或中科院一区期刊',
      ccf: { A: 1, B: 1, C: 0, N: 0 },
      cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 },
      types: { journal: 1, conf: 1, preprint: 0 },
    },
    ccfAll: {
      label: 'CCF 收录',
      tip: 'CCF-A/B/C 类会议期刊',
      ccf: { A: 1, B: 1, C: 1, N: 0 },
      cas: { 1: 0, 2: 0, 3: 0, 4: 0, N: 0 },
      types: { journal: 1, conf: 1, preprint: 0 },
    },
    cas1: {
      label: '中科院一区',
      tip: '仅中科院一区及以上期刊',
      ccf: { A: 0, B: 0, C: 0, N: 0 },
      cas: { 1: 1, 2: 0, 3: 0, 4: 0, N: 0 },
      types: { journal: 1, conf: 0, preprint: 0 },
    },
    cas12: {
      label: '一、二区',
      tip: '中科院一区或二区期刊',
      ccf: { A: 0, B: 0, C: 0, N: 0 },
      cas: { 1: 1, 2: 1, 3: 0, 4: 0, N: 0 },
      types: { journal: 1, conf: 0, preprint: 0 },
    },
    custom: { label: '自定义', tip: '', ccf: null, cas: null, types: null },
  };

  const DEFAULT_STATE = Object.assign(
    {
      enabled: true,
      preset: 'ab',
      yearFrom: '',
      yearTo: '',
      include: '',
      exclude: '',
      sortByRank: false,
      collapsed: false,
      fullMode: false,
      maxHits: 1000,
    },
    { ccf: Object.assign({}, PRESETS.ab.ccf) },
    { cas: Object.assign({}, PRESETS.ab.cas) },
    { types: Object.assign({}, PRESETS.ab.types) }
  );

  let state = Object.assign({}, DEFAULT_STATE);
  let entries = [];
  let fullInfos = null;
  let panelEl = null;
  let fullHost = null;
  let fullBox = null;
  const listeners = [];

  const RANK_ORDER = { A: 0, B: 1, C: 2, N: 3 };

  /* ------------------------------------------------------------------ */
  /* 设置持久化                                                          */
  /* ------------------------------------------------------------------ */

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('settings', (r) => {
          if (chrome.runtime.lastError) return resolve();
          const s = r && r.settings;
          if (s && typeof s === 'object') {
            state = Object.assign({}, DEFAULT_STATE, s);
            state.ccf = Object.assign({}, DEFAULT_STATE.ccf, s.ccf || {});
            state.cas = Object.assign({}, DEFAULT_STATE.cas, s.cas || {});
            state.types = Object.assign({}, DEFAULT_STATE.types, s.types || {});
          }
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { chrome.storage.local.set({ settings: state }); } catch (e) { /* ignore */ }
    }, 200);
  }

  /* ------------------------------------------------------------------ */
  /* 结果解析                                                            */
  /* ------------------------------------------------------------------ */

  function yearFromKey(id) {
    let m = id.match(/(\d{4})$/);
    if (m) {
      const y = +m[1];
      if (y >= 1900 && y <= 2100) return y;
    }
    m = id.match(/(\d{2})$/);
    if (m) {
      const y = 2000 + +m[1];
      if (y <= new Date().getFullYear() + 1) return y;
    }
    return null;
  }

  function parseEntry(li) {
    const id = li.id || '';
    const seg = id.split('/');
    const stream = seg.length >= 2 ? seg[0] + '/' + seg[1] : '';
    const cls = li.className || '';
    const informal = /\binformal\b/.test(cls);
    const inproc = /\binproceedings\b|\bincollection\b/.test(cls);
    const article = /\barticle\b/.test(cls);
    const isPreprint = informal || stream === 'journals/corr';
    const kind = isPreprint ? 'preprint' : inproc ? 'conf' : article ? 'journal' : 'other';

    const cite = li.querySelector('cite');
    let title = '';
    let venueName = '';
    let year = null;

    if (cite) {
      const t = cite.querySelector('span.title');
      if (t) title = t.textContent.trim();
      const v = cite.querySelector('span[itemprop="isPartOf"] span[itemprop="name"]');
      if (v) venueName = v.textContent.trim();
      const y = cite.querySelector('[itemprop="datePublished"]');
      if (y) {
        const m = y.textContent.match(/\d{4}/);
        if (m) year = +m[0];
      }
    }
    if (!year) year = yearFromKey(id);
    if (!title) {
      const a = li.querySelector('a[href*="/rec/"]');
      if (a) title = (a.textContent || '').trim();
    }
    if (!venueName && id) venueName = seg[1] ? seg[1].toUpperCase() : '';

    const rank = Engine.lookup({ stream, venueName, kind });
    return { li, id, stream, kind, isPreprint, title, venueName, year, rank };
  }

  const ENTRY_SEL = '#completesearch-publs li.entry, ul.publ-list li.entry';

  function collectEntries() {
    const nodes = document.querySelectorAll(ENTRY_SEL);
    entries = [];
    for (const li of nodes) entries.push(parseEntry(li));
    return entries;
  }

  /**
   * DBLP 的搜索结果由前端 JS 渲染，且可能在扩展执行后整块替换 DOM 节点，
   * 导致已注入的标注与被隐藏的条目全部丢失。这里判断是否需要重跑。
   */
  function needsRefresh() {
    const nodes = document.querySelectorAll(ENTRY_SEL);
    if (!nodes.length) return false;
    if (nodes.length !== entries.length) return true;
    for (const e of entries) if (!e.li.isConnected) return true;
    for (const li of nodes) {
      if (li.querySelector('cite') && !li.querySelector('.drf-badges')) return true;
    }
    return false;
  }


  /* ------------------------------------------------------------------ */
  /* 等级标注                                                            */
  /* ------------------------------------------------------------------ */

  function chip(text, cls, tip) {
    const s = document.createElement('span');
    s.className = 'drf-chip ' + cls;
    s.textContent = text;
    if (tip) s.title = tip;
    return s;
  }

  function applyBadges() {
    for (const e of entries) {
      const cite = e.li.querySelector('cite');
      if (!cite) continue;
      const sig = [e.kind, e.rank.ccf, e.rank.cas, e.rank.casTop, e.rank.ccfName, e.rank.casName].join('|');
      let box = cite.querySelector('.drf-badges');
      if (box && box.dataset.sig === sig) continue;
      if (!box) {
        box = document.createElement('span');
        box.className = 'drf-badges';
        cite.appendChild(box);
      }
      box.dataset.sig = sig;
      box.textContent = '';

      if (e.kind === 'preprint') {
        box.appendChild(chip('预印本', 'drf-chip-none', 'arXiv / CoRR 预印本，未经同行评审'));
        continue;
      }
      if (e.rank.ccf) {
        box.appendChild(
          chip(
            'CCF ' + e.rank.ccf,
            'drf-chip-ccf-' + e.rank.ccf.toLowerCase(),
            (e.rank.ccfName ? e.rank.ccfName + '\n' : '') + 'CCF 推荐目录 ' + e.rank.ccf + ' 类'
          )
        );
      }
      if (e.rank.cas) {
        box.appendChild(
          chip(
            '中科院' + e.rank.cas + '区' + (e.rank.casTop ? ' Top' : ''),
            'drf-chip-cas-' + e.rank.cas,
            (e.rank.casName ? e.rank.casName + '\n' : '') + '中科院文献情报中心期刊分区表：' + e.rank.cas + ' 区' + (e.rank.casTop ? '（Top 期刊）' : '')
          )
        );
      }
      if (!e.rank.ccf && !e.rank.cas) {
        box.appendChild(chip('未收录', 'drf-chip-none', 'CCF 推荐目录与中科院分区表中均未查到该 venue'));
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 筛选                                                                */
  /* ------------------------------------------------------------------ */

  function passes(e) {
    const s = state;
    if (e.kind === 'preprint') return !!s.types.preprint;
    if (e.kind === 'conf' && !s.types.conf) return false;
    if (e.kind === 'journal' && !s.types.journal) return false;

    if (s.yearFrom && e.year && e.year < +s.yearFrom) return false;
    if (s.yearTo && e.year && e.year > +s.yearTo) return false;

    if (s.include) {
      const k = s.include.toLowerCase().trim();
      if (k && !(e.title || '').toLowerCase().includes(k)) return false;
    }
    if (s.exclude) {
      const kws = s.exclude.split(/[,，;；|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      const t = (e.title || '').toLowerCase();
      if (kws.some((k) => t.includes(k))) return false;
    }

    const ccfKey = e.rank.ccf || 'N';
    const casKey = e.rank.cas ? String(e.rank.cas) : 'N';
    return !!(s.ccf[ccfKey] || s.cas[casKey]);
  }

  function rankScore(e) {
    const c = e.rank.ccf ? RANK_ORDER[e.rank.ccf] : 9;
    const q = e.rank.cas || 9;
    return Math.min(c, q) * 10 + (e.rank.casTop ? 0 : 1);
  }

  function applyFilter() {
    let shown = 0;
    for (const e of entries) {
      const ok = state.enabled ? passes(e) : true;
      e.li.classList.toggle('drf-hidden', !ok);
      if (ok) shown++;
    }
    if (state.sortByRank) sortEntries();
    if (fullInfos) renderFullRows();

    const total = entries.length;
    const cnt = panelEl && panelEl.querySelector('#drf-count');
    if (cnt) cnt.textContent = state.enabled ? shown + ' / ' + total : '未启用';

    const hint = panelEl && panelEl.querySelector('#drf-hint');
    if (hint) {
      if (!state.enabled) hint.textContent = '筛选已关闭';
      else if (total && shown === 0) hint.textContent = '没有符合条件的结果，可放宽条件或点击「全部」';
      else hint.textContent = '';
    }
  }

  function sortEntries() {
    if (!entries.length) return;
    const list = entries[0].li.parentElement;
    if (!list) return;
    const order = entries.slice().sort((a, b) => rankScore(a) - rankScore(b));
    const last = entries[entries.length - 1].li;
    let anchor = last.nextSibling;
    while (anchor && anchor.nodeType === 1 && anchor.classList && anchor.classList.contains('entry')) {
      anchor = anchor.nextSibling;
    }
    for (const e of order) list.insertBefore(e.li, anchor);
  }

  /* ------------------------------------------------------------------ */
  /* 全量筛选（DBLP 官方 API）                                            */
  /* ------------------------------------------------------------------ */

  async function fetchAllHits(q, cap) {
    const out = [];
    let f = 0;
    for (let guard = 0; guard < 25; guard++) {
      const url = '/search/publ/api?q=' + encodeURIComponent(q) + '&format=json&h=1000&f=' + f;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('DBLP API HTTP ' + r.status);
      const j = await r.json();
      const hits = (j.result && j.result.hits && j.result.hits.hit) || [];
      if (!hits.length) break;
      for (const h of hits) out.push(h.info);
      const total = parseInt((j.result.hits && j.result.hits['@total']) || '0', 10);
      f += hits.length;
      if (out.length >= cap || f >= total) break;
    }
    return out.slice(0, cap);
  }

  function authorsOf(info) {
    if (!info.authors || !info.authors.author) return [];
    const a = info.authors.author;
    return Array.isArray(a) ? a.map((x) => x.text) : [a.text];
  }

  function infoToEntry(info) {
    const key = info.key || '';
    const seg = key.split('/');
    const stream = seg.length >= 2 ? seg[0] + '/' + seg[1] : '';
    const isPreprint = stream === 'journals/corr';
    const kind = isPreprint ? 'preprint' : /\bConference\b|\bWorkshop\b/i.test(info.type || '') ? 'conf' : 'journal';
    const venueName = info.venue || (seg[1] ? seg[1].toUpperCase() : '');
    const rank = Engine.lookup({ stream, venueName, kind });
    return {
      kind,
      isPreprint,
      title: info.title || '',
      venueName,
      year: parseInt(info.year, 10) || null,
      rank,
      info,
    };
  }

  function ensureFullBox() {
    const host = document.querySelector('#completesearch-publs');
    if (!host) return null;
    if (fullBox && fullBox.isConnected) return fullBox;
    fullBox = document.createElement('div');
    fullBox.id = 'drf-full';
    fullBox.className = 'drf-full';
    host.parentElement.insertBefore(fullBox, host);
    fullHost = host;
    return fullBox;
  }

  function renderFullRows() {
    if (!fullBox || !fullInfos) return;
    const all = fullInfos.map(infoToEntry);
    const shown = all.filter((e) => (state.enabled ? passes(e) : true));
    const list = fullBox.querySelector('.drf-full-list');
    list.textContent = '';
    const body = document.createDocumentFragment();
    for (const e of shown) {
      const li = document.createElement('li');
      li.className = 'drf-full-item';

      const h = document.createElement('div');
      h.className = 'drf-full-title';
      const a = document.createElement('a');
      a.href = 'https://dblp.org/rec/' + e.info.key + '.html';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = e.title;
      h.appendChild(a);
      li.appendChild(h);

      const meta = document.createElement('div');
      meta.className = 'drf-full-meta';
      const au = authorsOf(e.info);
      const auTxt = au.length > 4 ? au.slice(0, 4).join(', ') + ' et al.' : au.join(', ');
      meta.textContent = (auTxt ? auTxt + ' · ' : '') + e.venueName + (e.year ? ' · ' + e.year : '');
      li.appendChild(meta);

      const badgeWrap = document.createElement('span');
      badgeWrap.className = 'drf-badges drf-badges-block';
      if (e.kind === 'preprint') badgeWrap.appendChild(chip('预印本', 'drf-chip-none', 'arXiv / CoRR 预印本'));
      if (e.rank.ccf) badgeWrap.appendChild(chip('CCF ' + e.rank.ccf, 'drf-chip-ccf-' + e.rank.ccf.toLowerCase(), e.rank.ccfName));
      if (e.rank.cas) badgeWrap.appendChild(chip('中科院' + e.rank.cas + '区' + (e.rank.casTop ? ' Top' : ''), 'drf-chip-cas-' + e.rank.cas, e.rank.casName));
      if (!e.rank.ccf && !e.rank.cas && e.kind !== 'preprint') badgeWrap.appendChild(chip('未收录', 'drf-chip-none', '未收录'));
      li.appendChild(badgeWrap);

      body.appendChild(li);
    }
    list.appendChild(body);
    const head = fullBox.querySelector('.drf-full-head');
    head.textContent = '';
    const span = document.createElement('span');
    span.innerHTML =
      '全量结果 <b>' + all.length + '</b> 条，符合筛选 <b>' + shown.length + '</b> 条' +
      (fullInfos.length >= state.maxHits ? '（已截断到前 ' + state.maxHits + ' 条）' : '');
    const back = document.createElement('button');
    back.className = 'drf-link-btn';
    back.textContent = '返回 DBLP 原生列表';
    back.addEventListener('click', exitFullMode);
    head.appendChild(span);
    head.appendChild(back);
  }

  async function enterFullMode() {
    const q = new URLSearchParams(location.search).get('q');
    if (!q) { setHint('当前页面没有查询词，无法全量筛选'); return; }
    setHint('正在通过 DBLP API 获取全部结果…');
    try {
      fullInfos = await fetchAllHits(q, state.maxHits);
    } catch (e) {
      setHint('获取失败：' + e.message + '（可稍后重试，或改用分页）');
      return;
    }
    const box = ensureFullBox();
    if (!box) { setHint('未找到结果容器'); return; }
    box.innerHTML =
      '<div class="drf-full-head"></div><ol class="drf-full-list"></ol>';
    box.style.display = '';
    fullHost.style.display = 'none';
    state.fullMode = true;
    saveSettings();
    renderFullRows();
    setHint('');
  }

  function exitFullMode() {
    if (fullBox) { fullBox.style.display = 'none'; fullBox.innerHTML = ''; }
    if (fullHost) fullHost.style.display = '';
    fullInfos = null;
    state.fullMode = false;
    saveSettings();
    setHint('');
    if (panelEl) {
      const b = panelEl.querySelector('#drf-full');
      if (b) b.textContent = '全量筛选（不限页）';
    }
  }

  /* ------------------------------------------------------------------ */
  /* 面板                                                                */
  /* ------------------------------------------------------------------ */

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'drf-panel';
    panelEl.className = 'drf-panel';

    const presetBtns = Object.entries(PRESETS)
      .filter(([k]) => k !== 'custom')
      .map(([k, v]) => '<button class="drf-pill" data-preset="' + k + '" title="' + v.tip + '">' + v.label + '</button>')
      .join('');

    panelEl.innerHTML =
      '<div class="drf-head">' +
      '  <span class="drf-title">DBLP 等级筛选</span>' +
      '  <span class="drf-count" id="drf-count">–</span>' +
      '  <button class="drf-icon-btn" id="drf-toggle" title="收起 / 展开">▾</button>' +
      '</div>' +
      '<div class="drf-body">' +
      '  <div class="drf-presets">' + presetBtns +
      '    <button class="drf-pill drf-pill-reset" id="drf-reset" title="清空所有条件">重置</button>' +
      '  </div>' +
      '  <div class="drf-group">' +
      '    <div class="drf-label">CCF 等级</div>' +
      '    <div class="drf-chips" data-group="ccf">' +
      '      <button class="drf-chip-btn drf-ccf-a" data-k="A">A 类</button>' +
      '      <button class="drf-chip-btn drf-ccf-b" data-k="B">B 类</button>' +
      '      <button class="drf-chip-btn drf-ccf-c" data-k="C">C 类</button>' +
      '      <button class="drf-chip-btn" data-k="N">未收录</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="drf-group">' +
      '    <div class="drf-label">中科院分区</div>' +
      '    <div class="drf-chips" data-group="cas">' +
      '      <button class="drf-chip-btn" data-k="1">一区</button>' +
      '      <button class="drf-chip-btn" data-k="2">二区</button>' +
      '      <button class="drf-chip-btn" data-k="3">三区</button>' +
      '      <button class="drf-chip-btn" data-k="4">四区</button>' +
      '      <button class="drf-chip-btn" data-k="N">未收录</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="drf-group">' +
      '    <div class="drf-label">类型</div>' +
      '    <div class="drf-chips" data-group="types">' +
      '      <button class="drf-chip-btn" data-k="journal">期刊</button>' +
      '      <button class="drf-chip-btn" data-k="conf">会议</button>' +
      '      <button class="drf-chip-btn" data-k="preprint">预印本</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="drf-group drf-years">' +
      '    <div class="drf-label">年份</div>' +
      '    <input class="drf-num" id="drf-year-from" type="number" placeholder="起" min="1900" max="2100">' +
      '    <span class="drf-dash">–</span>' +
      '    <input class="drf-num" id="drf-year-to" type="number" placeholder="止" min="1900" max="2100">' +
      '  </div>' +
      '  <div class="drf-group">' +
      '    <input class="drf-text" id="drf-include" type="text" placeholder="标题必须包含…">' +
      '    <input class="drf-text" id="drf-exclude" type="text" placeholder="标题排除（逗号分隔）…">' +
      '  </div>' +
      '  <div class="drf-actions">' +
      '    <button class="drf-btn drf-btn-primary" id="drf-full">全量筛选（不限页）</button>' +
      '    <button class="drf-btn" id="drf-sort">按等级排序</button>' +
      '  </div>' +
      '  <div class="drf-hint" id="drf-hint"></div>' +
      '  <div class="drf-meta" id="drf-meta"></div>' +
      '</div>';

    document.body.appendChild(panelEl);
    wirePanel();
    syncPanel();
  }

  function setHint(t) {
    const h = panelEl && panelEl.querySelector('#drf-hint');
    if (h) h.textContent = t || '';
  }

  function chipState(group, k, on) {
    const sel = '#drf-panel [data-group="' + group + '"] [data-k="' + k + '"]';
    const el = panelEl.querySelector(sel);
    if (el) el.classList.toggle('drf-on', !!on);
  }

  function syncPanel() {
    if (!panelEl) return;
    for (const k of ['A', 'B', 'C', 'N']) chipState('ccf', k, state.ccf[k]);
    for (const k of ['1', '2', '3', '4', 'N']) chipState('cas', k, state.cas[k]);
    for (const k of ['journal', 'conf', 'preprint']) chipState('types', k, state.types[k]);

    panelEl.querySelectorAll('.drf-pill[data-preset]').forEach((b) => {
      b.classList.toggle('drf-pill-on', b.dataset.preset === state.preset);
    });

    const yf = panelEl.querySelector('#drf-year-from');
    const yt = panelEl.querySelector('#drf-year-to');
    const inc = panelEl.querySelector('#drf-include');
    const exc = panelEl.querySelector('#drf-exclude');
    if (document.activeElement !== yf) yf.value = state.yearFrom || '';
    if (document.activeElement !== yt) yt.value = state.yearTo || '';
    if (document.activeElement !== inc) inc.value = state.include || '';
    if (document.activeElement !== exc) exc.value = state.exclude || '';

    panelEl.querySelector('#drf-sort').classList.toggle('drf-btn-on', !!state.sortByRank);
    panelEl.querySelector('#drf-full').textContent = state.fullMode ? '退出全量模式' : '全量筛选（不限页）';
    const body = panelEl.querySelector('.drf-body');
    body.style.display = state.collapsed ? 'none' : '';
    panelEl.querySelector('#drf-toggle').textContent = state.collapsed ? '▸' : '▾';

    if (!panelEl.querySelector('#drf-meta').dataset.done) {
      const st = Engine.stats();
      panelEl.querySelector('#drf-meta').textContent =
        '数据 ' + st.version + '｜CCF 会议 ' + st.conf + ' · CCF 期刊 ' + st.journal + ' · 分区表期刊 ' + st.cas;
      panelEl.querySelector('#drf-meta').dataset.done = '1';
    }
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    state.preset = name;
    if (p && p.ccf) {
      state.ccf = Object.assign({}, p.ccf);
      state.cas = Object.assign({}, p.cas);
      state.types = Object.assign({}, p.types);
    }
    saveSettings();
    syncPanel();
    applyFilter();
  }

  function markCustom() {
    state.preset = 'custom';
    saveSettings();
    syncPanel();
  }

  function wirePanel() {
    panelEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;

      if (t.dataset.preset) { applyPreset(t.dataset.preset); return; }

      if (t.dataset.k && t.closest('.drf-chips')) {
        const group = t.closest('.drf-chips').dataset.group;
        const k = t.dataset.k;
        state[group][k] = state[group][k] ? 0 : 1;
        markCustom();
        applyFilter();
        return;
      }

      if (t.id === 'drf-toggle') {
        state.collapsed = !state.collapsed;
        saveSettings();
        syncPanel();
        return;
      }
      if (t.id === 'drf-reset') { applyPreset('all'); return; }
      if (t.id === 'drf-sort') {
        state.sortByRank = !state.sortByRank;
        saveSettings();
        syncPanel();
        applyFilter();
        return;
      }
      if (t.id === 'drf-full') {
        if (state.fullMode) exitFullMode();
        else enterFullMode();
        return;
      }
    });

    const pair = [
      ['#drf-year-from', 'yearFrom'],
      ['#drf-year-to', 'yearTo'],
      ['#drf-include', 'include'],
      ['#drf-exclude', 'exclude'],
    ];
    for (const [sel, key] of pair) {
      const el = panelEl.querySelector(sel);
      el.addEventListener('input', () => {
        state[key] = el.value;
        saveSettings();
        applyFilter();
      });
    }
  }

  function removePanel() {
    if (panelEl && panelEl.parentElement) panelEl.parentElement.removeChild(panelEl);
    panelEl = null;
  }

  /* ------------------------------------------------------------------ */
  /* 启动与重跑                                                          */
  /* ------------------------------------------------------------------ */

  function refresh() {
    collectEntries();
    if (!entries.length) return;
    applyBadges();
    applyFilter();
  }

  let pending = null;
  function scheduleRefresh() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (needsRefresh()) refresh();
    }, 350);
  }

  function startObserver() {
    const obs = new MutationObserver(() => scheduleRefresh());
    obs.observe(document.body, { childList: true, subtree: true });

    // 兜底：DBLP 渲染时机不完全可预测，前 30 秒持续核对
    let ticks = 0;
    const iv = setInterval(() => {
      if (needsRefresh()) refresh();
      if (++ticks > 60) clearInterval(iv);
    }, 500);
  }

  function waitForResults(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const n = document.querySelectorAll(ENTRY_SEL).length;
        if (n > 0 || Date.now() - t0 > timeoutMs) return resolve(n);
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  async function boot() {
    try {
      await Engine.load();
    } catch (e) {
      console.error('[DBLP 等级筛选器] 等级数据加载失败', e);
      return;
    }
    await loadSettings();
    await waitForResults(8000);
    buildPanel();
    refresh();
    startObserver();

    // 弹窗/其他标签页改了设置 -> 同步
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings || !changes.settings.newValue) return;
        const s = changes.settings.newValue;
        state = Object.assign({}, DEFAULT_STATE, s);
        state.ccf = Object.assign({}, DEFAULT_STATE.ccf, s.ccf || {});
        state.cas = Object.assign({}, DEFAULT_STATE.cas, s.cas || {});
        state.types = Object.assign({}, DEFAULT_STATE.types, s.types || {});
        syncPanel();
        if (state.fullMode && !fullInfos) enterFullMode();
        else if (!state.fullMode && fullInfos) exitFullMode();
        else applyFilter();
      });
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'drf:refresh') { syncPanel(); applyFilter(); }
      });
    } catch (e) { /* 忽略 */ }

    // 快捷键 Alt+F 快速收起/展开
    document.addEventListener('keydown', (ev) => {
      if (ev.altKey && (ev.key === 'f' || ev.key === 'F')) {
        state.collapsed = !state.collapsed;
        saveSettings();
        syncPanel();
      }
    });

    window.addEventListener('popstate', () => {
      setTimeout(() => { exitFullModeIfStale(); refresh(); }, 300);
    });
  }

  function exitFullModeIfStale() {
    if (state.fullMode) exitFullMode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
