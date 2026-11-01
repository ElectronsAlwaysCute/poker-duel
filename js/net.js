/*
 * js/net.js —— 局域网联机客户端（全局 PokerNet，UMD 风格）
 * 契约：docs/LAN.md §3/§4/§5/§6.2
 * 仅使用 fetch + EventSource（零依赖）；单机模式不加载/不调用本模块亦可正常工作。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PokerNet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var SESSION_KEY = 'poker-duel-lan-session-v1';
  var INFO_TTL_MS = 4000;
  var ERROR_TEXT = {
    BAD_REQUEST: '请求无效，请重试',
    ROOM_NOT_FOUND: '房间不存在或已关闭',
    ROOM_FULL: '房间已满，请让房主确认',
    BAD_TOKEN: '身份校验失败，请重新加入房间',
    BAD_PHASE: '当前阶段不能执行该操作',
    ILLEGAL_ACTION: '行动不合法，请重试',
    SERVER_BUSY: '服务器繁忙，请稍后再试',
    ROOM_CLOSED: '房间已关闭',
    NETWORK: '无法连接局域网服务器，请确认已运行 node server.js',
    TIMEOUT: '服务器响应超时，请重试',
    NO_SESSION: '没有可恢复的联机会话',
    UNSUPPORTED: '当前浏览器不支持联机所需的 EventSource'
  };

  var session = null;
  var stream = null;
  var handlers = {};
  var manualClose = false;
  var gotFirstUpdate = false;
  var infoCache = { at: 0, info: null, ok: false };
  var snapshotRetryTimer = null;
  var lastUpdateAt = 0;

  /* ------------------------------------------------------------------ *
   * 基础
   * ------------------------------------------------------------------ */
  function now() { return Date.now(); }

  function getSessionStorage() {
    try { return root.sessionStorage || null; } catch (e) { return null; }
  }

  function errorText(code, message) {
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    return message || ERROR_TEXT.NETWORK;
  }

  function makeError(code, message) {
    var e = new Error(errorText(code, message));
    e.code = code || 'NETWORK';
    return e;
  }

  // file:// 等非 http(s) 环境下不发任何网络请求（否则控制台会出现 CORS 报错）。
  // 注意：Node 冒烟脚本里没有 location 全局对象，此守卫必须放行，不能拦截 fetch。
  function hasHttpOrigin() {
    try {
      var loc = root.location;
      if (!loc || !loc.protocol) return true;
      var proto = loc.protocol;
      if (proto === 'http:' || proto === 'https:') return true;
      if (proto === 'file:' || proto === 'data:' || proto === 'about:') return false;
      return true;
    } catch (e) { return true; }
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.code !== 'string' || !raw.code) return null;
    if (typeof raw.token !== 'string' || !raw.token) return null;
    return {
      code: String(raw.code).toUpperCase(),
      token: String(raw.token),
      playerId: raw.playerId === 'p2' ? 'p2' : 'p1',
      name: typeof raw.name === 'string' ? raw.name : '',
      host: !!raw.host
    };
  }

  function loadSession() {
    try {
      var storage = getSessionStorage();
      if (!storage) return null;
      var raw = storage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { return null; }
      return normalizeSession(parsed);
    } catch (e) {
      return null;
    }
  }

  function saveSession(next) {
    session = normalizeSession(next);
    try {
      var storage = getSessionStorage();
      if (storage && session) storage.setItem(SESSION_KEY, JSON.stringify(session));
      else if (storage) storage.removeItem(SESSION_KEY);
    } catch (e) { /* 隐私模式忽略 */ }
    return session;
  }

  function clearSession() {
    session = null;
    try {
      var storage = getSessionStorage();
      if (storage) storage.removeItem(SESSION_KEY);
    } catch (e) { /* ignore */ }
  }

  function emit(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fn = handlers[name];
    if (typeof fn === 'function') {
      try { fn.apply(null, args); } catch (err) {
        if (root.console && root.console.error) root.console.error('[PokerNet] handler error:', err);
      }
    }
  }

  function emitStatus(status, detail) {
    emit('status', status, detail || null);
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */
  function http(method, path, body, timeoutMs) {
    if (!hasHttpOrigin()) return Promise.reject(makeError('NETWORK'));
    var opts = {
      method: method,
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var controller = null;
    var timer = null;
    if (typeof root.AbortController === 'function') {
      controller = new root.AbortController();
      opts.signal = controller.signal;
    }
    if (controller) {
      timer = setTimeout(function () {
        try { controller.abort(); } catch (e) { /* ignore */ }
      }, timeoutMs || 9000);
    }
    return root.fetch(path, opts).then(function (res) {
      if (timer) { clearTimeout(timer); timer = null; }
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        if (!res.ok) {
          var err = (data && data.error) || {};
          var e2 = makeError(err.code || ('HTTP_' + res.status), err.message);
          e2.status = res.status;
          throw e2;
        }
        if (data && data.ok === false) {
          var err2 = data.error || {};
          throw makeError(err2.code || 'UNKNOWN', err2.message);
        }
        return data;
      });
    }, function (err) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (err && err.code) throw err;
      var aborted = err && err.name === 'AbortError';
      throw makeError(aborted ? 'TIMEOUT' : 'NETWORK');
    });
  }

  /* ------------------------------------------------------------------ *
   * 服务信息 / 可用性
   * ------------------------------------------------------------------ */
  function available(force) {
    if (!hasHttpOrigin()) {
      infoCache = { at: now(), info: null, ok: false };
      return Promise.resolve(null);
    }
    if (!force && infoCache.at && (now() - infoCache.at) < INFO_TTL_MS) {
      return Promise.resolve(infoCache.ok ? infoCache.info : null);
    }
    return http('GET', '/api/info', undefined, 4000).then(function (data) {
      var ok = !!(data && data.ok);
      infoCache = { at: now(), info: ok ? data : null, ok: ok };
      return infoCache.info;
    }).catch(function () {
      infoCache = { at: now(), info: null, ok: false };
      return null;
    });
  }

  function getInfo() { return infoCache.ok ? infoCache.info : null; }

  /* ------------------------------------------------------------------ *
   * SSE
   * ------------------------------------------------------------------ */
  function closeStream() {
    manualClose = true;
    if (snapshotRetryTimer) { clearTimeout(snapshotRetryTimer); snapshotRetryTimer = null; }
    if (stream) {
      try { stream.close(); } catch (e) { /* ignore */ }
      stream = null;
    }
  }

  function handleEvent(event, fallbackType) {
    var data = null;
    try { data = event && event.data ? JSON.parse(event.data) : null; } catch (e) { data = null; }
    if (!data || typeof data !== 'object') return;
    var type = data.type || fallbackType;
    if (type === 'update') {
      gotFirstUpdate = true;
      lastUpdateAt = now();
      if (data.meta) emit('meta', data.meta);
      emit('update', data);
      return;
    }
    if (type === 'presence') {
      if (data.meta) emit('meta', data.meta);
      emit('presence', data);
      return;
    }
    if (type === 'room_closed') {
      emit('roomClosed', data.reason || 'closed', data);
      closeStream();
      clearSession();
      return;
    }
    if (type === 'error') {
      emit('error', { code: data.code || 'NETWORK', message: errorText(data.code, data.message) });
      closeStream();
      if (data.code === 'BAD_TOKEN' || data.code === 'ROOM_NOT_FOUND' || data.code === 'ROOM_CLOSED') clearSession();
    }
  }

  function startStream() {
    closeStream();
    manualClose = false;
    gotFirstUpdate = false;
    if (typeof root.EventSource !== 'function') {
      emitStatus('unsupported');
      emit('error', { code: 'UNSUPPORTED', message: errorText('UNSUPPORTED') });
      return;
    }
    if (!session) {
      emit('error', { code: 'NO_SESSION', message: errorText('NO_SESSION') });
      return;
    }
    var url = '/api/rooms/' + encodeURIComponent(session.code) + '/stream?token=' + encodeURIComponent(session.token);
    var source = null;
    emitStatus('connecting');
    try {
      source = new root.EventSource(url);
    } catch (err) {
      emitStatus('closed');
      emit('error', { code: 'NETWORK', message: errorText('NETWORK') });
      return;
    }
    stream = source;
    source.addEventListener('open', function () {
      if (manualClose) return;
      emitStatus('open');
    });
    source.addEventListener('update', function (ev) { handleEvent(ev, 'update'); });
    source.addEventListener('presence', function (ev) { handleEvent(ev, 'presence'); });
    source.addEventListener('room_closed', function (ev) { handleEvent(ev, 'room_closed'); });
    source.addEventListener('message', function (ev) { handleEvent(ev, null); });
    source.addEventListener('error', function (ev) {
      if (manualClose) return;
      // 服务器主动发送的命名事件 error 带 data；连接错误是普通 Event
      if (ev && typeof ev.data === 'string' && ev.data) {
        handleEvent(ev, 'error');
        return;
      }
      if (source.readyState === 2) {
        emitStatus('closed');
        emit('error', { code: 'NETWORK', message: errorText('NETWORK') });
      } else {
        emitStatus('reconnecting');
      }
    });
    // 首次推送兜底：SSE 若被代理缓冲，主动拉一次快照
    snapshotRetryTimer = setTimeout(function () {
      snapshotRetryTimer = null;
      if (gotFirstUpdate || manualClose) return;
      getSnapshot().then(function (data) {
        if (data) emit('update', data);
      }).catch(function () { /* 让 SSE 继续尝试 */ });
    }, 1600);
  }

  function connect(callbacks) {
    handlers = callbacks || {};
    if (!session) session = loadSession();
    if (!session) {
      return Promise.reject(makeError('NO_SESSION'));
    }
    startStream();
    return Promise.resolve(session);
  }

  /* ------------------------------------------------------------------ *
   * 房间 API
   * ------------------------------------------------------------------ */
  function buildRoomSession(room, fallbackHost) {
    if (!room || !room.code || !room.token) throw makeError('BAD_REQUEST');
    var next = saveSession({
      code: room.code,
      token: room.token,
      playerId: room.playerId || (fallbackHost ? 'p1' : 'p2'),
      host: fallbackHost,
      name: (room.meta && room.meta.players && room.meta.players[room.playerId] && room.meta.players[room.playerId].name) || ''
    });
    return next;
  }

  function createRoom(name, config) {
    return http('POST', '/api/rooms', { name: name, config: config }).then(function (res) {
      var room = res && res.room;
      buildRoomSession(room, true);
      return room;
    });
  }

  function joinRoom(code, name) {
    var normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return http('POST', '/api/rooms/' + encodeURIComponent(normalized) + '/join', { name: name }).then(function (res) {
      var room = res && res.room;
      buildRoomSession(room, false);
      return room;
    });
  }

  function submitLayout(cardIds) {
    if (!session) return Promise.reject(makeError('NO_SESSION'));
    return http('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/layout', {
      token: session.token,
      cardIds: Array.isArray(cardIds) ? cardIds.slice() : []
    });
  }

  function sendAction(action) {
    if (!session) return Promise.reject(makeError('NO_SESSION'));
    return http('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/action', {
      token: session.token,
      action: action
    });
  }

  function rematch() {
    if (!session) return Promise.reject(makeError('NO_SESSION'));
    return http('POST', '/api/rooms/' + encodeURIComponent(session.code) + '/rematch', {
      token: session.token
    });
  }

  function leave() {
    var current = session;
    closeStream();
    clearSession();
    if (!current) return Promise.resolve({ ok: true });
    return http('POST', '/api/rooms/' + encodeURIComponent(current.code) + '/leave', {
      token: current.token
    }, 4000).catch(function () {
      return { ok: true };
    });
  }

  function getSnapshot() {
    if (!session) return Promise.reject(makeError('NO_SESSION'));
    return http('GET', '/api/rooms/' + encodeURIComponent(session.code) + '?token=' + encodeURIComponent(session.token));
  }

  function disconnect() {
    closeStream();
  }

  /* ------------------------------------------------------------------ *
   * 对外
   * ------------------------------------------------------------------ */
  var PokerNet = {
    VERSION: '1.0.0',
    available: available,
    getInfo: getInfo,
    createRoom: createRoom,
    joinRoom: joinRoom,
    connect: connect,
    disconnect: disconnect,
    getSnapshot: getSnapshot,
    submitLayout: submitLayout,
    sendAction: sendAction,
    rematch: rematch,
    leave: leave,
    getSession: function () { return session || loadSession(); },
    clearSession: clearSession,
    errorText: errorText,
    lastUpdateAt: function () { return lastUpdateAt; }
  };

  root.PokerNet = PokerNet;
  return PokerNet;
});
