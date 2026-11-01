#!/usr/bin/env node
/* =========================================================================
 * 扑克牌 · 比大小 —— 局域网联机权威服务器（零依赖）
 * 协议：docs/LAN.md
 *  - 静态文件服务（index.html / css / js ...）
 *  - 房间管理：创建 / 加入 / 布阵 / 行动 / 再来一局 / 离开 / 快照
 *  - 实时通道：SSE（EventSource），每客户端「镜像 + 脱敏」视图，防作弊
 *  - 规则权威：js/engine.js（服务端唯一状态）
 * 用法：node server.js [port]   （默认 5200，监听 0.0.0.0）
 * 测试：require('./server.js').createLanServer({ port: 0 })
 * ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const E = require('./js/engine.js');

const ROOT = __dirname;
const VERSION = '1.6.0';
const MAX_BODY = 64 * 1024;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 5;
const ROOM_TTL_MS = 10 * 60 * 1000;
const DISCONNECT_TTL_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const SWEEP_MS = 60 * 1000;
const MAX_ROOMS = 200;
const MAX_NAME_LEN = 16;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const API_ERRORS = {
  BAD_REQUEST: 400,
  BAD_TOKEN: 403,
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  BAD_PHASE: 409,
  ILLEGAL_ACTION: 400,
  SERVER_BUSY: 503,
  ROOM_CLOSED: 410
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */
function now() { return Date.now(); }
function otherId(id) { return id === 'p1' ? 'p2' : 'p1'; }
function swapId(id) { return id === 'p1' ? 'p2' : (id === 'p2' ? 'p1' : id); }
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function sendJson(res, httpCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(httpCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function fail(res, code, message) {
  sendJson(res, API_ERRORS[code] || 400, { ok: false, error: { code: code, message: message } });
}
function ok(res, payload, httpCode) {
  sendJson(res, httpCode || 200, Object.assign({ ok: true }, payload || {}));
}

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  let s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!s) return fallback;
  const arr = Array.from(s);
  if (arr.length > MAX_NAME_LEN) s = arr.slice(0, MAX_NAME_LEN).join('');
  return s || fallback;
}

function randomToken() { return crypto.randomBytes(16).toString('hex'); }

function generateCode(rooms) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(ROOM_CODE_LEN);
    for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('无法生成房间码');
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject({ code: 'BAD_REQUEST', message: '请求体过大（上限 64KB）' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject({ code: 'BAD_REQUEST', message: 'JSON 解析失败' }); }
    });
    req.on('error', function () { reject({ code: 'BAD_REQUEST', message: '读取请求失败' }); });
  });
}

/* ------------------------------------------------------------------ *
 * 脱敏：占位卡（不泄露任何身份/数值/顺序）
 * ------------------------------------------------------------------ */
function hiddenCard(tag, i) {
  return {
    id: 'hidden-' + tag + '-' + i,
    hidden: true,
    rank: '?',
    suit: null,
    suitSymbol: '',
    red: false,
    value: 0,
    joker: false,
    revealed: false
  };
}
function hiddenCards(tag, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(hiddenCard(tag, i));
  return out;
}

function sanitizeSidesFor(sides, viewerPid) {
  const opp = otherId(viewerPid);
  const n = sides[opp].faceDown.length;
  sides[opp].faceDown = hiddenCards('ev-fd', n);
}

function sanitizeRegionResult(result, viewerPid) {
  const opp = otherId(viewerPid);
  if (result.difficultyDraw && result.difficultyDraw.playerId !== viewerPid) {
    result.difficultyDraw.card = hiddenCard('diff', 0);
  }
  const publicIds = Object.create(null);
  if (result.faceUp) {
    ['p1', 'p2'].forEach(function (pid) {
      (result.faceUp[pid] || []).forEach(function (c) { publicIds[c.id] = true; });
    });
  }
  if (result.drawn) {
    ['p1', 'p2'].forEach(function (pid) {
      const arr = result.drawn[pid];
      if (Array.isArray(arr)) arr.forEach(function (c) { publicIds[c.id] = true; });
      else if (arr) publicIds[arr.id] = true;
    });
  }
  if (result.allCards && result.allCards[opp]) {
    result.allCards[opp] = result.allCards[opp].map(function (c, i) {
      return publicIds[c.id] ? c : hiddenCard('allcards', i);
    });
  }
}

