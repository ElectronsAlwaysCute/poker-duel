'use strict';
/*
 * lan_authority.js —— 手机当房主（Android 内嵌权威服务器）的纯 JS 权威逻辑。
 * 从项目 server.js (v1.6.0) 的 createLanServer 逻辑移植：房间/座位/布阵/行动/再来一局/
 * 离开/快照/镜像脱敏/SSE 事件日志；引擎复用 js/engine.js（E）。
 *
 * 运行环境：Android 隐藏 WebView（页面 assets/host/authority.html）。
 * Java 端通过 JS 桥调用：
 *   handle(method, pathname, queryObj, bodyText, headersObj) -> {status, body}
 *   poll(code, token, sinceSeq) -> {events:[{seq,type,...}], closed:boolean}
 * 事件不直接写流，而是写入每玩家 event 日志；Java HTTP/SSE 层轮询日志后下发。
 *
 * Node 测试：module.exports = createAuthority（注入 require('./js/engine.js')）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
  } else {
    root.createLanAuthority = factory(root.PokerEngine);
  }
}(typeof window !== 'undefined' ? window : this, function (E) {
  if (!E) throw new Error('LanAuthority 依赖 PokerEngine');

  var VERSION = '2.11.0-host';
  var MAX_ROOMS = 16;
  var MAX_EVENT_LOG = 400;

  function now() { return Date.now(); }
  function otherId(id) { return id === 'p1' ? 'p2' : 'p1'; }
  function swapId(id) { return id === 'p1' ? 'p2' : (id === 'p2' ? 'p1' : id); }
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function randomToken() {
    var s = '';
    var chars = '0123456789abcdef';
    for (var i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * 16));
    }
    return s;
  }
  /* v2.12.7：房间码长度与 PC 权威 server.js（ROOM_CODE_LEN=5）一致，修复手机当房主显示
   * 4 位房间码、而客户端 UI/输入校验按 5 位导致无法加入的问题。 */
  function generateCode(rooms) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var attempt = 0; attempt < 200; attempt++) {
      var code = '';
      for (var i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
      if (!rooms.has(code)) return code;
    }
    throw new Error('无法生成房间码');
  }
  function sanitizeName(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    var v = raw.replace(/[\u0000-\u001f<>]/g, '').trim();
    if (!v) return fallback;
    return v.slice(0, 16);
  }

  /* ---------------- 脱敏（与 server.js 相同口径） ---------------- */
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
    var out = [];
    for (var i = 0; i < n; i++) out.push(hiddenCard(tag, i));
    return out;
  }
  function sanitizeSidesFor(sides, viewerPid) {
    var opp = otherId(viewerPid);
    var n = sides[opp].faceDown.length;
    sides[opp].faceDown = hiddenCards('ev-fd', n);
  }
  function sanitizeRegionResult(result, viewerPid) {
    var opp = otherId(viewerPid);
    if (result.difficultyDraw && result.difficultyDraw.playerId !== viewerPid) {
      result.difficultyDraw.card = hiddenCard('diff', 0);
    }
    var publicIds = Object.create(null);
    if (result.faceUp) {
      ['p1', 'p2'].forEach(function (pid) {
        (result.faceUp[pid] || []).forEach(function (c) { publicIds[c.id] = true; });
      });
    }
    if (result.drawn) {
      ['p1', 'p2'].forEach(function (pid) {
        var arr = result.drawn[pid];
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
    var opp = otherId(viewerPid);
    var s = clone(state);
    if (s.config) s.config.seed = null;
    delete s._rngState;
    s.deck = hiddenCards('deck', state.deck.length);
    s.players[opp].hand = hiddenCards('hand-' + opp, state.players[opp].hand.length);
    for (var i = 0; i < s.regions.length; i++) {
      var n = state.regions[i].sides[opp].faceDown.length;
      s.regions[i].sides[opp].faceDown = hiddenCards('fd-' + i, n);
      if (s.regions[i].result) sanitizeRegionResult(s.regions[i].result, viewerPid);
    }
    if (!s.layout.revealed) s.layout.assignments[opp] = null;
    s.discard = s.discard.map(function (c, idx) { return c.revealed ? c : hiddenCard('discard', idx); });
    return s;
  }

  /* ---------------- 镜像（viewer p2 视角整体交换） ---------------- */
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
    var s = state;
    var oldP1 = s.players.p1;
    var oldP2 = s.players.p2;
    s.players = { p1: oldP2, p2: oldP1 };
    s.players.p1.id = 'p1';
    s.players.p2.id = 'p2';

    var fp = s.config.firstPlayer;
    var sp = s.config.secondPlayer;
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
      var sideP1 = region.sides.p1;
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
    var opp = otherId(viewerPid);
    var e = clone(ev);
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
    var swapped = viewerPid === 'p2';
    var state = room.state ? sanitizeStateFor(room.state, viewerPid) : null;
    if (state && swapped) state = mirrorState(state);
    var evs = (events || []).map(function (ev) { return sanitizeEventFor(ev, viewerPid); });
    if (swapped) evs = evs.map(function (ev) { return mirrorEvent(ev); });
    return { state: state, events: evs, meta: buildMeta(room, viewerPid) };
  }
  function buildMeta(room, viewerPid) {
    var swapped = viewerPid === 'p2';
    var players = {
      p1: room.tokens.p1 ? { name: room.names.p1, connected: !!room.connected.p1 } : null,
      p2: room.tokens.p2 ? { name: room.names.p2, connected: !!room.connected.p2 } : null
    };
    var rematchReady = { p1: !!room.rematchReady.p1, p2: !!room.rematchReady.p2 };
    if (swapped) {
      var tmp = players.p1;
      players.p1 = players.p2;
      players.p2 = tmp;
      var r1 = rematchReady.p1;
      rematchReady.p1 = rematchReady.p2;
      rematchReady.p2 = r1;
    }
    var roomConfig = room.config || {};
    var metaConfig = {
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
      lanUrls: (room.lanUrls || []).slice(),
      serverNow: now()
    };
  }

  /* ---------------- 权威服务器主体 ---------------- */
  return function createLanAuthority(options) {
    var opts = options || {};
    var rooms = new Map();
    var lanUrls = (opts.lanUrls && opts.lanUrls.slice()) || [];
    var startedAt = now();

    function withRoom(room, pid, events) {
      var view = buildView(room, pid, events);
      return { seq: room.seq, type: 'update', state: view.state, events: view.events, meta: view.meta };
    }
    function log(room, pid, payload) {
      var arr = room.logs[pid];
      arr.push(payload);
      if (arr.length > MAX_EVENT_LOG) arr.splice(0, arr.length - MAX_EVENT_LOG);
    }
    function broadcast(room, events) {
      room.seq++;
      room.lastActivity = now();
      ['p1', 'p2'].forEach(function (pid) {
        if (!room.tokens[pid]) return;
        log(room, pid, withRoom(room, pid, events));
      });
    }
    function broadcastPresence(room) {
      room.seq++;
      room.lastActivity = now();
      ['p1', 'p2'].forEach(function (pid) {
        if (!room.tokens[pid]) return;
        log(room, pid, { seq: room.seq, type: 'presence', meta: buildMeta(room, pid) });
      });
    }
    function notifyClosed(room, reason) {
      ['p1', 'p2'].forEach(function (pid) {
        if (!room.tokens[pid]) return;
        log(room, pid, { seq: room.seq + 1, type: 'room_closed', reason: reason });
      });
      room.closed = true;
      room.seq++;
    }
    function destroyRoom(room, reason) {
      notifyClosed(room, reason || 'closed');
    }
    function buildInitialState(room) {
      var cfg = {
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
    function fail(status, code, message) {
      return { status: status, body: { ok: false, error: { code: code, message: message } } };
    }
    function ok(body) { return { status: 200, body: Object.assign({ ok: true }, body) }; }

    function sanitizeConfig(raw) {
      var normalized = E.defaultConfig(raw || {});
      var validation = E.validateConfig(normalized);
      if (!validation.ok) return { error: validation.errors.join('；') };
      return {
        config: {
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
        }
      };
    }

    function handle(method, pathname, query, bodyText, headers) {
      try {
        var body = {};
        if (bodyText) {
          try { body = JSON.parse(bodyText); } catch (e) { return fail(400, 'BAD_REQUEST', 'JSON 解析失败'); }
        }
        if (!body || typeof body !== 'object') body = {};

        if (pathname === '/api/info' && method === 'GET') {
          return ok({
            version: VERSION,
            engineVersion: E.VERSION,
            lanUrls: lanUrls.slice(),
            rooms: rooms.size,
            uptimeSec: Math.floor((now() - startedAt) / 1000)
          });
        }

        if (pathname === '/api/rooms' && method === 'POST') {
          if (rooms.size >= MAX_ROOMS) return fail(503, 'SERVER_BUSY', '房间数已满');
          var sc = sanitizeConfig(body.config);
          if (sc.error) return fail(400, 'BAD_REQUEST', sc.error);
          var code = generateCode(rooms);
          var room = {
            code: code,
            createdAt: now(),
            lastActivity: now(),
            config: sc.config,
            names: { p1: sanitizeName(body.name, '房主'), p2: null },
            status: 'waiting',
            state: null,
            seq: 0,
            tokens: { p1: randomToken(), p2: null },
            connected: { p1: false, p2: false },
            logs: { p1: [], p2: [] },
            rematchReady: { p1: false, p2: false },
            lanUrls: lanUrls.slice(),
            closed: false
          };
          rooms.set(code, room);
          return ok({
            room: {
              code: code,
              token: room.tokens.p1,
              playerId: 'p1',
              state: null,
              meta: buildMeta(room, 'p1')
            }
          });
        }

        var match = /^\/api\/rooms\/([A-Za-z0-9]{4,12})(?:\/(join|layout|action|rematch|leave|snapshot))?$/.exec(pathname);
        if (!match) return fail(400, 'BAD_REQUEST', '接口不存在');
        var codeU = match[1].toUpperCase();
        var action = match[2] || null;
        var roomU = rooms.get(codeU);
        if (!roomU) return fail(404, 'ROOM_NOT_FOUND', '房间不存在或已结束');

        if (action === 'join' && method === 'POST') {
          if (roomU.status !== 'waiting' || roomU.tokens.p2) return fail(409, 'ROOM_FULL', '房间已满或对局已开始');
          roomU.tokens.p2 = randomToken();
          roomU.names.p2 = sanitizeName(body.name, '对手');
          roomU.lastSeen = roomU.lastSeen || {};
          roomU.rematchReady = { p1: false, p2: false };
          try {
            roomU.state = buildInitialState(roomU);
          } catch (e) {
            return fail(400, 'BAD_REQUEST', '创建对局失败：' + (e && e.message ? e.message : '未知错误'));
          }
          roomU.status = 'layout';
          broadcast(roomU, []);
          var view = buildView(roomU, 'p2', []);
          return ok({
            room: {
              code: codeU,
              token: roomU.tokens.p2,
              playerId: 'p2',
              state: view.state,
              meta: view.meta
            }
          });
        }

        /* token 身份 */
        var token = (query && query.token) || '';
        if (!token && headers) {
          var auth = headers.authorization;
          if (typeof auth === 'string' && auth.indexOf('Bearer ') === 0) token = auth.slice(7).trim();
        }
        if (!token && body && typeof body.token === 'string') token = body.token;
        var pid = null;
        if (token && roomU.tokens.p1 === token) pid = 'p1';
        else if (token && roomU.tokens.p2 === token) pid = 'p2';
        if (!pid) return fail(401, 'BAD_TOKEN', '身份校验失败，请重新进入房间');
        roomU.lastSeen = roomU.lastSeen || {};
        roomU.lastSeen[pid] = now();

        if (method === 'GET' && (!action || action === 'snapshot')) {
          var viewS = buildView(roomU, pid, []);
          return ok({ seq: roomU.seq, type: 'update', state: viewS.state, events: [], meta: viewS.meta });
        }

        if (action === 'layout' && method === 'POST') {
          if (roomU.status !== 'layout' || !roomU.state) return fail(409, 'BAD_PHASE', '当前不在战前布局阶段');
          if (roomU.state.layout.submitted[pid]) return fail(409, 'BAD_PHASE', '你已提交过布阵');
          var cardIds = body && body.cardIds;
          if (!Array.isArray(cardIds)) return fail(400, 'BAD_REQUEST', '缺少 cardIds');
          try {
            E.submitLayout(roomU.state, pid, cardIds.map(String));
          } catch (e2) {
            return fail(409, 'ILLEGAL_ACTION', e2 && e2.message ? e2.message : '布阵不合法');
          }
          var events = [];
          if (roomU.state.layout.submitted.p1 && roomU.state.layout.submitted.p2) {
            try {
              events = E.finalizeLayout(roomU.state);
              roomU.status = roomU.state.phase === 'gameover' ? 'gameover' : 'battle';
            } catch (e3) {
              return fail(409, 'ILLEGAL_ACTION', e3 && e3.message ? e3.message : '揭示失败');
            }
          }
          broadcast(roomU, events);
          return ok({ submitted: true });
        }

        if (action === 'action' && method === 'POST') {
          if (roomU.status !== 'battle' || !roomU.state) return fail(409, 'BAD_PHASE', '当前不在战役阶段');
          if (roomU.state.turn !== pid) return fail(409, 'ILLEGAL_ACTION', '尚未轮到你行动');
          var act = body && body.action;
          if (!act || typeof act !== 'object' || typeof act.type !== 'string') return fail(400, 'BAD_REQUEST', '缺少 action');
          var legal = [];
          try { legal = E.getLegalActions(roomU.state); } catch (e4) { legal = []; }
          var isValid = legal.some(function (a) {
            if (a.type !== act.type) return false;
            if (a.type === 'end_turn') return true;
            if (a.type === 'draw') return true;
            if (a.type === 'settle') return a.regionId === act.regionId;
            if (a.type === 'flip' || a.type === 'place') return a.regionId === act.regionId && a.cardId === act.cardId;
            if (a.type === 'move') return a.fromRegionId === act.fromRegionId && a.cardId === act.cardId && a.toRegionId === act.toRegionId;
            return false;
          });
          if (!isValid) return fail(409, 'ILLEGAL_ACTION', '该行动在当前局面不合法');
          var eventsA;
          try {
            eventsA = E.performAction(roomU.state, act);
          } catch (e5) {
            return fail(409, 'ILLEGAL_ACTION', e5 && e5.message ? e5.message : '行动执行失败');
          }
          roomU.status = roomU.state.phase === 'gameover' ? 'gameover' : 'battle';
          broadcast(roomU, eventsA);
          return ok({});
        }

        if (action === 'rematch' && method === 'POST') {
          if (roomU.status !== 'gameover') return fail(409, 'BAD_PHASE', '对局尚未结束');
          roomU.rematchReady[pid] = true;
          var started = false;
          if (roomU.rematchReady.p1 && roomU.rematchReady.p2) {
            try {
              roomU.state = buildInitialState(roomU);
            } catch (e6) {
              return fail(400, 'BAD_REQUEST', '创建新对局失败');
            }
            roomU.status = 'layout';
            roomU.rematchReady = { p1: false, p2: false };
            started = true;
          }
          roomU.lastActivity = now();
          broadcast(roomU, []);
          return ok({ started: started });
        }

        if (action === 'leave' && method === 'POST') {
          destroyRoom(roomU, 'peer_left');
          return ok({ left: true });
        }

        return fail(400, 'BAD_REQUEST', '不支持的请求');
      } catch (err) {
        return fail(500, 'INTERNAL', String(err && err.message ? err.message : err));
      }
    }

    /* SSE/轮询：返回某玩家 since 之后的事件日志 */
    function poll(code, token, since) {
      var room = rooms.get(String(code || '').toUpperCase());
      if (!room) return { events: [], closed: true };
      var pid = null;
      if (room.tokens.p1 === token) pid = 'p1';
      else if (room.tokens.p2 === token) pid = 'p2';
      if (!pid) return { events: [], closed: true };
      room.connected[pid] = true;
      var arr = room.logs[pid];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].seq > since) out.push(arr[i]);
      }
      return { events: out, closed: !!room.closed, seq: room.seq };
    }
    function disconnect(code, token) {
      var room = rooms.get(String(code || '').toUpperCase());
      if (!room) return;
      if (room.tokens.p1 === token) room.connected.p1 = false;
      else if (room.tokens.p2 === token) room.connected.p2 = false;
    }
    function info() {
      return { version: VERSION, engineVersion: E.VERSION, lanUrls: lanUrls.slice(), rooms: rooms.size, uptimeSec: Math.floor((now() - startedAt) / 1000) };
    }

    return {
      VERSION: VERSION,
      handle: handle,
      poll: poll,
      disconnect: disconnect,
      info: info,
      rooms: rooms,
      lanUrls: lanUrls
    };
  };
}));
