/**
 * DBLP 等级筛选器 — 等级匹配引擎
 *
 * 输入：DBLP 记录的 venue 信息（流键 + 展示名）
 * 输出：CCF 等级（A/B/C/未收录）与中科院分区（1-4 区/未收录）
 *
 * 匹配分三级，逐级降级：
 *   1. DBLP 流键精确匹配（conf/cvpr、journals/tmi）—— 最可靠
 *   2. venue 展示名规范化后精确匹配
 *   3. 词元前缀 + 相似度模糊匹配，用于把 DBLP 缩写名
 *      （"IEEE Trans. Medical Imaging"）对齐到分区表全称
 *      （"IEEE Transactions on Medical Imaging"）
 *
 * 关键设计：缩写绝大多数是原词的前缀（Trans.→Transactions、Vis.→Vision），
 * 因此以「前缀匹配」为主，只对少数非前缀缩写（J.→Journal）做显式展开，
 * 避免把 Vis. 误展开成 Visualization 这类错误。
 */
(function () {
  'use strict';

  const STOP = new Set([
    'on', 'of', 'the', 'for', 'and', 'in', 'to', 'a', 'an', 'at', 'by', 'with',
    'from', 'into', 'as', 'via', 'using', 'over', 'under', 'between', 'during',
    'about', 'its', 'their', 'this', 'that', 'these', 'those', 'is', 'are', 'be',
    'not', 'or', 'if', 'then', 'than', 'so', 'such', 'other', 'more', 'most',
    'all', 'any', 'some', 'no', 'only', 'also', 'based', 'special', 'part',
    'series', 'volume', 'vol', 'issue', 'de', 'la', 'le', 'und', 'fur', 'der',
    'die', 'das', 'et', 'al',
  ]);

  // 仅保留「不是原词前缀」的缩写展开；其余交给前缀匹配处理
  const EXPAND = {
    j: 'journal',
    jr: 'journal',
    jrnl: 'journal',
    natl: 'national',
    intl: 'international',
    wk: 'workshop',
    wksp: 'workshop',
    mtg: 'meeting',
  };

  const PREFIX_MIN = 3;      // 短于 3 字符不参与前缀匹配，避免误命中
  const THRESHOLD = 0.8;     // 词元相似度阈值
  const MAX_CANDIDATES = 8000; // 候选集过大时放弃，避免卡顿

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
      .trim();
  }

  function expandTokens(s) {
    const out = [];
    for (const t of norm(s).split(' ')) {
      if (!t || STOP.has(t)) continue;
      out.push(EXPAND[t] || t);
    }
    return out;
  }

  function prefixEq(x, y) {
    if (x === y) return true;
    if (x.length < PREFIX_MIN || y.length < PREFIX_MIN) return false;
    return x.startsWith(y) || y.startsWith(x);
  }

  /** 词元集合相似度（一对一配对） */
  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const used = new Array(b.length).fill(false);
    let inter = 0;
    for (const x of a) {
      for (let i = 0; i < b.length; i++) {
        if (used[i]) continue;
        if (prefixEq(x, b[i])) { used[i] = true; inter++; break; }
      }
    }
    return inter / Math.max(a.length, b.length);
  }

  function firstTokenOk(a, b) {
    return a.length > 0 && b.length > 0 && prefixEq(a[0], b[0]);
  }

  /** 词元倒排索引：精确表 + 前缀感知的候选剪枝 + 相似度打分 */
  function makeMatcher(records) {
    const exact = new Map();
    const inv = new Map();
    records.forEach((rec, i) => {
      if (!rec._t || !rec._t.length) return;
      const k = rec._t.join(' ');
      if (!exact.has(k)) exact.set(k, rec);
      for (const t of rec._t) {
        let s = inv.get(t);
        if (!s) { s = new Set(); inv.set(t, s); }
        s.add(i);
      }
    });
    return { records, exact, inv, keys: [...inv.keys()].sort() };
  }

  function lowerBound(keys, t) {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 取出与词元 t 前缀兼容的所有倒排 posting。
   * DBLP 用的是缩写（"Trans." / "Comput."），分区表用的是全称（"Transactions" /
   * "Computers"），所以不能按精确词元取交集，必须按前缀扩展。
   */
  function postingsForToken(m, t) {
    const out = new Set();
    // 索引词以 t 开头：trans -> transactions
    for (let i = lowerBound(m.keys, t); i < m.keys.length && m.keys[i].startsWith(t); i++) {
      for (const x of m.inv.get(m.keys[i])) out.add(x);
    }
    // t 以索引词开头：process -> process(es) 之类的反向包含
    for (let L = PREFIX_MIN; L < t.length; L++) {
      const s = m.inv.get(t.slice(0, L));
      if (s) for (const x of s) out.add(x);
    }
    return out;
  }

  function bestIn(m, a, set) {
    let best = null;
    let bestScore = 0;
    for (const i of set) {
      const rec = m.records[i];
      if (!firstTokenOk(a, rec._t)) continue;
      const sc = similarity(a, rec._t);
      if (sc > bestScore) { bestScore = sc; best = rec; }
    }
    return bestScore >= THRESHOLD ? best : null;
  }

  function matchIn(m, a) {
    if (!a || !a.length) return null;
    const hit = m.exact.get(a.join(' '));
    if (hit) return hit;

    const sets = [];
    for (const t of a) {
      const s = postingsForToken(m, t);
      if (s.size) sets.push(s);
    }
    if (!sets.length) return null;
    sets.sort((x, y) => x.size - y.size);

    // 先用两个最稀有词元的交集（更精确），失败再退回到最小的那个集合
    if (sets.length >= 2) {
      const inter = new Set();
      for (const i of sets[1]) if (sets[0].has(i)) inter.add(i);
      if (inter.size) {
        const r = bestIn(m, a, inter);
        if (r) return r;
      }
    }
    if (sets[0].size > MAX_CANDIDATES) return null;
    return bestIn(m, a, sets[0]);
  }

  const Engine = {
    data: null,
    _casMatcher: null,
    _ccfMatcher: null,
    _nameCache: null,

    async load() {
      // 用户脚本版本会把等级库直接内联成 window.__DRF_RANKS__，避免额外请求
      if (typeof window !== 'undefined' && window.__DRF_RANKS__) {
        this.data = window.__DRF_RANKS__;
        this._build();
        return this.data;
      }
      const res = await fetch(chrome.runtime.getURL('src/data/ranks.json'));
      this.data = await res.json();
      this._build();
      return this.data;
    },

    _build() {
      const d = this.data;

      const casRecords = d.cas.map((r) => Object.assign({}, r, { _t: expandTokens(r.n) }));
      this._casMatcher = makeMatcher(casRecords);

      // CCF 按展示名建索引（会议用简称，期刊用简称 + 全称）
      const ccfRecords = [];
      const seen = new Set();
      const push = (name, rec, key, kind) => {
        const t = expandTokens(name);
        if (!t.length) return;
        const sig = kind + '|' + t.join(' ');
        if (seen.has(sig)) return;
        seen.add(sig);
        ccfRecords.push({ _t: t, r: rec.r, a: rec.a || rec.f || name, f: rec.f || '', key, kind });
      };
      for (const [key, rec] of Object.entries(d.conf)) {
        push(rec.a, rec, key, 'conf');
        push(rec.f, rec, key, 'conf');
      }
      for (const [key, rec] of Object.entries(d.journal)) {
        push(rec.a, rec, key, 'journal');
        push(rec.f, rec, key, 'journal');
      }
      this._ccfMatcher = makeMatcher(ccfRecords);

      this._nameCache = new Map();
    },

    /**
     * @param {{stream:string, venueName:string, kind:'conf'|'journal'|'preprint'}} q
     * @returns {{ccf:('A'|'B'|'C'|null), ccfName:string, cas:(1|2|3|4|null), casTop:boolean,
     *            casName:string, matchedBy:string}}
     */
    lookup(q) {
      const res = { ccf: null, ccfName: '', cas: null, casTop: false, casName: '', matchedBy: '' };
      if (!this.data) return res;

      const stream = String(q.stream || '').replace(/^\//, '');
      const isPreprint = q.kind === 'preprint' || stream === 'journals/corr';
      if (isPreprint) return res;

      // 1) 流键精确匹配
      if (stream) {
        const rec = this.data.conf[stream] || this.data.journal[stream];
        if (rec) {
          res.ccf = rec.r;
          res.ccfName = rec.a || rec.f || stream;
          res.matchedBy = 'key';
        }
      }

      // 2)/(3) venue 展示名匹配
      const name = (q.venueName || '').trim();
      if (name) {
        const ck = 'ccf:' + name;
        let c = this._nameCache.get(ck);
        if (c === undefined) {
          const hit = matchIn(this._ccfMatcher, expandTokens(name));
          c = hit ? { ccf: hit.r, ccfName: hit.a, matchedBy: 'name' } : null;
          this._nameCache.set(ck, c);
        }
        if (!res.ccf && c) {
          res.ccf = c.ccf;
          res.ccfName = c.ccfName;
          res.matchedBy = c.matchedBy;
        }
      }

      // 中科院分区只对期刊有意义
      if (name && (q.kind === 'journal' || !q.kind)) {
        const mk = 'cas:' + name;
        let m = this._nameCache.get(mk);
        if (m === undefined) {
          m = matchIn(this._casMatcher, expandTokens(name));
          this._nameCache.set(mk, m);
        }
        if (m) {
          res.cas = m.q;
          res.casTop = !!m.t;
          res.casName = m.n;
        }
      }

      return res;
    },

    stats() {
      const d = this.data || {};
      return {
        version: (d.meta && d.meta.version) || '?',
        conf: Object.keys(d.conf || {}).length,
        journal: Object.keys(d.journal || {}).length,
        cas: (d.cas || []).length,
        sources: (d.meta && d.meta.sources) || [],
      };
    },

    /** 诊断用：解释某个 venue 名为什么命中/未命中（也方便同学自己排查） */
    explain(venueName) {
      const out = { name: venueName, tokens: expandTokens(venueName), cas: [] };
      const m = this._casMatcher;
      if (!m) return out;
      const a = out.tokens;
      const sets = [];
      out.postings = a.map((t) => {
        const s = postingsForToken(m, t);
        if (s.size) sets.push(s);
        return { token: t, expanded: s.size };
      });
      if (!sets.length) return out;
      sets.sort((x, y) => x.size - y.size);
      out.candidates = sets[0].size;

      const scored = [];
      const scan = (set) => {
        for (const i of set) {
          const rec = m.records[i];
          if (!firstTokenOk(a, rec._t)) continue;
          scored.push({ n: rec.n, q: rec.q, t: rec.t, score: +similarity(a, rec._t).toFixed(3) });
        }
      };
      if (sets.length >= 2) {
        const inter = new Set();
        for (const i of sets[1]) if (sets[0].has(i)) inter.add(i);
        if (inter.size) { out.intersection = inter.size; scan(inter); }
      }
      if (!scored.length) scan(sets[0]);
      scored.sort((x, y) => y.score - x.score);
      out.cas = scored.slice(0, 5);
      return out;
    },
  };

  window.DRFEngine = Engine;
})();
