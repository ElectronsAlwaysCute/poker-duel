/*
 * js/music.js —— 背景音乐（全局 PokerMusic，零依赖）
 * 循环播放 music/1.mp3；音量/开关由 main.js 的设置持久化后调用 configure()。
 * 浏览器自动播放策略：配置时先尝试播放（失败静默），并在首次 pointerdown/keydown/touchstart
 * 用户手势时再次尝试；任何失败都不抛出、不写 console，不影响游戏。
 */
(function (root) {
  'use strict';

  var M = {};
  var audio = null;
  var cfg = { enabled: true, volume: 30 }; // volume: 0..100（默认 30，避免开局过响）
  var gestureBound = false;
  var loadError = false;
  var loopSrc = 'music/1.mp3';

  function clampVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 30;
    n = Math.round(n);
    return Math.max(0, Math.min(100, n));
  }

  function unitVolume() { return cfg.volume / 100; }
  function supported() { return typeof root.Audio === 'function'; }

  function ensure() {
    if (audio || !supported()) return audio;
    try {
      audio = new root.Audio(loopSrc);
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = unitVolume();
      audio.addEventListener('error', function () { loadError = true; });
    } catch (err) {
      audio = null;
    }
    return audio;
  }

  function shouldPlay() {
    return cfg.enabled && cfg.volume > 0 && !!ensure();
  }

  function attemptPlay() {
    var a = ensure();
    if (!a || !shouldPlay()) return;
    try {
      var p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { /* 自动播放策略/无音频设备：静默等待下一次用户手势 */ });
      }
    } catch (err) { /* ignore */ }
  }

  function pause() {
    if (!audio) return;
    try { audio.pause(); } catch (err) { /* ignore */ }
  }

  function apply() {
    var a = ensure();
    if (a) a.volume = unitVolume();
    if (shouldPlay()) attemptPlay(); else pause();
  }

  function state() {
    var ready = 0;
    var err = loadError ? -1 : null;
    var playing = false;
    var src = null;
    if (audio) {
      ready = audio.readyState || 0;
      playing = !audio.paused && !audio.ended;
      if (audio.error) err = audio.error.code;
      src = audio.currentSrc || audio.src || null;
    }
    return {
      supported: supported(),
      enabled: cfg.enabled,
      volume: cfg.volume,
      volumeUnit: unitVolume(),
      playing: playing,
      loop: audio ? !!audio.loop : null,
      readyState: ready,
      error: err,
      src: src
    };
  }

  // 浏览器要求用户手势后才能播放：在首次 pointerdown/keydown/touchstart 时补一次播放尝试
  function bindGesture() {
    if (gestureBound) return;
    var doc = root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    gestureBound = true;
    var unlock = function () {
      if (cfg.enabled && cfg.volume > 0) attemptPlay();
    };
    doc.addEventListener('pointerdown', unlock, true);
    doc.addEventListener('keydown', unlock, true);
    doc.addEventListener('touchstart', unlock, { capture: true, passive: true });
  }

  M.configure = function (opts) {
    opts = opts || {};
    if (opts.enabled != null) cfg.enabled = !!opts.enabled;
    if (opts.volume != null) cfg.volume = clampVolume(opts.volume);
    bindGesture();
    apply();
    return state();
  };

  M.setEnabled = function (on) {
    cfg.enabled = !!on;
    apply();
    return state();
  };

  M.setVolume = function (v) {
    cfg.volume = clampVolume(v);
    apply();
    return state();
  };

  M.play = attemptPlay;
  M.pause = pause;
  M.state = state;
  M.getConfig = function () { return { enabled: cfg.enabled, volume: cfg.volume }; };

  root.PokerMusic = M;
})(typeof globalThis !== 'undefined' ? globalThis : this);
