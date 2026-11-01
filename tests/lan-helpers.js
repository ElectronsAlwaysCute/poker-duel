'use strict';
/*
 * LAN 集成测试公共工具（零依赖，仅 Node 内置模块）
 * 依据 docs/LAN.md（唯一契约）。职责：
 *  - 以编程方式启动 server.js：createLanServer({}) + listen(0,'127.0.0.1')
 *  - 原始 HTTP 客户端（保留响应原始文本，供脱敏审计）
 *  - SSE 客户端：解析 id/event/data，保留服务器下发的原始 data 字符串
 *  - 视图分析：隐藏占位卡结构校验、公开投影、镜像比较、秘密集合提取
 *  - 双客户端对局驱动（用镜像视图 + Engine.getLegalActions 计算合法行动）
 */

const http = require('http');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));

/* ------------------------------------------------------------------ */
/* 服务器启动                                                          */
/* ------------------------------------------------------------------ */

async function startLanServer(opts) {
  opts = opts || {};
  let mod;
  try {
    mod = require(path.join(ROOT, 'server.js'));
  } catch (err) {
    console.error('\n[qa] 无法加载 server.js：' + err.message + '\n');
    process.exit(2);
  }
  const factory = mod.createLanServer || (mod.default && mod.default.createLanServer);
  if (typeof factory !== 'function') {
    console.error('\n[qa] server.js 未导出 createLanServer（docs/LAN.md 要求可编程启动）\n');
    process.exit(2);
  }
  const srv = factory({ port: 0, host: '127.0.0.1', lanUrls: opts.lanUrls });
  const info = await srv.listen(0, '127.0.0.1');
  const port = info && (info.port || (srv.server && srv.server.address() && srv.server.address().port));
  assert.ok(port > 0, '无法确定服务器端口');
  return {
    srv,
    port,
    baseUrl: 'http://127.0.0.1:' + port,
    lanUrls: (info && info.lanUrls) || srv.getLanUrls(),
    close: async () => { try { await srv.close(); } catch (e) { /* ignore */ } },
  };
}

/* ------------------------------------------------------------------ */
/* 原始 HTTP 客户端                                                    */
/* ------------------------------------------------------------------ */

/**
 * 发起 HTTP 请求，保留原始响应文本（脱敏审计用）。
 * @returns {{status,headers,text,json,error}}
 */
function request(port, method, pathName, options) {
  options = options || {};
  return new Promise((resolve) => {
    let bodyText = null;
    if (options.body !== undefined) {
      bodyText = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    const headers = Object.assign({}, options.headers || {});
    if (bodyText !== null && !options.omitContentType) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyText);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers,
      timeout: options.timeoutMs || 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, raw: text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('HTTP 请求超时')); });
    req.on('error', (err) => resolve({ status: 0, headers: {}, text: '', json: null, error: String(err && err.message || err) }));
    if (bodyText !== null) req.write(bodyText);
    req.end();
  });
}

/** 构造带 token 的 API 客户端（仅用于记录全部 HTTP 原始响应文本）。 */
class HttpClient {
  constructor(port, label) {
    this.port = port;
    this.label = label || 'client';
    this.rawHttpTexts = [];
    this.token = null;
    this.code = null;
    this.playerId = null;
  }
  async call(method, pathName, body, options) {
    const sep = pathName.indexOf('?') >= 0 ? '&' : '?';
    let full = pathName;
    if (options && options.queryToken && this.token) full += sep + 'token=' + encodeURIComponent(this.token);
    const res = await request(this.port, method, full, Object.assign({ body }, options || {}));
    this.rawHttpTexts.push(res.text);
    return res;
  }
  get(pathName, options) { return this.call('GET', pathName, undefined, options); }
  post(pathName, body, options) { return this.call('POST', pathName, body, options); }
}

/* ------------------------------------------------------------------ */
/* SSE 客户端                                                          */
/* ------------------------------------------------------------------ */