function sanitizeStateFor(state, viewerPid) {
  const opp = otherId(viewerPid);
  const s = clone(state);
  // 防作弊：随机种子/内部 RNG 状态可重建整副牌局，绝不能下发
  if (s.config) s.config.seed = null;
  delete s._rngState;
  s.deck = hiddenCards('deck', state.deck.length);
  s.players[opp].hand = hiddenCards('hand-' + opp, state.players[opp].hand.length);
  for (let i = 0; i < s.regions.length; i++) {
    const n = state.regions[i].sides[opp].faceDown.length;
    s.regions[i].sides[opp].faceDown = hiddenCards('fd-' + i, n);
    if (s.regions[i].result) sanitizeRegionResult(s.regions[i].result, viewerPid);
  }
  if (!s.layout.revealed) s.layout.assignments[opp] = null;
  s.discard = s.discard.map(function (c, i) { return c.revealed ? c : hiddenCard('discard', i); });
  return s;
}

/* ------------------------------------------------------------------ *
 * 镜像：让每个客户端都把「自己」当 p1（guest 视角整体交换）
 * ------------------------------------------------------------------ */
function mirrorRegionResult(r) {
  r.winner = swapId(r.winner);
  r.sums = { p1: r.sums.p2, p2: r.sums.p1 };
  r.faceUp = { p1: r.faceUp.p2, p2: r.faceUp.p1 };
  r.drawn = { p1: r.drawn.p2, p2: r.drawn.p1 };
  r.allCards = { p1: r.allCards.p2, p2: r.allCards.p1 };
  if (r.difficultyDraw && r.difficultyDraw.playerId) r.difficultyDraw.playerId = swapId(r.difficultyDraw.playerId);
}

function mirrorResult(r) {
  r.winner = swapId(r.winner);
  r.regionWins = { p1: r.regionWins.p2, p2: r.regionWins.p1, ties: r.regionWins.ties };
  r.handSums = { p1: r.handSums.p2, p2: r.handSums.p1 };
  if (r.forfeitedBy) r.forfeitedBy = swapId(r.forfeitedBy);
  if (Array.isArray(r.unsettledRegions)) r.unsettledRegions = r.unsettledRegions.slice();
}

function mirrorState(state) {
  const s = state;
  const oldP1 = s.players.p1;
  const oldP2 = s.players.p2;
  s.players = { p1: oldP2, p2: oldP1 };
  s.players.p1.id = 'p1';
  s.players.p2.id = 'p2';

  const fp = s.config.firstPlayer;
  const sp = s.config.secondPlayer;
  if (fp === 'p1' || fp === 'p2') {
    s.config.firstPlayer = swapId(fp);
    s.config.secondPlayer = swapId(sp);
  }
  if (s.config.playerNames) {
    s.config.playerNames = { p1: s.config.playerNames.p2, p2: s.config.playerNames.p1 };
  }
  if (s.turn) s.turn = swapId(s.turn);

  s.layout.submitted = { p1: s.layout.submitted.p2, p2: s.layout.submitted.p1 };
  s.layout.assignments = { p1: s.layout.assignments.p2, p2: s.layout.assignments.p1 };

  s.regionWins = { p1: s.regionWins.p2, p2: s.regionWins.p1, ties: s.regionWins.ties };

  if (s.endgame) {
    if (s.endgame.drawnCounts) s.endgame.drawnCounts = { p1: s.endgame.drawnCounts.p2, p2: s.endgame.drawnCounts.p1 };
    if (s.endgame.skipped) s.endgame.skipped = { p1: s.endgame.skipped.p2, p2: s.endgame.skipped.p1 };
  }

  s.regions.forEach(function (region) {
    const sideP1 = region.sides.p1;
    region.sides.p1 = region.sides.p2;
    region.sides.p2 = sideP1;
    if (region.result) mirrorRegionResult(region.result);
  });
  if (s.result) mirrorResult(s.result);
  return s;
}

