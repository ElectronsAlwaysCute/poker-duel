/*
 * js/main.js —— 对局控制器：驱动 PokerEngine + PokerAI + PokerUI
 * 负责：设置持久化、布局/战役/决战流程、动画时序、AI 调度、PokerDebug、URL 参数。
 */
(function (root) {
  'use strict';

  var E = root.PokerEngine;
  var SETTINGS_KEY = 'poker-duel-settings-v1';
  var DIFFICULTY_IDS = [1, 2, 3];
  var REGION_IDS = [3, 5, 7];
  var SETTLE_IDS = [1, 2, 4];
  var SETTLE_NAMES = { 1: '简单', 2: '标准', 4: '复杂' };
  var AI_STRENGTHS = ['easy', 'medium', 'hard'];
  /* v2.7：档位职责——简单档=稳健启发式（medium 参数）；中等档=最强启发式（hard 参数）；困难档=机器学习（ML 2.3.0）。
     v2.8：ML 2.2.2 修复浏览器（无 process 全局）下 build/布局自由决策的 process.env 未保护引用——
     此前浏览器困难档在决战 build 阶段会静默回退启发式（ML 只在战斗阶段生效）。
     v2.9：ML 2.3.0 去人工注入（删 0.02 tempo bonus、死 REGION_LAMBDA、planpi 叶 H 先验权重），Node 强度不降反升。 */
  var AI_ENGINES = ['heuristic', 'ml'];
  var DEFAULT_AI_ENGINE = 'ml';
  /* v2.9：ML 2.3.0 全区域启用（3/5/7 区；null = 不做区域门控） */
  var ML_POLICY_OPTS = {
    lambda: 0.85, margin: 0.002, topPlans: 5, heuristicTop: 5, worlds: 2,
    mlRegions: null, strength: 'hard'
  };
  var mlPolicyCache = null;
  var mediumPolicyCache = null;
  var mlWarned = {};
  var mlStats = { decisions: 0, mlChoices: 0, heuristicChoices: 0, mlFallbacks: 0, apSpendGuard: 0, lastGate: '' };
  /* v2.5：内部默认引擎（设置面板不展示，仅供调试/QA） */
  root.PokerAIDefaults = { defaultEngine: DEFAULT_AI_ENGINE, engines: AI_ENGINES.slice() };
  var DEFAULT_SETTLE_CARDS = 2;
  var ACTION_TYPES = ['settle', 'flip', 'place', 'move', 'draw'];
  var TURN_TIMER_OPTIONS = [0, 15, 30, 60];
  var DEFAULT_TURN_TIME_LIMIT = 30;

  var game = {
    state: null,
    settings: null,
    view: null,
    aiLayoutIds: null,
    aiTimer: null,
    busy: false,
    animation: true,
    aiDelayOverride: null,
    debug: false,
    urlSeed: null,
    autoplay: false,
    autoplayRunning: false,
    // v1.8.1：是否处于联机入口/房间上下文（?lan=1 大厅、等待房间、对局、断线恢复）；用于隐藏单机专属设置
    lanPage: false,
    // v1.6 托管（由简单 AI 代打本地玩家；单机 + 联机；不持久化）
    trustee: false,
    trusteeTimer: null,
    trusteeStall: 0,
    trusteeOverlayWasOpen: false,
    trusteePauseReason: '',
    trusteeLanOfflineNotified: false,
    trusteeFailCount: 0,
    mode: 'solo',
    lan: null,
    stallSeen: { p1: 0, p2: 0 }
  };

  function net() { return root.PokerNet || null; }

  function isLan() { return game.mode === 'lan'; }

  /* ================================================================== *
   * v1.7 联机零命令体验：本地服务器探测 / 一键启动引导
   * ================================================================== */
  var LAN_PORT_KEY = 'poker-duel-lan-port';
  var LAN_PROBE_PORTS = [5200, 5211];
  var LAN_LAUNCH_COMMAND = 'node tools/launch.js';

  function isFileProtocol() {
    try { return !!(root.location && root.location.protocol === 'file:'); } catch (err) { return false; }
  }

  function readLanPort() {
    try {
      var v = Number(root.localStorage && root.localStorage.getItem(LAN_PORT_KEY));
      return isFinite(v) && v > 0 && v <= 65535 ? v : null;
    } catch (err) { return null; }
  }

  function saveLanPort(port) {
    var p = Number(port);
    if (!isFinite(p) || p <= 0 || p > 65535) return;
    try { root.localStorage.setItem(LAN_PORT_KEY, String(p)); } catch (err) { /* 隐私模式忽略 */ }
  }

  /* 探测顺序：上次成功端口优先，其次常见 5200 / 5211 */
  function lanProbePortList() {
    var list = [];
    var saved = readLanPort();
    if (saved) list.push(saved);
    for (var i = 0; i < LAN_PROBE_PORTS.length; i++) {
      if (list.indexOf(LAN_PROBE_PORTS[i]) < 0) list.push(LAN_PROBE_PORTS[i]);
    }
    return list;
  }

  /* file:// → http 探测：no-cors fetch 可跨源发出，成功返回 opaque 响应即视为端口有服务 */
  function probeLanPort(port, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var ctrl = null;
      var timer = null;
      var finish = function (ok) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(ok ? { port: Number(port) } : null);
      };
      try { ctrl = root.AbortController ? new root.AbortController() : null; } catch (err) { ctrl = null; }
      timer = setTimeout(function () {
        done = true;
        try { if (ctrl) ctrl.abort(); } catch (err) { /* ignore */ }
        resolve(null);
      }, timeoutMs || 1500);
      try {
        var opts = { method: 'GET', mode: 'no-cors', cache: 'no-store' };
        if (ctrl) opts.signal = ctrl.signal;
        root.fetch('http://127.0.0.1:' + port + '/', opts).then(function () { finish(true); }, function () { finish(false); });
      } catch (err) {
        finish(false);
      }
    });
  }

  function probeLocalLanServer(ports) {
    var list = (ports && ports.length) ? ports.slice() : lanProbePortList();
    return Promise.all(list.map(function (p) { return probeLanPort(p); })).then(function (hits) {
      for (var i = 0; i < list.length; i++) if (hits[i]) return hits[i];
      return null;
    });
  }

  /* 页面在 file:// 下「局域网联机」：探测成功则跳转，失败显示一键启动引导（不阻塞单机） */
  function openLanLaunchGuide() {
    var ports = lanProbePortList();
    root.PokerUI.showLanLaunchGuide({ state: 'probing', ports: ports, command: LAN_LAUNCH_COMMAND });
    probeLocalLanServer(ports).then(function (hit) {
      if (!hit) {
        root.PokerUI.updateLanLaunchGuide({ state: 'not-found', ports: ports, command: LAN_LAUNCH_COMMAND });
        return;
      }
      saveLanPort(hit.port);
      root.PokerUI.updateLanLaunchGuide({ state: 'found', port: hit.port, ports: ports, command: LAN_LAUNCH_COMMAND });
      root.PokerUI.toast('已连接本地联机服务器（端口 ' + hit.port + '），正在进入联机大厅…', 'success');
      setTimeout(function () {
        try { root.location.href = 'http://127.0.0.1:' + hit.port + '/?lan=1'; }
        catch (err) {
          root.PokerUI.updateLanLaunchGuide({ state: 'not-found', ports: ports, command: LAN_LAUNCH_COMMAND, error: '跳转失败，请在浏览器手动打开 http://127.0.0.1:' + hit.port + '/?lan=1' });
        }
      }, 420);
    }, function () {
      root.PokerUI.updateLanLaunchGuide({ state: 'not-found', ports: ports, command: LAN_LAUNCH_COMMAND });
    });
  }

  function retryLanLaunchGuide() {
    var ports = lanProbePortList();
    root.PokerUI.updateLanLaunchGuide({ state: 'probing', ports: ports, command: LAN_LAUNCH_COMMAND });
    probeLocalLanServer(ports).then(function (hit) {
      if (!hit) {
        root.PokerUI.updateLanLaunchGuide({ state: 'not-found', ports: ports, command: LAN_LAUNCH_COMMAND });
        return;
      }
      saveLanPort(hit.port);
      root.PokerUI.updateLanLaunchGuide({ state: 'found', port: hit.port, ports: ports, command: LAN_LAUNCH_COMMAND });
      root.PokerUI.toast('已连接本地联机服务器（端口 ' + hit.port + '），正在进入联机大厅…', 'success');
      setTimeout(function () {
        try { root.location.href = 'http://127.0.0.1:' + hit.port + '/?lan=1'; }
        catch (err) {
          root.PokerUI.updateLanLaunchGuide({ state: 'not-found', ports: ports, command: LAN_LAUNCH_COMMAND, error: '跳转失败，请手动打开 http://127.0.0.1:' + hit.port + '/?lan=1' });
        }
      }, 420);
    }, function () {
      root.PokerUI.updateLanLaunchGuide({ state: 'not-found', ports: ports, command: LAN_LAUNCH_COMMAND });
    });
  }

  function newLanState() {
    return {
      role: 'host',
      session: null,
      meta: null,
      connection: 'connecting',
      pendingUpdates: [],
      processing: false,
      layoutSubmitted: false,
      rematchRequested: false,
      actionPending: false,
      actionTimer: null
    };
  }

  function lanOpponentOnline() {
    var meta = game.lan && game.lan.meta;
    if (!meta || !meta.players || !meta.players.p2) return true;
    return meta.players.p2.connected !== false;
  }

  function lanViewModel() {
    if (!isLan() || !game.lan) return null;
    var meta = game.lan.meta || null;
    var players = (meta && meta.players) || {};
    return {
      active: true,
      role: game.lan.role,
      meta: meta,
      connection: game.lan.connection,
      code: (meta && meta.code) || (game.lan.session && game.lan.session.code) || '',
      myName: (players.p1 && players.p1.name) || (game.settings && game.settings.nickname) || currentNickname(),
      opponentName: (players.p2 && players.p2.name) || '对手',
      rematchRequested: !!game.lan.rematchRequested
    };
  }

  function netErrorText(err) {
    var n = net();
    if (!err) return '网络异常，请重试';
    if (n && n.errorText) return n.errorText(err.code, err.message);
    return err.message || '网络异常，请重试';
  }

  /* ================================================================== *
   * 设置持久化
   * ================================================================== */
  function allRanks() {
    return E && E.RANKS ? E.RANKS.slice() : ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  }

  function defaultSettings() {
    return {
      difficulty: 1,
      regionCount: 5,
      settleCards: DEFAULT_SETTLE_CARDS,
      firstPlayer: 'random',
      aiStrength: 'medium',
      aiEngine: DEFAULT_AI_ENGINE,
      animation: 'standard',
      turnTimeLimit: DEFAULT_TURN_TIME_LIMIT,
      drag: defaultDragSetting(),
      musicEnabled: true,
      musicVolume: 30,
      sfxEnabled: true,
      sfxVolume: 70,
      nickname: '玩家'
    };
  }

  /* v2.17：拖拽操作改为可选设置（桌面默认开、安卓默认关） */
  function isAndroidLikePlatform() {
    try {
      if (root && root.__POKER_ANDROID) return true;
      var ua = String((root && root.navigator && root.navigator.userAgent) || '');
      if (/Android/i.test(ua)) return true;
      var search = String((root && root.location && root.location.search) || '');
      if (/(?:^|[?&])(?:android=1|drag=0)(?:&|$)/.test(search)) return true;
    } catch (errDrag) { /* ignore */ }
    return false;
  }

  function defaultDragSetting() { return isAndroidLikePlatform() ? 'off' : 'on'; }

  function applyDragSetting(settings) {
    try {
      if (root.PokerUI && typeof root.PokerUI.setDragEnabled === 'function') {
        root.PokerUI.setDragEnabled(!(settings && settings.drag === 'off'));
      }
    } catch (errDragApply) { /* ignore */ }
  }

  function normalizeAiStrength(raw) {
    if (raw === 'normal') return 'medium'; // 旧版本 'normal' 迁移
    return AI_STRENGTHS.indexOf(raw) >= 0 ? raw : 'medium';
  }

  /* 档位→启发式强度映射：简单→medium（稳健启发式）；中等/困难→hard（最强启发式，用于回退/布局）。 */
  function effectiveHeuristicStrength(strength) {
    if (strength === 'easy') return 'medium';
    return 'hard';
  }

  /* v1.8：困难档 AI 引擎选择（heuristic = 启发式 3.3.0 对照；ml = 机器学习实验，默认） */
  function normalizeAiEngine(raw) {
    return AI_ENGINES.indexOf(raw) >= 0 ? raw : DEFAULT_AI_ENGINE;
  }

  /* v2.18：三档均为纯学习浏览器 bundle（policy-only；layout 使用产品阶段基线/启发式）：
     简单 = gen60（H96）；中等 = gen241（H128）；困难 = 2026-10-31 交付 PPO H192 gen436。
     若对应纯学习模块缺失，回退到启发式/产品 ML（安全回退，不影响规则）。 */
  function aiMlModule() { return root.PokerAIPure || root.PokerAIML || null; }

  function mlAvailability() {
    var ml = aiMlModule();
    var heur = root.PokerAI;
    var ok = !!(ml && typeof ml.hasModel === 'function' && ml.hasModel() &&
      typeof ml.createPolicy === 'function' &&
      heur && heur._internals);
    return {
      available: ok,
      version: ml && ml.VERSION ? String(ml.VERSION) : null
    };
  }

  function warnMlOnce(key, err) {
    if (mlWarned[key]) return;
    mlWarned[key] = true;
    try {
      if (root.console && typeof root.console.warn === 'function') {
        root.console.warn('[PokerApp] ML AI 不可用/异常，已回退启发式 3.3.0：' + (err && err.message ? err.message : err));
      }
    } catch (e) { /* ignore */ }
  }

  /* ML 策略单例（懒加载；FROZEN 参数 + 区域门控；创建失败安全返回 null） */
  function getMlPolicy() {
    var info = mlAvailability();
    if (!info.available) return null;
    if (mlPolicyCache && mlPolicyCache.version === info.version && mlPolicyCache.policy) {
      return mlPolicyCache.policy;
    }
    try {
      var ml = aiMlModule();
      var factory = typeof ml.createPolicy === 'function' ? ml.createPolicy : ml.create;
      if (typeof factory !== 'function') return null;
      var policy = factory(root.PokerAI, ML_POLICY_OPTS);
      if (!policy || typeof policy.chooseAction !== 'function') return null;
      mlPolicyCache = { version: info.version, policy: policy };
      return policy;
    } catch (err) {
      warnMlOnce('create', err);
      return null;
    }
  }

  function currentAiEngine() {
    return normalizeAiEngine(game.settings ? game.settings.aiEngine : DEFAULT_AI_ENGINE);
  }

  /* v2.16：中等档保持产品 ML 2.3.0（世界模型+采样世界计划评估+决战自适应搜索）；
     困难档升级为 Phase16 gen195 纯学习（H128，policy-only）。layout 仍走产品阶段基线/启发式布局。 */
  function aiMediumModule() { return root.PokerAIML || null; }

  function getMediumPolicy() {
    var ml = aiMediumModule();
    if (!ml || typeof ml.createPolicy !== 'function') return null;
    if (!ml.hasModel || !ml.hasModel()) return null;
    var version = ml.VERSION ? String(ml.VERSION) : '';
    if (mediumPolicyCache && mediumPolicyCache.version === version && mediumPolicyCache.policy) {
      return mediumPolicyCache.policy;
    }
    try {
      var policy = ml.createPolicy(root.PokerAI, ML_POLICY_OPTS);
      if (!policy || typeof policy.chooseAction !== 'function') return null;
      mediumPolicyCache = { version: version, policy: policy };
      return policy;
    } catch (err) {
      warnMlOnce('create-medium', err);
      return null;
    }
  }

  /* v2.18：简单档 = gen60（PokerAIPureSimple）；中等档 = Phase17 联赛 PPO gen241（PokerAIPure）；
     困难档 = 2026-10-31 交付 PPO H192 gen436（PokerAIPureHard）。
     三者都是 policy-only 浏览器 bundle；layout 使用产品阶段基线。 */
  var purePolicyCache = { simple: null, medium: null, hard: null };

  function pureLearnModule(kind) {
    if (kind === 'simple') return root.PokerAIPureSimple || null;
    if (kind === 'hard') return root.PokerAIPureHard || null;
    return root.PokerAIPure || null;
  }

  function getPureLearnPolicy(kind) {
    var mod = pureLearnModule(kind);
    if (!mod || typeof mod.createPolicy !== 'function') return null;
    var version = mod.VERSION ? String(mod.VERSION) : '';
    var cached = purePolicyCache[kind];
    if (cached && cached.version === version && cached.policy) return cached.policy;
    try {
      var policy = mod.createPolicy(root.PokerAI, ML_POLICY_OPTS);
      if (!policy || typeof policy.chooseAction !== 'function') return null;
      purePolicyCache[kind] = { version: version, policy: policy };
      return policy;
    } catch (err) {
      warnMlOnce('pure-' + kind, err);
      return null;
    }
  }

  /* 返回 null 表示「本次决策可以使用 ML」，否则返回不可用原因（engine/strength/lan/unavailable/region-gate）。
     v2.5：仅困难档使用 ML（设置面板已无引擎选项，内部 engine 默认 ml）。 */
  function mlGateReason(st, strength) {
    if (isLan()) return 'lan';
    if (currentAiEngine() !== 'ml') return 'engine';
    if (strength !== 'hard') return 'strength';
    var info = mlAvailability();
    if (!info.available) return 'unavailable';
    var policy = getMlPolicy();
    if (!policy) return 'unavailable';
    var regionCount = st && st.config ? Number(st.config.regionCount) : null;
    if (typeof policy.isMlEnabled === 'function' && regionCount && !policy.isMlEnabled(regionCount)) {
      return 'region-gate';
    }
    return null;
  }

  /* 当前对局（或菜单）下的 ML 生效状态，供 PokerDebug/设置摘要使用 */
  function aiEngineState() {
    var engine = currentAiEngine();
    var info = mlAvailability();
    var st = game.state;
    var regionCount = st && st.config ? Number(st.config.regionCount) : null;
    var gate = null;
    var usingMl = false;
    var gateReason = null;
    if (engine === 'ml' && info.available) {
      var policy = getMlPolicy();
      if (policy && typeof policy.isMlEnabled === 'function' && regionCount) {
        gate = { mlRegions: Array.isArray(policy.options && policy.options.mlRegions) ? policy.options.mlRegions.slice() : null, regionCount: regionCount };
        gateReason = policy.isMlEnabled(regionCount) ? null : 'region-gate';
      }
    }
    usingMl = !!(engine === 'ml' && info.available && !isLan() && regionCount && gateReason === null);
    var fallback = engine === 'ml' && (!info.available || (regionCount ? gateReason !== null : false));
    var policyStats = null;
    if (info.available) {
      var pol = getMlPolicy();
      if (pol && typeof pol.getStats === 'function') {
        try { policyStats = pol.getStats(); } catch (e) { policyStats = null; }
      }
    }
    return {
      engine: engine,
      available: info.available,
      mlVersion: info.version,
      fallsBack: !!fallback,
      defaults: {
        engine: DEFAULT_AI_ENGINE,
        policy: clonePlain(ML_POLICY_OPTS),
        mlRegions: ML_POLICY_OPTS.mlRegions ? ML_POLICY_OPTS.mlRegions.slice() : null
      },
      gate: gate,
      gateReason: gateReason,
      usingMl: !!usingMl,
      lan: isLan(),
      regionCount: regionCount,
      strength: game.settings ? game.settings.aiStrength : null,
      heuristicStrength: game.settings ? effectiveHeuristicStrength(game.settings.aiStrength) : null,
      stats: { controller: deepClone_mlStats(), policy: policyStats },
      warned: Object.keys(mlWarned)
    };
  }

  function deepClone_mlStats() {
    return {
      decisions: mlStats.decisions,
      mlChoices: mlStats.mlChoices,
      heuristicChoices: mlStats.heuristicChoices,
      mlFallbacks: mlStats.mlFallbacks,
      apSpendGuard: mlStats.apSpendGuard,
      lastGate: mlStats.lastGate
    };
  }

  function clonePlain(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (err) { return null; }
  }

  function settleModeMeta(cards) {
    var list = (E && E.SETTLE_MODES) || [];
    var n = Number(cards);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === n) return list[i];
    }
    // 引擎未更新时的契约回退（1=简单 / 2=标准 / 4=复杂）
    if (SETTLE_NAMES[n]) return { id: n, name: SETTLE_NAMES[n], label: '双方各补 ' + n + ' 张', cards: n };
    return null;
  }

  function settleModeName(cards) {
    var mode = settleModeMeta(cards);
    if (mode) return mode.name;
    var n = Number(cards);
    return SETTLE_NAMES[n] || ('各补 ' + Number(n || DEFAULT_SETTLE_CARDS) + ' 张');
  }

  function buildConfig(overrides) {
    var s = game.settings || defaultSettings();
    var o = overrides || {};
    var settleCards = o.settleCards != null ? Number(o.settleCards) : Number(s.settleCards);
    if (SETTLE_IDS.indexOf(settleCards) < 0) settleCards = DEFAULT_SETTLE_CARDS;
    var turnTimeLimit = o.turnTimeLimit != null ? Number(o.turnTimeLimit) : Number(s.turnTimeLimit);
    if (!isEngineTimerValue(turnTimeLimit)) turnTimeLimit = defaultTurnTimeLimit();
    var cfg = {
      regionCount: o.regionCount != null ? Number(o.regionCount) : s.regionCount,
      difficulty: o.difficulty != null ? Number(o.difficulty) : s.difficulty,
      settleCards: settleCards,
      firstPlayer: o.firstPlayer != null ? o.firstPlayer : s.firstPlayer,
      aiStrength: o.aiStrength || s.aiStrength,
      turnTimeLimit: turnTimeLimit,
      seed: o.seed !== undefined ? o.seed : null
    };
    // 网页固定标准单副牌 54 张（3/5/7 区一致）；仅调试入口显式传 deck 时覆盖
    if (o.deck && typeof o.deck === 'object') {
      var ranks = Array.isArray(o.deck.ranks)
        ? o.deck.ranks.filter(function (r) { return E.RANK_VALUES[r] !== undefined; })
        : allRanks();
      var suits = Array.isArray(o.deck.suits) && o.deck.suits.length ? o.deck.suits.slice() : null;
      cfg.deck = { jokers: o.deck.jokers !== false, ranks: ranks, suits: suits };
      if (o.deck.copies != null) cfg.deck.copies = Number(o.deck.copies);
    }
    if (o.playerNames) cfg.playerNames = o.playerNames;
    return cfg;
  }

  function normalizeSettings(raw) {
    var def = defaultSettings();
    if (!raw || typeof raw !== 'object') return def;
    try {
      var difficulty = DIFFICULTY_IDS.indexOf(Number(raw.difficulty)) >= 0 ? Number(raw.difficulty) : 1;
      var regionCount = REGION_IDS.indexOf(Number(raw.regionCount)) >= 0 ? Number(raw.regionCount) : 5;
      var rawSettle = Number(raw.settleCards);
      if (rawSettle === 3) rawSettle = 4; // 旧版「复杂 = 各补 3 张」迁移为 4
      var settleCards = SETTLE_IDS.indexOf(rawSettle) >= 0 ? rawSettle : def.settleCards;
      var firstPlayer = ['random', 'p1', 'p2'].indexOf(raw.firstPlayer) >= 0 ? raw.firstPlayer : 'random';
      var aiStrength = normalizeAiStrength(raw.aiStrength);
      var aiEngine = normalizeAiEngine(raw.aiEngine);
      var animation = raw.animation === 'fast' ? 'fast' : 'standard';
      var drag = raw.drag === 'off' ? 'off' : (raw.drag === 'on' ? 'on' : defaultDragSetting());
      var turnTimeLimit = isSettingsTimerValue(raw.turnTimeLimit) ? Number(raw.turnTimeLimit) : def.turnTimeLimit;
      var musicEnabled = raw.musicEnabled !== false && raw.musicEnabled !== 0 && raw.musicEnabled !== '0';
      var musicVolume = Math.round(Number(raw.musicVolume));
      if (!isFinite(musicVolume)) musicVolume = def.musicVolume;
      musicVolume = Math.max(0, Math.min(100, musicVolume));
      var sfxEnabled = raw.sfxEnabled !== false && raw.sfxEnabled !== 0 && raw.sfxEnabled !== '0';
      var sfxVolume = Math.round(Number(raw.sfxVolume));
      if (!isFinite(sfxVolume)) sfxVolume = def.sfxVolume;
      sfxVolume = Math.max(0, Math.min(100, sfxVolume));
      var settings = {
        difficulty: difficulty,
        regionCount: regionCount,
        settleCards: settleCards,
        firstPlayer: firstPlayer,
        aiStrength: aiStrength,
        aiEngine: aiEngine,
        animation: animation,
        drag: drag,
        turnTimeLimit: turnTimeLimit,
        musicEnabled: musicEnabled,
        musicVolume: musicVolume,
        sfxEnabled: sfxEnabled,
        sfxVolume: sfxVolume,
        nickname: validNickname(raw.nickname)
      };
      game.settings = settings;
      var check = E.validateConfig(buildConfig({}));
      if (!check.ok) return def;
      return settings;
    } catch (err) {
      return def;
    }
  }

  function validNickname(value) {
    var name = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    return name || '玩家';
  }

  var NICK_KEY = 'poker-duel-lan-nickname-v1';

  function randomNickname() {
    return '玩家' + (Math.floor(Math.random() * 900) + 100);
  }

  function readTabNickname() {
    try { return root.sessionStorage ? root.sessionStorage.getItem(NICK_KEY) : null; } catch (e) { return null; }
  }

  function writeTabNickname(name) {
    try { if (root.sessionStorage) root.sessionStorage.setItem(NICK_KEY, name); } catch (e) { /* ignore */ }
  }

  /* 联机昵称：默认每个标签页随机唯一（sessionStorage 隔离）；用户可在大厅修改 */
  function currentNickname() {
    var tabName = readTabNickname();
    if (tabName) return validNickname(tabName);
    var generated = randomNickname();
    writeTabNickname(generated);
    return generated;
  }

  function loadSettings() {
    var def = defaultSettings();
    try {
      var raw = root.localStorage ? root.localStorage.getItem(SETTINGS_KEY) : null;
      if (!raw) return def;
      return normalizeSettings(JSON.parse(raw));
    } catch (err) {
      return def;
    }
  }

  function saveSettings(settings) {
    try {
      if (root.localStorage) {
        root.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          difficulty: settings.difficulty,
          regionCount: settings.regionCount,
          settleCards: settings.settleCards,
          firstPlayer: settings.firstPlayer,
          aiStrength: settings.aiStrength,
          aiEngine: normalizeAiEngine(settings.aiEngine),
          animation: settings.animation,
          drag: settings.drag === 'off' ? 'off' : 'on',
          turnTimeLimit: settings.turnTimeLimit,
          musicEnabled: settings.musicEnabled !== false,
          musicVolume: Number(settings.musicVolume),
          sfxEnabled: settings.sfxEnabled !== false,
          sfxVolume: Number(settings.sfxVolume),
          nickname: validNickname(settings.nickname)
        }));
      }
    } catch (err) { /* 隐私模式等场景忽略 */ }
  }

  /* ================================================================== *
   * 背景音乐（js/music.js，全局 PokerMusic）
   * ================================================================== */
  function musicEngine() {
    return root.PokerMusic || null;
  }

  function applyMusicSettings() {
    var s = game.settings || defaultSettings();
    var enabled = s.musicEnabled !== false;
    var volume = Number(s.musicVolume);
    if (!isFinite(volume)) volume = 30;
    volume = Math.max(0, Math.min(100, Math.round(volume)));
    var m = musicEngine();
    if (m && typeof m.configure === 'function') m.configure({ enabled: enabled, volume: volume });
    if (root.PokerUI && typeof root.PokerUI.setMusicState === 'function') {
      root.PokerUI.setMusicState({ enabled: enabled, volume: volume });
    }
  }

  /* ================================================================== *
   * 音效（js/sfx.js，全局 PokerSFX；失败静默，不阻塞游戏）
   * ================================================================== */
  function sfxEngine() {
    return root.PokerSFX || null;
  }

  function playSfx(name) {
    var s = sfxEngine();
    if (!s || typeof s.play !== 'function') return;
    try { s.play(name); } catch (err) { /* ignore */ }
  }

  function applySfxSettings() {
    var s = game.settings || defaultSettings();
    var enabled = s.sfxEnabled !== false;
    var volume = Number(s.sfxVolume);
    if (!isFinite(volume)) volume = 70;
    volume = Math.max(0, Math.min(100, Math.round(volume)));
    var sfx = sfxEngine();
    if (sfx && typeof sfx.configure === 'function') sfx.configure({ enabled: enabled, volume: volume });
    if (root.PokerUI && typeof root.PokerUI.setSfxState === 'function') {
      root.PokerUI.setSfxState({ enabled: enabled, volume: volume });
    }
  }

  function settleWinnerSfx(winner) {
    if (winner === 'p1') return 'settle.win';
    if (winner === 'p2') return 'settle.lose';
    return 'settle.tie';
  }

  function gameResultSfx(result) {
    if (!result) return 'game.draw';
    if (result.winner === 'p1') return 'game.win';
    if (result.winner === 'p2') return 'game.lose';
    return 'game.draw';
  }

  // 单个事件 → 音效（结算胜负音在结算动画结果帧播，不在此处）
  function playEventSfx(ev) {
    if (!ev) return;
    switch (ev.type) {
      case 'flip': playSfx('card.flip'); break;
      case 'place': playSfx('card.place'); break;
      case 'move': playSfx('card.move'); break;
      case 'draw': playSfx('card.draw'); break;
      case 'extra_draw': playSfx('card.draw'); break;
      case 'settle': case 'endgame_settle': playSfx('settle.go'); break;
      case 'endgame_start': playSfx('endgame.start'); break;
      case 'game_over': playSfx(gameResultSfx(ev.result)); break;
      case 'turn_start': if (ev.playerId === 'p1') playSfx('turn.start'); break;
      case 'battle_start': playSfx('turn.start'); break;
      default: break;
    }
  }

  // 布局揭示：洗牌 + 后手补牌 + 开局回合提示
  function playLayoutSfx(events) {
    var revealed = false;
    var started = false;
    (events || []).forEach(function (ev) {
      if (!ev) return;
      if (ev.type === 'layout_reveal') revealed = true;
      if (ev.type === 'extra_draw') playSfx('card.draw');
      if (ev.type === 'battle_start') started = true;
      if (ev.type === 'turn_start' && ev.playerId === 'p1') started = true;
    });
    if (revealed) playSfx('card.shuffle');
    if (started) playSfx('turn.start');
  }

  // 无动画/调试路径：按事件顺序补齐音效（结算立即播胜负音）
  function playEventsSfxFast(events) {
    (events || []).forEach(function (ev) {
      if (!ev) return;
      playEventSfx(ev);
      if (ev.type === 'settle' || ev.type === 'endgame_settle') playSfx(settleWinnerSfx(ev.winner));
    });
  }

  /* ================================================================== *
   * 每回合倒计时（v1.5）：UI 侧计时，引擎只负责配置（不执行计时）
   * ================================================================== */
  var turnTimer = {
    limit: DEFAULT_TURN_TIME_LIMIT,
    remaining: DEFAULT_TURN_TIME_LIMIT,
    deadline: 0,
    running: false,
    expired: false,
    paused: false,
    interval: null,
    lastTickSound: null,
    localTurn: false,
    override: null,
    timeoutAttempts: 0,
    timeoutToastShown: false
  };

  function timerOptions() {
    return (E && Array.isArray(E.TURN_TIME_LIMIT_OPTIONS)) ? E.TURN_TIME_LIMIT_OPTIONS.slice() : TURN_TIMER_OPTIONS.slice();
  }

  function defaultTurnTimeLimit() {
    var n = Number(E && E.DEFAULT_TURN_TIME_LIMIT);
    return isFinite(n) ? n : DEFAULT_TURN_TIME_LIMIT;
  }

  function isSettingsTimerValue(v) {
    return timerOptions().indexOf(Number(v)) >= 0;
  }

  // 引擎合法值：0 或 5-300 的整数。debug 覆盖允许 1-4 秒（仅 UI 计时用，不传给引擎）
  function isEngineTimerValue(v) {
    var n = Number(v);
    return Number.isInteger(n) && (n === 0 || (n >= 5 && n <= 300));
  }

  function normalizeTimerOverride(v) {
    var n = Number(v);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n <= 0) return 0;
    return Math.max(1, Math.min(300, n));
  }

  function settingsTimerLimit() {
    var s = game.settings;
    var n = s ? Number(s.turnTimeLimit) : NaN;
    return isSettingsTimerValue(n) ? n : defaultTurnTimeLimit();
  }

  function effectiveTimerLimit() {
    if (turnTimer.override != null) return turnTimer.override;
    var st = game.state;
    if (st && st.config && st.config.turnTimeLimit != null) {
      var n = Number(st.config.turnTimeLimit);
      if (isFinite(n)) return Math.max(0, Math.min(300, Math.round(n)));
    }
    return settingsTimerLimit();
  }

  function isLocalTimerTurn() {
    var st = game.state;
    if (!st || st.phase !== 'battle' || !st.turn) return false;
    if (st.endgame && st.endgame.phase === 'showdown') return false;
    // 自动演示 / 自动对局时双方由 AI 控制，不启用真人计时
    if (game.autoplayRunning || (game.autoplay && !isLan())) return false;
    // v1.6/v1.7 托管期间本地玩家也由 AI 代打（单机与联机）：暂停本地倒计时，避免与代打竞争
    if (game.trustee) return false;
    return st.turn === 'p1'; // 单机人类 / LAN 镜像后自己都是 p1
  }

  function isTimerOverlayPaused() {
    if (!root.document) return false;
    if (root.document.visibilityState === 'hidden') return true;
    if (root.PokerUI && typeof root.PokerUI.isTimerOverlayOpen === 'function') {
      try { return !!root.PokerUI.isTimerOverlayOpen(); } catch (err) { return false; }
    }
    return false;
  }

  function timerSfx(name) {
    var sfx = root.PokerSFX;
    if (!sfx || typeof sfx.play !== 'function') return;
    try { sfx.play(name); } catch (err) { /* 音效失败不影响计时 */ }
  }

  function timerNow() {
    return (root.performance && typeof root.performance.now === 'function') ? root.performance.now() : Date.now();
  }

  function stopTimerInterval() {
    if (turnTimer.interval) {
      clearInterval(turnTimer.interval);
      turnTimer.interval = null;
    }
  }

  function startTimerInterval() {
    if (turnTimer.interval) return;
    turnTimer.interval = setInterval(onTimerInterval, 200);
  }

  function renderTurnTimerDom() {
    if (!root.PokerUI || typeof root.PokerUI.renderTurnTimer !== 'function') return;
    var st = game.state;
    var limit = turnTimer.limit;
    var state = 'idle';
    if (st && st.phase === 'battle') {
      if (limit <= 0) state = 'off';
      else if (st.endgame && st.endgame.phase === 'showdown') state = 'idle';
      else if (isTrusteeActive()) state = 'trustee';
      else if (isLocalTimerTurn()) {
        state = turnTimer.expired ? 'expired' : (turnTimer.paused ? 'paused' : 'running');
      } else {
        state = 'opponent';
      }
    } else if (limit <= 0 && st) {
      state = 'off';
    }
    root.PokerUI.renderTurnTimer({
      state: state,
      total: limit > 0 ? limit : 0,
      remaining: turnTimer.remaining,
      localPlayerId: 'p1'
    });
  }

  function resetTurnTimer(limit) {
    turnTimer.limit = Math.max(0, Math.round(Number(limit) || 0));
    turnTimer.remaining = turnTimer.limit;
    turnTimer.expired = false;
    turnTimer.paused = false;
    turnTimer.lastTickSound = null;
    turnTimer.timeoutAttempts = 0;
    turnTimer.timeoutToastShown = false;
    if (turnTimer.limit > 0) {
      turnTimer.deadline = timerNow() + turnTimer.limit * 1000;
      turnTimer.running = true;
      startTimerInterval();
    } else {
      turnTimer.running = false;
      turnTimer.deadline = 0;
      stopTimerInterval();
    }
    renderTurnTimerDom();
  }

  function syncTimerForState(events) {
    var limit = effectiveTimerLimit();
    var local = isLocalTimerTurn();
    var localStart = false;
    if (events && events.length) {
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev) continue;
        if (ev.type === 'turn_start' && ev.playerId === 'p1') localStart = true;
        if (ev.type === 'battle_start') localStart = true;
      }
    }
    if (!game.state) {
      turnTimer.localTurn = false;
      turnTimer.running = false;
      turnTimer.expired = false;
      turnTimer.paused = false;
      turnTimer.limit = limit;
      turnTimer.remaining = limit;
      stopTimerInterval();
      renderTurnTimerDom();
      return;
    }
    if (!local) {
      turnTimer.localTurn = false;
      turnTimer.running = false;
      turnTimer.expired = false;
      turnTimer.paused = false;
      turnTimer.limit = limit;
      turnTimer.remaining = limit;
      stopTimerInterval();
      renderTurnTimerDom();
      return;
    }
    var newTurn = localStart || !turnTimer.localTurn || turnTimer.limit !== limit;
    turnTimer.localTurn = true;
    if (newTurn) {
      resetTurnTimer(limit);
    } else {
      startTimerInterval();
      renderTurnTimerDom();
    }
  }

  function timerState() {
    var st = game.state;
    var local = isLocalTimerTurn();
    var limit = effectiveTimerLimit();
    var paused = !!(turnTimer.paused || (local && isTimerOverlayPaused()));
    var trustee = isTrusteeActive();
    var state;
    if (limit <= 0) state = 'off';
    else if (!st || st.phase !== 'battle') state = 'idle';
    else if (trustee) state = 'trustee';
    else if (!local) state = 'opponent';
    else state = turnTimer.expired ? 'expired' : (paused ? 'paused' : 'running');
    return {
      enabled: limit > 0,
      total: limit,
      remaining: Math.max(0, Math.round(turnTimer.remaining * 10) / 10),
      running: !!turnTimer.running && !turnTimer.expired && !paused,
      paused: paused,
      expired: !!turnTimer.expired,
      localPlayerId: 'p1',
      localTurn: local,
      trustee: trustee,
      state: state
    };
  }

  function attemptTimeoutEndTurn() {
    if (!turnTimer.expired) return;
    if (!isLocalTimerTurn()) { syncTimerForState(); return; }
    if (isTimerOverlayPaused()) return;
    if (game.busy || (game.view && game.view.busy)) return;
    if (isLan() && game.lan && (game.lan.actionPending || game.lan.processing)) return;
    if (turnTimer.timeoutAttempts >= 12) {
      // 连续被拒绝：恢复短倒计时，避免卡死/重复弹提示
      turnTimer.expired = false;
      turnTimer.timeoutAttempts = 0;
      resetTurnTimer(Math.max(1, Math.min(5, turnTimer.limit || 5)));
      return;
    }
    turnTimer.timeoutAttempts++;
    try {
      commitAction({ type: 'end_turn' });
    } catch (err) { /* commitAction 内部已有错误提示 */ }
  }

  function onTimerInterval() {
    var st = game.state;
    if (!st || st.phase !== 'battle' || turnTimer.limit <= 0) {
      if (turnTimer.running || turnTimer.expired || turnTimer.interval) {
        turnTimer.running = false;
        turnTimer.expired = false;
        stopTimerInterval();
        renderTurnTimerDom();
      }
      return;
    }
    if (!isLocalTimerTurn()) {
      turnTimer.running = false;
      turnTimer.paused = false;
      turnTimer.expired = false;
      turnTimer.remaining = turnTimer.limit;
      stopTimerInterval();
      renderTurnTimerDom();
      return;
    }
    if (isTimerOverlayPaused()) {
      turnTimer.paused = true;
      renderTurnTimerDom();
      return; // 暂停期间不推进
    }
    if (turnTimer.paused) {
      turnTimer.paused = false;
      if (!turnTimer.expired) turnTimer.deadline = timerNow() + turnTimer.remaining * 1000;
    }
    if (turnTimer.expired) {
      renderTurnTimerDom();
      attemptTimeoutEndTurn();
      return;
    }
    if (!turnTimer.running) {
      turnTimer.running = true;
      turnTimer.deadline = timerNow() + turnTimer.remaining * 1000;
    }
    turnTimer.remaining = Math.max(0, (turnTimer.deadline - timerNow()) / 1000);
    var whole = Math.ceil(turnTimer.remaining);
    if (turnTimer.remaining > 0 && turnTimer.remaining <= 5 && whole !== turnTimer.lastTickSound) {
      turnTimer.lastTickSound = whole;
      timerSfx('turn.warning');
    }
    if (turnTimer.remaining <= 0) {
      turnTimer.remaining = 0;
      turnTimer.expired = true;
      turnTimer.running = false;
      if (!turnTimer.timeoutToastShown) {
        turnTimer.timeoutToastShown = true;
        root.PokerUI.toast('⏱ 超时，自动结束回合', 'warn');
        timerSfx('turn.timeout');
      }
      renderTurnTimerDom();
      attemptTimeoutEndTurn();
      return;
    }
    renderTurnTimerDom();
  }

  function onTimerVisibilityChange() {
    if (!root.document) return;
    if (root.document.visibilityState === 'hidden') {
      if (turnTimer.running && !turnTimer.expired) turnTimer.paused = true;
      renderTurnTimerDom();
      return;
    }
    if (turnTimer.paused && !isTimerOverlayPaused()) {
      turnTimer.paused = false;
      if (!turnTimer.expired) turnTimer.deadline = timerNow() + turnTimer.remaining * 1000;
    }
    renderTurnTimerDom();
  }

  /* ================================================================== *
   * 视图模型
   * ================================================================== */
  function makeView() {
    return {
      mode: 'idle',
      selectedHandCardId: null,
      selectedRegionId: null,
      moveSource: null,
      layoutSelection: [],
      layoutSelectedHandCard: null,
      busy: false,
      legalActions: [],
      hintOverride: '',
      trustee: false,
      autoplayDemo: false
    };
  }

  function clearSelections() {
    var v = game.view;
    if (!v) return;
    v.mode = 'idle';
    v.selectedHandCardId = null;
    v.selectedRegionId = null;
    v.moveSource = null;
    v.hintOverride = '';
  }

  function refreshView() {
    if (!game.view) game.view = makeView();
    if (isLan() && game.lan) {
      // processing 只用于 SSE 更新队列防重入，不能参与 UI busy 判定
      var lanBlocked = !lanOpponentOnline() || game.lan.actionPending;
      game.view.busy = game.busy || lanBlocked;
      game.view.lan = lanViewModel();
      game.view.layoutLocked = !!game.lan.layoutSubmitted;
      game.view.trustee = isTrusteeActive(); // v1.7：联机托管同样显示状态
      game.view.autoplayDemo = false;
    } else {
      game.view.busy = game.busy;
      game.view.lan = null;
      game.view.layoutLocked = false;
      game.view.trustee = isTrusteeActive();
      game.view.autoplayDemo = !!game.autoplay;
    }
    if (game.state && game.state.phase === 'battle') {
      try {
        game.view.legalActions = E.getLegalActions(game.state) || [];
      } catch (err) {
        game.view.legalActions = [];
      }
    } else {
      game.view.legalActions = [];
    }
    root.PokerUI.render(game.state, game.view);
    var hand = document.querySelector('[data-testid="hand"]');
    if (hand) hand.scrollLeft = 0;
    syncTimerForState();
    checkStallTransition();
  }

  /* v1.5 防拖延提醒：stallCount 从 0 变 1 时提示一次（第二次就会认输） */
  function checkStallTransition() {
    if (!game.state || !game.state.players) return;
    var st = game.state;
    var names = (st.config && st.config.playerNames) || { p1: '你', p2: '电脑' };
    ['p1', 'p2'].forEach(function (pid) {
      var sc = (st.players[pid] && st.players[pid].stallCount) || 0;
      var prev = game.stallSeen[pid] || 0;
      if (sc > prev && sc === 1) {
        if (pid === 'p1') {
          root.PokerUI.toast('本回合无有效行动：再空过一回合或仅移牌将判负（认输）', 'warn');
        } else {
          root.PokerUI.toast(names.p2 + ' 连续 1 个回合无有效行动（再犯将认输）', 'warn');
        }
      }
      game.stallSeen[pid] = sc;
    });
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */
  function boot() {
    if (!E) {
      var app = document.getElementById('app');
      if (app) {
        app.innerHTML = '<div class="fatal-error"><h1>加载失败</h1><p>规则引擎 js/engine.js 未能加载，请确认文件完整。</p></div>';
      }
      return;
    }
    game.settings = loadSettings();
    game.view = makeView();

    var url = parseUrl();
    game.debug = url.debug;
    game.autoplay = !!url.autoplay;
    // v1.8.1：?lan=1 时即使尚未进房间（仅大厅），也视为 LAN 上下文（设置面板隐藏单机专属 AI 引擎块）
    game.lanPage = !!url.lan;
    // v1.8：?aiengine=heuristic|ml 覆盖本次会话设置（设置面板应用后才持久化）
    if (url.aiengine) game.settings.aiEngine = url.aiengine;
    if (url.timer != null) game.settings.turnTimeLimit = url.timer;
    if (url.music === false) game.settings.musicEnabled = false;
    else if (url.music === true) game.settings.musicEnabled = true;
    if (url.volume != null) game.settings.musicVolume = url.volume;
    if (url.sfx === false) game.settings.sfxEnabled = false;
    else if (url.sfx === true) game.settings.sfxEnabled = true;
    if (url.sfxvol != null) game.settings.sfxVolume = url.sfxvol;
    if (url.hasGameParams) {
      if (url.overrides.animation) game.settings.animation = 'fast';
    }
    // ?autoplay=1 默认快速（同步跑完）；加 &anim=1 则保留标准动画节奏自动演示
    game.animation = game.autoplay ? !!url.anim : (game.settings.animation !== 'fast');

    root.PokerUI.init(uiHandlers);
    root.PokerUI.setAnimationEnabled(game.animation);
    applyDragSetting(game.settings);
    root.PokerUI.setDebug(game.debug);
    root.PokerUI.setAutoplay(game.autoplay);
    applyMusicSettings();
    applySfxSettings();
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', onTimerVisibilityChange, false);
    }
    syncTimerForState();

    var savedLan = net() && net().getSession();
    var resumeRequested = !!savedLan && (!url.lan || (url.room && savedLan.code === url.room));
    if (resumeRequested) {
      root.PokerUI.render(null, game.view);
      game.lanPage = true; // v1.8.1：断线恢复亦属 LAN 上下文
      resumeLanSession(savedLan);
      installDebugApi();
      return;
    }
    if (url.lan) {
      root.PokerUI.render(null, game.view);
      // v1.7：file:// 下无法直接联机 → 先探测本地服务器，成功自动跳转，失败显示一键启动引导
      if (isFileProtocol()) openLanLaunchGuide();
      else openLanLobby({ code: url.room || '' });
      installDebugApi();
      return;
    }

    if (url.hasGameParams) {
      root.PokerUI.render(null, game.view);
      var started = startGame(url.overrides);
      if (started && game.autoplay) {
        startAutoplay();
      } else if (!started) {
        openSettings(true);
      }
    } else {
      root.PokerUI.render(null, game.view);
      openSettings(true);
    }
    installDebugApi();
  }

  function parseUrl() {
    var result = {
      hasGameParams: false,
      overrides: {},
      debug: false,
      autoplay: false,
      anim: false,
      lan: false,
      room: '',
      seed: null,
      music: null,
      volume: null,
      sfx: null,
      sfxvol: null,
      timer: null,
      aiengine: null
    };
    try {
      if (!root.location || !root.location.search) return result;
      var q = new root.URLSearchParams(root.location.search);
      if (q.get('seed') !== null && q.get('seed') !== '') {
        var seed = Number(q.get('seed'));
        if (isFinite(seed)) { result.overrides.seed = seed; result.seed = seed; result.hasGameParams = true; }
      }
      if (q.get('difficulty') !== null && q.get('difficulty') !== '') {
        var diff = Number(q.get('difficulty'));
        if (DIFFICULTY_IDS.indexOf(diff) >= 0) { result.overrides.difficulty = diff; result.hasGameParams = true; }
      }
      if (q.get('regions') !== null && q.get('regions') !== '') {
        var regions = Number(q.get('regions'));
        if (REGION_IDS.indexOf(regions) >= 0) { result.overrides.regionCount = regions; result.hasGameParams = true; }
      }
      if (q.get('first') !== null && q.get('first') !== '') {
        var first = q.get('first');
        if (['random', 'p1', 'p2'].indexOf(first) >= 0) { result.overrides.firstPlayer = first; result.hasGameParams = true; }
      }
      if (q.get('fast') === '1') { result.overrides.animation = 'fast'; result.hasGameParams = true; }
      if (q.get('settle') !== null && q.get('settle') !== '') {
        var settle = Number(q.get('settle'));
        if (settle === 3) settle = 4; // 旧 URL ?settle=3 迁移为 4
        if (SETTLE_IDS.indexOf(settle) >= 0) { result.overrides.settleCards = settle; result.hasGameParams = true; }
      }
      if (q.get('debug') === '1') result.debug = true;
      if (q.get('aiengine') !== null && q.get('aiengine') !== '') {
        var aiEngineParam = String(q.get('aiengine')).toLowerCase();
        if (AI_ENGINES.indexOf(aiEngineParam) >= 0) result.aiengine = aiEngineParam;
      }
      if (q.get('autoplay') === '1') { result.autoplay = true; result.hasGameParams = true; }
      if (q.get('anim') === '1') result.anim = true;
      if (q.get('timer') !== null && q.get('timer') !== '') {
        var timerParam = Number(q.get('timer'));
        if (isSettingsTimerValue(timerParam)) result.timer = timerParam;
      }
      if (q.get('music') !== null) {
        var musicParam = q.get('music');
        if (musicParam === '0' || musicParam === 'off') result.music = false;
        else if (musicParam === '1' || musicParam === 'on') result.music = true;
      }
      if (q.get('volume') !== null && q.get('volume') !== '') {
        var volumeParam = Number(q.get('volume'));
        if (isFinite(volumeParam)) result.volume = Math.max(0, Math.min(100, Math.round(volumeParam)));
      }
      if (q.get('sfx') !== null) {
        var sfxParam = q.get('sfx');
        if (sfxParam === '0' || sfxParam === 'off') result.sfx = false;
        else if (sfxParam === '1' || sfxParam === 'on') result.sfx = true;
      }
      if (q.get('sfxvol') !== null && q.get('sfxvol') !== '') {
        var sfxvolParam = Number(q.get('sfxvol'));
        if (isFinite(sfxvolParam)) result.sfxvol = Math.max(0, Math.min(100, Math.round(sfxvolParam)));
      }
      if (q.get('lan') === '1') result.lan = true;
      if (q.get('room')) {
        var room = String(q.get('room')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
        if (room) { result.room = room; result.lan = true; }
      }
    } catch (err) { /* ignore */ }
    return result;
  }

  /* ================================================================== *
   * UI 回调
   * ================================================================== */
  var uiHandlers = {
    onOpenSettings: function () {
      if (isLan()) {
        root.PokerUI.toast('联机中不可修改单机设置；对局设置由房主创建房间时决定', 'info');
        return;
      }
      openSettings(false);
    },
    onOpenRules: function () { root.PokerUI.showRules(); },
    onCloseRules: function () { root.PokerUI.closeRules(); },
    onStartGame: function (draft) {
      if (isLan()) return;
      applyDraft(draft);
      startGame({});
    },
    onApplySettings: function (draft) {
      applyDraft(draft);
      root.PokerUI.toast('设置已保存', 'success');
    },
    onCancelSettings: function () {
      root.PokerUI.closeSettings();
      // 取消时撤销设置面板内的音乐/音效试听，恢复到已保存设置
      applyMusicSettings();
      applySfxSettings();
      applyDragSetting(game.settings);
      if (!game.state) refreshView();
    },
    onOpenLanLobby: function () {
      // v1.7：file:// 页面点击「局域网联机」→ 探测本地服务器（已启动则自动跳转，否则显示一键启动引导）
      if (isFileProtocol()) {
        openLanLaunchGuide();
        return;
      }
      root.PokerUI.closeSettings();
      applyMusicSettings();
      applySfxSettings();
      openLanLobby({});
    },
    onCloseLanLaunch: function () {
      root.PokerUI.closeLanLaunchGuide();
      if (!game.state && isFileProtocol()) openSettings(true);
    },
    onLanRetryConnect: function () {
      retryLanLaunchGuide();
    },
    onLanCopyCommand: function () {
      try { root.PokerUI.copyText(LAN_LAUNCH_COMMAND); } catch (err) { /* ignore */ }
      root.PokerUI.toast('已复制启动命令：' + LAN_LAUNCH_COMMAND + '（在项目目录运行；或直接双击「启动联机.bat」）', 'info');
    },
    onToggleMusic: function () {
      var s = game.settings || defaultSettings();
      s.musicEnabled = !(s.musicEnabled !== false);
      game.settings = s;
      saveSettings(s);
      applyMusicSettings();
      root.PokerUI.toast('背景音乐已' + (s.musicEnabled ? '开启' : '关闭'), 'info');
    },
    onMusicPreview: function (preview) {
      // 设置面板内即时试听：不写入 localStorage，取消/应用时会重设为正式设置
      var enabled = !preview || preview.enabled !== false;
      var volume = preview && preview.volume != null ? Number(preview.volume) : 30;
      if (!isFinite(volume)) volume = 0;
      volume = Math.max(0, Math.min(100, Math.round(volume)));
      var m = musicEngine();
      if (m && typeof m.configure === 'function') m.configure({ enabled: enabled, volume: volume });
      if (root.PokerUI && typeof root.PokerUI.setMusicState === 'function') {
        root.PokerUI.setMusicState({ enabled: enabled, volume: volume });
      }
    },
    onToggleSfx: function () {
      var s = game.settings || defaultSettings();
      s.sfxEnabled = !(s.sfxEnabled !== false);
      game.settings = s;
      saveSettings(s);
      applySfxSettings();
      root.PokerUI.toast('音效已' + (s.sfxEnabled ? '开启' : '关闭'), 'info');
      if (s.sfxEnabled) playSfx('ui.confirm');
    },
    onSfxPreview: function (preview) {
      // 设置面板内即时试听：不写入 localStorage，取消/应用时会重设为正式设置
      var enabled = !preview || preview.enabled !== false;
      var volume = preview && preview.volume != null ? Number(preview.volume) : 70;
      if (!isFinite(volume)) volume = 0;
      volume = Math.max(0, Math.min(100, Math.round(volume)));
      var sfx = sfxEngine();
      if (sfx && typeof sfx.configure === 'function') sfx.configure({ enabled: enabled, volume: volume });
      if (root.PokerUI && typeof root.PokerUI.setSfxState === 'function') {
        root.PokerUI.setSfxState({ enabled: enabled, volume: volume });
      }
    },
    onDragPreview: function (preview) {
      applyDragSetting({ drag: preview && preview.enabled ? 'on' : 'off' });
    },
    onLanRetryInfo: function () { refreshLanAvailability(); },
    onLanCreate: function (payload) { createLanRoom(payload); },
    onLanJoin: function (payload) { joinLanRoom(payload); },
    onLanCloseLobby: function () {
      root.PokerUI.closeLanLobby();
      game.lanPage = false; // 关闭大厅 = 回到单机上下文
      if (game.state) refreshView();
      else openSettings(true);
    },
    onLanLeave: function () { leaveLanRoom(); },
    onLanRematch: function () { requestRematch(); },
    onLanReturnLobby: function () {
      root.PokerUI.closeRoomClosed();
      openLanLobby({});
    },
    onLanBackSolo: function () {
      root.PokerUI.closeRoomClosed();
      backToSolo();
    },
    onActionClick: handleActionClick,
    onRegionClick: handleRegionClick,
    onHandClick: handleHandClick,
    onLayoutSlotClick: handleLayoutSlotClick,
    onDragDrop: handleDragDrop,
    onConfirmLayout: confirmLayout,
    onClearLayout: clearLayout,
    onToggleAutoplay: function () { setTrustee(!game.trustee); },
    onRestart: restart,
    onKeyDown: handleGlobalKey
  };

  function openSettings(initial) {
    if (!game.state) root.PokerUI.render(null, game.view);
    // v1.8.1：LAN 上下文（大厅/等待房间/对局）不显示单机专属的「困难档 AI 引擎」设置块
    root.PokerUI.showSettings(game.settings, {
      initial: !!initial,
      lanMode: isLan() || !!game.lanPage
    });
  }

  function applyDraft(draft) {
    if (!draft) return;
    game.settings = normalizeSettings(draft);
    game.animation = game.settings.animation !== 'fast';
    root.PokerUI.setAnimationEnabled(game.animation);
    applyDragSetting(game.settings);
    saveSettings(game.settings);
    applyMusicSettings();
    applySfxSettings();
    // 当前对局同步新的回合时限（引擎只在创建时保存该配置，这里仅更新 UI 计时用的字段）
    if (game.state && game.state.config && game.state.phase !== 'gameover') {
      game.state.config.turnTimeLimit = game.settings.turnTimeLimit;
      syncTimerForState();
    }
  }

  /* ================================================================== *
   * 开新对局
   * ================================================================== */
  function clearAiTimer() {
    if (game.aiTimer) {
      clearTimeout(game.aiTimer);
      game.aiTimer = null;
    }
  }

  function startGame(overrides) {
    if (isLan()) {
      root.PokerUI.toast('联机中请先离开房间，再开始单机对局', 'warn');
      return null;
    }
    clearAiTimer();
    game.busy = false;
    game.autoplayRunning = false;
    // v1.6：新开一局/再来一局默认关闭托管（不持久化）
    if (game.trustee) disableTrustee(true);
    var rawOverrides = overrides && typeof overrides === 'object' ? overrides : {};
    var cfgOverrides = {};
    for (var okey in rawOverrides) {
      if (Object.prototype.hasOwnProperty.call(rawOverrides, okey)) cfgOverrides[okey] = rawOverrides[okey];
    }
    // v1.8：aiEngine 属于控制器设置而非引擎配置；startGame 覆盖仅对本次对局生效（不自动持久化）
    if (rawOverrides.aiEngine != null) {
      game.settings.aiEngine = normalizeAiEngine(rawOverrides.aiEngine);
      delete cfgOverrides.aiEngine;
    }
    // debug/URL 开局覆盖电脑强度时同步到控制器设置，保证困难档 AI 引擎判断与之一致
    if (rawOverrides.aiStrength != null) {
      game.settings.aiStrength = normalizeAiStrength(rawOverrides.aiStrength);
    }
    /* v2.18：困难档已启用（交付 PPO H192 gen436）；仅当模块缺失时安全回退中等档。 */
    if (game.settings.aiStrength === 'hard' &&
        !(root.PokerAIPureHard && typeof root.PokerAIPureHard.createPolicy === 'function')) {
      game.settings.aiStrength = 'medium';
      try {
        root.PokerUI.toast('困难 AI 模块缺失，已使用中等 AI', 'warn');
      } catch (errHard) { /* toast 不可用时静默 */ }
    }
    // 每局重置 ML 使用统计（策略单例缓存保留）
    mlStats = { decisions: 0, mlChoices: 0, heuristicChoices: 0, mlFallbacks: 0, apSpendGuard: 0, lastGate: '' };
    // debug 覆盖：2 秒等非引擎合法值只用于 UI 计时，不透传给引擎
    if (rawOverrides.turnTimeLimit != null) {
      turnTimer.override = normalizeTimerOverride(rawOverrides.turnTimeLimit);
      if (!isEngineTimerValue(rawOverrides.turnTimeLimit)) delete cfgOverrides.turnTimeLimit;
    }
    var cfg;
    try {
      cfg = buildConfig(cfgOverrides);
    } catch (err) {
      root.PokerUI.toast('配置读取失败', 'error');
      return null;
    }
    var validation = E.validateConfig(cfg);
    if (!validation.ok) {
      root.PokerUI.toast(validation.errors[0] || '配置不可用', 'error');
      return null;
    }
    var st;
    try {
      st = E.createGame(cfg);
    } catch (err) {
      root.PokerUI.toast(err && err.message ? err.message : '创建对局失败', 'error');
      return null;
    }
    game.state = st;
    game.view = makeView();
    game.view.layoutSelection = new Array(st.config.regionCount).fill(null);
    game.busy = false;
    game.aiLayoutIds = null;
    root.PokerUI.closeAllOverlays();
    refreshView();
    // 开局动作通常来自点击（用户手势），补一次播放尝试；失败静默
    var music = musicEngine();
    if (music && typeof music.play === 'function') music.play();
    return st;
  }

  function restart() {
    if (isLan()) return;
    root.PokerUI.closeAllOverlays();
    startGame({});
  }

  /* ================================================================== *
   * 自动演示（?autoplay=1；与 PokerDebug.autoPlayToEnd 同一实现）
   * ================================================================== */
  function startAutoplay() {
    if (!game.state) return;
    if (!game.animation) {
      setTimeout(function () { autoPlayToEnd(); }, 140);
      return;
    }
    game.autoplayRunning = true;
    if (game.state.phase === 'layout') autoplayLayoutThenBattle();
    else stepAutoplay();
  }

  function autoplayLayoutThenBattle() {
    var st = game.state;
    if (!st) return;
    var R = st.config.regionCount;
    try {
      E.submitLayout(st, 'p1', chooseAiLayout(st, 'p1'));
      E.submitLayout(st, 'p2', chooseAiLayout(st, 'p2'));
      var events = E.finalizeLayout(st);
      game.view.layoutSelection = new Array(R).fill(null);
      refreshView();
      playLayoutSfx(events);
      var tail = events.filter(function (ev) {
        return ev.type === 'endgame_start' || ev.type === 'endgame_settle' || ev.type === 'game_over';
      });
      root.PokerUI.playLayoutReveal(events).then(function () {
        return playEvents(tail);
      }).then(function () {
        if (!st || st.phase === 'gameover') { game.autoplayRunning = false; return; }
        stepAutoplay();
      });
    } catch (err) {
      game.autoplayRunning = false;
      root.PokerUI.toast('自动演示布阵失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    }
  }

  function stepAutoplay() {
    if (!game.autoplayRunning) return;
    if (!game.state || game.state.phase === 'gameover') { game.autoplayRunning = false; return; }
    if (game.state.phase === 'layout') { autoplayLayoutThenBattle(); return; }
    if (game.busy) { setTimeout(stepAutoplay, 150); return; }
    var action = chooseAiAction(game.state, game.state.turn);
    if (!action) { game.autoplayRunning = false; return; }
    commitAction(action);
    setTimeout(stepAutoplay, 320);
  }

  /* ================================================================== *
   * v1.6 托管：由简单 AI 代打本地玩家（仅单机；与 ?autoplay=1 调试演示相互独立）
   * ================================================================== */
  function isTrusteeActive() {
    return !!game.trustee && !(game.autoplay && !isLan()) && !game.autoplayRunning;
  }

  function clearTrusteeTimer() {
    if (game.trusteeTimer) {
      clearTimeout(game.trusteeTimer);
      game.trusteeTimer = null;
    }
  }

  function trusteePausedNow() {
    if (root.document && root.document.visibilityState === 'hidden') return true;
    if (root.PokerUI && typeof root.PokerUI.isTimerOverlayOpen === 'function') {
      try { return !!root.PokerUI.isTimerOverlayOpen(); } catch (err) { return false; }
    }
    return false;
  }

  /* 供 PokerDebug / UI 查询的托管状态 */
  function trusteeState() {
    var st = game.state;
    var btn = null;
    try {
      if (root.document) btn = root.document.querySelector('[data-testid="btn-autoplay"]');
    } catch (err) { btn = null; }
    return {
      enabled: !!game.trustee,
      active: isTrusteeActive(),
      aiStrength: 'easy',
      phase: st ? st.phase : null,
      turn: st ? (st.turn || null) : null,
      busy: !!game.busy,
      pending: !!game.trusteeTimer,
      paused: isTrusteeActive() ? trusteePausedNow() : false,
      pauseReason: game.trusteePauseReason || '',
      lan: isLan(),
      banner: !!(game.view && game.view.trustee),
      button: btn ? {
        hidden: !!btn.hidden,
        text: String(btn.textContent || '').trim(),
        pressed: btn.getAttribute('aria-pressed')
      } : null
    };
  }

  function setTrusteePauseReason(reason) {
    game.trusteePauseReason = reason || '';
  }

  /* 安全关闭托管（silent 时不 toast；用于终局/重开/LAN/异常退出） */
  function disableTrustee(silent) {
    var was = !!game.trustee;
    game.trustee = false;
    game.trusteeStall = 0;
    game.trusteeOverlayWasOpen = false;
    game.trusteePauseReason = '';
    game.trusteeLanOfflineNotified = false;
    game.trusteeFailCount = 0;
    clearTrusteeTimer();
    if (game.view) game.view.trustee = false;
    if (root.document && root.document.body) root.document.body.classList.remove('is-trustee');
    if (game.view) refreshView();
    syncTimerForState();
    if (was && !silent) root.PokerUI.toast('已取消托管，恢复手动操作', 'info');
  }

  function setTrustee(enabled, opts) {
    var on = !!enabled;
    var silent = !!(opts && opts.silent);
    if (game.autoplay || game.autoplayRunning) {
      if (on && !silent) root.PokerUI.toast('自动演示模式下不可使用托管', 'warn');
      return trusteeState();
    }
    if (!on) {
      if (game.trustee) disableTrustee(silent);
      return trusteeState();
    }
    if (game.trustee) return trusteeState();
    if (!game.state || game.state.phase === 'gameover') {
      if (!silent) root.PokerUI.toast('当前没有可托管的对局', 'info');
      return trusteeState();
    }
    if (isLan() && (!game.lan || game.lan.connection === 'offline')) {
      if (!silent) root.PokerUI.toast('联机状态异常，暂不能开启托管', 'warn');
      return trusteeState();
    }
    game.trustee = true;
    game.trusteeStall = 0;
    game.trusteeFailCount = 0;
    game.trusteePauseReason = '';
    clearTrusteeTimer();
    clearSelections();
    if (!silent) {
      root.PokerUI.toast(isLan()
        ? '已开启托管：简单 AI 代打（联机），点「取消托管」接管'
        : '已开启托管：简单 AI 代打，点「取消托管」接管', 'info');
    }
    syncTimerForState();
    refreshView();
    scheduleTrusteeStep(180);
    return trusteeState();
  }

  function scheduleTrusteeStep(delayMs) {
    clearTrusteeTimer();
    if (!game.trustee) return;
    var delay = delayMs != null ? Math.max(0, Number(delayMs) || 0)
      : (game.animation ? 380 : 90);
    game.trusteeTimer = setTimeout(function () {
      game.trusteeTimer = null;
      trusteeStep();
    }, delay);
  }

  function trusteeStep() {
    if (!isTrusteeActive()) {
      if (game.trustee) disableTrustee(true);
      return;
    }
    var st = game.state;
    if (!st || st.phase === 'gameover') { disableTrustee(true); return; }
    if (trusteePausedNow()) {
      // 页面隐藏 / 弹层打开：暂停调度，恢复后继续（同一时刻只有一个托管定时器）
      game.trusteeOverlayWasOpen = true;
      scheduleTrusteeStep(320);
      return;
    }
    if (game.trusteeOverlayWasOpen) {
      game.trusteeOverlayWasOpen = false;
      game.trusteeStall = 0;
    }
    if (st.phase === 'layout') {
      if (game.busy) { scheduleTrusteeStep(140); return; }
      if (isLan()) { lanTrusteeLayout(); return; }
      autoLayoutByTrustee();
      return;
    }
    if (st.phase !== 'battle') { scheduleTrusteeStep(320); return; }
    if (isLan()) { lanTrusteeBattleStep(); return; }
    if (game.busy || (game.view && game.view.busy)) {
      game.trusteeStall++;
      if (game.trusteeStall > 90) {
        root.PokerUI.toast('托管等待超时，已自动取消托管', 'warn');
        disableTrustee(true);
        return;
      }
      scheduleTrusteeStep(game.animation ? 180 : 60);
      return;
    }
    if (st.turn !== 'p1') {
      game.trusteeStall++;
      if (st.turn === 'p2' && !game.aiTimer && !game.busy && game.trusteeStall % 6 === 2) {
        // 对手 AI 调度丢失时补一次调度，避免托管永远等待
        scheduleAI();
      }
      if (game.trusteeStall > 90) {
        root.PokerUI.toast('托管等待对手超时，已自动取消托管', 'warn');
        disableTrustee(true);
        return;
      }
      scheduleTrusteeStep(game.animation ? 240 : 120);
      return;
    }
    game.trusteeStall = 0;
    if (st.endgame && st.endgame.phase === 'showdown') { scheduleTrusteeStep(260); return; }
    trusteeAct();
  }

  /* v1.7 联机托管：对手掉线/重连中暂停（恢复后自动继续） */
  function lanTrusteeOpponentPaused() {
    if (!game.lan) return false;
    if (lanOpponentOnline()) {
      if (game.trusteeLanOfflineNotified) {
        game.trusteeLanOfflineNotified = false;
        root.PokerUI.toast('对手已重连，托管继续', 'info');
      }
      return false;
    }
    if (!game.trusteeLanOfflineNotified) {
      game.trusteeLanOfflineNotified = true;
      root.PokerUI.toast('对手已断开，托管已暂停，等待重连…', 'warn');
    }
    setTrusteePauseReason('opponent-offline');
    return true;
  }

  function lanTrusteeStallTooLong() {
    game.trusteeStall++;
    if (game.trusteeStall > 140) {
      root.PokerUI.toast('托管等待超时，已自动取消托管', 'warn');
      disableTrustee(true);
      return true;
    }
    return false;
  }

  /* v1.7 LAN 托管布阵：easy AI 选牌后走既有 confirmLanLayout（网络提交 + 等服务器揭示） */
  function lanTrusteeLayout() {
    if (!game.lan) { disableTrustee(true); return; }
    if (lanTrusteeOpponentPaused()) { scheduleTrusteeStep(600); return; }
    if (game.lan.layoutSubmitted) {
      setTrusteePauseReason('waiting-reveal');
      scheduleTrusteeStep(300);
      return;
    }
    if (game.lan.actionPending) {
      setTrusteePauseReason('waiting-server');
      if (lanTrusteeStallTooLong()) return;
      scheduleTrusteeStep(200);
      return;
    }
    var st = game.state;
    if (!st || st.phase !== 'layout') { scheduleTrusteeStep(250); return; }
    setTrusteePauseReason('');
    game.trusteeStall = 0;
    var ids = [];
    try { ids = chooseAiLayout(st, 'p1', 'easy'); } catch (err) { ids = []; }
    if (!Array.isArray(ids) || ids.length !== st.config.regionCount) {
      root.PokerUI.toast('托管自动布阵失败，已自动取消托管', 'error');
      disableTrustee(true);
      return;
    }
    game.view.layoutSelection = ids.slice();
    game.view.layoutSelectedHandCard = null;
    confirmLanLayout();
    if (!game.lan.actionPending) {
      game.trusteeFailCount++;
      if (game.trusteeFailCount > 6) {
        root.PokerUI.toast('托管自动布阵提交失败，已自动取消托管', 'warn');
        disableTrustee(true);
        return;
      }
    } else {
      game.trusteeFailCount = 0;
    }
    scheduleTrusteeStep(320);
  }

  /* v1.7 LAN 托管行动：等 actionPending/processing 结束（SSE 更新渲染完成）后再决策下一步 */
  function lanTrusteeBattleStep() {
    if (!game.lan) { disableTrustee(true); return; }
    if (lanTrusteeOpponentPaused()) { scheduleTrusteeStep(600); return; }
    if (game.lan.actionPending || game.lan.processing || game.busy) {
      setTrusteePauseReason(game.lan.actionPending ? 'waiting-server' : 'rendering');
      if (lanTrusteeStallTooLong()) return;
      scheduleTrusteeStep(game.animation ? 180 : 80);
      return;
    }
    var st = game.state;
    if (!st || st.phase !== 'battle') { scheduleTrusteeStep(260); return; }
    setTrusteePauseReason('');
    game.trusteeStall = 0;
    if (st.turn !== 'p1') {
      setTrusteePauseReason('not-local-turn');
      scheduleTrusteeStep(220);
      return;
    }
    if (st.endgame && st.endgame.phase === 'showdown') { scheduleTrusteeStep(260); return; }
    trusteeAct();
  }

  function trusteeAct() {
    var st = game.state;
    if (!st || st.phase !== 'battle' || st.turn !== 'p1' || game.busy) {
      scheduleTrusteeStep(120);
      return;
    }
    clearSelections();
    var action = null;
    try {
      action = chooseAiAction(st, 'p1', 'easy');
    } catch (err) {
      action = null;
    }
    if (!action) {
      // 防御：正常引擎至少有 end_turn；AI 异常时回退到首个合法行动，避免卡死
      var legal = [];
      try { legal = E.getLegalActions(st) || []; } catch (err2) { legal = []; }
      action = legal.length ? legal[0] : null;
    }
    if (!action) {
      root.PokerUI.toast('托管无法继续（没有合法行动），已自动取消托管', 'warn');
      disableTrustee(true);
      return;
    }
    try {
      commitAction(action);
    } catch (err3) {
      root.PokerUI.toast('托管执行异常，已自动取消托管', 'error');
      disableTrustee(true);
      return;
    }
    if (isLan() && game.lan) {
      // commitAction→commitLanAction 同步置 actionPending；若被拒（离线/忙/非本地回合计）计数防死循环
      if (!game.lan.actionPending && !game.lan.processing) {
        game.trusteeFailCount++;
        if (game.trusteeFailCount > 8) {
          root.PokerUI.toast('托管提交连续失败，已自动取消托管', 'warn');
          disableTrustee(true);
          return;
        }
      } else {
        game.trusteeFailCount = 0;
      }
    }
    scheduleTrusteeStep(game.animation ? 520 : 90);
  }

  function autoLayoutByTrustee() {
    var st = game.state;
    if (!st || st.phase !== 'layout') { scheduleTrusteeStep(200); return; }
    var R = st.config.regionCount;
    game.busy = true;
    var events;
    try {
      var ids = chooseAiLayout(st, 'p1', 'easy');
      if (!Array.isArray(ids) || ids.length !== R) throw new Error('托管布阵结果不可用');
      E.submitLayout(st, 'p1', ids);
      E.submitLayout(st, 'p2', chooseAiLayout(st, 'p2'));
      events = E.finalizeLayout(st);
    } catch (err) {
      game.busy = false;
      root.PokerUI.toast('托管自动布阵失败，已自动取消托管', 'error');
      disableTrustee(true);
      return;
    }
    game.view.layoutSelection = new Array(R).fill(null);
    game.view.layoutSelectedHandCard = null;
    syncTimerForState(events);
    refreshView();
    playLayoutSfx(events);
    var tail = events.filter(function (ev) {
      return ev.type === 'endgame_start' || ev.type === 'endgame_settle' || ev.type === 'game_over';
    });
    root.PokerUI.playLayoutReveal(events).then(function () {
      return playEvents(tail);
    }).then(function () {
      game.busy = false;
      refreshView();
      if (game.state && game.state.phase === 'battle' && game.state.turn === 'p2') scheduleAI();
      scheduleTrusteeStep(game.animation ? 420 : 120);
    });
  }

  /* ================================================================== *
   * AI 适配
   * ================================================================== */
  function chooseAiLayout(st, pid, strengthOverride) {
    var R = st.config.regionCount;
    var hand = st.players[pid].hand;
    var fallback = hand.slice(0, R).map(function (c) { return c.id; });
    var ai = root.PokerAI;
    if (!ai || typeof ai.chooseLayout !== 'function') return fallback;
    try {
      var tier = strengthOverride || game.settings.aiStrength;
      /* 布局使用档位对应的启发式强度（简单=稳健；中等/困难回退=最强） */
      var ids = ai.chooseLayout(st, pid, { strength: effectiveHeuristicStrength(tier) });
      if (!Array.isArray(ids) || ids.length !== R) return fallback;
      var handIds = hand.map(function (c) { return c.id; });
      var seen = {};
      for (var i = 0; i < ids.length; i++) {
        if (seen[ids[i]] || handIds.indexOf(ids[i]) < 0) return fallback;
        seen[ids[i]] = true;
      }
      return ids;
    } catch (err) {
      return fallback;
    }
  }

  function isActionLegal(action, legal) {
    if (!action || typeof action !== 'object' || !action.type) return false;
    for (var i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (a.type !== action.type) continue;
      if (a.type === 'draw' || a.type === 'end_turn') return true;
      if (a.type === 'settle') { if (a.regionId === action.regionId) return true; continue; }
      if (a.type === 'flip' || a.type === 'place') {
        if (a.regionId === action.regionId && a.cardId === action.cardId) return true;
        continue;
      }
      if (a.type === 'move') {
        if (a.fromRegionId === action.fromRegionId && a.cardId === action.cardId && a.toRegionId === action.toRegionId) return true;
        continue;
      }
      return true;
    }
    return false;
  }

  function chooseAiActionRaw(st, pid, strengthOverride) {
    var legal = E.getLegalActions(st);
    if (!legal.length) return null;
    var fallback = legal[0];
    var tier = strengthOverride || game.settings.aiStrength;
    mlStats.decisions++;
    /* v2.18：简单档 = gen60 H96；中等档 = gen241 H128；困难档 = 交付 PPO H192 gen436。
       仅在单机且 engine=ml 时启用；模块缺失/返回非法时安全回退启发式。 */
    mlStats.lastGate = '';
    if (!isLan() && currentAiEngine() === 'ml') {
      var pureKind = tier === 'easy' ? 'simple' : (tier === 'hard' ? 'hard' : (tier === 'medium' ? 'medium' : null));
      if (pureKind) {
        try {
          var purePolicy = getPureLearnPolicy(pureKind);
          if (purePolicy) {
            var pureAction = purePolicy.chooseAction(st, pid, { strength: 'hard' });
            if (isActionLegal(pureAction, legal)) {
              mlStats.mlChoices++;
              return pureAction;
            }
            mlStats.mlFallbacks++;
            warnMlOnce('illegal-pure-' + pureKind, new Error('纯学习策略返回非法行动：' + JSON.stringify(pureAction)));
          } else {
            mlStats.mlFallbacks++;
            mlStats.lastGate = 'pure-' + pureKind + '-unavailable';
          }
        } catch (errPure) {
          mlStats.mlFallbacks++;
          warnMlOnce('pure-' + pureKind, errPure);
        }
      }
    }
    var ai = root.PokerAI;
    if (!ai || typeof ai.chooseAction !== 'function') return fallback;
    try {
      var action = ai.chooseAction(st, pid, { strength: effectiveHeuristicStrength(tier) });
      if (isActionLegal(action, legal)) {
        mlStats.heuristicChoices++;
        return action;
      }
    } catch (err2) {
      /* 回退到第一个合法行动，避免把 AI 异常暴露给玩家 */
      warnMlOnce('heuristic', err2);
    }
    return fallback;
  }

  /* ================================================================== *
   * v2.17：战略决战行动点上限规则下的产品 AI guard
   * 引擎规则（config.endgameApCapRule 默认 true）：build 阶段结束回合时行动点未花完 → 之后回合
   * 行动点上限 -1；用尽 → +1（≤3）；上限降到 0 → 判负（forfeitReason='ap-cap-zero'）。
   * 旧 AI 在 build 阶段常在还有合法动作时主动 end_turn，会连续 -1 直至判负；产品侧加 guard：
   * 若处于 build 阶段、AI 决策为 end_turn、且仍有可花费行动点的非 end_turn 合法动作 → 改为启发式最优
   * 非 end_turn 动作（必要时取第一个合法非 end_turn 动作）。guard 只作用于产品 AI 决策；
   * 研究/评估脚本不启用（口径差异记录在 Phase17 报告）。
   * ================================================================== */
  function isEndgameBuildState(st) {
    return !!(st && st.endgame && st.endgame.triggered && st.endgame.phase === 'build');
  }

  function apSpendGuard(st, pid, action) {
    if (!st || !st.config || st.config.endgameApCapRule === false) return action;
    if (!isEndgameBuildState(st)) return action;
    if (!action || action.type !== 'end_turn') return action;
    var player = st.players && st.players[pid];
    var ap = player && player.ap != null ? Number(player.ap) : 0;
    if (!isFinite(ap) || ap <= 0) return action;
    var legal = E.getLegalActions(st);
    var nonEnd = [];
    for (var i = 0; i < legal.length; i++) { if (legal[i].type !== 'end_turn') nonEnd.push(legal[i]); }
    if (!nonEnd.length) return action;
    try {
      var ai = root.PokerAI;
      if (ai && typeof ai.chooseAction === 'function') {
        var guess = ai.chooseAction(st, pid, { strength: 'hard' });
        if (guess && guess.type !== 'end_turn' && isActionLegal(guess, nonEnd)) {
          mlStats.apSpendGuard++;
          return guess;
        }
      }
    } catch (errGuard) { /* 安全回退到第一个非 end_turn 动作 */ }
    mlStats.apSpendGuard++;
    return nonEnd[0];
  }

  function chooseAiAction(st, pid, strengthOverride) {
    return apSpendGuard(st, pid, chooseAiActionRaw(st, pid, strengthOverride));
  }

  /* ================================================================== *
   * 布局阶段交互
   * ================================================================== */
  function handleHandClick(cardId) {
    if (!game.state || game.busy) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地操作
    if (isLan() && game.state.phase === 'layout') {
      if (game.lan.layoutSubmitted) { root.PokerUI.toast('已提交布阵，等待对手布阵…', 'info'); return; }
      if (!lanOpponentOnline()) { root.PokerUI.toast('对手已断开，等待重连…', 'warn'); return; }
    }
    if (game.state.phase === 'layout') {
      var usedSlot = game.view.layoutSelection.indexOf(cardId);
      if (usedSlot >= 0) {
        root.PokerUI.toast('该牌已放入区域 ' + (usedSlot + 1) + '，点击槽位可取回', 'warn');
        return;
      }
      if (game.view.layoutSelectedHandCard === cardId) game.view.layoutSelectedHandCard = null;
      else game.view.layoutSelectedHandCard = cardId;
      refreshView();
      return;
    }
    if (game.state.phase !== 'battle' || game.state.turn !== 'p1') return;
    if (game.view.mode === 'place') {
      if (game.view.selectedHandCardId === cardId) {
        game.view.selectedHandCardId = null;
      } else {
        game.view.selectedHandCardId = cardId;
        if (game.view.selectedRegionId != null) {
          var rid = game.view.selectedRegionId;
          var target = findLegal('place', { regionId: rid, cardId: cardId });
          if (target) { commitAction(target); return; }
        }
      }
      refreshView();
      return;
    }
    if (game.view.mode === 'idle') {
      root.PokerUI.toast('请先选择一项行动（快捷键 1-5）', 'info');
    }
  }

  function handleLayoutSlotClick(index) {
    if (!game.state || game.state.phase !== 'layout' || game.busy) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地操作
    if (isLan()) {
      if (game.lan.layoutSubmitted) { root.PokerUI.toast('已提交布阵，等待对手布阵…', 'info'); return; }
      if (!lanOpponentOnline()) { root.PokerUI.toast('对手已断开，等待重连…', 'warn'); return; }
    }
    var sel = game.view.layoutSelection;
    if (index < 0 || index >= sel.length) return;
    if (sel[index]) {
      sel[index] = null;
      game.view.layoutSelectedHandCard = null;
      refreshView();
      return;
    }
    var cardId = game.view.layoutSelectedHandCard;
    if (!cardId) {
      root.PokerUI.toast('请先点击一张手牌，再点击区域槽位', 'info');
      return;
    }
    if (sel.indexOf(cardId) >= 0) {
      root.PokerUI.toast('该牌已放入其他区域', 'warn');
      return;
    }
    sel[index] = cardId;
    game.view.layoutSelectedHandCard = null;
    refreshView();
  }

  /* v1.6：拖动落点非法时的明确原因（AP 不足 / 区域已结算 / 决战阶段 / 无合法目标） */
  function dragDropInvalidReason(type, regionId) {
    var st = game.state;
    if (!st) return '当前无法操作';
    var eg = st.endgame;
    var egp = eg ? (eg.phase || (eg.triggered ? 'build' : '')) : '';
    if (egp === 'showdown' || egp === 'done') return '战略决战最终结算中，暂不可操作';
    var costs = E.ACTION_COSTS || {};
    var cost = costs[type] != null ? costs[type] : (type === 'flip' ? 2 : 1);
    var ap = ownAp();
    if (cost > ap) {
      var verb = type === 'flip' ? '翻牌' : type === 'move' ? '移牌' : '放牌';
      return verb + '需要 ' + cost + ' 点行动点（当前 ' + ap + ' 点）';
    }
    var region = st.regions && st.regions[regionId];
    if (region && region.status !== 'open') {
      if (type === 'flip') return '该区域已结算，无法翻牌';
      if (type === 'move') return '目标区域已结算，无法移牌';
      return '该区域已结算，无法放牌';
    }
    if (type === 'flip') return '该牌当前不可翻开';
    if (type === 'move') return '无法移动到该区域';
    return '无法放入该区域';
  }

  /* v1.5 拖动落点处理（UI 层负责指针拖拽，main 负责规则校验与提交）
   * v1.6：我方背面牌落点分流 —— 拖回源区域 = 翻开（flip，2 AP）；拖到其他开放区域 = 移牌（move，1 AP） */
  function handleDragDrop(info) {
    if (!info || !game.state || game.busy) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地拖拽
    var st = game.state;
    if (st.phase === 'layout') {
      if (isLan()) {
        if (game.lan.layoutSubmitted) { root.PokerUI.toast('已提交布阵，等待对手布阵…', 'info'); return; }
        if (!lanOpponentOnline()) { root.PokerUI.toast('对手已断开，等待重连…', 'warn'); return; }
      }
      if (info.kind === 'slot' && info.target && info.target.type === 'hand') {
        handleLayoutSlotClick(info.slotIndex);
        return;
      }
      if (info.kind === 'hand' && info.target && info.target.type === 'slot') {
        game.view.layoutSelectedHandCard = info.cardId;
        handleLayoutSlotClick(info.target.index);
        return;
      }
      return;
    }
    if (st.phase !== 'battle' || st.turn !== 'p1') return;
    var target = info.target || {};
    if (target.type !== 'region') return;
    var rid = Number(target.regionId);
    if (info.kind === 'hand') {
      if (!findLegal('place', { regionId: rid, cardId: info.cardId })) {
        playSfx('ui.error');
        root.PokerUI.toast(dragDropInvalidReason('place', rid), 'warn');
        return;
      }
      commitAction({ type: 'place', regionId: rid, cardId: info.cardId });
      return;
    }
    if (info.kind === 'back') {
      var fromRid = info.regionId != null ? Number(info.regionId) : null;
      if (fromRid == null) {
        playSfx('ui.error');
        root.PokerUI.toast('无法确定这张背面牌所在区域，请刷新后重试', 'warn');
        return;
      }
      if (rid === fromRid) {
        // 拖回源区域 = 翻开（flip，2 AP；引擎只允许翻开自己区域内的背面牌）
        if (!findLegal('flip', { regionId: fromRid, cardId: info.cardId })) {
          playSfx('ui.error');
          root.PokerUI.toast(dragDropInvalidReason('flip', fromRid), 'warn');
          return;
        }
        commitAction({ type: 'flip', regionId: fromRid, cardId: info.cardId });
        return;
      }
      // 拖到其他区域 = 移牌（move，1 AP；不能移动到同一个区域）
      if (!findLegal('move', { cardId: info.cardId, toRegionId: rid })) {
        playSfx('ui.error');
        root.PokerUI.toast(dragDropInvalidReason('move', rid), 'warn');
        return;
      }
      commitAction({ type: 'move', fromRegionId: fromRid, cardId: info.cardId, toRegionId: rid });
    }
  }

  function clearLayout() {    if (!game.state || game.state.phase !== 'layout' || game.busy) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地操作
    if (isLan() && game.lan.layoutSubmitted) return;
    game.view.layoutSelection = new Array(game.state.config.regionCount).fill(null);
    game.view.layoutSelectedHandCard = null;
    refreshView();
  }

  function confirmLayout() {
    if (isTrusteeActive()) return; // v1.6/v1.7 托管期间由自动布阵接管（含联机）
    if (isLan()) return confirmLanLayout();
    if (!game.state || game.state.phase !== 'layout' || game.busy) return;
    var R = game.state.config.regionCount;
    var sel = game.view.layoutSelection;
    var ids = [];
    for (var i = 0; i < R; i++) {
      if (!sel[i]) {
        var count = sel.filter(Boolean).length;
        root.PokerUI.toast('请为每个区域各选择一张牌（当前 ' + count + '/' + R + '）', 'warn');
        return;
      }
      ids.push(sel[i]);
    }
    game.busy = true;
    var events;
    try {
      // 顺序按 Lead 约定：人类先提交，AI 再 chooseLayout + 提交，最后揭示（AI 公平性由 AI 自身保证）
      E.submitLayout(game.state, 'p1', ids);
      var aiIds = chooseAiLayout(game.state, 'p2');
      E.submitLayout(game.state, 'p2', aiIds);
      events = E.finalizeLayout(game.state);
    } catch (err) {
      game.busy = false;
      root.PokerUI.toast(err && err.message ? err.message : '布阵失败', 'error');
      refreshView();
      return;
    }
    game.view.layoutSelection = new Array(R).fill(null);
    game.view.layoutSelectedHandCard = null;
    syncTimerForState(events);
    refreshView();
    playLayoutSfx(events);

    var tailEvents = events.filter(function (ev) {
      return ev.type === 'endgame_start' || ev.type === 'endgame_settle' || ev.type === 'game_over';
    });
    root.PokerUI.playLayoutReveal(events).then(function () {
      return playEvents(tailEvents);
    }).then(function () {
      game.busy = false;
      refreshView();
      if (game.state.phase === 'battle' && game.state.turn === 'p2') scheduleAI();
    });
  }

  /* ================================================================== *
   * 战役交互
   * ================================================================== */
  function findLegal(type, match) {
    if (!game.state || game.state.phase !== 'battle') return null;
    var legal = E.getLegalActions(game.state);
    for (var i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (a.type !== type) continue;
      var ok = true;
      for (var key in match) {
        if (Object.prototype.hasOwnProperty.call(match, key) && a[key] !== match[key]) { ok = false; break; }
      }
      if (ok) return a;
    }
    return null;
  }

  function handleActionClick(type) {
    if (!game.state || game.busy) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地操作
    if (game.state.phase !== 'battle' || game.state.turn !== 'p1') {
      if (game.state.phase === 'layout') root.PokerUI.toast('战前布局阶段：请先完成布阵', 'info');
      return;
    }
    var legal = E.getLegalActions(game.state);
    var has = false;
    for (var i = 0; i < legal.length; i++) if (legal[i].type === type) { has = true; break; }
    if (!has) {
      playSfx('ui.error');
      root.PokerUI.toast(actionUnavailableReason(type), 'warn');
      return;
    }
    // v1.4：结束回合（0 点）——不进入选择目标模式，直接提交
    if (type === 'end_turn') {
      if (game.view.mode !== 'idle') { clearSelections(); refreshView(); }
      commitAction({ type: 'end_turn' });
      return;
    }
    if (game.view.mode === type) {
      cancelMode();
      return;
    }
    clearSelections();
    game.view.mode = type;
    if (type === 'draw') {
      commitAction({ type: 'draw' });
      return;
    }
    refreshView();
  }

  function ownAp() {
    if (!game.state || !game.state.players || !game.state.players.p1) return 0;
    var ap = Number(game.state.players.p1.ap);
    return isFinite(ap) ? ap : 0;
  }

  function actionUnavailableReason(type) {
    var eg = game.state && game.state.endgame;
    var egp = eg ? (eg.phase || (eg.triggered ? 'build' : '')) : '';
    if (egp === 'build') {
      if (type === 'settle') return '战略决战·最终部署阶段：结算已禁用，只能翻牌 / 放牌 / 移牌';
      if (type === 'draw') return '战略决战·最终部署阶段：摸牌已禁用（牌堆已摸空）';
    }
    if (egp === 'showdown') return '战略决战最终结算中…';
    var costs = E.ACTION_COSTS || {};
    var cost = costs[type];
    if (type !== 'end_turn' && cost != null && cost > ownAp()) {
      return '行动点不足（需要 ' + cost + ' 点，当前 ' + ownAp() + ' 点）';
    }
    switch (type) {
      case 'settle': {
        var open = E.getOpenRegionIds(game.state).length;
        if (!open) return '没有未结算区域';
        var need = 2 * game.state.config.settleCards;
        if (game.state.deck.length < need) return '牌堆不足（结算需 ≥ ' + need + ' 张）';
        return '暂无可结算区域';
      }
      case 'flip': return '我方没有背面朝上的牌';
      case 'place': return E.getOpenRegionIds(game.state).length ? '手牌为空' : '没有未结算区域';
      case 'move': return '没有可移动的背面牌或其他未结算区域';
      case 'draw': return '牌堆已空';
      case 'end_turn': return '当前不能结束回合';
      default: return '当前无法执行该行动';
    }
  }

  function cancelMode() {
    clearSelections();
    refreshView();
  }

  function handleRegionClick(info) {
    if (!game.state || game.busy) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地操作
    if (game.state.phase !== 'battle' || game.state.turn !== 'p1') return;
    var mode = game.view.mode;
    var rid = info.regionId;
    var region = game.state.regions[rid];
    if (!region) return;
    if (mode === 'idle') {
      if (info.isBack) root.PokerUI.toast('请先选择「翻牌」或「移牌」行动', 'info');
      else if (region.status === 'open') root.PokerUI.toast('该区域可以结算，点击「结算」行动', 'info');
      return;
    }
    if (mode === 'settle') {
      if (region.status !== 'open') { playSfx('ui.error'); root.PokerUI.toast('该区域已经结算', 'warn'); return; }
      // v1.4：任意未结算区域均可结算（不再要求正面牌 > 2），仅保留 AP / 牌堆 / 决战阶段限制
      if (!findLegal('settle', { regionId: rid })) {
        var settleWhy = '牌堆不足，暂时无法结算';
        if (!E.getOpenRegionIds(game.state).length) settleWhy = '没有未结算区域';
        else if (game.state.deck.length < 2 * game.state.config.settleCards) {
          settleWhy = '牌堆不足（结算需 ≥ ' + (2 * game.state.config.settleCards) + ' 张）';
        }
        playSfx('ui.error');
        root.PokerUI.toast(settleWhy, 'warn');
        return;
      }
      var st = game.state;
      var p1Sum = E.getRegionSideSum(st, rid, 'p1');
      var p2Sum = E.getRegionSideSum(st, rid, 'p2');
      var count = E.getRegionFaceUpCount(st, rid);
      refreshView();
      root.PokerUI.showConfirmSettle({ regionId: rid, p1Sum: p1Sum, p2Sum: p2Sum, faceUpCount: count }).then(function (ok) {
        if (!ok) { refreshView(); return; }
        commitAction({ type: 'settle', regionId: rid });
      });
      return;
    }
    if (mode === 'flip') {
      if (!info.isBack) { root.PokerUI.toast('请点击高亮的我方背面牌', 'info'); return; }
      if (!findLegal('flip', { regionId: rid, cardId: info.cardId })) {
        playSfx('ui.error');
        root.PokerUI.toast('该牌不可翻开', 'warn');
        return;
      }
      commitAction({ type: 'flip', regionId: rid, cardId: info.cardId });
      return;
    }
    if (mode === 'place') {
      if (region.status !== 'open') { playSfx('ui.error'); root.PokerUI.toast('该区域已经结算', 'warn'); return; }
      var selected = game.view.selectedHandCardId;
      if (selected) {
        if (!findLegal('place', { regionId: rid, cardId: selected })) {
          playSfx('ui.error');
          root.PokerUI.toast('无法将这张牌放入该区域', 'warn');
          return;
        }
        commitAction({ type: 'place', regionId: rid, cardId: selected });
      } else {
        game.view.selectedRegionId = rid;
        game.view.hintOverride = '已选择区域 ' + (rid + 1) + '，请点击一张手牌';
        refreshView();
      }
      return;
    }
    if (mode === 'move') {
      if (info.isBack) {
        if (!findLegal('move', { cardId: info.cardId })) {
          playSfx('ui.error');
          root.PokerUI.toast('该牌无法移动（没有其他未结算区域）', 'warn');
          return;
        }
        game.view.moveSource = { regionId: rid, cardId: info.cardId };
        game.view.hintOverride = '';
        refreshView();
        return;
      }
      if (!game.view.moveSource) { root.PokerUI.toast('请先点击我方一张背面牌', 'info'); return; }
      var src = game.view.moveSource;
      if (!findLegal('move', { cardId: src.cardId, toRegionId: rid })) {
        playSfx('ui.error');
        root.PokerUI.toast('该区域不是合法目标', 'warn');
        return;
      }
      commitAction({ type: 'move', fromRegionId: src.regionId, cardId: src.cardId, toRegionId: rid });
      return;
    }
  }

  function commitAction(action) {
    if (isLan()) return commitLanAction(action);
    if (!game.state || game.busy) return;
    if (game.state.phase !== 'battle') return;
    game.busy = true;
    clearSelections();
    var events;
    try {
      events = E.performAction(game.state, action);
    } catch (err) {
      game.busy = false;
      root.PokerUI.toast(err && err.message ? err.message : '行动失败', 'error');
      refreshView();
      return;
    }
    syncTimerForState(events);
    refreshView();
    playEvents(events).then(function () {
      game.busy = false;
      refreshView();
      if (game.state.phase === 'battle' && game.state.turn === 'p2' && !game.autoplayRunning) scheduleAI();
    });
  }

  /* ================================================================== *
   * 事件动画序列
   * ================================================================== */
  function playEvents(events) {
    if (!events || !events.length) return Promise.resolve();
    if (!game.animation) {
      playEventsSfxFast(events);
      if (game.state && game.state.result) {
        root.PokerUI.showGameOver(game.state.result, game.state, isLan() ? { lan: lanViewModel() } : undefined);
      }
      return Promise.resolve();
    }
    var index = 0;
    function next() {
      if (index >= events.length) return Promise.resolve();
      var ev = events[index++];
      playEventSfx(ev);
      if (ev.type === 'settle') {
        return root.PokerUI.showSettlement(ev, {
          autoMs: 1750,
          onResult: function () { playSfx(settleWinnerSfx(ev.winner)); }
        }).then(next);
      }
      if (ev.type === 'endgame_start') {
        return root.PokerUI.showEndgameSplash(ev).then(next);
      }
      if (ev.type === 'endgame_draw') {
        return root.PokerUI.playEndgameDraw(ev).then(next);
      }
      if (ev.type === 'endgame_skip') {
        return root.PokerUI.showEndgameSkip(ev).then(next);
      }
      if (ev.type === 'endgame_showdown') {
        return root.PokerUI.showEndgameShowdown(ev).then(next);
      }
      if (ev.type === 'endgame_settle') {
        return root.PokerUI.showSettlement(ev, {
          endgame: true,
          deterministic: !!ev.deterministic,
          autoMs: 1250,
          onResult: function () { playSfx(settleWinnerSfx(ev.winner)); }
        }).then(next);
      }
      if (ev.type === 'game_over') {
        root.PokerUI.showGameOver(ev.result, game.state, isLan() ? { lan: lanViewModel() } : undefined);
        return Promise.resolve();
      }
      if (ev.type === 'flip' || ev.type === 'place' || ev.type === 'move') {
        var rid = ev.regionId != null ? ev.regionId : ev.toRegionId;
        var pre = ev.type === 'flip' ? root.PokerUI.flipCard(rid, ev.playerId) : Promise.resolve();
        return pre.then(function () { return root.PokerUI.flashRegion(rid); }).then(next);
      }
      if (ev.type === 'draw') {
        return root.PokerUI.playDrawAnim(ev).then(next);
      }
      return next();
    }
    return next();
  }

  /* ================================================================== *
   * AI 回合调度
   * ================================================================== */
  function scheduleAI() {
    clearAiTimer();
    if (isLan()) return;
    if (game.autoplayRunning) return;
    if (!game.state || game.state.phase !== 'battle' || game.state.turn !== 'p2') return;
    game.busy = true;
    refreshView();
    var delay = game.aiDelayOverride != null
      ? game.aiDelayOverride
      : (game.animation ? (780 + Math.floor(Math.random() * 320)) : 160);
    game.aiTimer = setTimeout(function () {
      game.aiTimer = null;
      if (!game.state || game.state.phase !== 'battle' || game.state.turn !== 'p2') {
        game.busy = false;
        refreshView();
        return;
      }
      var action = chooseAiAction(game.state, 'p2');
      if (!action) {
        game.busy = false;
        refreshView();
        root.PokerUI.toast('电脑无法行动，本局中止', 'error');
        return;
      }
      game.busy = false;
      commitAction(action);
    }, delay);
  }

  /* ================================================================== *
   * 键盘
   * ================================================================== */
  function handleGlobalKey(e) {
    if (!game.view) return;
    if (root.PokerUI.hasBlockingOverlay()) return;
    if (isTrusteeActive()) return; // v1.6 托管期间忽略本地快捷键操作
    var key = e.key;
    if (key === 'r' || key === 'R') {
      root.PokerUI.showRules();
      return;
    }
    if (!game.state) return;
    if (key === 'Escape') {
      if (game.view.mode !== 'idle' || game.view.layoutSelectedHandCard) {
        cancelMode();
        game.view.layoutSelectedHandCard = null;
        refreshView();
      }
      return;
    }
    if (key === 'Enter') {
      if (game.state.phase === 'layout') confirmLayout();
      return;
    }
    // v1.4：Space / 0 提前结束回合
    if (key === ' ' || key === 'Spacebar' || key === '0') {
      if (game.state.phase !== 'battle' || game.view.busy) return;
      e.preventDefault();
      handleActionClick('end_turn');
      return;
    }
    if (/^[1-5]$/.test(key)) {
      if (game.state.phase !== 'battle' || game.view.busy) return;
      handleActionClick(ACTION_TYPES[Number(key) - 1]);
    }
  }

  /* ================================================================== *
   * PokerDebug / PokerApp
   * ================================================================== */
  function installDebugApi() {
    root.PokerDebug = {
      version: (root.PokerEngine && root.PokerEngine.VERSION) || '1.4.0',
      startGame: function (configOverrides) {
        if (isLan()) { root.PokerUI.toast('联机模式请先离开房间再使用调试开局', 'warn'); return null; }
        var overrides = (configOverrides && typeof configOverrides === 'object') ? configOverrides : {};
        return startGame(overrides);
      },
      getState: function () { return game.state; },
      startLayoutDemo: function () {
        if (isLan()) return;
        startGame({});
      },
      submitLayoutByIndexes: function (indexes) {
        if (isLan()) return;
        submitLayoutByIndexes(indexes);
      },
      dispatch: function (action) {
        if (isLan()) { root.PokerUI.toast('联机模式不支持本地调试行动', 'warn'); return []; }
        return dispatchDebug(action);
      },
      autoPlayToEnd: function () {
        if (isLan()) { root.PokerUI.toast('联机模式不支持自动演示', 'warn'); return null; }
        return autoPlayToEnd();
      },
      setAnimationEnabled: function (enabled) {
        game.animation = !!enabled;
        root.PokerUI.setAnimationEnabled(!!enabled);
      },
      setAiDelay: function (ms) {
        var n = Number(ms);
        game.aiDelayOverride = isFinite(n) && n >= 0 ? n : null;
      },
      // v1.5：运行时覆盖当前对局回合时限（0=关闭；1-4 秒仅 UI 计时用于 E2E）
      setTurnTimeLimit: function (sec) {
        turnTimer.override = normalizeTimerOverride(sec);
        if (isLocalTimerTurn()) resetTurnTimer(turnTimer.override);
        else syncTimerForState();
        return timerState();
      },
      timerState: function () { return timerState(); },
      // v1.6 托管（E2E 便捷接口）：setAutoplay(bool) 开/关托管；autoplayState() 读取状态
      setAutoplay: function (enabled) { return setTrustee(!!enabled); },
      autoplayState: function () { return trusteeState(); },
      // v1.8 困难档 AI 引擎（设置/E2E）：heuristic=启发式 3.3.0 对照；ml=机器学习（默认）
      setAIEngine: function (engine) {
        var next = normalizeAiEngine(engine);
        if (String(engine) !== next) {
          root.PokerUI.toast('未知 AI 引擎：' + engine + '（可选 heuristic / ml）', 'warn');
        }
        game.settings.aiEngine = next;
        saveSettings(game.settings);
        if (next === 'ml' && !mlAvailability().available) {
          root.PokerUI.toast('ML 模块不可用，困难档将自动回退启发式 3.3.0', 'warn');
        }
        if (game.view) refreshView();
        return aiEngineState();
      },
      aiEngineState: function () { return aiEngineState(); },
      getResult: function () { return game.state ? (game.state.result || null) : null; }
    };
    root.PokerApp = {
      getState: function () { return game.state; },
      startGame: function (overrides) { return startGame(overrides || {}); },
      getController: function () {
        return {
          getState: function () { return game.state; },
          getView: function () { return game.view; },
          getSettings: function () { return game.settings; },
          getMode: function () { return game.mode; },
          getLanState: function () { return lanViewModel(); },
          restart: restart,
          startGame: function (overrides) { return startGame(overrides || {}); }
        };
      }
    };
  }

  function submitLayoutByIndexes(indexes) {
    if (!game.state || game.state.phase !== 'layout' || !game.view) return;
    var st = game.state;
    var hand = st.players.p1.hand;
    var R = st.config.regionCount;
    var ids = [];
    var seen = {};
    var list = Array.isArray(indexes) ? indexes : null;
    for (var i = 0; i < R; i++) {
      var idx = list && list[i] != null ? Number(list[i]) : i;
      if (!isFinite(idx) || idx < 0 || idx >= hand.length) idx = i % hand.length;
      var id = hand[idx].id;
      if (seen[id]) {
        for (var k = 0; k < hand.length; k++) {
          if (!seen[hand[k].id]) { id = hand[k].id; break; }
        }
      }
      seen[id] = true;
      ids.push(id);
    }
    game.view.layoutSelection = ids.slice();
    debugInstantLayout();
  }

  function debugInstantLayout() {
    if (!game.state || game.state.phase !== 'layout') return;
    var st = game.state;
    var R = st.config.regionCount;
    var ids = game.view.layoutSelection.slice();
    for (var i = 0; i < R; i++) {
      if (!ids[i]) { root.PokerUI.toast('布阵未完成', 'warn'); return; }
    }
    game.busy = true;
    var events;
    try {
      E.submitLayout(st, 'p1', ids);
      var aiIds = chooseAiLayout(st, 'p2');
      E.submitLayout(st, 'p2', aiIds);
      events = E.finalizeLayout(st);
    } catch (err) {
      game.busy = false;
      root.PokerUI.toast(err && err.message ? err.message : '布阵失败', 'error');
      refreshView();
      return;
    }
    game.view.layoutSelection = new Array(R).fill(null);
    game.view.layoutSelectedHandCard = null;
    game.busy = false;
    playLayoutSfx(events);
    refreshView();
    if (st.phase === 'gameover') {
      if (st.result) playSfx(gameResultSfx(st.result));
      root.PokerUI.showGameOver(st.result, st);
    } else if (st.phase === 'battle' && st.turn === 'p2') {
      // v1.5 修复：debug 快速布局后若电脑先手，需要继续调度 AI，否则对局卡住
      scheduleAI();
    }
  }

  function dispatchDebug(action) {
    var events = [];
    if (!game.state) return events;
    if (game.state.phase === 'layout') return events;
    if (game.state.phase === 'gameover') return events;
    var guard = 0;
    while (game.state.phase === 'battle' && game.state.turn === 'p2' && guard++ < 300) {
      var aiAction = chooseAiAction(game.state, 'p2');
      if (!aiAction) break;
      try {
        events = events.concat(E.performAction(game.state, aiAction));
      } catch (err) {
        break;
      }
    }
    if (game.state.phase !== 'battle') {
      playEventsSfxFast(events);
      finishDebugRender();
      return events;
    }
    if (!action || typeof action !== 'object' || !action.type) {
      playEventsSfxFast(events);
      finishDebugRender();
      return events;
    }
    var legal;
    try {
      legal = E.getLegalActions(game.state);
    } catch (err) {
      legal = [];
    }
    if (!isActionLegal(action, legal)) {
      playSfx('ui.error');
      root.PokerUI.toast('该行动在当前局面不合法', 'warn');
      playEventsSfxFast(events);
      finishDebugRender();
      return events;
    }
    try {
      events = events.concat(E.performAction(game.state, action));
    } catch (err) {
      playSfx('ui.error');
      root.PokerUI.toast(err && err.message ? err.message : '行动执行失败', 'warn');
      playEventsSfxFast(events);
      finishDebugRender();
      return events;
    }
    syncTimerForState(events);
    playEventsSfxFast(events);
    finishDebugRender();
    // debug 单步执行后若轮到电脑，继续 AI 调度（与正常提交路径一致，避免调试/测试卡住）
    if (game.state && game.state.phase === 'battle' && game.state.turn === 'p2' && !game.autoplayRunning) {
      scheduleAI();
    }
    return events;
  }

  function finishDebugRender() {
    clearAiTimer();
    game.busy = false;
    if (game.view) clearSelections();
    refreshView();
    if (game.state && game.state.phase === 'gameover') {
      root.PokerUI.showGameOver(game.state.result, game.state);
    }
  }

  function autoPlayToEnd() {
    clearAiTimer();
    game.autoplayRunning = false;
    if (!game.state || game.state.phase === 'gameover') {
      var started = startGame({});
      if (!started) return null;
    }
    var st = game.state;
    var guard = 0;
    if (st.phase === 'layout') {
      try {
        var p1Layout = chooseAiLayout(st, 'p1');
        E.submitLayout(st, 'p1', p1Layout);
        var p2Layout = chooseAiLayout(st, 'p2');
        E.submitLayout(st, 'p2', p2Layout);
        var layoutEvents = E.finalizeLayout(st);
        playLayoutSfx(layoutEvents);
      } catch (err) {
        root.PokerUI.toast('自动布阵失败：' + (err && err.message ? err.message : '未知错误'), 'error');
        return null;
      }
    }
    while (st.phase === 'battle' && guard++ < 5000) {
      var legal;
      try { legal = E.getLegalActions(st); } catch (err) { legal = []; }
      if (!legal.length) break;
      var action = chooseAiAction(st, st.turn) || legal[0];
      try {
        E.performAction(st, action);
      } catch (err) {
        try { E.performAction(st, legal[0]); } catch (err2) { break; }
      }
    }
    if (st.result) playSfx(gameResultSfx(st.result));
    finishDebugRender();
    return st.result || null;
  }

  /* ================================================================== *
   * 局域网联机
   * ================================================================== */
  function buildLanConfig() {
    var cfg = buildConfig({});
    // 不显式下发 deck：3/5/7 区一律标准单副牌 54 张（由引擎默认派生）
    return {
      regionCount: cfg.regionCount,
      difficulty: cfg.difficulty,
      settleCards: cfg.settleCards,
      firstPlayer: cfg.firstPlayer,
      turnTimeLimit: cfg.turnTimeLimit
    };
  }

  function timerLimitLabel(limit) {
    var n = Number(limit);
    if (!isFinite(n) || n <= 0) return '关闭';
    return n + ' 秒';
  }

  function buildLanConfigSummary() {
    var cfg = buildConfig({});
    var info = E.validateConfig(cfg).info || {};
    var diff = E.DIFFICULTIES[cfg.difficulty];
    var firstMap = { random: '随机先手', p1: '房主先手', p2: '客机先手' };
    return '区域 ' + cfg.regionCount + ' 个 · ' + (info.winsNeeded || '?') + ' 胜制 · 牌堆 ' +
      (info.deckSize || '?') + ' 张 · 后手补偿 ' + (info.compensationDraw != null ? info.compensationDraw : 1) +
      ' 张 · 结算「' +
      settleModeName(cfg.settleCards) + '」（双方各补 ' + cfg.settleCards + ' 张） · 难度「' +
      (diff ? diff.name : cfg.difficulty) + '」 · 回合倒计时 ' + timerLimitLabel(cfg.turnTimeLimit) +
      ' · ' + (firstMap[cfg.firstPlayer] || '随机先手');
  }

  function saveNickname(name) {
    var nickname = validNickname(name);
    game.settings.nickname = nickname;
    writeTabNickname(nickname);
  }

  function openLanLobby(options) {
    var opts = options || {};
    game.lanPage = true; // v1.8.1：大厅即 LAN 上下文
    root.PokerUI.showLanLobby({
      nickname: currentNickname(),
      code: opts.code || '',
      configSummary: buildLanConfigSummary(),
      availState: 'checking'
    });
    refreshLanAvailability();
  }

  function refreshLanAvailability() {
    var n = net();
    if (!n) {
      root.PokerUI.setLanAvailability('offline');
      return;
    }
    root.PokerUI.setLanAvailability('checking');
    n.available(true).then(function (info) {
      // 记录上次成功端口（v1.7：file:// 再次点击「局域网联机」时优先探测该端口）
      if (info) {
        var p = Number(root.location && root.location.port);
        if (p) saveLanPort(p);
      }
      if (!lanLobbyOpen()) return;
      root.PokerUI.setLanAvailability(info ? 'online' : 'offline', info);
    }, function () {
      if (lanLobbyOpen()) root.PokerUI.setLanAvailability('offline');
    });
  }

  function lanLobbyOpen() {
    return !!(root.PokerUI && typeof root.PokerUI.setLanAvailability === 'function');
  }

  // 联机会话建立后把地址栏改写为可刷新的分享链接格式 ?room=CODE（replaceState 不新增历史）。
  // code 为空时清除 room/lan 参数（离开房间/房间关闭后刷新不会误入大厅）。
  function syncLanUrl(code) {
    try {
      var loc = root.location;
      var hist = root.history;
      if (!loc || !hist || typeof hist.replaceState !== 'function') return;
      if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return;
      var params = new root.URLSearchParams(loc.search || '');
      params.delete('lan');
      if (code) params.set('room', String(code).toUpperCase());
      else params.delete('room');
      var qs = params.toString();
      var next = loc.pathname + (qs ? '?' + qs : '') + (loc.hash || '');
      var current = loc.pathname + (loc.search || '') + (loc.hash || '');
      if (next === current) return;
      hist.replaceState(null, '', next);
    } catch (e) { /* 地址栏改写失败不影响联机 */ }
  }

  function attachLanSession(room, role) {
    if (game.trustee) disableTrustee(true); // v1.6：联机模式不支持托管
    game.mode = 'lan';
    game.lanPage = true; // v1.8.1：联机对局属于 LAN 上下文（隐藏单机专属设置）
    game.state = null;
    game.busy = false;
    turnTimer.override = null;
    game.lan = newLanState();
    game.lan.role = role;
    game.lan.meta = (room && room.meta) || null;
    game.lan.session = net() ? net().getSession() : null;
    game.lan.connection = 'connecting';
    syncLanUrl((game.lan.session && game.lan.session.code) || (room && room.code));
    root.PokerUI.closeAllOverlays();
    refreshView();
  }

  function attachLanCallbacks() {
    return {
      status: function (status) {
        if (!isLan() || !game.lan) return;
        game.lan.connection = status;
        if (status === 'reconnecting') root.PokerUI.toast('网络连接中断，正在重连…', 'warn');
        if (status === 'closed') root.PokerUI.toast('连接已断开', 'error');
        refreshView();
      },
      meta: function (meta) {
        if (!isLan() || !game.lan || !meta) return;
        game.lan.meta = meta;
        if (meta.rematchReady) game.lan.rematchRequested = !!meta.rematchReady.p1;
        root.PokerUI.updateWaitingRoom(meta);
        if (game.state && game.state.phase === 'gameover') {
          root.PokerUI.updateGameOverLan(lanViewModel());
        }
        refreshView();
      },
      presence: function (data) {
        if (!isLan() || !game.lan || !data || !data.meta) return;
        game.lan.meta = data.meta;
        refreshView();
      },
      update: function (data) {
        enqueueLanUpdate(data);
      },
      roomClosed: function (reason) {
        handleLanRoomClosed(reason);
      },
      error: function (err) {
        handleLanError(err);
      }
    };
  }

  function createLanRoom(payload) {
    var n = net();
    if (!n) { root.PokerUI.setLanError('联机模块 js/net.js 未加载'); return; }
    root.PokerUI.setLanBusy(true);
    root.PokerUI.setLanError('');
    saveNickname(payload.name);
    n.createRoom(validNickname(payload.name), buildLanConfig()).then(function (room) {
      root.PokerUI.setLanBusy(false);
      root.PokerUI.closeLanLobby();
      attachLanSession(room, 'host');
      root.PokerUI.showWaitingRoom({
        code: room.code,
        meta: room.meta,
        lanUrls: (room.meta && room.meta.lanUrls) || [],
        myName: validNickname(payload.name),
        role: 'host',
        configSummary: buildLanConfigSummary()
      });
      var p = n.connect(attachLanCallbacks());
      if (p && p.catch) { p.catch(function () { root.PokerUI.toast('实时通道连接失败，请刷新重试', 'error'); }); }
    }).catch(function (err) {
      root.PokerUI.setLanBusy(false);
      root.PokerUI.setLanError(netErrorText(err));
      refreshLanAvailability();
    });
  }

  function joinLanRoom(payload) {
    var n = net();
    if (!n) { root.PokerUI.setLanError('联机模块 js/net.js 未加载'); return; }
    root.PokerUI.setLanBusy(true);
    root.PokerUI.setLanError('');
    saveNickname(payload.name);
    n.joinRoom(payload.code, validNickname(payload.name)).then(function (room) {
      root.PokerUI.setLanBusy(false);
      root.PokerUI.closeLanLobby();
      attachLanSession(room, 'guest');
      var p = n.connect(attachLanCallbacks());
      if (p && p.catch) { p.catch(function () { root.PokerUI.toast('实时通道连接失败，请刷新重试', 'error'); }); }
      if (room && room.state) {
        enqueueLanUpdate({ state: room.state, meta: room.meta, events: [], seq: 0 });
      } else {
        root.PokerUI.showWaitingRoom({
          code: room.code,
          meta: room.meta,
          lanUrls: (room.meta && room.meta.lanUrls) || [],
          myName: validNickname(payload.name),
          role: 'guest',
          configSummary: buildLanConfigSummary()
        });
      }
    }).catch(function (err) {
      root.PokerUI.setLanBusy(false);
      root.PokerUI.setLanError(netErrorText(err));
      refreshLanAvailability();
    });
  }

  function resumeLanSession(session) {
    var n = net();
    if (!n || !session) { openSettings(true); return; }
    if (game.trustee) disableTrustee(true); // v1.6：联机模式不支持托管
    game.mode = 'lan';
    game.lanPage = true; // v1.8.1：断线恢复亦属 LAN 上下文
    game.state = null;
    game.lan = newLanState();
    game.lan.role = session.host ? 'host' : 'guest';
    game.lan.session = session;
    game.lan.connection = 'connecting';
    game.lan.enteredGame = true;
    syncLanUrl(session.code);
    refreshView();
    root.PokerUI.showLanResuming('正在恢复上次联机…');
    root.PokerUI.toast('正在恢复上次联机…', 'info');
    var p = n.connect(attachLanCallbacks());
    if (p && p.catch) {
      p.catch(function () {
        n.clearSession();
        backToSolo('联机会话已失效，已回到单机模式');
      });
    }
    setTimeout(function () {
      if (!isLan() || game.state) return;
      n.getSnapshot().then(function (data) {
        if (!isLan() || game.state) return;
        enqueueLanUpdate(data);
      }).catch(function (err) {
        if (!isLan() || game.state) return;
        n.disconnect();
        n.clearSession();
        backToSolo('联机恢复失败（' + netErrorText(err) + '），已回到单机模式');
      });
    }, 1500);
  }

  function enqueueLanUpdate(data) {
    if (!isLan() || !game.lan || !data) return;
    game.lan.pendingUpdates.push(data);
    processLanQueue();
  }

  function processLanQueue() {
    if (!isLan() || !game.lan || game.lan.processing) return;
    var data = game.lan.pendingUpdates.shift();
    if (!data) return;
    var lan = game.lan;
    lan.processing = true;
    lan.actionPending = false;
    if (lan.actionTimer) {
      clearTimeout(lan.actionTimer);
      lan.actionTimer = null;
    }
    // 看门狗：极端情况下（动画 Promise 丢失/标签页被冻结）确保 busy 锁不会永久卡住
    var token = (lan.processToken || 0) + 1;
    lan.processToken = token;
    var watchdog = setTimeout(function () {
      if (!isLan() || game.lan !== lan || lan.processToken !== token || !lan.processing) return;
      lan.processing = false;
      lan.actionPending = false;
      game.busy = false;
      refreshView();
      processLanQueue();
    }, 9000);
    applyLanUpdate(data).then(function () {
      clearTimeout(watchdog);
      if (game.lan !== lan) return;
      lan.processing = false;
      game.busy = false;
      refreshView();
      processLanQueue();
    }, function (err) {
      clearTimeout(watchdog);
      if (game.lan !== lan) return;
      lan.processing = false;
      game.busy = false;
      refreshView();
      if (root.console && root.console.warn) root.console.warn('[PokerApp] LAN update render error:', err);
      processLanQueue();
    });
  }

  function applyLanUpdate(data) {
    if (!isLan() || !game.lan || !data) return Promise.resolve();
    var meta = data.meta || null;
    var st = data.state || null;
    var events = Array.isArray(data.events) ? data.events : [];
    if (meta) {
      game.lan.meta = meta;
      if (meta.rematchReady) game.lan.rematchRequested = !!meta.rematchReady.p1;
    }
    var prevPhase = game.state ? game.state.phase : null;
    if (!st) {
      // 等待状态（房主刷新重连）：关闭恢复提示，回到等待房间
      root.PokerUI.closeLanResuming();
      if (meta && meta.status === 'waiting') {
        var myName = (meta.players && meta.players.p1 && meta.players.p1.name) || '';
        root.PokerUI.showWaitingRoom({
          code: meta.code,
          meta: meta,
          lanUrls: meta.lanUrls || [],
          myName: myName,
          role: game.lan.role,
          configSummary: buildLanConfigSummary()
        });
      }
      game.busy = false;
      refreshView();
      return Promise.resolve();
    }
    if (st) {
      root.PokerUI.closeLanResuming();
      game.state = st;
      if (st.phase === 'layout') {
        if (!game.view) game.view = makeView();
        if (!Array.isArray(game.view.layoutSelection) || game.view.layoutSelection.length !== st.config.regionCount) {
          game.view.layoutSelection = new Array(st.config.regionCount).fill(null);
        }
        game.lan.layoutSubmitted = !!(st.layout && st.layout.submitted && st.layout.submitted.p1);
        var own = st.layout && st.layout.assignments && st.layout.assignments.p1;
        if (own && own.length === st.config.regionCount) {
          game.view.layoutSelection = own.map(function (card) { return card.id; });
        }
        if (game.lan.meta && game.lan.meta.status === 'layout') root.PokerUI.closeWaitingRoom();
        if (!game.lan.enteredGame) {
          game.lan.enteredGame = true;
          if (game.lan.role === 'host') root.PokerUI.toast('对手已加入，开始战前布局！', 'success');
          else root.PokerUI.toast('已加入房间，开始战前布局！', 'success');
        }
        if (prevPhase === 'gameover') {
          game.lan.rematchRequested = false;
          if (game.trustee) disableTrustee(true); // v1.7：联机重开新局默认关闭托管
          root.PokerUI.closeGameOver();
          root.PokerUI.toast('新对局开始！', 'success');
        }
      } else {
        if (game.view) game.view.layoutSelection = [];
        game.lan.layoutSubmitted = false;
        root.PokerUI.closeWaitingRoom();
      }
    }
    syncTimerForState(events);
    if (st && st.phase === 'battle' && prevPhase === 'layout') {
      game.busy = true;
      refreshView();
      playLayoutSfx(events);
      var tail = events.filter(function (ev) {
        return ev.type === 'endgame_start' || ev.type === 'endgame_settle' || ev.type === 'game_over';
      });
      return root.PokerUI.playLayoutReveal(events).then(function () {
        return playEvents(tail);
      }).then(function () {
        game.busy = false;
        refreshView();
        finishLanRender(st);
      });
    }
    game.busy = true;
    refreshView();
    return playEvents(events).then(function () {
      game.busy = false;
      refreshView();
      finishLanRender(st);
    });
  }

  function finishLanRender(st) {
    if (!isLan() || !st) return;
    if (st.phase === 'gameover') {
      disableTrustee(true); // v1.7：联机终局托管复位
      root.PokerUI.showGameOver(st.result, st, { lan: lanViewModel() });
    }
  }

  function handleLanError(err) {
    if (!isLan() || !err) return;
    if (err.code === 'BAD_TOKEN' || err.code === 'ROOM_NOT_FOUND' || err.code === 'ROOM_CLOSED') {
      handleLanRoomClosed('closed');
      return;
    }
    root.PokerUI.toast(netErrorText(err), 'error');
  }

  function handleLanRoomClosed(reason) {
    if (!isLan()) return;
    if (game.trustee) disableTrustee(true);
    var n = net();
    if (n) {
      n.disconnect();
      n.clearSession();
    }
    clearAiTimer();
    game.mode = 'solo';
    game.lanPage = false;
    game.state = null;
    game.lan = null;
    game.busy = false;
    syncLanUrl('');
    root.PokerUI.closeAllOverlays();
    refreshView();
    root.PokerUI.showRoomClosed(reason || 'closed');
  }

  function leaveLanRoom() {
    if (game.trustee) disableTrustee(true);
    var n = net();
    if (n) n.leave();
    clearAiTimer();
    game.mode = 'solo';
    game.lanPage = false;
    game.state = null;
    game.lan = null;
    game.busy = false;
    syncLanUrl('');
    root.PokerUI.closeAllOverlays();
    refreshView();
    openSettings(true);
    root.PokerUI.toast('已离开房间', 'info');
  }

  function backToSolo(message) {
    if (game.trustee) disableTrustee(true);
    var n = net();
    if (n) {
      n.disconnect();
      n.clearSession();
    }
    clearAiTimer();
    game.mode = 'solo';
    game.lanPage = false;
    game.state = null;
    game.lan = null;
    game.busy = false;
    syncLanUrl('');
    root.PokerUI.closeAllOverlays();
    refreshView();
    openSettings(true);
    if (message) root.PokerUI.toast(message, 'warn');
  }

  function requestRematch() {
    if (!isLan() || !game.lan) return;
    if (game.lan.rematchRequested) return;
    var n = net();
    if (!n) return;
    game.lan.rematchRequested = true;
    root.PokerUI.updateGameOverLan(lanViewModel());
    n.rematch().then(function (res) {
      if (!isLan() || !game.lan) return;
      if (res && res.meta) game.lan.meta = res.meta;
      root.PokerUI.updateGameOverLan(lanViewModel());
      refreshView();
    }).catch(function (err) {
      if (!isLan() || !game.lan) return;
      game.lan.rematchRequested = false;
      root.PokerUI.updateGameOverLan(lanViewModel());
      root.PokerUI.toast(netErrorText(err), 'error');
    });
  }

  function confirmLanLayout() {
    if (!game.state || game.busy || !game.lan) return;
    if (game.state.phase !== 'layout') return;
    if (game.lan.layoutSubmitted || game.lan.actionPending) return;
    if (!lanOpponentOnline()) {
      root.PokerUI.toast('对手已断开，等待重连…', 'warn');
      return;
    }
    var n = net();
    if (!n) return;
    var R = game.state.config.regionCount;
    var sel = game.view.layoutSelection || [];
    var ids = [];
    for (var i = 0; i < R; i++) {
      if (!sel[i]) {
        var count = sel.filter(Boolean).length;
        root.PokerUI.toast('请为每个区域各选择一张牌（当前 ' + count + '/' + R + '）', 'warn');
        return;
      }
      ids.push(sel[i]);
    }
    game.lan.actionPending = true;
    refreshView();
    n.submitLayout(ids).then(function () {
      if (!isLan() || !game.lan) return;
      // 若双方同时提交、服务器已直接揭示进入战役，则不再显示等待态
      if (game.state && game.state.phase !== 'layout') {
        game.lan.actionPending = false;
        refreshView();
        return;
      }
      game.lan.actionPending = false;
      game.lan.layoutSubmitted = true;
      game.view.layoutSelection = new Array(R).fill(null);
      game.view.layoutSelectedHandCard = null;
      root.PokerUI.toast('已提交布阵，等待对手布阵…', 'info');
      refreshView();
    }).catch(function (err) {
      if (!isLan() || !game.lan) return;
      game.lan.actionPending = false;
      root.PokerUI.toast(netErrorText(err), 'error');
      refreshView();
    });
  }

  function commitLanAction(action) {
    if (!game.state || game.busy || !game.lan) return;
    if (game.state.phase !== 'battle' || game.state.turn !== 'p1') return;
    if (game.lan.actionPending) return;
    if (!lanOpponentOnline()) {
      root.PokerUI.toast('对手已断开，等待重连…', 'warn');
      return;
    }
    var n = net();
    if (!n) return;
    clearSelections();
    game.lan.actionPending = true;
    refreshView();
    n.sendAction(action).then(function () {
      if (!isLan() || !game.lan) return;
      game.lan.actionTimer = setTimeout(function () {
        if (!isLan() || !game.lan) return;
        if (game.lan.actionPending) {
          game.lan.actionPending = false;
          game.busy = false;
          refreshView();
          root.PokerUI.toast('服务器响应较慢，请稍候…', 'warn');
        }
      }, 6000);
    }).catch(function (err) {
      if (!isLan() || !game.lan) return;
      game.lan.actionPending = false;
      game.busy = false;
      root.PokerUI.toast(netErrorText(err), 'error');
      refreshView();
    });
  }

  /* ================================================================== *
   * 启动挂载
   * ================================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