class SseClient {
  constructor(port, code, token, label) {
    this.port = port;
    this.code = code;
    this.token = token;
    this.label = label || 'sse';
    this.events = [];          // {id,event,data,json,raw}
    this.rawPayloads = [];     // 服务器原始 data 文本（脱敏审计）
    this.chunks = [];
    this.closed = false;
    this.ended = false;
    this._waiters = [];
    this._req = null;
    this._connectedResolve = null;
  }

  get path() {
    return '/api/rooms/' + encodeURIComponent(this.code) + '/stream?token=' + encodeURIComponent(this.token);
  }

  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = http.request({ host: '127.0.0.1', port: this.port, method: 'GET', path: this.path, timeout: timeoutMs || 8000 }, (res) => {
        if (res.statusCode !== 200) {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => reject(new Error('SSE 连接失败 status=' + res.statusCode + ' body=' + text.slice(0, 300))));
          return;
        }
        // 已收到响应头：连接成功，关闭 socket 超时（SSE 长连接）
        settled = true;
        req.setTimeout(0);
        resolve();
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          this.chunks.push(chunk);
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this._handleBlock(block);
          }
        });
        res.on('end', () => { this.ended = true; this._notifyEnded(); });
        res.on('close', () => { this.ended = true; this._notifyEnded(); });
      });
      this._req = req;
      req.on('timeout', () => { if (!settled) { req.destroy(new Error('SSE 连接超时')); } });
      req.on('error', (err) => {
        if (!this.ended) { this.ended = true; }
        if (!settled) reject(err);
      });
      req.end();
    });
  }

  _handleBlock(block) {
    const lines = block.split('\n');
    const ev = { id: null, event: 'message', data: '', raw: block };
    for (const line of lines) {
      if (!line || line.charAt(0) === ':') continue; // 注释 / ping
      const i = line.indexOf(':');
      const key = i >= 0 ? line.slice(0, i) : line;
      let value = i >= 0 ? line.slice(i + 1) : '';
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (key === 'id') ev.id = value;
      else if (key === 'event') ev.event = value;
      else if (key === 'data') ev.data += (ev.data ? '\n' : '') + value;
    }
    if (!ev.data) return; // ping/connected
    this.rawPayloads.push(ev.data);
    let json = null;
    try { json = JSON.parse(ev.data); } catch (e) { /* 记录原始解析失败 */ }
    ev.json = json;
    ev.seq = json && typeof json.seq === 'number' ? json.seq : (ev.id != null ? Number(ev.id) : null);
    this.events.push(ev);
    this._flushWaiters();
  }

  _flushWaiters() {
    for (let i = this._waiters.length - 1; i >= 0; i--) {
      const w = this._waiters[i];
      let found = null;
      for (const ev of this.events) {
        if (ev._used && !w.reuse) continue;
        if (w.match(ev)) { found = ev; break; }
      }
      if (found) {
        found._used = true;
        this._waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(found);
      }
    }
  }

  _notifyEnded() {
    for (const w of this._waiters) {
      if (w.wantEnd) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
    this._waiters = this._waiters.filter((w) => w.wantEnd ? (clearTimeout(w.timer), false) : true);
  }

  /** 等待满足 match 的事件（已收到的事件也会被匹配）。 */
  waitFor(match, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const w = { match: typeof match === 'string' ? (ev) => ev.event === match : match, reuse: false, wantEnd: false };
      // 先找未消费的历史事件
      for (const ev of this.events) {
        if (!ev._used && w.match(ev)) { ev._used = true; return resolve(ev); }
      }
      if (this.ended) return reject(new Error('SSE 已结束（' + (label || '') + '）'));
      w.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        reject(new Error('等待 SSE 事件超时：' + (label || String(match)) +
          '（已收到 ' + this.events.length + ' 条：' + this.events.slice(-6).map((e) => e.event + '#' + e.seq).join(',') + '）'));
      }, timeoutMs || 8000);
      w.resolve = resolve;
      w.reject = reject;
      this._waiters.push(w);
    });
  }

  /** 等待 SSE 连接结束（服务器关闭）。 */
  waitEnded(timeoutMs) {
    return new Promise((resolve) => {
      if (this.ended) return resolve(true);
      const w = { wantEnd: true, resolve: () => resolve(true), match: () => false, timer: null };
      w.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        resolve(false);
      }, timeoutMs || 5000);
      this._waiters.push(w);
    });
  }

  latestUpdate() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].event === 'update') return this.events[i].json;
    }
    return null;
  }

  allRawText() { return this.rawPayloads.join('\n'); }

  close() {
    if (this._req) { try { this._req.destroy(); } catch (e) { /* ignore */ } }
    this.closed = true;
  }
}