function mirrorEvent(e) {
  if (e.playerId) e.playerId = swapId(e.playerId);
  if (e.turn) e.turn = swapId(e.turn);
  if (e.type === 'layout_reveal' && e.layout) {
    e.layout = { p1: e.layout.p2, p2: e.layout.p1 };
  } else if (e.type === 'endgame_start') {
    if (e.drawnCounts) e.drawnCounts = { p1: e.drawnCounts.p2, p2: e.drawnCounts.p1 };
  } else if (e.type === 'settle' || e.type === 'endgame_settle') {
    e.winner = swapId(e.winner);
    if (e.sums) e.sums = { p1: e.sums.p2, p2: e.sums.p1 };
    if (e.drawn) e.drawn = { p1: e.drawn.p2, p2: e.drawn.p1 };
    if (e.regionBefore && e.regionBefore.sides) {
      e.regionBefore.sides = { p1: e.regionBefore.sides.p2, p2: e.regionBefore.sides.p1 };
    }
    if (e.regionResult) mirrorRegionResult(e.regionResult);
    if (e.difficultyDraw && e.difficultyDraw.playerId) e.difficultyDraw.playerId = swapId(e.difficultyDraw.playerId);
  } else if (e.type === 'game_over' && e.result) {
    mirrorResult(e.result);
  }
  return e;
}

function sanitizeEventFor(ev, viewerPid) {
  const opp = otherId(viewerPid);
  const e = clone(ev);
  if (e.type === 'action') {
    if (e.playerId === opp && e.action && e.action.cardId) e.action.cardId = 'hidden';
  } else if (e.type === 'place' || e.type === 'move' || e.type === 'draw' || e.type === 'extra_draw') {
    if (e.playerId === opp) e.card = hiddenCard('ev-' + e.type, 0);
  } else if (e.type === 'settle' || e.type === 'endgame_settle') {
    if (e.regionBefore) sanitizeSidesFor(e.regionBefore.sides, viewerPid);
    if (e.regionResult) sanitizeRegionResult(e.regionResult, viewerPid);
    if (e.difficultyDraw && e.difficultyDraw.playerId !== viewerPid) e.difficultyDraw.card = hiddenCard('ev-diff', 0);
  }
  return e;
}

function buildView(room, viewerPid, events) {
  const swapped = viewerPid === 'p2';
  let state = room.state ? sanitizeStateFor(room.state, viewerPid) : null;
  if (state && swapped) state = mirrorState(state);
  let evs = (events || []).map(function (ev) { return sanitizeEventFor(ev, viewerPid); });
  if (swapped) evs = evs.map(function (ev) { return mirrorEvent(ev); });
  return { state: state, events: evs, meta: buildMeta(room, viewerPid) };
}

function buildMeta(room, viewerPid) {
  const swapped = viewerPid === 'p2';
  const players = {
    p1: room.tokens.p1 ? { name: room.names.p1, connected: !!room.streams.p1 } : null,
    p2: room.tokens.p2 ? { name: room.names.p2, connected: !!room.streams.p2 } : null
  };
  const rematchReady = { p1: !!room.rematchReady.p1, p2: !!room.rematchReady.p2 };
  if (swapped) {
    const tmp = players.p1;
    players.p1 = players.p2;
    players.p2 = tmp;
    const r1 = rematchReady.p1;
    rematchReady.p1 = rematchReady.p2;
    rematchReady.p2 = r1;
  }
  const roomConfig = room.config || {};
  const metaConfig = {
    regionCount: roomConfig.regionCount,
    difficulty: roomConfig.difficulty,
    settleCards: roomConfig.settleCards,
    turnTimeLimit: roomConfig.turnTimeLimit,
    firstPlayer: swapped ? swapId(roomConfig.firstPlayer) : roomConfig.firstPlayer
  };
  return {
    code: room.code,
    me: 'p1',
    host: viewerPid === 'p1',
    status: room.status,
    turn: room.state && room.state.turn ? (swapped ? swapId(room.state.turn) : room.state.turn) : null,
    players: players,
    rematchReady: rematchReady,
    config: metaConfig,
    lanUrls: room.lanUrls.slice(),
    serverNow: now()
  };
}

