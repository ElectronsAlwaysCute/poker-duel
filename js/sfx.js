/* =========================================================================
 * js/sfx.js —— 音效播放器（全局 PokerSFX，零依赖，file:// 可直接使用）
 * 素材：Kenney 音频包（CC0），见 sfx/LICENSES.md 与 sfx/balance.json。
 * 音量均衡：构建时用 headless Edge 解码每个 ogg，按「有效段 RMS」归一到 -20dBFS、
 * 峰值上限 -1dBFS，并叠加每个音效的 trim 得到 gain（预计算在 MANIFEST 中）。
 * 运行时只做 HTMLAudioElement 播放（不依赖 fetch/WebAudio），因此 file:// 可用。
 * 所有失败静默，不影响游戏；播放受浏览器自动播放策略限制，由首次用户手势解锁。
 * ========================================================================= */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var TARGET_RMS_DB = -20;
  var PEAK_CEIL_DB = -1;

  /* 每个音效：
   * file 相对项目根；gain = 均衡后的播放增益（已含 trim，0..1）；
   * trimDb 人工相对微调；rmsDb/peakDb 为素材实测值（文档/调试用，不参与播放）；
   * minInterval 最小重播间隔 ms；maxConcurrent 同时最多发声数（1 = 重播时从头开始）。 */
  var MANIFEST = {
    'ui.click':      { file: 'sfx/ui-click.ogg',      gain: 0.5995, trimDb: -4, rmsDb: -19.6, peakDb: -1.4, duration: 0.097, minInterval: 40, maxConcurrent: 2 },
    'ui.confirm':    { file: 'sfx/ui-confirm.ogg',    gain: 0.5450, trimDb: 0,  rmsDb: -14.7, peakDb: -1.0, duration: 0.539, minInterval: 80, maxConcurrent: 2 },
    'ui.error':      { file: 'sfx/ui-error.ogg',      gain: 0.7057, trimDb: 0,  rmsDb: -17.0, peakDb: -1.2, duration: 0.102, minInterval: 120, maxConcurrent: 2 },
    'card.place':    { file: 'sfx/card-place.ogg',    gain: 1.0000, trimDb: 0,  rmsDb: -28.1, peakDb: -1.6, duration: 0.456, minInterval: 30, maxConcurrent: 4 },
    'card.move':     { file: 'sfx/card-move.ogg',     gain: 0.6310, trimDb: -4, rmsDb: -23.2, peakDb: -2.3, duration: 0.598, minInterval: 30, maxConcurrent: 4 },
    'card.flip':     { file: 'sfx/card-flip.ogg',     gain: 0.9849, trimDb: 0,  rmsDb: -19.9, peakDb: -3.0, duration: 0.493, minInterval: 40, maxConcurrent: 4 },
    'card.draw':     { file: 'sfx/card-draw.ogg',     gain: 0.6310, trimDb: -4, rmsDb: -20.9, peakDb: -3.1, duration: 0.584, minInterval: 50, maxConcurrent: 3 },
    'card.shuffle':  { file: 'sfx/card-shuffle.ogg',  gain: 1.0000, trimDb: 0,  rmsDb: -30.6, peakDb: -2.1, duration: 3.063, minInterval: 800, maxConcurrent: 1 },
    'settle.go':     { file: 'sfx/settle-go.ogg',     gain: 1.0000, trimDb: 0,  rmsDb: -31.4, peakDb: -1.5, duration: 0.767, minInterval: 150, maxConcurrent: 2 },
    'settle.win':    { file: 'sfx/settle-win.ogg',    gain: 0.7943, trimDb: -2, rmsDb: -27.2, peakDb: -1.8, duration: 0.170, minInterval: 200, maxConcurrent: 3 },
    'settle.lose':   { file: 'sfx/settle-lose.ogg',   gain: 0.8913, trimDb: -1, rmsDb: -28.5, peakDb: -2.4, duration: 0.809, minInterval: 200, maxConcurrent: 3 },
    'settle.tie':    { file: 'sfx/settle-tie.ogg',    gain: 0.6310, trimDb: -4, rmsDb: -29.2, peakDb: -2.2, duration: 0.227, minInterval: 200, maxConcurrent: 2 },
    'turn.start':    { file: 'sfx/turn-start.ogg',    gain: 0.3642, trimDb: -5, rmsDb: -16.2, peakDb: -0.9, duration: 0.608, minInterval: 150, maxConcurrent: 1 },
    'turn.warning':  { file: 'sfx/turn-warning.ogg',  gain: 0.4995, trimDb: -5, rmsDb: -19.0, peakDb: -0.4, duration: 0.022, minInterval: 650, maxConcurrent: 1 },
    'turn.timeout':  { file: 'sfx/turn-timeout.ogg',  gain: 0.7145, trimDb: -1, rmsDb: -18.1, peakDb: -0.1, duration: 0.163, minInterval: 500, maxConcurrent: 1 },
    'endgame.start': { file: 'sfx/endgame-start.ogg', gain: 1.0000, trimDb: 0,  rmsDb: -30.1, peakDb: -1.4, duration: 0.400, minInterval: 800, maxConcurrent: 1 },
    'game.win':      { file: 'sfx/game-win.ogg',      gain: 0.4925, trimDb: 0,  rmsDb: -13.8, peakDb: -5.3, duration: 1.758, minInterval: 1000, maxConcurrent: 1 },
    'game.lose':     { file: 'sfx/game-lose.ogg',     gain: 0.9821, trimDb: 0,  rmsDb: -19.8, peakDb: -10.6, duration: 1.740, minInterval: 1000, maxConcurrent: 1 },
    'game.draw':     { file: 'sfx/game-draw.ogg',     gain: 0.4392, trimDb: -2, rmsDb: -14.9, peakDb: -4.2, duration: 0.993, minInterval: 1000, maxConcurrent: 1 }
  };
  var NAMES = Object.keys(MANIFEST);

  var supported = typeof root.Audio === 'function';
  var cfg = { enabled: true, volume: 70 }; // volume: 0..100（音效独立音量，默认 70）
  var pools = {};
  var played = {};
  var blocked = { disabled: 0, throttled: 0, policy: 0, unknown: 0, error: 0 };
  var lastPlayAt = {};
  var gestureBound = false;
  var unlocked = false;
  var loadErrors = [];

  function now() {
    if (root.performance && typeof root.performance.now === 'function') return root.performance.now();
    return Date.now();
  }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function clampVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 70;
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  function linearToDb(x) { return x > 0 ? 20 * Math.log(x) / Math.LN10 : -Infinity; }

  function volumeFor(name) {
    var entry = MANIFEST[name];
    if (!entry) return 0;
    return clamp((cfg.volume / 100) * entry.gain, 0, 1);
  }

  function ensurePool(name) {
    if (pools[name]) return pools[name];
    var entry = MANIFEST[name];
    var pool = { name: name, els: [], idx: 0, loaded: 0, failed: 0, error: null };
    if (!supported) { pools[name] = pool; return pool; }
    for (var i = 0; i < entry.maxConcurrent; i++) {
      try {
        var el = new root.Audio(entry.file);
        el.preload = 'auto';
        el._sfxName = name;
        el._sfxLoaded = false;
        el._sfxFailed = false;
        (function (audioEl) {
          var markLoaded = function () {
            if (audioEl._sfxLoaded || audioEl._sfxFailed) return;
            audioEl._sfxLoaded = true;
            pool.loaded++;
          };
          var markFailed = function () {
            if (audioEl._sfxFailed) return;
            audioEl._sfxFailed = true;
            pool.failed++;
            var code = audioEl.error ? audioEl.error.code : -1;
            pool.error = 'media-error-' + code;
            loadErrors.push({ name: name, file: entry.file, code: code });
          };
          audioEl.addEventListener('canplaythrough', markLoaded, false);
          audioEl.addEventListener('loadeddata', markLoaded, false);
          audioEl.addEventListener('error', markFailed, false);
        })(el);
        el.addEventListener('ended', function () { /* 保留元素复用 */ }, false);
        pool.els.push(el);
        try { el.load(); } catch (err) { /* ignore */ }
      } catch (err) {
        pool.error = String(err && err.message || err);
        loadErrors.push({ name: name, file: entry.file, code: -2 });
        break;
      }
    }
    pools[name] = pool;
    return pool;
  }

  function pickElement(pool, restart) {
    var els = pool.els;
    if (!els.length) return null;
    if (restart || els.length === 1) {
      pool.idx = 0;
      return els[0];
    }
    var i, k, el;
    for (i = 0; i < els.length; i++) {
      k = (pool.idx + i) % els.length;
      el = els[k];
      if (el.paused || el.ended) { pool.idx = (k + 1) % els.length; return el; }
    }
    el = els[pool.idx];
    pool.idx = (pool.idx + 1) % els.length;
    return el;
  }

  function stopElement(el) {
    if (!el) return;
    try { el.pause(); el.currentTime = 0; } catch (err) { /* ignore */ }
  }

  function stopAll() {
    for (var name in pools) {
      if (!Object.prototype.hasOwnProperty.call(pools, name)) continue;
      var els = pools[name].els;
      for (var i = 0; i < els.length; i++) stopElement(els[i]);
    }
  }

  function applyVolumeToPlaying() {
    for (var name in pools) {
      if (!Object.prototype.hasOwnProperty.call(pools, name)) continue;
      var els = pools[name].els;
      var vol = volumeFor(name);
      for (var i = 0; i < els.length; i++) {
        if (!els[i].paused) {
          try { els[i].volume = vol; } catch (err) { /* ignore */ }
        }
      }
    }
  }

  function bindGesture() {
    if (gestureBound) return;
    var doc = root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    gestureBound = true;
    var unlock = function () {
      unlocked = true;
      // 首次手势后预载全部音效（懒加载失败静默）
      loadAll();
    };
    doc.addEventListener('pointerdown', unlock, true);
    doc.addEventListener('keydown', unlock, true);
    doc.addEventListener('touchstart', unlock, { capture: true, passive: true });
  }

  function play(name, opts) {
    if (typeof name !== 'string' || !MANIFEST[name]) { blocked.unknown++; return false; }
    if (!supported) { blocked.error++; return false; }
    if (!cfg.enabled || cfg.volume <= 0) { blocked.disabled++; return false; }
    var entry = MANIFEST[name];
    var t = now();
    if (lastPlayAt[name] != null && (t - lastPlayAt[name]) < entry.minInterval) {
      blocked.throttled++;
      return false;
    }
    var pool = ensurePool(name);
    if (!pool.els.length) { blocked.error++; return false; }
    var el = pickElement(pool, entry.maxConcurrent === 1);
    if (!el) { blocked.error++; return false; }
    var vol = volumeFor(name);
    if (opts && opts.volume != null) vol = clamp(vol * Number(opts.volume), 0, 1);
    lastPlayAt[name] = t;
    try {
      el.pause();
      el.currentTime = 0;
      el.volume = vol;
      var p = el.play();
      unlocked = true;
      if (p && typeof p.then === 'function') {
        p.then(function () { unlocked = true; }, function () { blocked.policy++; });
      }
    } catch (err) {
      blocked.error++;
      return false;
    }
    played[name] = (played[name] || 0) + 1;
    return true;
  }

  function loadAll() {
    for (var i = 0; i < NAMES.length; i++) ensurePool(NAMES[i]);
    return new Promise(function (resolve) {
      var started = now();
      var check = function () {
        var loaded = 0, failed = 0, total = 0;
        for (var i = 0; i < NAMES.length; i++) {
          var pool = pools[NAMES[i]];
          if (!pool) continue;
          loaded += pool.loaded;
          failed += pool.failed;
          total += pool.els.length;
        }
        if (loaded + failed >= total || now() - started > 6000) {
          resolve({ loaded: loaded, failed: failed, total: total });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  function totalCounts() {
    var loaded = 0, failed = 0, total = 0, playing = 0;
    for (var i = 0; i < NAMES.length; i++) {
      var pool = pools[NAMES[i]];
      if (!pool) continue;
      loaded += pool.loaded;
      failed += pool.failed;
      total += pool.els.length;
      for (var k = 0; k < pool.els.length; k++) {
        if (!pool.els[k].paused) playing++;
      }
    }
    return { loaded: loaded, failed: failed, total: total, playing: playing };
  }

  function state() {
    var counts = totalCounts();
    return {
      supported: supported,
      enabled: cfg.enabled,
      volume: cfg.volume,
      unlocked: unlocked,
      loaded: counts.loaded,
      failed: counts.failed,
      total: counts.total,
      playing: counts.playing,
      names: NAMES.length
    };
  }

  function soundsDebug() {
    var out = {};
    for (var i = 0; i < NAMES.length; i++) {
      var name = NAMES[i];
      var entry = MANIFEST[name];
      var pool = pools[name];
      var outRmsDb = linearToDb(entry.gain) + entry.rmsDb;
      var outPeakDb = linearToDb(entry.gain) + entry.peakDb;
      var playing = 0;
      if (pool) {
        for (var k = 0; k < pool.els.length; k++) {
          if (!pool.els[k].paused) playing++;
        }
      }
      out[name] = {
        file: entry.file,
        gain: entry.gain,
        trimDb: entry.trimDb,
        rmsDb: entry.rmsDb,
        peakDb: entry.peakDb,
        duration: entry.duration,
        minInterval: entry.minInterval,
        maxConcurrent: entry.maxConcurrent,
        outRmsDb: Math.round(outRmsDb * 10) / 10,
        outPeakDb: Math.round(outPeakDb * 10) / 10,
        // 峰值限制导致到不了目标 RMS 的短促音效（敲击/摩擦类）标记出来
        peakLimited: outRmsDb < TARGET_RMS_DB - 3,
        balanceOk: outPeakDb <= PEAK_CEIL_DB + 1 && (Math.abs(outRmsDb - TARGET_RMS_DB) <= 3 || outRmsDb < TARGET_RMS_DB - 3),
        loaded: pool ? pool.loaded : 0,
        failed: pool ? pool.failed : 0,
        error: pool ? pool.error : null,
        playing: playing,
        played: played[name] || 0
      };
    }
    return out;
  }

  function debugState() {
    return {
      version: VERSION,
      supported: supported,
      enabled: cfg.enabled,
      volume: cfg.volume,
      unlocked: unlocked,
      targetRmsDb: TARGET_RMS_DB,
      peakCeilDb: PEAK_CEIL_DB,
      loaded: totalCounts().loaded,
      failed: totalCounts().failed,
      total: totalCounts().total,
      played: played,
      blocked: blocked,
      loadErrors: loadErrors.slice(),
      sounds: soundsDebug()
    };
  }

  var API = {
    VERSION: VERSION,
    SOUND_NAMES: NAMES.slice(),
    TARGET_RMS_DB: TARGET_RMS_DB,
    PEAK_CEIL_DB: PEAK_CEIL_DB,
    configure: function (opts) {
      opts = opts || {};
      if (opts.enabled != null) cfg.enabled = !!opts.enabled;
      if (opts.volume != null) cfg.volume = clampVolume(opts.volume);
      bindGesture();
      if (cfg.enabled && cfg.volume > 0) loadAll();
      applyVolumeToPlaying();
      return state();
    },
    setEnabled: function (on) {
      cfg.enabled = !!on;
      if (!cfg.enabled) stopAll();
      else loadAll();
      bindGesture();
      return state();
    },
    setVolume: function (v) {
      cfg.volume = clampVolume(v);
      applyVolumeToPlaying();
      return state();
    },
    getConfig: function () { return { enabled: cfg.enabled, volume: cfg.volume }; },
    play: play,
    stopAll: stopAll,
    preload: loadAll,
    load: loadAll,
    unlock: function () { unlocked = true; bindGesture(); return loadAll(); },
    state: state,
    debugState: debugState,
    sounds: soundsDebug,
    getManifest: function () {
      var out = {};
      for (var i = 0; i < NAMES.length; i++) {
        var e = MANIFEST[NAMES[i]];
        out[NAMES[i]] = {
          file: e.file, gain: e.gain, trimDb: e.trimDb, rmsDb: e.rmsDb, peakDb: e.peakDb,
          duration: e.duration, minInterval: e.minInterval, maxConcurrent: e.maxConcurrent
        };
      }
      return out;
    }
  };

  root.PokerSFX = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