/* ------------------------------------------------------------------ */
/* 视图分析：隐藏占位卡 / 公开投影 / 镜像                              */
/* ------------------------------------------------------------------ */

const HIDDEN_FIELDS = {
  rank: '?',
  suit: null,
  suitSymbol: '',
  red: false,
  value: 0,
  joker: false,
  revealed: false,
};

function isHiddenCard(card) {
  if (!card || typeof card !== 'object') return false;
  if (card.hidden !== true) return false;
  if (typeof card.id !== 'string' || !/^hidden-[A-Za-z0-9_-]+$/.test(card.id)) return false;
  for (const k of Object.keys(HIDDEN_FIELDS)) {
    const expected = HIDDEN_FIELDS[k];
    if (expected === null) { if (card[k] !== null) return false; }
    else if (card[k] !== expected) return false;
  }
  return true;
}

/** 断言数组内全是隐藏占位卡且数量正确；返回错误数组。 */
function assertAllHidden(cards, expectedCount, label) {
  const errors = [];
  if (!Array.isArray(cards)) return [label + ' 不是数组'];
  if (expectedCount != null && cards.length !== expectedCount) {
    errors.push(label + ' 隐藏占位数量=' + cards.length + '，期望=' + expectedCount);
  }
  cards.forEach((c, i) => {
    if (!isHiddenCard(c)) errors.push(label + '[' + i + '] 不是合法隐藏占位卡：' + JSON.stringify(c).slice(0, 160));
  });
  // 占位卡 id 在同一数组内不得重复（否则无法按数量表示）
  const ids = cards.map((c) => c && c.id);
  if (new Set(ids).size !== ids.length) errors.push(label + ' 占位卡 id 重复');
  return errors;
}

function idOf(c) { return c && typeof c === 'object' ? c.id : c; }

/** 从某客户端视角提取「自己的私密牌 id 集合」（对手绝不应知道）。 */
function extractOwnSecrets(state) {
  const secrets = new Set();
  if (!state) return secrets;
  (state.players.p1.hand || []).forEach((c) => { if (!c.hidden) secrets.add(c.id); });
  for (const r of state.regions || []) {
    (r.sides.p1.faceDown || []).forEach((c) => { if (!c.hidden) secrets.add(c.id); });
  }
  if (state.layout && state.layout.assignments && state.layout.assignments.p1 && !state.layout.revealed) {
    for (const c of state.layout.assignments.p1) if (c && !c.hidden) secrets.add(c.id);
  }
  return secrets;
}

/** 从某客户端视角的事件中提取「自己的私密牌 id」（draw/extra_draw/难度摸牌等）。 */
function extractOwnEventSecrets(events, state) {
  const secrets = new Set();
  (events || []).forEach((ev) => {
    if (!ev) return;
    const own = ev.playerId === 'p1';
    if ((ev.type === 'place' || ev.type === 'move') && own && ev.card && !ev.card.hidden) secrets.add(ev.card.id);
    if (ev.type === 'draw' && own && ev.card && !ev.card.hidden) secrets.add(ev.card.id);
    if (ev.type === 'extra_draw' && own && ev.card && !ev.card.hidden) secrets.add(ev.card.id);
    if ((ev.type === 'settle' || ev.type === 'endgame_settle') && ev.difficultyDraw) {
      if (ev.difficultyDraw.playerId === 'p1' && ev.difficultyDraw.card && !ev.difficultyDraw.card.hidden) {
        secrets.add(ev.difficultyDraw.card.id);
      }
    }
  });
  return secrets;
}