/* ------------------------------------------------------------------ *
 * 服务器主体
 * ------------------------------------------------------------------ */
function createLanServer(options) {
  const opts = options || {};
  const rooms = new Map();
  const startedAt = now();
  let lanUrls = (opts.lanUrls && opts.lanUrls.slice()) || [];
  let heartbeatTimer = null;
  let sweepTimer = null;

  function computeLanUrls(port) {
    const urls = ['http://127.0.0.1:' + port];
    try {
      const ifaces = os.networkInterfaces();
      Object.keys(ifaces).forEach(function (name) {
        (ifaces[name] || []).forEach(function (addr) {
          if (addr && addr.family === 'IPv4' && !addr.internal) {
            const u = 'http://' + addr.address + ':' + port;
            if (urls.indexOf(u) < 0) urls.push(u);
          }
        });
      });
    } catch (e) { /* ignore */ }
    return urls;
  }

  /* ---- SSE ---- */
  function writeStream(room, pid, payload) {
    const res = room.streams[pid];
    if (!res || res.writableEnded) return;
    try {
      res.write('id: ' + payload.seq + '\nevent: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n');
    } catch (e) {
      room.streams[pid] = null;
    }
  }
  function broadcast(room, events) {
    room.seq++;
    room.lastActivity = now();
    ['p1', 'p2'].forEach(function (pid) {
      if (!room.tokens[pid]) return;
      const view = buildView(room, pid, events);
      writeStream(room, pid, {
        seq: room.seq,
        type: 'update',
        state: view.state,
        events: view.events,
        meta: view.meta
      });
    });
  }
  function broadcastPresence(room) {
    room.seq++;
    room.lastActivity = now();
    ['p1', 'p2'].forEach(function (pid) {
      if (!room.tokens[pid]) return;
      writeStream(room, pid, { seq: room.seq, type: 'presence', meta: buildMeta(room, pid) });
    });
  }
  function notifyClosed(room, reason) {
    ['p1', 'p2'].forEach(function (pid) {
      if (!room.tokens[pid]) return;
      writeStream(room, pid, { seq: room.seq + 1, type: 'room_closed', reason: reason });
      const res = room.streams[pid];
      if (res && !res.writableEnded) { try { res.end(); } catch (e) { /* ignore */ } }
      room.streams[pid] = null;
    });
    room.seq++;
  }
  function destroyRoom(room, reason) {
    if (!rooms.has(room.code)) return;
    notifyClosed(room, reason || 'closed');
    rooms.delete(room.code);
  }

  /* ---- 对应房间的状态构建 ---- */
  function buildInitialState(room) {
    const cfg = {
      regionCount: room.config.regionCount,
      difficulty: room.config.difficulty,
      settleCards: room.config.settleCards,
      firstPlayer: room.config.firstPlayer,
      deck: room.config.deck,
      playerNames: { p1: room.names.p1, p2: room.names.p2 },
      seed: null,
      turnTimeLimit: room.config.turnTimeLimit
    };
    return E.createGame(cfg);
  }

  /* ---- 路由处理 ---- */
  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/api/info' && method === 'GET') {
      return ok(res, {
        version: VERSION,
        engineVersion: E.VERSION,
        lanUrls: lanUrls.slice(),
        rooms: rooms.size,
        uptimeSec: Math.floor((now() - startedAt) / 1000)
      });
    }

    // 创建房间：POST /api/rooms
    if (pathname === '/api/rooms' && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return fail(res, e.code || 'BAD_REQUEST', e.message); }
      if (rooms.size >= MAX_ROOMS) return fail(res, 'SERVER_BUSY', '服务器房间数已满，请稍后再试');
      const normalized = E.defaultConfig(body.config || {});
      const validation = E.validateConfig(normalized);
      if (!validation.ok) return fail(res, 'BAD_REQUEST', validation.errors.join('；'));
      const config = {
        regionCount: normalized.regionCount,
        difficulty: normalized.difficulty,
        settleCards: normalized.settleCards,
        firstPlayer: normalized.firstPlayer,
        turnTimeLimit: normalized.turnTimeLimit,
        deck: {
          jokers: normalized.deck.jokers !== false,
          ranks: normalized.deck.ranks.slice(),
          suits: Array.isArray(normalized.deck.suits) && normalized.deck.suits.length ? normalized.deck.suits.slice() : null
        }
      };
      const hostName = sanitizeName(body.name, '房主');
      const code = generateCode(rooms);
      const room = {
        code: code,
        createdAt: now(),
        lastActivity: now(),
        config: config,
        names: { p1: hostName, p2: null },
        status: 'waiting',
        state: null,
        seq: 0,
        tokens: { p1: randomToken(), p2: null },
        streams: { p1: null, p2: null },
        lastSeen: { p1: now(), p2: 0 },
        rematchReady: { p1: false, p2: false },
        lanUrls: lanUrls.slice()
      };
      rooms.set(code, room);
      return ok(res, {
        room: {
          code: code,
          token: room.tokens.p1,
          playerId: 'p1',
          state: null,
          meta: buildMeta(room, 'p1')
        }
      });
    }

    // 其余路由：/api/rooms/:code[/action]
    const match = /^\/api\/rooms\/([A-Za-z0-9]{4,12})(?:\/(join|stream|layout|action|rematch|leave|snapshot))?$/.exec(pathname);
    if (!match) return fail(res, 'BAD_REQUEST', '接口不存在');
    const code = match[1].toUpperCase();
    const action = match[2] || null;
    const room = rooms.get(code);
    if (!room) return fail(res, 'ROOM_NOT_FOUND', '房间不存在或已结束');

    // 加入房间
    if (action === 'join' && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return fail(res, e.code || 'BAD_REQUEST', e.message); }
      if (room.status !== 'waiting' || room.tokens.p2) return fail(res, 'ROOM_FULL', '房间已满或对局已开始');
      const guestName = sanitizeName(body.name, '对手');
      room.tokens.p2 = randomToken();
      room.names.p2 = guestName;
      room.lastSeen.p2 = now();
      room.rematchReady = { p1: false, p2: false };
      try {
        room.state = buildInitialState(room);
      } catch (e) {
        return fail(res, 'BAD_REQUEST', '创建对局失败：' + (e && e.message ? e.message : '未知错误'));
      }
      room.status = 'layout';
      broadcast(room, []);
      const view = buildView(room, 'p2', []);
      return ok(res, {
        room: {
          code: code,
          token: room.tokens.p2,
          playerId: 'p2',
          state: view.state,
          meta: view.meta
        }
      });
    }

    // 以下接口需要 token 身份
    let token = url.searchParams.get('token') || '';
    const authHeader = req.headers['authorization'];
    if (!token && typeof authHeader === 'string' && authHeader.indexOf('Bearer ') === 0) {
      token = authHeader.slice(7).trim();
    }
    let body = null;
    if (method === 'POST') {
      try { body = await readBody(req); } catch (e) { return fail(res, e.code || 'BAD_REQUEST', e.message); }
      if (!token && body && typeof body.token === 'string') token = body.token;
    }
    let pid = null;
    if (token && room.tokens.p1 === token) pid = 'p1';
    else if (token && room.tokens.p2 === token) pid = 'p2';
    if (!pid) return fail(res, 'BAD_TOKEN', '身份校验失败，请重新进入房间');
    room.lastSeen[pid] = now();

    // 快照（GET /api/rooms/:code 或 /snapshot）
    if (method === 'GET' && (!action || action === 'snapshot')) {
      const view = buildView(room, pid, []);
      return ok(res, {
        seq: room.seq,
        type: 'update',
        state: view.state,
        events: [],
        meta: view.meta
      });
    }

    // SSE 实时通道
    if (action === 'stream' && method === 'GET') {
      if (room.streams[pid]) {
        try { room.streams[pid].end(); } catch (e) { /* ignore */ }
        room.streams[pid] = null;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');
      room.streams[pid] = res;
      room.lastActivity = now();
      const view = buildView(room, pid, []);
      writeStream(room, pid, {
        seq: room.seq,
        type: 'update',
        state: view.state,
        events: [],
        meta: view.meta
      });
      broadcastPresence(room);
      const cleanup = function () {
        if (room.streams[pid] === res) {
          room.streams[pid] = null;
          room.lastActivity = now();
          if (rooms.has(room.code)) broadcastPresence(room);
        }
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('close', cleanup);
      req.on('aborted', cleanup);
      return; // SSE 长连接
    }

    // 布阵
    if (action === 'layout' && method === 'POST') {
      if (room.status !== 'layout' || !room.state) return fail(res, 'BAD_PHASE', '当前不在战前布局阶段');
      if (room.state.layout.submitted[pid]) return fail(res, 'BAD_PHASE', '你已提交过布阵');
      const cardIds = body && body.cardIds;
      if (!Array.isArray(cardIds)) return fail(res, 'BAD_REQUEST', '缺少 cardIds');
      try {
        E.submitLayout(room.state, pid, cardIds.map(String));
      } catch (e) {
        return fail(res, 'ILLEGAL_ACTION', e && e.message ? e.message : '布阵不合法');
      }
      let events = [];
      if (room.state.layout.submitted.p1 && room.state.layout.submitted.p2) {
        try {
          events = E.finalizeLayout(room.state);
          room.status = room.state.phase === 'gameover' ? 'gameover' : 'battle';
        } catch (e) {
          return fail(res, 'ILLEGAL_ACTION', e && e.message ? e.message : '揭示失败');
        }
      }
      broadcast(room, events);
      return ok(res, { submitted: true });
    }

    // 行动
    if (action === 'action' && method === 'POST') {
      if (room.status !== 'battle' || !room.state) return fail(res, 'BAD_PHASE', '当前不在战役阶段');
      if (room.state.turn !== pid) return fail(res, 'ILLEGAL_ACTION', '尚未轮到你行动');
      const act = body && body.action;
      if (!act || typeof act !== 'object' || typeof act.type !== 'string') return fail(res, 'BAD_REQUEST', '缺少 action');
      let legal;
      try { legal = E.getLegalActions(room.state); } catch (e) { legal = []; }
      const isValid = legal.some(function (a) {
        if (a.type !== act.type) return false;
        if (a.type === 'end_turn') return true;
        if (a.type === 'draw') return true;
        if (a.type === 'settle') return a.regionId === act.regionId;
        if (a.type === 'flip' || a.type === 'place') return a.regionId === act.regionId && a.cardId === act.cardId;
        if (a.type === 'move') return a.fromRegionId === act.fromRegionId && a.cardId === act.cardId && a.toRegionId === act.toRegionId;
        return false;
      });
      if (!isValid) return fail(res, 'ILLEGAL_ACTION', '该行动在当前局面不合法');
      let events;
      try {
        events = E.performAction(room.state, act);
      } catch (e) {
        return fail(res, 'ILLEGAL_ACTION', e && e.message ? e.message : '行动执行失败');
      }
      room.status = room.state.phase === 'gameover' ? 'gameover' : 'battle';
      broadcast(room, events);
      return ok(res, {});
    }

    // 再来一局
    if (action === 'rematch' && method === 'POST') {
      if (room.status !== 'gameover') return fail(res, 'BAD_PHASE', '对局尚未结束');
      room.rematchReady[pid] = true;
      let started = false;
      if (room.rematchReady.p1 && room.rematchReady.p2) {
        try {
          room.state = buildInitialState(room);
        } catch (e) {
          return fail(res, 'BAD_REQUEST', '创建新对局失败');
        }
        room.status = 'layout';
        room.rematchReady = { p1: false, p2: false };
        started = true;
      }
      room.lastActivity = now();
      broadcast(room, []);
      return ok(res, { started: started });
    }

    // 离开房间
    if (action === 'leave' && method === 'POST') {
      destroyRoom(room, 'peer_left');
      return ok(res, { left: true });
    }

    return fail(res, 'BAD_REQUEST', '不支持的请求');
  }

  /* ---- 静态文件 ---- */
  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { rel = '/index.html'; }
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 Forbidden');
    }
    fs.readFile(filePath, function (err, buf) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found: ' + rel);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': buf.length
      });
      res.end(buf);
    });
  }

  const server = http.createServer(function (req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (e) { return fail(res, 'BAD_REQUEST', 'URL 不合法'); }
    if (url.pathname.indexOf('/api/') === 0) {
      handleApi(req, res, url).catch(function (err) {
        if (res.headersSent) { try { res.end(); } catch (e2) { /* ignore */ } return; }
        sendJson(res, 500, { ok: false, error: { code: 'SERVER_BUSY', message: err && err.message ? err.message : '服务器内部错误' } });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405 Method Not Allowed');
    }
    serveStatic(req, res, url.pathname);
  });

  /* ---- 生命周期 ---- */
  function listen(port, host) {
    return new Promise(function (resolve, reject) {
      const onError = function (err) { server.removeListener('listening', onListening); reject(err); };
      const onListening = function () {
        server.removeListener('error', onError);
        const addr = server.address();
        const actualPort = addr && addr.port ? addr.port : port;
        lanUrls = computeLanUrls(actualPort);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(function () {
          rooms.forEach(function (room) {
            ['p1', 'p2'].forEach(function (pid) {
              const res = room.streams[pid];
              if (res && !res.writableEnded) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
            });
          });
        }, HEARTBEAT_MS);
        if (heartbeatTimer.unref) heartbeatTimer.unref();
        if (sweepTimer) clearInterval(sweepTimer);
        sweepTimer = setInterval(function () {
          const t = now();
          rooms.forEach(function (room) {
            // 有活跃 SSE 连接的玩家视为在线（长时间思考不会被误清理）
            ['p1', 'p2'].forEach(function (pid) {
              if (room.streams[pid]) room.lastSeen[pid] = t;
            });
            const joined = ['p1', 'p2'].filter(function (pid) { return !!room.tokens[pid]; });
            const offlineTooLong = joined.some(function (pid) {
              return room.lastSeen[pid] && (t - room.lastSeen[pid]) > DISCONNECT_TTL_MS;
            });
            if (offlineTooLong) {
              destroyRoom(room, 'timeout');
              return;
            }
            const idle = t - (room.lastActivity || room.createdAt);
            const noStreams = !room.streams.p1 && !room.streams.p2;
            if (noStreams && idle > ROOM_TTL_MS) {
              destroyRoom(room, 'timeout');
            }
          });
        }, SWEEP_MS);
        if (sweepTimer.unref) sweepTimer.unref();
        resolve({ port: actualPort, lanUrls: lanUrls.slice(), localUrl: 'http://127.0.0.1:' + actualPort + '/' });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port == null ? 0 : port, host || '0.0.0.0');
      } catch (e) {
        server.removeListener('error', onError);
        reject(e);
      }
    });
  }

  function close() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    rooms.forEach(function (room) { notifyClosed(room, 'closed'); });
    rooms.clear();
    return new Promise(function (resolve) {
      server.close(function () { resolve(); });
      setTimeout(resolve, 1000).unref();
    });
  }

  return {
    server: server,
    rooms: rooms,
    listen: listen,
    close: close,
    getLanUrls: function () { return lanUrls.slice(); },
    _internals: {
      buildView: buildView,
      sanitizeStateFor: sanitizeStateFor,
      mirrorState: mirrorState,
      hiddenCard: hiddenCard
    }
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 5200);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('[lan] 端口不合法：' + process.argv[2]);
    process.exit(1);
  }
  const lanServer = createLanServer();
  lanServer.listen(port).then(function (info) {
    console.log('[lan] 扑克牌 · 比大小 —— 局域网联机服务器 v' + VERSION);
    console.log('[lan] 本机访问   http://127.0.0.1:' + info.port + '/');
    info.lanUrls.forEach(function (u) {
      if (u.indexOf('127.0.0.1') < 0) console.log('[lan] 局域网访问 ' + u + '/');
    });
    console.log('[lan] 两台设备打开同一地址：一方「创建房间」，另一方输入房间码「加入房间」');
  }).catch(function (err) {
    console.error('[lan] 启动失败：' + (err && err.message ? err.message : err));
    process.exit(1);
  });
  process.on('SIGINT', function () {
    lanServer.close().then(function () { process.exit(0); });
  });
}

module.exports = { createLanServer: createLanServer, VERSION: VERSION };