/**
 * 收集「当前时刻仍属自己私密、且从未公开过」的牌 id（脱敏审计真值）。
 * 规则：私密牌→公开的合法途径包括：翻牌、布局揭示、结算补牌、正面牌、已揭示弃牌、难度摸牌（仅收取方）。
 * 因此从「曾私密集合」中剔除「已公开集合」，避免把已合法公开的牌误判为泄漏。
 * @param sse SseClient（该客户端视角的 update 事件流）
 * @param state 该客户端最新视图 state
 */
function collectPrivateSecrets(sse, state, otherSse) {
  const privateIds = new Set();
  const publicIds = new Set();
  if (!state) return privateIds;
  // 当前仍私密的区域（自己手牌 / 自己背面牌 / 揭示前自己的布局分配）
  (state.players.p1.hand || []).forEach((c) => { if (!c.hidden) privateIds.add(c.id); });
  for (const r of state.regions || []) {
    (r.sides.p1.faceDown || []).forEach((c) => { if (!c.hidden) privateIds.add(c.id); });
  }
  if (state.layout && !state.layout.revealed && state.layout.assignments && state.layout.assignments.p1) {
    for (const c of state.layout.assignments.p1) if (c && !c.hidden) privateIds.add(c.id);
  }
  // 历史事件中的私密牌（自己发起的 place/move/draw/extra_draw、自己收取的难度摸牌）
  for (const ev of sse.events) {
    const u = ev.json;
    if (!u || u.type !== 'update') continue;
    for (const e of u.events || []) {
      if (!e) continue;
      if ((e.type === 'place' || e.type === 'move' || e.type === 'draw' || e.type === 'extra_draw') &&
        e.playerId === 'p1' && e.card && !e.card.hidden) {
        privateIds.add(e.card.id);
      }
      if ((e.type === 'settle' || e.type === 'endgame_settle') && e.difficultyDraw &&
        e.difficultyDraw.playerId === 'p1' && e.difficultyDraw.card && !e.difficultyDraw.card.hidden) {
        privateIds.add(e.difficultyDraw.card.id);
      }
    }
  }
  // 历史/当前已公开牌（对本客户端而言双方均可见）
  const addLayout = (layout) => {
    ['p1', 'p2'].forEach((pid) => (layout && layout[pid] || []).forEach((c) => c && c.id && publicIds.add(c.id)));
  };
  const publicStreams = [sse, otherSse].filter(Boolean);
  for (const stream of publicStreams) for (const ev of stream.events) {
    const u = ev.json;
    if (!u || u.type !== 'update') continue;
    const st = u.state;
    if (st) {
      for (const r of st.regions || []) {
        for (const pid of ['p1', 'p2']) {
          (r.sides[pid].faceUp || []).forEach((c) => publicIds.add(c.id));
        }
        if (r.result) {
          for (const pid of ['p1', 'p2']) {
            ((r.result.faceUp && r.result.faceUp[pid]) || []).forEach((c) => publicIds.add(c.id));
            const drawn = r.result.drawn && r.result.drawn[pid];
            if (Array.isArray(drawn)) drawn.forEach((c) => c && c.id && publicIds.add(c.id));
          }
        }
      }
      for (const c of st.discard || []) if (!c.hidden) publicIds.add(c.id);
      if (st.layout && st.layout.revealed) addLayout(st.layout.assignments);
    }
    for (const e of u.events || []) {
      if (!e) continue;
      if (e.type === 'flip' && e.card) publicIds.add(e.card.id);
      if (e.type === 'layout_reveal') addLayout(e.layout);
      if (e.type === 'settle' || e.type === 'endgame_settle') {
        for (const pid of ['p1', 'p2']) {
          ((e.regionResult && e.regionResult.faceUp && e.regionResult.faceUp[pid]) || []).forEach((c) => publicIds.add(c.id));
        }
        if (e.drawn) {
          for (const pid of ['p1', 'p2']) {
            const list = e.drawn[pid];
            if (Array.isArray(list)) list.forEach((c) => c && c.id && publicIds.add(c.id));
          }
        }
      }
    }
  }
  for (const id of publicIds) privateIds.delete(id);
  return privateIds;
}

/** 公开投影：去除隐藏身份，只保留双方都可见的公开信息；guest 视角会做 p1↔p2 交换后比较。 */
function publicProjection(state, opts) {
  opts = opts || {};
  const swap = !!opts.guestSwap;
  const swapPid = (pid) => (swap && (pid === 'p1' || pid === 'p2') ? (pid === 'p1' ? 'p2' : 'p1') : pid);
  const projRegionSides = (sides) => {
    const side = (pid) => {
      const src = sides[swapPid(pid)] || { faceUp: [], faceDown: [] };
      return {
        faceUpIds: (src.faceUp || []).map((c) => c.id).sort(),
        faceUpSums: (src.faceUp || []).reduce((n, c) => n + (c.value || 0), 0),
        faceDownCount: (src.faceDown || []).length,
      };
    };
    return { p1: side('p1'), p2: side('p2') };
  };
  const projResult = (r) => r ? {
    winner: swapPid(r.winner),
    reason: r.reason,
    early: !!r.early,
    unsettledRegions: (r.unsettledRegions || []).slice().sort(),
    regionWins: { p1: swap ? r.regionWins.p2 : r.regionWins.p1, p2: swap ? r.regionWins.p1 : r.regionWins.p2, ties: r.regionWins.ties },
    handSums: { p1: swap ? r.handSums.p2 : r.handSums.p1, p2: swap ? r.handSums.p1 : r.handSums.p2 },
    winsNeeded: r.winsNeeded,
  } : null;
  const projRegionResult = (res, regionIndex) => res ? {
    winner: swapPid(res.winner),
    settleCards: res.settleCards,
    sums: { p1: swap ? res.sums.p2 : res.sums.p1, p2: swap ? res.sums.p1 : res.sums.p2 },
    faceUpIds: {
      p1: ((res.faceUp && res.faceUp[swapPid('p1')]) || []).map((c) => c.id).sort(),
      p2: ((res.faceUp && res.faceUp[swapPid('p2')]) || []).map((c) => c.id).sort(),
    },
    drawnIds: {
      p1: ((res.drawn && res.drawn[swapPid('p1')]) || []).map((c) => c.id).sort(),
      p2: ((res.drawn && res.drawn[swapPid('p2')]) || []).map((c) => c.id).sort(),
    },
  } : null;
  return {
    phase: state.phase,
    turn: swapPid(state.turn),
    deckCount: (state.deck || []).length,
    discardCount: (state.discard || []).length,
    discardRevealedIds: (state.discard || []).filter((c) => !c.hidden).map((c) => c.id).sort(),
    players: {
      p1: {
        handCount: swap ? (state.players.p2.hand || []).length : (state.players.p1.hand || []).length,
        regionsWon: swap ? state.players.p2.regionsWon : state.players.p1.regionsWon,
      },
      p2: {
        handCount: swap ? (state.players.p1.hand || []).length : (state.players.p2.hand || []).length,
        regionsWon: swap ? state.players.p1.regionsWon : state.players.p2.regionsWon,
      },
    },
    regions: (state.regions || []).map((r) => ({
      id: r.id,
      status: r.status,
      sides: projRegionSides(r.sides),
      result: projRegionResult(r.result, r.id),
    })),
    regionWins: { p1: swap ? state.regionWins.p2 : state.regionWins.p1, p2: swap ? state.regionWins.p1 : state.regionWins.p2, ties: state.regionWins.ties },
    layout: {
      submitted: { p1: swap ? state.layout.submitted.p2 : state.layout.submitted.p1, p2: swap ? state.layout.submitted.p1 : state.layout.submitted.p2 },
      revealed: state.layout.revealed,
      assignmentIds: state.layout.revealed ? {
        p1: (state.layout.assignments[swapPid('p1')] || []).map(idOf).sort(),
        p2: (state.layout.assignments[swapPid('p2')] || []).map(idOf).sort(),
      } : undefined,
    },
    endgame: { triggered: !!state.endgame.triggered, threshold: state.endgame.threshold },
    result: projResult(state.result),
    config: {
      regionCount: state.config.regionCount,
      difficulty: state.config.difficulty,
      settleCards: state.config.settleCards,
      winsNeeded: state.config.winsNeeded,
      initialDraw: state.config.initialDraw,
      layoutCount: state.config.layoutCount,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 断言辅助                                                            */
/* ------------------------------------------------------------------ */

function assertNoErrors(errors, label) {
  if (errors && errors.length) {
    throw new Error('[' + (label || 'LAN 断言') + '] ' + errors.length + ' 项失败：\n  - ' + errors.join('\n  - '));
  }
}

/** 断言 API 成功响应。 */
function assertOk(res, label) {
  assert.ok(res && res.status >= 200 && res.status < 300, (label || 'API') + ' 期望 HTTP 2xx，实际 ' + (res && res.status) +
    ' body=' + JSON.stringify(res && (res.json || res.text)).slice(0, 400));
  assert.ok(res.json && res.json.ok === true, (label || 'API') + ' 期望 {ok:true}，实际 ' + JSON.stringify(res.json).slice(0, 300));
  return res.json;
}

/** 断言 API 错误响应（状态码/错误码），返回 error 对象。 */
function assertApiError(res, opts, label) {
  opts = opts || {};
  const allowedStatus = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : [400, 403, 404, 405, 409, 410, 500, 503];
  const allowedCodes = opts.code ? (Array.isArray(opts.code) ? opts.code : [opts.code]) : null;
  assert.ok(res, (label || 'API 错误') + '：无响应');
  assert.ok(allowedStatus.indexOf(res.status) >= 0, (label || 'API 错误') + '：期望 HTTP ' + allowedStatus.join('/') + '，实际 ' + res.status +
    ' body=' + (res.text || '').slice(0, 300));
  assert.ok(res.json && res.json.ok === false, (label || 'API 错误') + '：期望 {ok:false}，实际 ' + (res.text || '').slice(0, 300));
  const err = res.json.error;
  assert.ok(err && typeof err.code === 'string', (label || 'API 错误') + '：缺少 error.code');
  assert.ok(typeof err.message === 'string' && err.message.length > 0, (label || 'API 错误') + '：缺少中文 message');
  if (allowedCodes) {
    assert.ok(allowedCodes.indexOf(err.code) >= 0, (label || 'API 错误') + '：期望错误码 ' + allowedCodes.join('/') + '，实际 ' + err.code);
  }
  return err;
}

/** 深度比较两个公开投影，返回差异路径字符串数组。 */
function diffProjection(a, b, pathStr) {
  pathStr = pathStr || '';
  const diffs = [];
  if (a === b) return diffs;
  const ta = a === null ? 'null' : typeof a;
  const tb = b === null ? 'null' : typeof b;
  if (ta !== tb) { diffs.push(pathStr + ': 类型不同 ' + ta + ' vs ' + tb); return diffs; }
  if (ta !== 'object') { diffs.push(pathStr + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b)); return diffs; }
  if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(pathStr + ': 数组/对象不一致'); return diffs; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(pathStr + '.length: ' + a.length + ' != ' + b.length);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diffs.push(...diffProjection(a[i], b[i], pathStr + '[' + i + ']'));
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { diffs.push(pathStr + '.' + k + ': 缺失（B 有 ' + JSON.stringify(b[k]) + '）'); continue; }
    if (!(k in b)) { diffs.push(pathStr + '.' + k + ': 多出（A 有 ' + JSON.stringify(a[k]) + '）'); continue; }
    diffs.push(...diffProjection(a[k], b[k], pathStr + '.' + k));
  }
  return diffs;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ */
/* 房间/双客户端驱动                                                   */
/* ------------------------------------------------------------------ */

/** 创建房间：返回 {code, token, playerId, meta, state, res}。 */
async function createRoom(port, httpClient, opts) {
  opts = opts || {};
  const body = { name: opts.name || '房主', config: opts.config || { regionCount: 5, difficulty: 1, settleCards: 2, firstPlayer: 'p1' } };
  const res = await httpClient.post('/api/rooms', body);
  const json = assertOk(res, '创建房间');
  assert.ok(json.room && json.room.code && json.room.token, '创建房间响应缺少 code/token');
  httpClient.code = json.room.code;
  httpClient.token = json.room.token;
  httpClient.playerId = json.room.playerId;
  return json.room;
}

async function joinRoom(port, httpClient, code, opts) {
  opts = opts || {};
  const res = await httpClient.post('/api/rooms/' + code + '/join', { name: opts.name || '对手' });
  const json = assertOk(res, '加入房间');
  assert.ok(json.room && json.room.token, '加入房间响应缺少 token');
  httpClient.code = code;
  httpClient.token = json.room.token;
  httpClient.playerId = json.room.playerId;
  return json.room;
}

async function openStream(port, code, token, label) {
  const sse = new SseClient(port, code, token, label);
  await sse.connect();
  const first = await sse.waitFor('update', 8000, label + ' 首帧 update');
  return { sse, first };
}

/** 等待某 SSE 客户端出现满足条件的 update（从历史或未来）。 */
async function waitUpdate(sse, predicate, label, timeoutMs) {
  const ev = await sse.waitFor((e) => e.event === 'update' && (!predicate || predicate(e.json)), timeoutMs || 8000, label);
  return ev.json;
}

/** 提交布阵：用自己视角的前 R 张手牌。 */
async function submitOwnLayout(httpClient, sse) {
  const latest = sse.latestUpdate();
  const state = latest.state;
  const R = state.config.regionCount;
  const ids = state.players.p1.hand.slice(0, R).map((c) => c.id);
  const res = await httpClient.post('/api/rooms/' + httpClient.code + '/layout', { token: httpClient.token, cardIds: ids });
  assertOk(res, httpClient.label + ' 提交布阵');
  return ids;
}

/** 在当前玩家视角计算合法行动（视图已镜像，turn='p1' 表示自己回合）。 */
function legalFromView(state) {
  if (!state || state.phase !== 'battle' || state.turn !== 'p1') return [];
  return E.getLegalActions(state);
}

/** 选择确定性行动（覆盖五种行动类型）。 */
function pickPlanAction(legal) {
  const order = ['settle', 'flip', 'place', 'move', 'draw'];
  for (const type of order) {
    const found = legal.find((a) => a.type === type);
    if (found) return found;
  }
  return legal[0] || null;
}

module.exports = {
  ROOT,
  E,
  startLanServer,
  request,
  HttpClient,
  SseClient,
  isHiddenCard,
  assertAllHidden,
  extractOwnSecrets,
  extractOwnEventSecrets,
  collectPrivateSecrets,
  publicProjection,
  diffProjection,
  assertOk,
  assertApiError,
  assertNoErrors,
  createRoom,
  joinRoom,
  openStream,
  waitUpdate,
  submitOwnLayout,
  legalFromView,
  pickPlanAction,
  sleep,
};


