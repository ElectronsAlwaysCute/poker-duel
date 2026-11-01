/*
 * js/ui.js —— 视图与交互层（全局 PokerUI）
 * 只负责 DOM 渲染、动画、弹层与原始交互事件回调；对局逻辑全部在 js/main.js。
 * 契约见 docs/CONTRACT.md §7.3（data-testid）。
 */
(function (root) {
  'use strict';

  var UI = {};
  var el = {};
  var handlers = {};
  var state = null;
  var view = null;
  var animationEnabled = true;
  var debugMode = false;
  var autoplayMode = false;
  var toastTimer = null;
  var lastLogSnapshot = '';

  var activeLayers = {};        // name -> overlay element
  var activeSettle = null;      // { finish }
  var activeSplash = null;      // { finish }
  var activeConfirm = null;     // { finish }
  var activeGameover = null;    // element
  var settingsEl = null;        // settings overlay element
  var settingsDraft = null;
  var settingsOpts = null;
  var rulesEl = null;
  var lanLobbyEl = null;
  var lanLobbyModel = null;
  var lanLaunchEl = null;       // v1.7 一键启动引导弹层（file:// 且本地服务器未启动）
  var lanLaunchModel = null;
  var lanWaitingEl = null;
  var lanWaitingModel = null;
  var roomClosedEl = null;
  var lanResumingEl = null;

  var ACTION_META = [
    { type: 'settle', icon: '⚔', label: '结算', sub: '任意未结算区域立即结算', key: '1' },
    { type: 'flip', icon: '⟲', label: '翻牌', sub: '翻开一张我方背面牌', key: '2' },
    { type: 'place', icon: '▣', label: '放牌', sub: '手牌背面朝上放入区域', key: '3' },
    { type: 'move', icon: '⇄', label: '移牌', sub: '移动我方背面牌到其他区域', key: '4' },
    { type: 'draw', icon: '✦', label: '摸牌', sub: '从牌堆摸一张牌', key: '5' }
  ];

  var END_TURN_META = { type: 'end_turn', icon: '⏭', label: '结束回合', sub: '放弃剩余行动点', key: 'Space' };

  // 回退值：正常情况下从引擎 E.ACTION_COSTS / E.AP_PER_TURN / state.config 读取（v1.4）
  var FALLBACK_ACTION_COSTS = { settle: 3, draw: 2, flip: 2, place: 1, move: 1, end_turn: 0 };

  function actionCost(type) {
    var e = eng();
    if (e && e.ACTION_COSTS && e.ACTION_COSTS[type] != null) return Number(e.ACTION_COSTS[type]) || 0;
    return FALLBACK_ACTION_COSTS[type] || 0;
  }

  function apPerTurn() {
    if (state && state.config && state.config.apPerTurn != null) return Number(state.config.apPerTurn) || 3;
    var e = eng();
    if (e && e.AP_PER_TURN != null) return Number(e.AP_PER_TURN) || 3;
    return 3;
  }

  function settleModeCards() {
    return (state && state.config && Number(state.config.settleCards)) || 1;
  }

  // 当前行动方的行动点（决战 build 阶段同样适用）
  function currentAp() {
    if (!state || !state.turn || !state.players) return 0;
    var p = state.players[state.turn];
    var ap = p && p.ap != null ? Number(p.ap) : 0;
    return isFinite(ap) ? ap : 0;
  }

  /* ================================================================== *
   * 基础工具
   * ================================================================== */
  function eng() { return root.PokerEngine; }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function $(selector) { return document.querySelector(selector); }

  function fmtCard(card) {
    var e = eng();
    if (e && e.formatCard) return e.formatCard(card);
    if (!card) return '—';
    return card.joker ? card.rank : (card.suitSymbol || '') + card.rank;
  }

  /* v1.5：音效播放（js/sfx.js 的 PokerSFX 未加载/失败时静默，不抛错） */
  function sfxPlay(name) {
    var s = root.PokerSFX;
    if (!s || typeof s.play !== 'function') return;
    try { s.play(name); } catch (err) { /* ignore */ }
  }

  /* v1.4：己方背面牌的真实牌面提示（只渲染自己的牌，对手背面牌不参与） */
  function ownBackTipText(card) {
    if (!card || card.hidden) return '';
    return fmtCard(card) + '（' + card.value + '）';
  }

  /* v1.6：己方背面牌拖动提示（title / aria-label 共用；落点决定动作） */
  function ownBackDragHint() {
    return '拖动：拖回本区域翻开，拖到其他区域移牌（翻牌 2 点 / 移牌 1 点行动点）';
  }

  function showOwnBackTooltip(btn) {
    if (!el.ownBackTooltip || !btn) return;
    var text = btn.getAttribute('data-tip');
    if (!text) return;
    var tip = el.ownBackTooltip;
    tip.textContent = text;
    tip.hidden = false;
    tip.classList.remove('is-below');
    var rect = btn.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var vw = root.innerWidth || document.documentElement.clientWidth || 0;
    var left = rect.left + rect.width / 2;
    var top = rect.top - tipRect.height - 8;
    var below = false;
    if (top < 8) {
      top = rect.bottom + 8;
      below = true;
    }
    var half = tipRect.width / 2;
    if (vw > 0) left = Math.max(half + 6, Math.min(vw - half - 6, left));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    if (below) tip.classList.add('is-below');
  }

  function hideOwnBackTooltip() {
    if (!el.ownBackTooltip) return;
    el.ownBackTooltip.hidden = true;
    el.ownBackTooltip.classList.remove('is-below');
  }

  function playerName(pid) {
    if (state && state.config && state.config.playerNames && state.config.playerNames[pid]) {
      return state.config.playerNames[pid];
    }
    return pid === 'p1' ? '你' : '电脑';
  }

  /* v2.1：后手补偿固定 1 张（3/5/7 区相同），优先读引擎派生字段 */
  function compensationDrawCount() {
    var cfg = state && state.config;
    if (!cfg) return 1;
    if (cfg.compensationDraw != null) return Number(cfg.compensationDraw) || 0;
    return 1;
  }

  function shortName(pid) {
    var name = playerName(pid);
    if (!name) return pid === 'p1' ? '你' : '电';
    return name.charAt(0);
  }

  function isLanView() {
    return !!(view && view.lan && view.lan.active);
  }

  function lanMeta() {
    return (view && view.lan && view.lan.meta) || null;
  }

  function lanOpponentOnline() {
    var meta = lanMeta();
    if (!meta) return true;
    var p2 = meta.players && meta.players.p2;
    return !p2 || p2.connected !== false;
  }

  function lanText(key, fallback) {
    var texts = (view && view.lan && view.lan.texts) || null;
    return (texts && texts[key]) || fallback;
  }

  function difficultyInfo() {
    var e = eng();
    var fallback = { name: '消耗', rule: 'loser-draw', label: '单独结算后败者摸牌' };
    if (!state || !e) return fallback;
    return e.DIFFICULTIES[state.config.difficulty] || fallback;
  }

  function ruleShort(rule) {
    if (rule === 'loser-draw') return '败者摸牌';
    if (rule === 'winner-draw') return '胜者摸牌';
    return '不摸牌';
  }

  function sumSide(region, pid) {
    var cards = region.sides[pid].faceUp;
    var sum = 0;
    for (var i = 0; i < cards.length; i++) sum += cards[i].value;
    return sum;
  }

  function countTies(st) {
    var n = 0;
    for (var i = 0; i < st.regions.length; i++) {
      var r = st.regions[i];
      if (r.status === 'settled' && r.result && r.result.winner === 'tie') n++;
    }
    return n;
  }

  // v1.4：开放区域是否满足结算条件（不存在正面牌张数下限；仅牌堆 ≥ 2N 且非决战阶段）
  function regionSettleable() {
    if (!state || state.phase !== 'battle') return false;
    var egp = endgamePhase();
    if (egp === 'build' || egp === 'showdown' || egp === 'done') return false;
    var deck = state.deck || [];
    return deck.length >= 2 * settleModeCards();
  }

  function findHandCard(cardId) {
    if (!state) return null;
    var hand = state.players.p1.hand;
    for (var i = 0; i < hand.length; i++) if (hand[i].id === cardId) return hand[i];
    return null;
  }

  function defaultView() {
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

  /* ================================================================== *
   * 卡片渲染
   * ================================================================== */
  function miniCard(card, extraClass, extraAttrs) {
    if (!card) return '';
    if (card.hidden) {
      return backCard((extraClass || '') + ' is-hidden-card', extraAttrs);
    }
    var cls = 'card card-mini' +
      (card.red ? ' is-red' : '') +
      (card.joker ? ' is-joker' : '') +
      (extraClass ? ' ' + extraClass : '');
    return '<span class="' + cls + '"' + (extraAttrs || '') + ' aria-hidden="true">' +
      '<span class="c-rank">' + esc(card.rank) + '</span>' +
      '<span class="c-suit">' + (card.joker ? '★' : esc(card.suitSymbol || '')) + '</span>' +
      '</span>';
  }

  function backCard(extraClass, extraAttrs) {
    return '<span class="card card-mini card-back' + (extraClass ? ' ' + extraClass : '') + '"' + (extraAttrs || '') + ' aria-hidden="true">' +
      '<span class="back-pattern"></span></span>';
  }

  /* v2.4/v2.5：己方暗牌半透明牌面 —— 真实 rank/suit（仅本地玩家可见）+ 半透明牌背纹理（v2.5 按用户要求移除「暗」角标，保留虚线边/半透明区分） */
  function ownHiddenFaceHTML(card) {
    return '<span class="own-back-face" aria-hidden="true">' +
      '<span class="c-rank">' + esc(card.rank) + '</span>' +
      '<span class="c-suit">' + (card.joker ? '★' : esc(card.suitSymbol || '')) + '</span>' +
      '</span>' +
      '<span class="back-pattern"></span>';
  }

  /* 布局槽位中的己方已放牌（槽位按钮本身负责点击/拖拽；内层牌仅展示） */
  function ownHiddenCardHTML(card, extraClass) {
    if (!card) return '';
    return '<span class="card card-mini card-back own-hidden-card' +
      (card.red ? ' is-red' : '') + (card.joker ? ' is-joker' : '') +
      (extraClass ? ' ' + extraClass : '') + '" data-card-id="' + esc(card.id) + '" aria-hidden="true">' +
      ownHiddenFaceHTML(card) +
      '</span>';
  }

  function handCardHTML(card, opts) {
    opts = opts || {};
    var cls = 'card card-hand' +
      (card.red ? ' is-red' : '') +
      (card.joker ? ' is-joker' : '') +
      (opts.selected ? ' is-selected' : '') +
      (opts.used != null ? ' is-used' : '');
    var badge = opts.used != null
      ? '<span class="used-badge">区域 ' + (opts.used + 1) + '</span>'
      : '';
    return '<button type="button" class="' + cls + '" data-testid="hand-card" data-card-id="' + esc(card.id) + '" data-draggable="hand"' +
      ' aria-label="' + esc(fmtCard(card)) + '，数值 ' + card.value + '，手牌"' +
      (opts.used != null ? ' disabled' : '') + '>' +
      badge +
      '<span class="c-rank">' + esc(card.rank) + '</span>' +
      '<span class="c-suit">' + (card.joker ? '★' : esc(card.suitSymbol || '')) + '</span>' +
      '<span class="c-value">' + card.value + '</span>' +
      '</button>';
  }

  /* ================================================================== *
   * 挂载
   * ================================================================== */
  var SHELL = '' +
    '<header class="topbar">' +
      '<div class="brand">' +
        '<span class="brand-suit" aria-hidden="true">♠</span>' +
        '<div class="brand-text"><h1>扑克牌 · 比大小</h1><p>战前布局 · 战役消耗 · 战略决战</p></div>' +
      '</div>' +
      '<nav class="phase-banner" data-testid="phase-banner" aria-label="对局阶段">' +
        '<span class="phase-step" data-phase="layout"><span class="phase-num">1</span><span class="phase-name">战前布局</span></span>' +
        '<span class="phase-sep" aria-hidden="true">›</span>' +
        '<span class="phase-step" data-phase="battle"><span class="phase-num">2</span><span class="phase-name">战役消耗</span></span>' +
        '<span class="phase-sep" aria-hidden="true">›</span>' +
        '<span class="phase-step" data-phase="endgame"><span class="phase-num">3</span><span class="phase-name">战略决战</span></span>' +
      '</nav>' +
      '<div class="top-actions">' +
        '<div class="turn-timer" id="turn-timer" data-testid="turn-timer" data-state="off" data-total="30" data-remaining="30" role="timer" aria-label="回合倒计时" hidden>' +
          '<span class="tt-icon" aria-hidden="true">⏱</span>' +
          '<span class="tt-text" id="turn-timer-text">30s</span>' +
          '<i class="tt-bar" aria-hidden="true"><b id="turn-timer-fill"></b></i>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost btn-autoplay" data-testid="btn-autoplay" aria-pressed="false" aria-label="托管：由简单 AI 代打本地玩家" title="托管：由简单 AI 代打，可随时取消接管" hidden>托管</button>' +
        '<button type="button" class="btn btn-ghost btn-music" data-testid="btn-music-toggle" aria-label="背景音乐：开 · 音量 30%" aria-pressed="true" title="背景音乐：开 · 音量 30%（点击切换开关）"><span class="music-note" aria-hidden="true">♪</span></button>' +
        '<button type="button" class="btn btn-ghost btn-sfx" data-testid="btn-sfx-toggle" aria-label="音效：开 · 音量 70%" aria-pressed="true" title="音效：开 · 音量 70%（点击切换开关）"><span class="sfx-icon" aria-hidden="true">🔊</span></button>' +
        '<button type="button" class="btn btn-ghost btn-mobile-info" data-testid="btn-mobile-info" aria-label="显示/隐藏信息面板" title="显示/隐藏信息面板">信息</button>' +
        '<button type="button" class="btn btn-ghost" data-testid="btn-rules" aria-label="查看规则">规则</button>' +
        '<button type="button" class="btn btn-ghost" data-testid="btn-settings" aria-label="打开设置">设置</button>' +
      '</div>' +
    '</header>' +
    '<div class="lan-bar" id="lan-bar" hidden></div>' +
    '<div class="autoplay-banner" id="autoplay-banner" hidden></div>' +
    '<main class="table">' +
      '<section class="board">' +
        '<div class="seat seat-opponent" id="opponent-seat"></div>' +
        '<div class="regions" id="regions"></div>' +
        '<div class="seat seat-player" id="player-seat"></div>' +
      '</section>' +
      '<aside class="sidebar">' +
        '<button type="button" class="mobile-info-close" data-mobile-info-close aria-label="关闭信息面板">关闭 ✕</button>' +
        '<div class="stat-panel" id="stat-panel"></div>' +
        '<div class="log-panel">' +
          '<div class="panel-head"><h2>对局日志</h2><span class="log-count" id="log-count">0</span></div>' +
          '<div class="log-list" id="log-list" data-testid="log-list" aria-live="polite"></div>' +
        '</div>' +
      '</aside>' +
    '</main>' +
    '<footer class="actionbar">' +
      '<div class="action-buttons" id="action-buttons"></div>' +
      '<div class="action-meta">' +
        '<div class="action-status">' +
          '<div class="ap-meter" id="ap-meter" aria-live="polite">' +
            '<span class="ap-actor" id="ap-actor" hidden>对手</span>' +
            '<span class="ap-dots" id="ap-dots" aria-hidden="true"></span>' +
            '<b class="ap-text" id="action-points" data-testid="action-points" data-ap="0">行动点 — / 3</b>' +
          '</div>' +
          '<div class="turn-indicator" id="turn-indicator" data-testid="turn-indicator"></div>' +
        '</div>' +
        '<div class="action-hint" id="action-hint"></div>' +
      '</div>' +
    '</footer>' +
    '<div class="own-back-tooltip" id="own-back-tooltip" data-testid="own-back-tooltip" role="tooltip" hidden></div>' +
    '<div class="overlay-root" id="overlay-root"></div>' +
    '<div class="endgame-banner" id="endgame-banner" hidden></div>' +
    '<div class="endgame-skip" id="endgame-skip-notice" hidden></div>' +
    '<div class="toast-root"><div class="toast" id="toast" data-testid="toast" role="status" aria-live="polite"></div></div>' +
    '<div class="debug-badge" id="debug-badge" hidden></div>';

  /* ================================================================== *
   * v2.17：平台判定（Android APP / 桌面 Web）
   * 仅用于 Android 专属 UI（设置隐藏联机入口、滚动条加粗、触摸阈值），
   * 不改变桌面行为。?drag=0 是 v2.11.2 Android WebView 的旧 URL 标记，
   * v2.17 起只作平台识别，不再禁用拖拽；?android=1 供调试/E2E 强制模拟。
   * ================================================================== */
  function isAndroidPlatform() {
    try {
      if (root && root.__POKER_ANDROID) return true;
      var ua = String((root && root.navigator && root.navigator.userAgent) || '');
      if (/Android/i.test(ua)) return true;
      var search = String((root && root.location && root.location.search) || '');
      if (/(?:^|[?&])android=1(?:&|$)/.test(search)) return true;
      if (/(?:^|[?&])drag=0(?:&|$)/.test(search)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function initPlatform() {
    var isAndroid = isAndroidPlatform();
    try {
      if (root && root.document && root.document.body) {
        root.document.body.classList.toggle('is-android-app', isAndroid);
        root.document.body.setAttribute('data-platform', isAndroid ? 'android' : 'web');
      }
      if (root) root.PokerPlatform = { isAndroid: isAndroid, version: 'v2.17' };
    } catch (e) { /* ignore */ }
  }

  UI.init = function (callbacks) {
    handlers = callbacks || {};
    var app = document.getElementById('app');
    if (!app) throw new Error('缺少 #app 根节点');
    app.innerHTML = SHELL;
    initPlatform();
    el = {
      topbar: $('.topbar'),
      lanBar: $('#lan-bar'),
      autoplayToggle: $('[data-testid="btn-autoplay"]'),
      autoplayBanner: $('#autoplay-banner'),
      phaseBanner: $('[data-testid="phase-banner"]'),
      regions: $('#regions'),
      opponentSeat: $('#opponent-seat'),
      playerSeat: $('#player-seat'),
      statPanel: $('#stat-panel'),
      logList: $('#log-list'),
      logCount: $('#log-count'),
      actionButtons: $('#action-buttons'),
      apMeter: $('#ap-meter'),
      apDots: $('#ap-dots'),
      apActor: $('#ap-actor'),
      actionPoints: $('#action-points'),
      ownBackTooltip: $('#own-back-tooltip'),
      musicToggle: $('[data-testid="btn-music-toggle"]'),
      sfxToggle: $('[data-testid="btn-sfx-toggle"]'),
      turnTimer: $('#turn-timer'),
      turnTimerText: $('#turn-timer-text'),
      turnTimerFill: $('#turn-timer-fill'),
      hint: $('#action-hint'),
      turnIndicator: $('#turn-indicator'),
      overlayRoot: $('#overlay-root'),
      endgameBanner: $('#endgame-banner'),
      endgameSkip: $('#endgame-skip-notice'),
      toast: $('#toast'),
      debugBadge: $('#debug-badge')
    };
    bindStaticEvents();
  };

  /* ================================================================== *
   * 静态事件（委托）
   * ================================================================== */
  function bindStaticEvents() {
    var mobileInfoClose = document.querySelector('[data-mobile-info-close]');
    if (mobileInfoClose) {
      mobileInfoClose.addEventListener('click', function () {
        document.body.classList.remove('is-mobile-info-open');
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.body.classList.remove('is-mobile-info-open');
    });
    el.topbar.addEventListener('click', function (e) {
      var autoplayBtn = e.target.closest('[data-testid="btn-autoplay"]');
      if (autoplayBtn) {
        if (handlers.onToggleAutoplay) handlers.onToggleAutoplay();
        return;
      }
      var musicBtn = e.target.closest('[data-testid="btn-music-toggle"]');
      if (musicBtn) {
        if (handlers.onToggleMusic) handlers.onToggleMusic();
        return;
      }
      var sfxBtn = e.target.closest('[data-testid="btn-sfx-toggle"]');
      if (sfxBtn) {
        if (handlers.onToggleSfx) handlers.onToggleSfx();
        return;
      }
      var mobileInfoBtn = e.target.closest('[data-testid="btn-mobile-info"]');
      if (mobileInfoBtn) {
        document.body.classList.toggle('is-mobile-info-open');
        return;
      }
      var btn = e.target.closest('[data-testid="btn-rules"],[data-testid="btn-settings"]');
      if (!btn) return;
      if (btn.getAttribute('data-testid') === 'btn-rules') {
        if (handlers.onOpenRules) handlers.onOpenRules();
      } else if (handlers.onOpenSettings) {
        handlers.onOpenSettings();
      }
    });

    if (el.lanBar) {
      el.lanBar.addEventListener('click', function (e) {
        if (e.target.closest('[data-lan-leave]')) {
          if (handlers.onLanLeave) handlers.onLanLeave();
        } else if (e.target.closest('[data-lan-copy-code]')) {
          UI.copyText(lanBarCode());
        } else if (e.target.closest('[data-lan-copy-url]')) {
          UI.copyText(lanBarUrl());
        }
      });
    }

    el.regions.addEventListener('click', function (e) {
      var empty = e.target.closest('[data-empty-start]');
      if (empty) { if (handlers.onOpenSettings) handlers.onOpenSettings(); return; }
      var confirmBtn = e.target.closest('[data-testid="btn-confirm-layout"]');
      if (confirmBtn) { if (!confirmBtn.disabled && handlers.onConfirmLayout) handlers.onConfirmLayout(); return; }
      var clearBtn = e.target.closest('[data-testid="btn-clear-layout"]');
      if (clearBtn) { if (handlers.onClearLayout) handlers.onClearLayout(); return; }
      var slot = e.target.closest('[data-slot]');
      if (slot) {
        var slotIndex = Number(slot.getAttribute('data-slot'));
        var placedCardId = view && view.layoutSelectedHandCard;
        var handNode = placedCardId
          ? document.querySelector('#hand [data-testid="hand-card"][data-card-id="' + placedCardId + '"]')
          : null;
        var fromRect = handNode && handNode.getBoundingClientRect ? handNode.getBoundingClientRect() : null;
        var wasFilled = slot.classList.contains('is-filled');
        if (handlers.onLayoutSlotClick) handlers.onLayoutSlotClick(slotIndex);
        // 放牌 FLIP：手牌飞向槽位（渲染完成后用新 DOM 目标执行）
        if (!wasFilled && placedCardId && view && view.layoutSelection &&
            view.layoutSelection[slotIndex] === placedCardId) {
          var newSlot = el.regions.querySelector('[data-slot="' + slotIndex + '"]');
          UI.playLayoutPlace(placedCardId, fromRect, newSlot || slot);
        }
        return;
      }
      var back = e.target.closest('.back-btn');
      if (back) {
        showOwnBackTooltip(back);
        if (handlers.onRegionClick) {
          handlers.onRegionClick({
            regionId: Number(back.getAttribute('data-region-id')),
            cardId: back.getAttribute('data-card-id'),
            isBack: true
          });
        }
        return;
      }
      var region = e.target.closest('[data-region-id]');
      if (region) {
        if (handlers.onRegionClick) {
          handlers.onRegionClick({
            regionId: Number(region.getAttribute('data-region-id')),
            cardId: null,
            isBack: false
          });
        }
      }
    });

    // v1.4：己方背面牌真实牌面提示（hover / 键盘聚焦 / 触屏点击，仅自己可见）
    el.regions.addEventListener('mouseover', function (e) {
      var back = e.target.closest('.back-btn');
      if (back) showOwnBackTooltip(back);
    });
    el.regions.addEventListener('mouseout', function (e) {
      var back = e.target.closest('.back-btn');
      if (!back) return;
      if (e.relatedTarget && back.contains(e.relatedTarget)) return;
      hideOwnBackTooltip();
    });
    el.regions.addEventListener('focusin', function (e) {
      var back = e.target.closest('.back-btn');
      if (back) showOwnBackTooltip(back);
    });
    el.regions.addEventListener('focusout', function (e) {
      if (e.target.closest('.back-btn')) hideOwnBackTooltip();
    });
    el.regions.addEventListener('scroll', hideOwnBackTooltip, true);
    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest || !e.target.closest('.back-btn')) hideOwnBackTooltip();
    }, true);
    root.addEventListener('resize', hideOwnBackTooltip);
    root.addEventListener('scroll', hideOwnBackTooltip, true);

    el.playerSeat.addEventListener('click', function (e) {
      var card = e.target.closest('[data-testid="hand-card"]');
      if (!card || card.disabled) return;
      if (handlers.onHandClick) handlers.onHandClick(card.getAttribute('data-card-id'));
    });

    el.actionButtons.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      if (handlers.onActionClick) handlers.onActionClick(btn.getAttribute('data-action'));
    });

    document.addEventListener('keydown', function (e) {
      if (UI.handleKeydown(e)) return;
      if (handlers.onKeyDown) handlers.onKeyDown(e);
    }, false);

    // v1.5：按钮点击音（确认弹层的「确认」由 showConfirmSettle 播 ui.confirm，避免同一次点击重复）
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || btn.disabled) return;
      if (btn.closest('[data-confirm-ok]')) return;
      sfxPlay('ui.click');
    }, true);

    bindDragEvents();
  }

  /* ================================================================== *
   * v1.5 拖动（Pointer Events，与点击并存）
   * ================================================================== */
  var drag = {
    active: false, moved: false, pointerId: null, startX: 0, startY: 0,
    sourceEl: null, kind: null, cardId: null, regionId: null, slotIndex: null,
    ghost: null, ghostLabel: null, suppressClickUntil: 0, hoverEl: null, hoverKey: null,
    sourceRid: null, plan: null
  };
  var DRAG_THRESHOLD = 6;
  var DRAG_THRESHOLD_ANDROID = 8; // v2.17：Android 触屏恢复拖拽，略提高阈值以减少点按误触
  var DRAG_FALLBACK_COST = { flip: 2, move: 1, place: 1 };

  /* v2.17：拖拽改为可选设置（桌面默认开、安卓默认关）；null = 未显式设置时按平台默认 */
  var dragPreference = null;
  function setDragPreference(value) {
    if (value === true || value === 'on' || value === 1 || value === '1') dragPreference = true;
    else if (value === false || value === 'off' || value === 0 || value === '0') dragPreference = false;
    else dragPreference = null;
    return dragPreference;
  }
  function dragPreferenceDefault() { return !isAndroidPlatform(); }

  function dragEnabled() {
    // v2.17：拖拽为可选操作（设置面板可开关）；安卓默认关闭、桌面默认开启；关闭后仍可点选。
    if (root && root.__POKER_DISABLE_DRAG) return false;
    if (dragPreference === false) return false;
    if (dragPreference === null && !dragPreferenceDefault()) return false;
    if (!state || !view || view.busy) return false;
    if (view.trustee) return false; // v1.6 托管期间由 AI 代打，禁用本地拖拽
    if (state.phase === 'layout') return !view.layoutLocked;
    if (state.phase === 'battle') return state.turn === 'p1';
    return false;
  }

  UI.setDragEnabled = function (value) { setDragPreference(value); };
  UI.isDragEnabled = function () { return dragEnabled(); };

  /* v1.6：拖动期间的动作提示 / 合法性与引擎保持一致（提交前 main.js 仍会用 findLegal 复核） */
  function dragActionCost(action) {
    var e = eng();
    var costs = e && e.ACTION_COSTS;
    if (costs && costs[action] != null) return costs[action];
    return DRAG_FALLBACK_COST[action] != null ? DRAG_FALLBACK_COST[action] : 0;
  }

  function dragActionLabel(action) {
    if (action === 'flip') return '翻开';
    if (action === 'move') return '移牌';
    if (action === 'place') return '放牌';
    return '拖动';
  }

  function dragOwnAp() {
    if (!state || !state.players || !state.players.p1) return 0;
    var ap = Number(state.players.p1.ap);
    return isFinite(ap) ? ap : 0;
  }

  function dragEndgamePhase() {
    if (!state || !state.endgame) return '';
    return state.endgame.phase || (state.endgame.triggered ? 'build' : '');
  }

  /* 拖动开始时快照合法行动：背面牌 → flip（同区）/ move（异区）；手牌 → place */
  function buildDragPlan(kind, cardId, sourceRid) {
    var plan = { kind: kind, flip: false, moveTargets: {}, placeTargets: {}, ap: dragOwnAp(), endgamePhase: '' };
    if (!state || state.phase !== 'battle') return plan;
    plan.endgamePhase = dragEndgamePhase();
    var acts = (view && view.legalActions) || [];
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i];
      if (kind === 'back') {
        if (a.type === 'flip' && a.cardId === cardId && Number(a.regionId) === sourceRid) plan.flip = true;
        else if (a.type === 'move' && a.cardId === cardId && Number(a.fromRegionId) === sourceRid) {
          plan.moveTargets[Number(a.toRegionId)] = true;
        }
      } else if (kind === 'hand') {
        if (a.type === 'place' && a.cardId === cardId) plan.placeTargets[Number(a.regionId)] = true;
      }
    }
    return plan;
  }

  function dragInvalidReason(action, regionId) {
    var egp = dragEndgamePhase();
    if (egp === 'showdown' || egp === 'done') return '战略决战最终结算中，暂不可操作';
    var cost = dragActionCost(action);
    var ap = dragOwnAp();
    if (cost > ap) {
      var verb = action === 'flip' ? '翻牌' : action === 'move' ? '移牌' : '放牌';
      return verb + '需要 ' + cost + ' 点行动点（当前 ' + ap + ' 点）';
    }
    var region = state && state.regions ? state.regions[regionId] : null;
    if (region && region.status !== 'open') {
      if (action === 'flip') return '该区域已结算，无法翻牌';
      if (action === 'move') return '目标区域已结算，无法移牌';
      return '该区域已结算，无法放牌';
    }
    if (action === 'flip') return '该牌当前不可翻开';
    if (action === 'move') return '无法移动到该区域';
    return '无法放入该区域';
  }

  function dragHintForTarget(target) {
    if (!target || target.type !== 'region') return null;
    var rid = Number(target.regionId);
    var action;
    var valid = false;
    if (drag.kind === 'back') {
      var same = drag.sourceRid != null && rid === drag.sourceRid;
      action = same ? 'flip' : 'move';
      valid = !!drag.plan && (same ? !!drag.plan.flip : !!drag.plan.moveTargets[rid]);
    } else if (drag.kind === 'hand') {
      action = 'place';
      valid = !!drag.plan && !!drag.plan.placeTargets[rid];
    } else {
      return null;
    }
    return { action: action, valid: valid, reason: valid ? '' : dragInvalidReason(action, rid) };
  }

  function dragBadgeHTML(hint) {
    var label = esc(dragActionLabel(hint.action));
    if (!hint.valid) {
      return '<span class="dab-label">' + label + '</span>' +
        '<span class="dab-reason">' + esc(hint.reason || '不可用') + '</span>';
    }
    return '<span class="dab-label">' + label + '</span>' +
      '<span class="dab-cost">' + dragActionCost(hint.action) + ' AP</span>';
  }

  function dragSetGhostLabel(text) {
    var label = drag.ghostLabel;
    if (!label) return;
    if (text) { label.textContent = text; label.hidden = false; }
    else { label.textContent = ''; label.hidden = true; }
  }

  function dragDefaultGhostLabel() {
    if (drag.kind === 'back') return '拖回本区域 = 翻开 · 其他区域 = 移牌';
    if (drag.kind === 'hand' && state && state.phase === 'battle') return '拖到区域 = 放牌';
    return '';
  }

  /* 悬停区域：加 is-drop-hover + data-drop-action/data-drop-valid + drop-action-badge（testid） */
  function dragApplyHover(hoverEl, hint) {
    if (!hoverEl) {
      dragClearHighlight();
      dragSetGhostLabel(dragDefaultGhostLabel());
      return;
    }
    var key = hint ? hint.action + '|' + (hint.valid ? '1' : '0') : 'none';
    if (drag.hoverEl === hoverEl && drag.hoverKey === key) return;
    dragClearHighlight();
    drag.hoverEl = hoverEl;
    drag.hoverKey = key;
    hoverEl.classList.add('is-drop-hover');
    if (!hint) { dragSetGhostLabel(dragDefaultGhostLabel()); return; }
    hoverEl.setAttribute('data-drop-action', hint.action);
    hoverEl.setAttribute('data-drop-valid', hint.valid ? 'true' : 'false');
    hoverEl.classList.add(hint.valid ? 'is-drop-valid' : 'is-drop-invalid');
    hoverEl.classList.add(hint.action === 'flip' ? 'is-drop-flip'
      : hint.action === 'move' ? 'is-drop-move' : 'is-drop-place');
    var badge = document.createElement('span');
    badge.className = 'drop-action-badge ' + (hint.valid ? 'is-valid' : 'is-invalid');
    badge.setAttribute('data-testid', 'drop-action-badge');
    badge.setAttribute('data-drop-action', hint.action);
    badge.setAttribute('data-drop-valid', hint.valid ? 'true' : 'false');
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = dragBadgeHTML(hint);
    hoverEl.appendChild(badge);
    // 当前落点动作由区域徽标展示，ghost 标签让位避免重复
    dragSetGhostLabel('');
  }

  function onDragPointerDown(e) {
    if (!dragEnabled()) return;
    if (e.button != null && e.button !== 0) return;
    var node = e.target && e.target.closest ? e.target.closest('[data-draggable]') : null;
    if (!node) return;
    var kind = node.getAttribute('data-draggable');
    if (!kind) return;
    drag.active = true;
    drag.moved = false;
    drag.pointerId = e.pointerId;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.sourceEl = node;
    drag.kind = kind;
    drag.cardId = node.getAttribute('data-card-id');
    drag.regionId = node.getAttribute('data-region-id');
    drag.slotIndex = node.getAttribute('data-slot');
    drag.hoverEl = null;
    drag.hoverKey = null;
    drag.sourceRid = node.getAttribute('data-region-id') != null
      ? Number(node.getAttribute('data-region-id')) : null;
    drag.plan = (kind === 'back' || (kind === 'hand' && state && state.phase === 'battle'))
      ? buildDragPlan(kind, drag.cardId, drag.sourceRid) : null;
  }

  function dragGhostCreate() {
    var ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.setAttribute('data-testid', 'drag-ghost');
    ghost.setAttribute('data-drag-kind', drag.kind || '');
    ghost.setAttribute('aria-hidden', 'true');
    var clone = drag.sourceEl.cloneNode(true);
    clone.removeAttribute('data-testid');
    clone.removeAttribute('data-draggable');
    clone.removeAttribute('id');
    var ids = clone.querySelectorAll('[id]');
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute('id');
    clone.classList.add('drag-ghost-card');
    if (drag.sourceEl.classList.contains('layout-slot')) {
      clone.classList.remove('layout-slot');
      clone.classList.add('drag-ghost-slot');
    }
    ghost.appendChild(clone);
    // v1.6：ghost 上跟随显示当前落点动作（翻开 / 移牌 / 放牌）
    var label = document.createElement('span');
    label.className = 'drag-ghost-action';
    label.setAttribute('data-testid', 'drag-ghost-action');
    label.hidden = true;
    ghost.appendChild(label);
    drag.ghostLabel = label;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    if (drag.sourceEl) drag.sourceEl.classList.add('is-drag-source');
    document.body.classList.add('is-dragging');
  }

  function dragGhostMove(x, y) {
    if (!drag.ghost) return;
    drag.ghost.style.left = x + 'px';
    drag.ghost.style.top = y + 'px';
  }

  var DRAG_HOVER_CLASSES = ['is-drop-hover', 'is-drop-valid', 'is-drop-invalid',
    'is-drop-flip', 'is-drop-move', 'is-drop-place'];

  function dragClearHighlight() {
    if (drag.hoverEl) {
      var el = drag.hoverEl;
      for (var i = 0; i < DRAG_HOVER_CLASSES.length; i++) el.classList.remove(DRAG_HOVER_CLASSES[i]);
      el.removeAttribute('data-drop-action');
      el.removeAttribute('data-drop-valid');
      var badge = el.querySelector('[data-testid="drop-action-badge"]');
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      drag.hoverEl = null;
    }
    drag.hoverKey = null;
  }

  function dragFindTarget(x, y) {
    var node = document.elementFromPoint(x, y);
    if (!node) return null;
    if (state && state.phase === 'layout') {
      if (drag.kind === 'hand') {
        var slot = node.closest ? node.closest('.layout-slot[data-slot]') : null;
        if (slot && !slot.classList.contains('is-filled') && !slot.disabled) {
          return { type: 'slot', index: Number(slot.getAttribute('data-slot')), el: slot };
        }
        return null;
      }
      if (drag.kind === 'slot') {
        var hand = node.closest ? node.closest('[data-testid="hand"]') : null;
        var seat = node.closest ? node.closest('[data-testid="player-seat"]') : null;
        if (hand || seat) return { type: 'hand', el: hand || seat };
        return null;
      }
      return null;
    }
    var region = node.closest ? node.closest('.region[data-region-id]') : null;
    if (region) return { type: 'region', regionId: Number(region.getAttribute('data-region-id')), el: region };
    return null;
  }

  function onDragPointerMove(e) {
    if (!drag.active) return;
    if (drag.pointerId != null && e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      var th = (root && root.PokerPlatform && root.PokerPlatform.isAndroid) ? DRAG_THRESHOLD_ANDROID : DRAG_THRESHOLD;
      if (dx * dx + dy * dy < th * th) return;
      drag.moved = true;
      dragGhostCreate();
    }
    if (e.cancelable) { try { e.preventDefault(); } catch (err) { /* ignore */ } }
    dragGhostMove(e.clientX, e.clientY);
    var target = dragFindTarget(e.clientX, e.clientY);
    dragApplyHover(target && target.el ? target.el : null, dragHintForTarget(target));
  }

  function onDragPointerUp(e) {
    if (!drag.active) return;
    if (drag.pointerId != null && e.pointerId !== drag.pointerId) return;
    var wasMoved = drag.moved;
    var target = wasMoved ? dragFindTarget(e.clientX, e.clientY) : null;
    var detail = {
      kind: drag.kind,
      cardId: drag.cardId,
      regionId: drag.regionId != null ? Number(drag.regionId) : null,
      slotIndex: drag.slotIndex != null ? Number(drag.slotIndex) : null,
      target: target ? { type: target.type, index: target.index, regionId: target.regionId } : null
    };
    dragCleanup();
    if (!wasMoved) return;
    // 拖拽结束后的 click 不应再被当成点击（避免重复触发选择/提交）
    drag.suppressClickUntil = Date.now() + 500;
    if (target && handlers.onDragDrop) handlers.onDragDrop(detail);
  }

  function dragCleanup() {
    drag.active = false;
    drag.moved = false;
    drag.pointerId = null;
    if (drag.sourceEl) {
      drag.sourceEl.classList.remove('is-drag-source');
      drag.sourceEl = null;
    }
    drag.kind = null;
    drag.cardId = null;
    drag.regionId = null;
    drag.slotIndex = null;
    drag.sourceRid = null;
    drag.plan = null;
    drag.ghostLabel = null;
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag.ghost = null;
    dragClearHighlight();
    // 兜底清理：hoverEl 引用失效 / 重渲染残留时也不留下高亮、徽标与高亮 class
    var marked = document.querySelectorAll('.is-drop-hover, .is-drop-valid, .is-drop-invalid, ' +
      '.is-drop-flip, .is-drop-move, .is-drop-place');
    for (var i = 0; i < marked.length; i++) {
      for (var c = 0; c < DRAG_HOVER_CLASSES.length; c++) marked[i].classList.remove(DRAG_HOVER_CLASSES[c]);
      marked[i].removeAttribute('data-drop-action');
      marked[i].removeAttribute('data-drop-valid');
    }
    var badges = document.querySelectorAll('[data-testid="drop-action-badge"]');
    for (var b = 0; b < badges.length; b++) {
      if (badges[b].parentNode) badges[b].parentNode.removeChild(badges[b]);
    }
    var sources = document.querySelectorAll('.is-drag-source');
    for (var s = 0; s < sources.length; s++) sources[s].classList.remove('is-drag-source');
    document.body.classList.remove('is-dragging');
  }

  function bindDragEvents() {
    el.regions.addEventListener('pointerdown', onDragPointerDown, false);
    el.playerSeat.addEventListener('pointerdown', onDragPointerDown, false);
    document.addEventListener('pointermove', onDragPointerMove, { capture: true, passive: false });
    document.addEventListener('pointerup', onDragPointerUp, true);
    document.addEventListener('pointercancel', function () { if (drag.active) dragCleanup(); }, true);
    document.addEventListener('click', function (e) {
      if (Date.now() < drag.suppressClickUntil) {
        drag.suppressClickUntil = 0;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && drag.active) {
        dragCleanup();
        drag.suppressClickUntil = Date.now() + 300;
        e.stopPropagation();
      }
    }, true);
  }

  /* ================================================================== *
   * 新战略决战：阶段辅助 / 状态横幅
   * ================================================================== */
  function endgameInfo() {
    if (!state || !state.endgame) return null;
    if (state.endgame.triggered || state.endgame.phase) return state.endgame;
    return null;
  }

  function endgamePhase() {
    var eg = endgameInfo();
    if (!eg) return '';
    if (eg.phase === 'build' || eg.phase === 'showdown' || eg.phase === 'done') return eg.phase;
    return '';
  }

  function openRegionCount() {
    if (eng().getOpenRegionIds) return eng().getOpenRegionIds(state).length;
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) if (state.regions[i].status === 'open') n++;
    return n;
  }

  function backsCount(pid) {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) n += state.regions[i].sides[pid].faceDown.length;
    return n;
  }

  function endgameDrawPerPlayer(eg) {
    if (eg && eg.drawPerPlayer != null) return Number(eg.drawPerPlayer) || 0;
    // 决战触发时双方各摸「剩余区域数」张（合计 2×剩余区域数，刚好摸空牌堆）
    return openRegionCount();
  }

  function renderEndgameBanner() {
    if (!el.endgameBanner) return;
    var eg = endgameInfo();
    var phase = endgamePhase();
    var active = state.phase === 'battle' && eg && (phase === 'build' || phase === 'showdown');
    if (!active) {
      el.endgameBanner.hidden = true;
      el.endgameBanner.innerHTML = '';
      el.endgameBanner.removeAttribute('data-phase');
      el.endgameBanner.removeAttribute('data-testid');
      if (el.endgameSkip) {
        el.endgameSkip.hidden = true;
        el.endgameSkip.innerHTML = '';
        el.endgameSkip.removeAttribute('data-testid');
      }
      return;
    }
    var open = openRegionCount();
    el.endgameBanner.hidden = false;
    el.endgameBanner.setAttribute('data-phase', phase);
    if (phase === 'build') {
      el.endgameBanner.setAttribute('data-testid', 'endgame-build-banner');
      el.endgameBanner.className = 'endgame-banner is-build';
      el.endgameBanner.innerHTML =
        '<div class="eg-main"><span class="eg-kicker">战略决战 · 最终部署</span>' +
          '<span class="eg-text">摸牌 / 结算已禁用 · 每回合 3 行动点，可连续翻牌（2）/ 放牌（1）/ 移牌（1）· 行动点上限规则：主动结束回合时未花完行动点 → 之后回合上限 -1；用尽行动点 → +1（最高 3）；上限降到 0 即判负 · 无牌可动自动跳过该方回合</span></div>' +
        '<div class="eg-res">' +
          '<span class="eg-side side-p1">你 手牌 <b>' + state.players.p1.hand.length + '</b> · 背面 <b>' + backsCount('p1') + '</b></span>' +
          '<span class="eg-side side-p2">' + esc(playerName('p2')) + ' 手牌 <b>' + state.players.p2.hand.length + '</b> · 背面 <b>' + backsCount('p2') + '</b></span>' +
          '<span class="eg-lock">剩余 ' + open + ' 区 · 补牌 ' +
            ((eg.drawnCounts && eg.drawnCounts.p1 != null) ? eg.drawnCounts.p1 : endgameDrawPerPlayer(eg)) + ' / ' +
            ((eg.drawnCounts && eg.drawnCounts.p2 != null) ? eg.drawnCounts.p2 : endgameDrawPerPlayer(eg)) + ' 张</span>' +
        '</div>';
    } else {
      el.endgameBanner.setAttribute('data-testid', 'endgame-showdown-banner');
      el.endgameBanner.className = 'endgame-banner is-showdown';
      el.endgameBanner.innerHTML =
        '<div class="eg-main"><span class="eg-kicker">战略决战 · 最终结算</span>' +
          '<span class="eg-text">双方无牌可动：按各区域当前正面牌点数比较（无补牌 · 无随机 · 不执行难度规则）</span></div>';
    }
    if (el.endgameSkip) {
      var skipped = eg.skipped || {};
      var parts = [];
      if (skipped.p1) parts.push(playerName('p1'));
      if (skipped.p2) parts.push(playerName('p2'));
      if (parts.length && phase === 'build') {
        el.endgameSkip.hidden = false;
        el.endgameSkip.setAttribute('data-testid', 'endgame-skip-notice');
        el.endgameSkip.innerHTML = '<span class="eg-skip-dot" aria-hidden="true"></span>' +
          esc(parts.join(' / ')) + ' 已无牌可翻/可放，回合被跳过 · 另一方连续行动';
      } else {
        el.endgameSkip.hidden = true;
        el.endgameSkip.innerHTML = '';
        el.endgameSkip.removeAttribute('data-testid');
      }
    }
  }

  /* ================================================================== *
   * 总渲染
   * ================================================================== */
  UI.render = function (nextState, nextView) {
    state = nextState || null;
    view = nextView || view || defaultView();
    if (!state) { renderEmpty(); return; }
    renderPhase();
    renderTrustee();
    renderEndgameBanner();
    renderSeats();
    renderRegions();
    renderStats();
    renderActions();
    renderHintAndTurn();
    renderLog();
    renderDebug();
    renderLanBar();
  };

  function renderEmpty() {
    state = null;
    if (el.lanBar) { el.lanBar.hidden = true; el.lanBar.innerHTML = ''; }
    renderTrustee();
    if (el.endgameBanner) {
      el.endgameBanner.hidden = true;
      el.endgameBanner.innerHTML = '';
      el.endgameBanner.removeAttribute('data-testid');
    }
    if (el.endgameSkip) {
      el.endgameSkip.hidden = true;
      el.endgameSkip.innerHTML = '';
      el.endgameSkip.removeAttribute('data-testid');
    }
    var steps = el.phaseBanner.querySelectorAll('.phase-step');
    for (var i = 0; i < steps.length; i++) steps[i].classList.remove('is-active', 'is-done');
    el.opponentSeat.innerHTML =
      '<div class="seat-inner"><div class="seat-avatar avatar-p2" aria-hidden="true">电</div>' +
      '<div class="seat-info"><div class="seat-line"><span class="seat-name">电脑</span></div>' +
      '<div class="seat-sub">等待对局开始</div></div></div>';
    el.regions.classList.remove('is-layout', 'is-revealing');
    el.regions.innerHTML =
      '<div class="empty-state">' +
        '<span class="empty-mark" aria-hidden="true">♠ ♥ ♦ ♣</span>' +
        '<h2>牌桌已就绪</h2>' +
        '<p>战前布局 → 战役消耗 → 战略决战。调整难度、区域数、结算随机性与电脑强度后开始对局。</p>' +
        '<button type="button" class="btn btn-primary btn-lg" data-empty-start>开始新对局</button>' +
      '</div>';
    el.playerSeat.innerHTML =
      '<div class="seat-inner"><div class="seat-avatar avatar-p1" aria-hidden="true">你</div>' +
      '<div class="seat-info"><div class="seat-line"><span class="seat-name">你</span></div>' +
      '<div class="seat-sub">点击「开始新对局」进入牌桌</div></div></div>';
    el.statPanel.innerHTML = statsEmptyHTML();
    el.actionButtons.innerHTML = '';
    hideOwnBackTooltip();
    renderActionPoints(null);
    el.logList.innerHTML = '<div class="log-empty">暂无记录</div>';
    el.logCount.textContent = '0';
    el.hint.textContent = '调整设置后开始对局';
    el.turnIndicator.className = 'turn-indicator is-neutral';
    el.turnIndicator.innerHTML = '<span class="turn-text">等待开始</span>';
    el.debugBadge.hidden = true;
  }

  function renderPhase() {
    var order = ['layout', 'battle', 'endgame'];
    var active = state.phase === 'layout' ? 'layout'
      : state.phase === 'battle' ? (state.endgame && state.endgame.triggered ? 'endgame' : 'battle')
      : 'endgame';
    var activeIdx = order.indexOf(active);
    var steps = el.phaseBanner.querySelectorAll('.phase-step');
    for (var i = 0; i < steps.length; i++) {
      steps[i].classList.toggle('is-active', i === activeIdx);
      steps[i].classList.toggle('is-done', i < activeIdx);
    }
    el.phaseBanner.setAttribute('data-phase', state.phase);
  }

  /* v1.6/v1.7 托管：顶栏开关（单机 + 联机对局显示，大厅/终局隐藏）+ 托管横幅 + 本地操作区锁定 */
  function renderTrustee() {
    var trustee = !!(view && view.trustee);
    var lan = isLanView();
    var showBtn = !(view && view.autoplayDemo) && !!state &&
      (state.phase === 'layout' || state.phase === 'battle');
    if (el.autoplayToggle) {
      el.autoplayToggle.hidden = !showBtn;
      el.autoplayToggle.classList.toggle('is-active', showBtn && trustee);
      el.autoplayToggle.setAttribute('aria-pressed', showBtn && trustee ? 'true' : 'false');
      el.autoplayToggle.textContent = showBtn && trustee ? '取消托管' : '托管';
      el.autoplayToggle.title = showBtn && trustee
        ? (lan ? '托管中（简单 AI）：联机对局中代打，点击取消并接管操作'
          : '托管中（简单 AI）：点击取消并接管操作')
        : (lan ? '托管：由简单 AI 代打本地玩家（联机对局可用），可随时取消接管'
          : '托管：由简单 AI 代打，可随时取消接管');
      el.autoplayToggle.setAttribute('aria-label', showBtn && trustee
        ? '取消托管：接管本地操作'
        : (lan ? '托管：由简单 AI 代打本地玩家（联机）' : '托管：由简单 AI 代打本地玩家'));
    }
    if (el.autoplayBanner) {
      if (!trustee) {
        el.autoplayBanner.hidden = true;
        el.autoplayBanner.innerHTML = '';
        el.autoplayBanner.removeAttribute('data-testid');
        el.autoplayBanner.removeAttribute('data-phase');
        el.autoplayBanner.removeAttribute('data-mode');
      } else {
        var phaseText = state && state.phase === 'layout'
          ? (lan ? '联机自动布阵中' : '自动布阵中')
          : (lan ? '联机代打中' : '代打中');
        el.autoplayBanner.hidden = false;
        el.autoplayBanner.setAttribute('data-testid', 'autoplay-banner');
        el.autoplayBanner.setAttribute('data-phase', state ? state.phase : '');
        el.autoplayBanner.setAttribute('data-ai-strength', 'easy');
        el.autoplayBanner.setAttribute('data-mode', lan ? 'lan' : 'solo');
        el.autoplayBanner.innerHTML =
          '<span class="ab-dot" aria-hidden="true"></span>' +
          '<span class="ab-text">托管中（简单 AI）· ' + phaseText + ' · 点顶栏「取消托管」接管</span>';
      }
    }
    if (root.document && root.document.body) {
      root.document.body.classList.toggle('is-trustee', trustee);
    }
  }

  function renderSeats() {
    var p1 = state.players.p1;
    var p2 = state.players.p2;
    var cfg = state.config;
    var p2First = cfg.firstPlayer === 'p2';
    var p1First = cfg.firstPlayer === 'p1';
    var handSum1 = eng().getHandSum ? eng().getHandSum(state, 'p1') : 0;

    el.opponentSeat.innerHTML =
      '<div class="seat-inner">' +
        '<div class="seat-avatar avatar-p2" aria-hidden="true">' + esc(shortName('p2')) + '</div>' +
        '<div class="seat-info">' +
          '<div class="seat-line"><span class="seat-name">' + esc(p2.name) + '</span>' +
          '<span class="seat-tag ' + (p2First ? 'is-first' : 'is-second') + '">' + (p2First ? '先手' : '后手') + '</span>' +
          (isLanView() && !lanOpponentOnline() ? '<span class="seat-tag is-offline" data-testid="lan-opponent-offline">已断开</span>' : '') +
          '</div>' +
          '<div class="seat-sub">区域胜场 <b>' + state.regionWins.p2 + '</b> · 手牌 <b data-testid="opp-hand-count">' + p2.hand.length + '</b> 张</div>' +
        '</div>' +
        '<div class="opp-hand-stack" aria-hidden="true">' + oppBacksHTML(p2.hand.length) + '</div>' +
      '</div>';

    var used = {};
    if (state.phase === 'layout' && view.layoutSelection) {
      for (var i = 0; i < view.layoutSelection.length; i++) {
        if (view.layoutSelection[i]) used[view.layoutSelection[i]] = i;
      }
    }
    var handHTML = '';
    if (!p1.hand.length) {
      handHTML = '<div class="hand-empty">手牌已空</div>';
    } else {
      for (var k = 0; k < p1.hand.length; k++) {
        var card = p1.hand[k];
        var isUsed = used[card.id] != null;
        var selected = view.layoutSelectedHandCard === card.id || view.selectedHandCardId === card.id;
        handHTML += handCardHTML(card, {
          selected: selected,
          used: isUsed ? used[card.id] : null
        });
      }
    }
    el.playerSeat.innerHTML =
      '<div class="seat-inner">' +
        '<div class="seat-avatar avatar-p1" aria-hidden="true">' + esc(shortName('p1')) + '</div>' +
        '<div class="seat-info">' +
          '<div class="seat-line"><span class="seat-name">' + esc(p1.name) + '</span>' +
          '<span class="seat-tag ' + (p1First ? 'is-first' : 'is-second') + '">' + (p1First ? '先手' : '后手') + '</span></div>' +
          '<div class="seat-sub">区域胜场 <b>' + state.regionWins.p1 + '</b> · 手牌 <b>' + p1.hand.length + '</b> 张 · 手牌总和 <b>' + handSum1 + '</b></div>' +
        '</div>' +
        '<div class="hand" id="hand" data-testid="hand">' + handHTML + '</div>' +
      '</div>';
  }

  function oppBacksHTML(count) {
    if (count <= 0) return '<span class="opp-hand-empty">无手牌</span>';
    var shown = Math.min(count, 7);
    var html = '';
    for (var i = 0; i < shown; i++) {
      html += '<span class="card card-back card-tiny back-offset" style="--i:' + i + '" aria-hidden="true"></span>';
    }
    html += '<span class="opp-hand-count">×' + count + '</span>';
    return html;
  }

  /* ================================================================== *
   * 区域 / 布局
   * ================================================================== */
  function renderRegions() {
    var R = state.config.regionCount;
    el.regions.style.setProperty('--cols', String(R));
    if (state.phase === 'layout') {
      el.regions.classList.add('is-layout');
      hideOwnBackTooltip();
      el.regions.innerHTML = layoutPanelHTML();
      return;
    }
    el.regions.classList.remove('is-layout');
    hideOwnBackTooltip();
    var legal = buildLegalSets();
    var html = '';
    for (var i = 0; i < state.regions.length; i++) html += regionHTML(state.regions[i], legal);
    el.regions.innerHTML = html;
  }

  function layoutPanelHTML() {
    var R = state.config.regionCount;
    var p1First = state.config.firstPlayer === 'p1';
    var lan = isLanView();
    var offline = lan && !lanOpponentOnline();
    var locked = !!(lan && (view.layoutLocked || offline));
    var trustee = !!(view && view.trustee);
    var oppName = playerName('p2');
    var count = 0;
    var slots = '';
    for (var i = 0; i < R; i++) {
      var cardId = view.layoutSelection[i];
      var card = cardId ? findHandCard(cardId) : null;
      if (card) count++;
      slots += '<button type="button" class="layout-slot' + (card ? ' is-filled' : '') +
        (view.layoutSelectedHandCard && !locked ? ' is-ready' : '') + (locked ? ' is-locked' : '') + '"' +
        ' data-testid="layout-slot-' + i + '" data-slot="' + i + '"' +
        (card && !locked && !trustee ? ' data-draggable="slot"' : '') + (locked || trustee ? ' disabled' : '') +
        ' aria-label="区域 ' + (i + 1) + (card ? '，已背面放置一张牌，点击取回' : '，空槽位，点击放置') + '">' +
        '<span class="slot-name">区域 ' + (i + 1) + '</span>' +
        '<span class="slot-body">' + (card ? ownHiddenCardHTML(card, 'slot-card') : '<span class="slot-empty">+</span>') + '</span>' +
        '<span class="slot-hint">' + (locked ? '已提交' : trustee ? '托管布阵中' : card ? '半透明可见 · 点击取回' : '点击放置') + '</span>' +
        '</button>';
    }
    var selectedCard = view.layoutSelectedHandCard ? findHandCard(view.layoutSelectedHandCard) : null;
    var comp = compensationDrawCount();
    var hint;
    if (locked) {
      hint = offline
        ? '对手已断开，等待重连后再继续布阵…'
        : '已提交布阵，等待 ' + oppName + ' 布阵… 双方都提交后同时揭示';
    } else if (trustee) {
      hint = lan
        ? '托管中：简单 AI 正在自动布阵并提交（联机），点顶栏「取消托管」接管'
        : '托管中：简单 AI 正在自动布阵，点顶栏「取消托管」接管';
    } else {
      hint = '从 ' + state.players.p1.hand.length + ' 张手牌中选出 ' + R +
        ' 张，背面朝上放入 ' + R + ' 个区域 · 双方布阵完成后同时揭示 · ' +
        (lan ? playerName('p1') : '你') + (p1First ? ' 先手' : ' 后手（揭示后额外补 ' + comp + ' 张）') +
        (selectedCard ? ' · 已选一张手牌，点击区域槽位放置' : ' · 先点手牌，再点区域槽位');
    }
    return '<div class="layout-panel' + (locked ? ' is-locked' : '') + (trustee ? ' is-trustee' : '') +
      '" data-testid="layout-panel"' +
      ' data-anim-state="' + (locked || trustee ? 'revealing' : 'dealing') + '">' +
      '<div class="layout-head">' +
        '<div><span class="layout-kicker">战前布局</span><p class="layout-hint" data-testid="layout-hint">' + esc(hint) + '</p></div>' +
        '<div class="layout-progress"><span>已选 <b>' + count + '</b> / ' + R + '</span><span class="layout-mini">' +
          (locked ? '等待对手布阵…' : trustee ? '托管中 · 简单 AI' : '双方同时揭示 · 后手补 ' + comp + ' 张') + '</span></div>' +
      '</div>' +
      '<div class="layout-slots" style="--cols:' + R + '">' + slots + '</div>' +
      '<div class="layout-controls">' +
        '<span class="layout-tip">' + (locked
          ? '操作已锁定，等待对手完成布阵'
          : trustee
            ? '托管中：简单 AI 正在自动布阵，点顶栏「取消托管」接管'
            : '已放入区域的牌在手牌区显示正面与区域角标（仅自己可见）；槽位取回后可重新选择') + '</span>' +
        '<div class="layout-btns">' +
          (locked ? '' : '<button type="button" class="btn btn-ghost" data-testid="btn-clear-layout"' +
            (trustee ? ' disabled' : '') + '>清空重选</button>') +
          '<button type="button" class="btn btn-primary" data-testid="btn-confirm-layout"' +
            (count < R || locked || trustee ? ' disabled' : '') + '>' +
            (locked ? '已提交布阵' : trustee ? '托管布阵中…' : '确认布阵 <span>' + count + '/' + R + '</span>') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function buildLegalSets() {
    var legal = { settle: {}, flip: {}, place: {}, moveSelect: {}, moveTargets: {} };
    if (!state || state.phase !== 'battle') return legal;
    var acts = view.legalActions || [];
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i];
      if (a.type === 'settle') legal.settle[a.regionId] = true;
      else if (a.type === 'flip') legal.flip[a.cardId] = a.regionId;
      else if (a.type === 'place') legal.place[a.regionId] = true;
      else if (a.type === 'move') {
        legal.moveSelect[a.cardId] = a.fromRegionId;
        if (view.moveSource && view.moveSource.cardId === a.cardId) legal.moveTargets[a.toRegionId] = true;
      }
    }
    return legal;
  }

  function regionHTML(region, legal) {
    if (region.status !== 'open') return settledRegionHTML(region);
    var rid = region.id;
    var p1s = sumSide(region, 'p1');
    var p2s = sumSide(region, 'p2');
    // v1.4：任意未结算区域均可结算（不再要求区域内正面牌 > 2），仅保留牌堆/决战阶段限制
    var settleable = regionSettleable();
    var settleBadge = settleable ? '可结算' : (endgamePhase() ? '决战阶段不可结算' : '牌堆不足，暂不可结算');
    var cls = ['region'];
    if (settleable) cls.push('is-settleable');

    var target = false;
    var dim = false;
    if (view.mode === 'settle') {
      target = !!legal.settle[rid];
      dim = !target;
    } else if (view.mode === 'place') {
      target = !!legal.place[rid];
      dim = !target;
    } else if (view.mode === 'move' && view.moveSource) {
      target = !!legal.moveTargets[rid];
      dim = !target && rid !== view.moveSource.regionId;
    } else if (view.mode === 'flip') {
      dim = true;
    }
    if (target) cls.push('is-target');
    if (dim) cls.push('is-dim');
    if (view.selectedRegionId === rid) cls.push('is-picked');

    var diff = p1s - p2s;
    var diffCls = diff > 0 ? 'is-plus' : (diff < 0 ? 'is-minus' : 'is-even');
    var diffText = diff === 0 ? '持平' : (diff > 0 ? '+' + diff : String(diff));

    var p2Cards = '';
    for (var i = 0; i < region.sides.p2.faceUp.length; i++) p2Cards += miniCard(region.sides.p2.faceUp[i]);
    if (!p2Cards) p2Cards = '<span class="card-empty">尚未亮牌</span>';

    var p1Cards = '';
    for (var j = 0; j < region.sides.p1.faceUp.length; j++) p1Cards += miniCard(region.sides.p1.faceUp[j]);
    if (!p1Cards) p1Cards = '<span class="card-empty">尚未亮牌</span>';

    var ownBacks = '';
    var ownBackCards = region.sides.p1.faceDown;
    for (var k = 0; k < ownBackCards.length; k++) {
      var card = ownBackCards[k];
      var canFlip = view.mode === 'flip' && legal.flip[card.id] != null;
      var canMove = view.mode === 'move' && legal.moveSelect[card.id] != null;
      var clickable = canFlip || canMove;
      var isSource = view.moveSource && view.moveSource.cardId === card.id;
      var tip = ownBackTipText(card);
      var dragHint = ownBackDragHint();
      ownBacks += '<button type="button" class="card card-mini card-back back-btn own-back' +
        (card.red ? ' is-red' : '') + (card.joker ? ' is-joker' : '') +
        (clickable ? ' is-clickable' : '') + (isSource ? ' is-source' : '') + '"' +
        ' data-card-id="' + esc(card.id) + '" data-region-id="' + rid + '" data-draggable="back"' +
        (tip ? ' data-tip="' + esc(tip) + '"' : '') +
        ' title="' + esc((tip ? tip + '（仅自己可见） · ' : '') + dragHint) + '"' +
        ' aria-label="' + esc((tip
          ? '我方背面牌：' + tip + '，位于区域 ' + (rid + 1) + '，仅自己可见'
          : '我方背面牌，位于区域 ' + (rid + 1)) + '；' + dragHint + '；点击可翻开或移动') + '">' +
        ownHiddenFaceHTML(card) + '</button>';
    }
    if (!ownBacks) ownBacks = '<span class="back-empty">无</span>';

    var oppBacks = '';
    var oppBackCards = region.sides.p2.faceDown;
    for (var m = 0; m < oppBackCards.length; m++) {
      oppBacks += backCard('back-tiny');
    }
    if (!oppBacks) oppBacks = '<span class="back-empty">无</span>';

    return '<article class="' + cls.join(' ') + '" data-testid="region-' + rid + '" data-region-id="' + rid +
      '" data-status="open" data-settleable="' + settleable + '" aria-label="区域 ' + (rid + 1) + '，' +
      (settleable ? '可结算' : settleBadge) + '">' +
      '<header class="region-head">' +
        '<span class="region-name">区域 ' + (rid + 1) + '</span>' +
        '<span class="region-badge' + (settleable ? ' is-ready' : '') + '" data-testid="region-' + rid + '-status">' +
          (settleable ? '可结算' : '对峙中') + '</span>' +
      '</header>' +
      '<div class="region-side side-opp">' +
        '<div class="side-label"><span class="side-name">' + esc(playerName('p2')) + '</span>' +
          '<span class="sum-chip' + (p2s > p1s ? ' is-ahead' : '') + '" data-testid="region-' + rid + '-p2-sum">' + p2s + '</span></div>' +
        '<div class="card-row">' + p2Cards + '</div>' +
      '</div>' +
      '<div class="region-vs"><span class="vs-chip ' + diffCls + '">' + diffText + '</span></div>' +
      '<div class="region-side side-mine">' +
        '<div class="side-label"><span class="side-name">' + esc(playerName('p1')) + '</span>' +
          '<span class="sum-chip' + (p1s > p2s ? ' is-ahead' : '') + '" data-testid="region-' + rid + '-p1-sum">' + p1s + '</span></div>' +
        '<div class="card-row">' + p1Cards + '</div>' +
      '</div>' +
      '<div class="region-backs">' +
        '<div class="back-group back-opp"><span class="back-label">对方背面</span><span class="back-stack">' + oppBacks + '</span></div>' +
        '<div class="back-group back-mine"><span class="back-label">我方背面</span><span class="back-stack">' + ownBacks + '</span></div>' +
      '</div>' +
    '</article>';
  }

  function settledRegionHTML(region) {
    var res = region.result || {};
    var winner = res.winner || 'tie';
    var banner = winner === 'p1' ? playerName('p1') + '赢得此区域' : winner === 'p2' ? playerName('p2') + '赢得此区域' : '平局';
    var mood = winner === 'p1' ? 'is-win' : winner === 'p2' ? 'is-lose' : 'is-tie';
    var sums = res.sums || { p1: 0, p2: 0 };
    var p1Cards = cardsSnapshotHTML(res, 'p1');
    var p2Cards = cardsSnapshotHTML(res, 'p2');
    var diff = sums.p1 - sums.p2;
    var diffText = diff === 0 ? '持平' : (diff > 0 ? '+' + diff : String(diff));
    var note = '';
    if (res.difficultyDraw) {
      var diffInfo = difficultyInfo();
      note = '<div class="settled-note">难度：' + esc(ruleShort(diffInfo.rule)) + ' → ' +
        esc(playerName(res.difficultyDraw.playerId)) + '摸 1 张牌</div>';
    } else if (winner === 'tie' && state.config.difficulty !== 2) {
      note = '<div class="settled-note">平局：难度规则不产生摸牌</div>';
    }
    return '<article class="region is-settled ' + mood + '" data-testid="region-' + region.id +
      '" data-region-id="' + region.id + '" data-status="settled" aria-label="区域 ' + (region.id + 1) + '，已结算，' + banner + '">' +
      '<header class="region-head">' +
        '<span class="region-name">区域 ' + (region.id + 1) + '</span>' +
        '<span class="region-badge is-done" data-testid="region-' + region.id + '-status">已结算</span>' +
      '</header>' +
      '<div class="settled-banner">' + banner + '</div>' +
      '<div class="settled-line side-p2"><span class="settled-name">' + esc(playerName('p2')) + '</span>' +
        '<span class="settled-cards">' + p2Cards + '</span>' +
        '<b class="settled-sum" data-testid="region-' + region.id + '-p2-sum">' + sums.p2 + '</b></div>' +
      '<div class="settled-line side-p1"><span class="settled-name">' + esc(playerName('p1')) + '</span>' +
        '<span class="settled-cards">' + p1Cards + '</span>' +
        '<b class="settled-sum" data-testid="region-' + region.id + '-p1-sum">' + sums.p1 + '</b></div>' +
      '<div class="settled-diff">差值 ' + diffText + '</div>' +
      note +
    '</article>';
  }

  function cardsSnapshotHTML(res, pid) {
    var faceUp = (res.faceUp && res.faceUp[pid]) || [];
    var drawn = (res.drawn && res.drawn[pid]) || [];
    if (!Array.isArray(drawn)) drawn = drawn ? [drawn] : []; // 兼容旧结构（单张）
    var html = '';
    for (var i = 0; i < faceUp.length; i++) html += miniCard(faceUp[i], 'settle-card');
    for (var d = 0; d < drawn.length; d++) html += miniCard(drawn[d], 'settle-card is-drawn');
    return html || '<span class="card-empty">—</span>';
  }

  /* ================================================================== *
   * 侧栏统计 / 行动栏 / 提示
   * ================================================================== */
  function totalDeckSize() {
    try {
      var info = eng().validateConfig(state.config).info;
      if (info && info.deckSize) return info.deckSize;
    } catch (e) { /* ignore */ }
    var n = state.deck.length + state.discard.length + state.players.p1.hand.length + state.players.p2.hand.length;
    for (var i = 0; i < state.regions.length; i++) {
      n += state.regions[i].sides.p1.faceUp.length + state.regions[i].sides.p1.faceDown.length +
        state.regions[i].sides.p2.faceUp.length + state.regions[i].sides.p2.faceDown.length;
      if (state.regions[i].result) {
        var all = state.regions[i].result.allCards;
        if (all) n += all.p1.length + all.p2.length;
      }
    }
    return n;
  }

  function renderStats() {
    var deckN = state.deck.length;
    var openCount = eng().getOpenRegionIds ? eng().getOpenRegionIds(state).length : state.regions.filter(function (r) { return r.status === 'open'; }).length;
    var threshold = eng().getEndgameThreshold ? eng().getEndgameThreshold(state) : 2 * openCount;
    var total = totalDeckSize();
    var pct = total ? Math.max(0, Math.min(100, Math.round(deckN / total * 100))) : 0;
    var danger = state.phase === 'battle' && openCount > 0 && deckN <= threshold + 2;
    var ties = countTies(state);
    var need = state.config.winsNeeded;

    el.statPanel.innerHTML =
      '<div class="panel-head"><h2>对局信息</h2><span class="phase-chip">' +
        (state.phase === 'layout' ? '布局'
          : state.phase === 'gameover' ? '结束'
          : (endgamePhase() === 'build' ? '决战·部署'
            : endgamePhase() === 'showdown' ? '决战·结算'
            : (state.endgame && state.endgame.triggered ? '决战' : '战役'))) +
      '</span></div>' +
      '<div class="stat-grid">' +
        '<div class="stat"><span class="stat-label">牌堆</span><b class="stat-value" data-testid="deck-count">' + deckN + '</b>' +
          '<span class="stat-hint">共 ' + total + ' 张</span></div>' +
        '<div class="stat"><span class="stat-label">决战阈值</span><b class="stat-value' + (danger ? ' is-danger' : '') + '" data-testid="threshold-count">' + threshold + '</b>' +
          '<span class="stat-hint">剩余 ' + openCount + ' 区</span></div>' +
      '</div>' +
      '<div class="deck-meter' + (danger ? ' is-danger' : '') + '" aria-hidden="true">' +
        '<div class="deck-fill" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<div class="scoreboard">' +
        '<div class="score-side score-p1"><span class="score-name" title="' + esc(playerName('p1')) + '">' + esc(playerName('p1')) + '</span><b class="score-num" data-testid="score-p1">' + state.regionWins.p1 + '</b></div>' +
        '<div class="score-center"><span class="score-tie-label">平</span><b class="score-tie-num" data-testid="score-ties">' + ties + '</b></div>' +
        '<div class="score-side score-p2"><b class="score-num" data-testid="score-p2">' + state.regionWins.p2 + '</b><span class="score-name" title="' + esc(playerName('p2')) + '">' + esc(playerName('p2')) + '</span></div>' +
      '</div>' +
      '<div class="score-caption">先达 ' + need + ' 个区域胜场者获胜' +
        (state.phase === 'gameover' ? ' · 对局已结束' : '') + '</div>' +
      '<div class="stat-extra" data-testid="compensation-draw">后手补偿 <b>' +
        compensationDrawCount() + '</b> 张（固定）</div>';
  }

  function statsEmptyHTML() {
    return '<div class="panel-head"><h2>对局信息</h2></div>' +
      '<div class="stat-grid">' +
        '<div class="stat"><span class="stat-label">牌堆</span><b class="stat-value" data-testid="deck-count">—</b><span class="stat-hint">等待开始</span></div>' +
        '<div class="stat"><span class="stat-label">决战阈值</span><b class="stat-value" data-testid="threshold-count">—</b><span class="stat-hint">等待开始</span></div>' +
      '</div>' +
      '<div class="deck-meter"><div class="deck-fill" style="width:0%"></div></div>' +
      '<div class="scoreboard">' +
        '<div class="score-side score-p1"><span class="score-name">' + esc(playerName('p1')) + '</span><b class="score-num" data-testid="score-p1">0</b></div>' +
        '<div class="score-center"><span class="score-tie-label">平</span><b class="score-tie-num" data-testid="score-ties">0</b></div>' +
        '<div class="score-side score-p2"><b class="score-num" data-testid="score-p2">0</b><span class="score-name">' + esc(playerName('p2')) + '</span></div>' +
      '</div>';
  }

  // v1.4：行动点显示（testid 文本始终为「行动点 N / 3」，另加 data-ap / data-actor；
  // 对手回合在胶囊内额外显示「对手」小标签并以红色区分，避免误读）
  function renderActionPoints() {
    if (!el.actionPoints) return;
    var maxAp = apPerTurn();
    var battle = state && state.phase === 'battle';
    var actor = battle && state.turn ? state.turn : null;
    var ap = actor ? currentAp() : 0;
    /* v2.17：战略决战 build 阶段显示该玩家的行动点上限（apCap，初始 3，可 -1/+1） */
    var capAp = maxAp;
    if (actor && state && state.endgame && state.endgame.triggered && state.endgame.phase === 'build') {
      var p = state.players && state.players[actor];
      if (p && p.apCap != null && isFinite(Number(p.apCap))) capAp = Math.max(0, Math.min(maxAp, Number(p.apCap)));
    }
    el.actionPoints.textContent = (!battle || !actor)
      ? '行动点 — / ' + maxAp
      : '行动点 ' + ap + ' / ' + capAp;
    el.actionPoints.setAttribute('data-ap', actor ? String(ap) : '');
    el.actionPoints.setAttribute('data-actor', actor || '');
    el.actionPoints.setAttribute('data-ap-cap', actor ? String(capAp) : '');
    if (el.apActor) el.apActor.hidden = !(actor && actor !== 'p1');
    if (el.apDots) {
      var dots = '';
      for (var i = 0; i < capAp; i++) {
        dots += '<i class="ap-dot' + (i < ap ? ' is-filled' : '') + '" aria-hidden="true"></i>';
      }
      el.apDots.innerHTML = dots;
    }
    if (el.apMeter) {
      el.apMeter.classList.toggle('is-opponent', !!actor && actor !== 'p1');
      el.apMeter.classList.toggle('is-empty', !!actor && ap <= 0);
    }
  }

  function actionCostBadge(type) {
    var cost = actionCost(type);
    return '<span class="action-cost" data-testid="action-' + type + '-cost" title="消耗 ' + cost +
      ' 行动点" aria-label="消耗 ' + cost + ' 行动点">' + cost + '</span>';
  }

  function renderActions() {
    renderActionPoints();
    var counts = { settle: 0, flip: 0, place: 0, move: 0, draw: 0 };
    var acts = state.phase === 'battle' ? (view.legalActions || []) : [];
    for (var i = 0; i < acts.length; i++) {
      if (counts[acts[i].type] != null) counts[acts[i].type]++;
    }
    var lan = isLanView();
    var lanBlocked = lan && (!lanOpponentOnline() || view.busy);
    var myTurn = state.phase === 'battle' && state.turn === 'p1' && !view.busy && !lanBlocked && !view.trustee;
    var html = '';
    for (var k = 0; k < ACTION_META.length; k++) {
      var meta = ACTION_META[k];
      var enabled = myTurn && counts[meta.type] > 0;
      var reason = enabled ? '' : disabledReason(meta.type, myTurn, counts[meta.type]);
      var cost = actionCost(meta.type);
      var tip = enabled ? (meta.sub + ' · 消耗 ' + cost + ' 行动点') : reason;
      html += '<button type="button" class="action-btn' + (view.mode === meta.type ? ' is-active' : '') + '"' +
        ' data-action="' + meta.type + '" data-testid="action-' + meta.type + '" data-key="' + meta.key + '" data-cost="' + cost + '"' +
        (enabled ? '' : ' disabled') +
        ' title="' + esc(tip) + '"' +
        ' aria-label="' + esc(meta.label + '：' + meta.sub + '（消耗 ' + cost + ' 行动点）' + (enabled ? '' : '，不可用：' + reason)) + '">' +
        '<span class="action-icon" aria-hidden="true">' + meta.icon + '</span>' +
        '<span class="action-text"><b>' + meta.label + '</b><small>' + meta.sub + '</small></span>' +
        '<span class="action-key" aria-hidden="true">' + meta.key + '</span>' +
        actionCostBadge(meta.type) +
        '</button>';
    }
    // v1.4：结束回合（0 点，轮到自己即可用；决战 build 阶段同样可用）
    var endEnabled = myTurn && endgamePhase() !== 'showdown';
    var endReason = endEnabled ? '' : disabledReason(END_TURN_META.type, myTurn, 1);
    html += '<button type="button" class="action-btn is-end-turn' + (view.mode === 'end_turn' ? ' is-active' : '') + '"' +
      ' data-action="end_turn" data-testid="btn-end-turn" data-key="' + END_TURN_META.key + '" data-cost="' + actionCost('end_turn') + '"' +
      (endEnabled ? '' : ' disabled') +
      ' title="' + esc(endEnabled ? '提前结束本回合，放弃剩余行动点（快捷键 Space / 0）' : endReason) + '"' +
      ' aria-label="' + esc(END_TURN_META.label + '：' + END_TURN_META.sub + (endEnabled ? '' : '，不可用：' + endReason)) + '">' +
      '<span class="action-icon" aria-hidden="true">' + END_TURN_META.icon + '</span>' +
      '<span class="action-text"><b>' + END_TURN_META.label + '</b><small>' + END_TURN_META.sub + '</small></span>' +
      '<span class="action-key" aria-hidden="true">' + END_TURN_META.key + '</span>' +
      actionCostBadge('end_turn') +
      '</button>';
    el.actionButtons.innerHTML = html;
  }

  function disabledReason(type, myTurn, count) {
    var lan = isLanView();
    if (view && view.trustee) return '托管中：由简单 AI 代打，点顶栏「取消托管」接管';
    if (!myTurn) {
      if (lan && !lanOpponentOnline()) return '对手已断开，等待重连…';
      if (state.phase === 'layout') return view.layoutLocked ? '已提交布阵，等待对手布阵…' : '战前布局阶段，暂不能行动';
      if (state.phase === 'gameover') return '对局已结束';
      if (view.busy) return lan ? '等待服务器响应…' : '行动处理中…';
      if (endgamePhase() === 'showdown') return '最终结算中…';
      if (state.turn === 'p2') {
        if (endgamePhase() === 'build') return lan ? '等待 ' + playerName('p2') + ' 部署' : '电脑正在部署……';
        return lan ? '等待 ' + playerName('p2') + ' 行动' : '等待电脑行动';
      }
      return '当前不可行动';
    }
    if (type === 'end_turn') return endgamePhase() === 'showdown' ? '最终结算中…' : '当前不能结束回合';
    var egp = endgamePhase();
    if (egp === 'build') {
      if (type === 'settle') return '战略决战部署阶段：结算已禁用';
      if (type === 'draw') return '战略决战部署阶段：摸牌已禁用（牌堆已摸空）';
    }
    if (egp === 'showdown') return '最终结算中…';
    var cost = actionCost(type);
    var ap = currentAp();
    if (cost > ap) return '行动点不足（需要 ' + cost + ' 点，当前 ' + ap + ' 点）';
    var open = openRegionCount();
    switch (type) {
      case 'settle':
        if (!open) return '没有未结算区域';
        if (state.deck.length < 2 * settleModeCards()) return '牌堆不足（结算需 ≥ ' + (2 * settleModeCards()) + ' 张）';
        return '暂无可结算区域';
      case 'flip': return '我方没有背面朝上的牌';
      case 'place': return open ? '手牌为空' : '没有未结算区域';
      case 'move': return '没有可移动的背面牌或其他未结算区域';
      case 'draw': return '牌堆已空';
      default: return '当前不可执行';
    }
  }

  function modePrompt() {
    if (view.mode === 'settle') return '请选择要结算的区域（Esc 取消）';
    if (view.mode === 'flip') return '请选择要翻开的牌（Esc 取消）';
    if (view.mode === 'place') {
      if (view.selectedHandCardId) return '请选择要放入的区域（Esc 取消）';
      if (view.selectedRegionId != null) return '请选择要放入的手牌（Esc 取消）';
      return '请选择要放置的手牌（Esc 取消）';
    }
    if (view.mode === 'move') {
      return view.moveSource ? '请选择目标区域（Esc 取消）' : '请选择要移动的牌（Esc 取消）';
    }
    return '';
  }

  function renderHintAndTurn() {
    var lan = isLanView();
    var oppName = playerName('p2');
    var egp = endgamePhase();
    var eg = endgameInfo();
    var hint = (view && view.trustee)
      ? (state.phase === 'layout'
        ? (lan ? '托管中：简单 AI 正在自动布阵并提交（联机），点顶栏「取消托管」接管'
          : '托管中：简单 AI 正在自动布阵，点顶栏「取消托管」接管')
        : (lan ? '托管中：简单 AI 正在联机代打，点顶栏「取消托管」接管'
          : '托管中：简单 AI 正在代打，点顶栏「取消托管」接管'))
      : (view.hintOverride || modePrompt());
    if (!hint) {
      if (state.phase === 'layout') {
        hint = lan
          ? (view.layoutLocked ? '已提交布阵，等待 ' + oppName + ' 布阵…' : '点选手牌，背面朝上放入区域；双方提交后同时揭示')
          : '点选手牌，再点击区域槽位；确认布阵后开始战役';
      } else if (state.phase === 'gameover') {
        hint = lan ? '对局结束：可再来一局（需双方确认），或离开房间' : '对局结束：可再来一局，或调整设置后再战';
      } else if (egp === 'build') {
        var skipped = (eg && eg.skipped) || {};
        if (state.turn === 'p1') {
          hint = skipped.p2
            ? '对手已无牌可动（回合被跳过）：你连续行动，可翻牌 / 放牌 / 移牌'
            : '最终部署：可翻牌 / 放牌 / 移牌；摸牌与结算已禁用，无牌可动时自动跳过';
        } else if (lan && !lanOpponentOnline()) {
          hint = '对手已断开，等待重连…';
        } else {
          hint = lan ? '等待 ' + oppName + ' 部署…' : '电脑正在部署……';
        }
      } else if (egp === 'showdown') {
        hint = '双方无牌可动：按各区域现有正面牌点数结算中……';
      } else if (lan && !lanOpponentOnline()) {
        hint = '对手已断开，等待重连…';
      } else if (state.turn === 'p2') {
        hint = lan ? '等待 ' + oppName + ' 行动…' : '电脑正在思考……';
      } else if (view.busy && lan) {
        hint = '等待服务器同步…';
      } else {
        hint = '请选择行动（快捷键 1-5，Space 结束回合）';
      }
    }
    el.hint.textContent = hint;
    el.hint.title = '同一回合内可连续行动；行动点耗尽或点「结束回合」后交给对方';

    var text = '';
    var cls = '';
    if (state.phase === 'layout') {
      text = view.layoutLocked ? '等待对手布阵' : '战前布局';
      cls = view.layoutLocked ? 'is-thinking' : 'is-neutral';
    } else if (state.phase === 'gameover') {
      text = '对局结束';
      cls = 'is-neutral';
    } else if (egp === 'showdown') {
      text = '最终结算中';
      cls = 'is-thinking';
    } else if (egp === 'build') {
      if (state.turn === 'p1') {
        text = '轮到你部署';
        cls = 'is-you';
      } else {
        text = lan ? '等待对手部署' : '电脑部署中';
        cls = 'is-thinking';
      }
    } else if (lan && !lanOpponentOnline()) {
      text = '等待重连';
      cls = 'is-thinking';
    } else if (state.turn === 'p2') {
      text = lan ? '等待对手行动' : '电脑思考中';
      cls = 'is-thinking';
    } else if (view.busy) {
      text = lan ? '等待服务器…' : '行动结算中';
      cls = 'is-thinking';
    } else {
      text = '轮到你行动';
      cls = 'is-you';
    }
    el.turnIndicator.className = 'turn-indicator ' + cls;
    el.turnIndicator.innerHTML = cls === 'is-thinking'
      ? '<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="turn-text">' + text + '</span>'
      : '<span class="turn-text">' + text + '</span>';
  }

  // 联机日志文本：引擎日志以房主(p1)视角生成，且「战略决战/立即结算」等行硬编码「你/电脑」。
  // 客户端把视角词映射成真实昵称（房主视角：你=自己；客机视角：你=对手），并镜像 tone 颜色。
  function lanLogText(text, role) {
    if (!state || !state.config || !state.config.playerNames) return text;
    var names = state.config.playerNames;
    var hostName = role === 'guest' ? names.p2 : names.p1;
    var guestName = role === 'guest' ? names.p1 : names.p2;
    if (!hostName || !guestName) return text;
    return String(text)
      .replace(/电脑/g, '\u0001')
      .replace(/你/g, '\u0002')
      .split('\u0001').join(guestName)
      .split('\u0002').join(hostName);
  }

  function renderLog() {
    var log = state.log || [];
    var snapshot = log.length + ':' + (log.length ? log[log.length - 1].seq : 0);
    if (snapshot === lastLogSnapshot) return;
    lastLogSnapshot = snapshot;
    var slice = log.slice(-200);
    var lan = view.lan || null;
    var lanRole = lan ? lan.role : null;
    var html = '';
    for (var i = 0; i < slice.length; i++) {
      var entry = slice[i];
      var tone = entry.tone || 'info';
      var text = entry.text;
      if (lan) {
        text = lanLogText(text, lanRole);
        if (lanRole === 'guest') {
          if (tone === 'p1') tone = 'p2';
          else if (tone === 'p2') tone = 'p1';
        }
      }
      html += '<div class="log-item tone-' + esc(tone) + '">' +
        '<span class="log-seq">' + esc(entry.seq) + '</span>' +
        '<span class="log-text">' + esc(text) + '</span></div>';
    }
    el.logList.innerHTML = html || '<div class="log-empty">暂无记录</div>';
    el.logCount.textContent = String(log.length);
    el.logList.scrollTop = el.logList.scrollHeight;
  }

  function renderDebug() {
    if (!debugMode && !autoplayMode) { el.debugBadge.hidden = true; return; }
    if (!state) { el.debugBadge.hidden = true; return; }
    el.debugBadge.hidden = false;
    var prefix = autoplayMode ? '自动演示 · ' : '';
    el.debugBadge.textContent = prefix + 'seed ' + state.config.seed + ' · 难度 ' + state.config.difficulty +
      ' · ' + state.config.regionCount + ' 区 · ' + state.phase +
      ' · turn ' + (state.turn || '—') + ' · 牌堆 ' + state.deck.length +
      ' · 手牌 ' + state.players.p1.hand.length + '/' + state.players.p2.hand.length;
  }

  /* ================================================================== *
   * 联机连接状态条
   * ================================================================== */
  function lanBarCode() {
    var lan = view && view.lan;
    if (!lan) return '';
    if (lan.meta && lan.meta.code) return lan.meta.code;
    return lan.code || '';
  }

  function lanBarUrl() {
    var lan = view && view.lan;
    if (!lan) return '';
    var urls = (lan.meta && lan.meta.lanUrls) || lan.lanUrls || [];
    var bases = lanShareBases(urls);
    var code = lanBarCode();
    if (!bases.length) return '';
    return bases[0] + (code ? '/?room=' + code : '');
  }

  /* 规范化 + 去重局域网地址：去掉尾部斜杠，局域网 IP 优先，回环地址靠后 */
  function normalizeLanBase(url) {
    if (!url) return '';
    try {
      var parsed = new root.URL(String(url), root.location && root.location.href ? root.location.href : undefined);
      return parsed.protocol + '//' + parsed.host;
    } catch (e) {
      return String(url).replace(/\/+$/, '');
    }
  }

  function isLoopbackBase(base) {
    return /^https?:\/\/(127\.|localhost|\[::1\]|0\.0\.0\.0)/i.test(base);
  }

  function lanShareBases(urls) {
    var list = [];
    var seen = {};
    function push(u) {
      var base = normalizeLanBase(u);
      if (!base || seen[base]) return;
      seen[base] = true;
      list.push(base);
    }
    (urls || []).forEach(push);
    if (root.location && /^https?:$/.test(root.location.protocol)) push(root.location.origin);
    list.sort(function (a, b) {
      return (isLoopbackBase(a) ? 1 : 0) - (isLoopbackBase(b) ? 1 : 0);
    });
    return list;
  }

  function renderLanBar() {
    if (!el.lanBar) return;
    var lan = view && view.lan;
    if (!lan || !lan.active) {
      el.lanBar.hidden = true;
      el.lanBar.innerHTML = '';
      return;
    }
    el.lanBar.hidden = false;
    var meta = lan.meta || null;
    var connection = lan.connection || 'connecting';
    var connText = connection === 'open' ? '已连接'
      : connection === 'reconnecting' ? '重连中…'
      : connection === 'connecting' ? '连接中…' : '未连接';
    var connCls = connection === 'open' ? 'is-online'
      : (connection === 'reconnecting' || connection === 'connecting') ? 'is-pending' : 'is-offline';
    var me = (meta && meta.players && meta.players.p1) || { name: lan.myName || '' };
    var opp = meta && meta.players ? meta.players.p2 : null;
    var oppName = (opp && opp.name) || lan.opponentName || '对手';
    var oppOnline = !opp || opp.connected !== false;
    var role = lan.role === 'host' ? '房主' : '客机';
    var code = lanBarCode();
    el.lanBar.innerHTML =
      '<span class="lan-dot ' + connCls + '" aria-hidden="true"></span>' +
      '<span class="lan-conn" data-testid="lan-connection">' + connText + '</span>' +
      '<span class="lan-code-chip">房间 <b data-testid="lan-bar-code">' + esc(code) + '</b>' +
        '<button type="button" class="lan-copy" data-lan-copy-code aria-label="复制房间码">复制</button></span>' +
      '<span class="lan-role">' + role + '</span>' +
      '<span class="lan-players"><b>' + esc(me.name || '我') + '</b>' +
        '<span class="lan-vs">VS</span>' +
        '<b data-testid="lan-opponent" class="' + (oppOnline ? '' : 'is-offline') + '">' + esc(oppName) + '</b>' +
        (opp ? '<span class="lan-presence ' + (oppOnline ? 'is-online' : 'is-offline') + '">' + (oppOnline ? '在线' : '已断开') + '</span>' : '') +
      '</span>' +
      '<span class="lan-spacer"></span>' +
      (lanBarUrl() ? '<button type="button" class="lan-copy-url" data-lan-copy-url aria-label="复制局域网地址">复制地址</button>' : '') +
      '<button type="button" class="btn btn-ghost lan-leave" data-lan-leave data-testid="btn-lan-leave">离开房间</button>';
  }

  UI.copyText = function (text) {
    if (!text) return;
    function done() { UI.toast('已复制：' + text, 'success'); }
    function fallback() {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        done();
      } catch (err) {
        UI.toast('复制失败，请手动复制：' + text, 'warn');
      }
    }
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      root.navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  };

  /* ================================================================== *
   * Toast / 动画辅助
   * ================================================================== */
  UI.toast = function (message, tone) {
    var node = el.toast || document.getElementById('toast');
    if (!node) return;
    if (tone === 'error') sfxPlay('ui.error');
    node.textContent = message;
    node.className = 'toast show' + (tone ? ' toast-' + tone : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.className = 'toast'; }, 2400);
  };

  UI.setAnimationEnabled = function (enabled) {
    animationEnabled = !!enabled;
    document.body.classList.toggle('no-anim', !animationEnabled);
  };

  UI.isAnimationEnabled = function () { return animationEnabled; };

  UI.setDebug = function (enabled) { debugMode = !!enabled; if (state) renderDebug(); };

  UI.setAutoplay = function (enabled) { autoplayMode = !!enabled; if (state) renderDebug(); };

  UI.flashRegion = function (regionId) {
    if (!animationEnabled) return Promise.resolve();
    var node = el.regions.querySelector('[data-region-id="' + regionId + '"]');
    if (!node) return Promise.resolve();
    node.classList.add('is-flash');
    return delay(380).then(function () { node.classList.remove('is-flash'); });
  };

  /* 翻牌时给该区域最新翻开的牌一个 3D 翻面动画 */
  UI.flipCard = function (regionId, playerId) {
    if (!animationEnabled) return Promise.resolve();
    var node = el.regions.querySelector('[data-region-id="' + regionId + '"]');
    if (!node) return Promise.resolve();
    var side = playerId === 'p1' ? '.side-mine' : '.side-opp';
    var cards = node.querySelectorAll(side + ' .card-row .card-mini');
    var target = cards.length ? cards[cards.length - 1] : null;
    if (!target) return Promise.resolve();
    target.style.setProperty('--reveal-delay', '0ms');
    target.classList.add('reveal-card');
    return delay(340);
  };

  UI.pulseDeck = function () {
    if (!animationEnabled) return Promise.resolve();
    var node = el.statPanel.querySelector('[data-testid="deck-count"]');
    if (!node) return Promise.resolve();
    node.classList.add('is-pulse');
    return delay(420).then(function () { node.classList.remove('is-pulse'); });
  };

  /* ---------------------------- 飞牌动画 ---------------------------- */
  function deckAnchor() {
    return el.statPanel.querySelector('[data-testid="deck-count"]');
  }

  function handAnchor(pid) {
    if (pid === 'p2') return el.opponentSeat.querySelector('.opp-hand-stack') || el.opponentSeat;
    return el.playerSeat.querySelector('#hand') || el.playerSeat;
  }

  function ghostCard(html) {
    var g = document.createElement('div');
    g.className = 'ghost-card';
    g.innerHTML = html || '<div class="card card-back ghost-face"></div>';
    document.body.appendChild(g);
    return g;
  }

  // 用一个 fixed 定位的 ghost 从 fromEl 飞到 toEl（只用 transform/opacity）
  function flyGhost(fromEl, toEl, options) {
    if (!animationEnabled) return Promise.resolve();
    var opts = options || {};
    if (!fromEl || !toEl || !fromEl.getBoundingClientRect || !toEl.getBoundingClientRect) return Promise.resolve();
    var from = fromEl.getBoundingClientRect();
    var to = toEl.getBoundingClientRect();
    if (!from.width || !to.width) return Promise.resolve();
    var ghost = ghostCard(opts.html);
    ghost.style.left = from.left + 'px';
    ghost.style.top = from.top + 'px';
    ghost.style.width = from.width + 'px';
    ghost.style.height = from.height + 'px';
    if (opts.className) ghost.className += ' ' + opts.className;
    void ghost.offsetWidth; // 强制 reflow 后再启动过渡
    var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    var scale = Math.max(0.3, Math.min(1.15, (to.width || from.width) / from.width));
    ghost.classList.add('is-flying');
    ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')';
    var ms = opts.ms || 340;
    return delay(ms).then(function () {
      ghost.classList.add('is-landed');
      setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 120);
      return delay(opts.afterMs || 40);
    });
  }

  /* 布局：手牌 → 槽位 FLIP 飞牌（在槽位点击后调用） */
  UI.playLayoutPlace = function (cardId, fromRect, toEl) {
    if (!animationEnabled || !cardId) return Promise.resolve();
    var fromEl = null;
    if (fromRect) {
      fromEl = { getBoundingClientRect: function () { return fromRect; } };
    } else {
      fromEl = el.playerSeat.querySelector('#hand [data-card-id="' + cardId + '"]');
    }
    var target = toEl || el.regions.querySelector('.layout-slot.is-filled');
    if (!target) return Promise.resolve();
    var placed = target.classList ? target : null;
    if (placed) placed.classList.add('is-just-placed');
    return flyGhost(fromEl, target, {
      html: '<div class="card card-back ghost-face"></div>',
      ms: 300
    }).then(function () {
      if (placed) {
        setTimeout(function () { placed.classList.remove('is-just-placed'); }, 220);
      }
    });
  };

  /* 摸牌：牌从牌堆飞到摸牌方手牌 */
  UI.playDrawAnim = function (ev) {
    if (!animationEnabled) return Promise.resolve();
    var pid = (ev && ev.playerId) || 'p1';
    var card = ev && ev.card;
    var from = deckAnchor();
    var to = handAnchor(pid);
    // 只有自己（p1）摸牌才显示牌面；对手摸牌/补牌一律牌背（单机 p2 事件带真实牌面也不能泄漏）
    var showFace = pid === 'p1' && card && !card.hidden;
    var html = showFace ? miniCard(card, 'ghost-face') : backCard('ghost-face');
    return flyGhost(from, to, { html: html, ms: 320 }).then(function () {
      var hand = el.playerSeat.querySelector('#hand');
      if (pid === 'p1' && hand) {
        hand.classList.add('is-pulse');
        setTimeout(function () { hand.classList.remove('is-pulse'); }, 260);
      }
      return UI.pulseDeck();
    });
  };

  UI.playLayoutReveal = function (events) {
    if (!animationEnabled) return Promise.resolve();
    // v2.1：后手补偿固定 1 张：收集 extra_draw 事件（顺序 layout_reveal → extra_draw → battle_start）
    var extras = [];
    (events || []).forEach(function (ev) { if (ev.type === 'extra_draw') extras.push(ev); });
    var regions = el.regions.querySelectorAll('.region[data-region-id]');
    if (!regions.length) return Promise.resolve();
    var panel = el.regions.querySelector('[data-testid="layout-panel"]');
    document.body.setAttribute('data-layout-anim', 'revealing');

    // 第一幕：双方布置的牌以牌背「落入」区域（电脑与我方同时，逐区错开）
    el.regions.classList.add('is-dealing');
    for (var d = 0; d < regions.length; d++) {
      var dealCards = regions[d].querySelectorAll('.region-side .card-row .card-mini');
      for (var dc = 0; dc < dealCards.length; dc++) {
        dealCards[dc].style.setProperty('--deal-delay', (d * 55 + dc * 40) + 'ms');
        dealCards[dc].classList.add('deal-drop');
      }
    }
    if (panel) panel.setAttribute('data-anim-state', 'dealing');
    return delay(regions.length * 55 + 260).then(function () {
      // 第二幕：全部背面停顿，营造「同时揭示」悬念
      el.regions.classList.remove('is-dealing');
      el.regions.classList.add('is-reveal-pending');
      if (panel) panel.setAttribute('data-anim-state', 'revealing');
      UI.toast('双方布阵完成，同时揭示！', 'info');
      return delay(650);
    }).then(function () {
      // 第三幕：逐区同时翻开——同一区域内我方与电脑的牌一起翻
      el.regions.classList.remove('is-reveal-pending');
      el.regions.classList.add('is-revealing');
      for (var r = 0; r < regions.length; r++) {
        var cards = regions[r].querySelectorAll('.region-side .card-mini');
        for (var c = 0; c < cards.length; c++) {
          cards[c].style.setProperty('--reveal-delay', (r * 90) + 'ms');
          cards[c].classList.add('reveal-card');
        }
        regions[r].classList.add('is-reveal-pulse');
      }
      return delay(regions.length * 90 + 480);
    }).then(function () {
      for (var rr = 0; rr < regions.length; rr++) regions[rr].classList.remove('is-reveal-pulse');
      el.regions.classList.remove('is-revealing');
      document.body.setAttribute('data-layout-anim', 'revealed');
      // 第三幕补：后手补偿固定 1 张飞入手牌（自己后手显示牌面，电脑一律牌背）
      if (!extras.length) return delay(120);
      var pid = extras[0].playerId || 'p2';
      UI.toast(playerName(pid) + '作为后手额外补 ' + extras.length + ' 张牌', 'info');
      var chain = Promise.resolve();
      extras.forEach(function (extra) {
        chain = chain.then(function () {
          var from = deckAnchor();
          var to = handAnchor(extra.playerId || pid);
          var extraShowFace = extra.playerId === 'p1' && extra.card && !extra.card.hidden;
          var html = extraShowFace ? miniCard(extra.card, 'ghost-face') : backCard('ghost-face');
          return flyGhost(from, to, { html: html, ms: 300, afterMs: 150 });
        });
      });
      return chain.then(function () { return delay(120); });
    });
  };

  /* ================================================================== *
   * 弹层基础设施
   * ================================================================== */
  function layerRoot() { return el.overlayRoot || document.getElementById('overlay-root'); }

  function openLayer(name, className, testid) {
    closeLayer(name);
    var node = document.createElement('div');
    node.className = className;
    if (testid) node.setAttribute('data-testid', testid);
    layerRoot().appendChild(node);
    activeLayers[name] = node;
    return node;
  }

  function closeLayer(name) {
    var node = activeLayers[name];
    if (node && node.parentNode) node.parentNode.removeChild(node);
    delete activeLayers[name];
  }

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /* ================================================================== *
   * 设置弹层
   * ================================================================== */
  function aiStrengthModes() {
    return [
      { id: 'easy', name: '简单', hint: '纯学习 H96，gen60 代（Phase12 PPO；保守回退档；p95 ≤25ms）' },
      { id: 'medium', name: '中等', hint: '纯学习 H128，gen241 代（Phase17 联赛 PPO；默认档；p95 ≤35ms）' },
      { id: 'hard', name: '困难', hint: '纯学习 H192，gen436 代（PPO；p95 ≤50ms）' }
    ];
  }

  function aiStrengthMeta(raw) {
    var list = aiStrengthModes();
    var id = raw === 'normal' ? 'medium' : raw; // 旧版本 'normal' 迁移
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[1];
  }

  /* 结算随机性：新版三档 = 简单 1 / 标准 2 / 复杂 4（config.settleCards 即补牌张数）。
   * 优先使用引擎 E.SETTLE_MODES 的文案；引擎未更新时仍按 1/2/4 契约渲染（忽略旧的 id=3）。 */
  function settleModes() {
    var engineList = eng().SETTLE_MODES;
    var byId = {};
    if (Array.isArray(engineList)) {
      for (var i = 0; i < engineList.length; i++) byId[engineList[i].id] = engineList[i];
    }
    return [1, 2, 4].map(function (id) {
      var fallback = {
        id: id,
        name: id === 1 ? '简单' : id === 2 ? '标准' : '复杂',
        label: '双方各补 ' + id + ' 张',
        cards: id
      };
      var m = byId[id];
      if (!m) return fallback;
      return { id: id, name: m.name || fallback.name, label: m.label || fallback.label, cards: id };
    });
  }

  function settleModeMeta(cards) {
    var n = Number(cards);
    if (n === 3) n = 4; // 旧版「复杂=3」迁移
    var list = settleModes();
    for (var i = 0; i < list.length; i++) if (list[i].id === n) return list[i];
    return list[1];
  }

  function normalizeSettleCards(value) {
    var n = Number(value);
    if (n === 3) n = 4; // 旧存档/旧 URL 的复杂=3 迁移为 4
    return [1, 2, 4].indexOf(n) >= 0 ? n : 2;
  }

  /* v1.5：回合倒计时选项（引擎 TURN_TIME_LIMIT_OPTIONS 为准：0=关闭/15/30/60） */
  function turnTimeOptions() {
    var e = eng();
    if (e && Array.isArray(e.TURN_TIME_LIMIT_OPTIONS)) return e.TURN_TIME_LIMIT_OPTIONS.slice();
    return [0, 15, 30, 60];
  }

  function normalizeTurnTimeLimit(value) {
    var n = Number(value);
    return turnTimeOptions().indexOf(n) >= 0 ? n : 30;
  }

  function aiDefaultEngine() {
    try {
      if (root.PokerAIDefaults && root.PokerAIDefaults.defaultEngine) {
        return root.PokerAIDefaults.defaultEngine === 'heuristic' ? 'heuristic' : 'ml';
      }
    } catch (e) { /* ignore */ }
    return 'ml';
  }

  function normalizeDraft(input) {
    var incoming = deepClone(input || {});
    var regionCount = Number(incoming.regionCount);
    if ([3, 5, 7].indexOf(regionCount) < 0) regionCount = 5;
    var settleCards = normalizeSettleCards(incoming.settleCards);
    var musicEnabled = incoming.musicEnabled !== false && incoming.musicEnabled !== 0 && incoming.musicEnabled !== '0';
    var musicVolume = Number(incoming.musicVolume);
    if (!isFinite(musicVolume)) musicVolume = 30;
    musicVolume = Math.max(0, Math.min(100, Math.round(musicVolume)));
    var sfxEnabled = incoming.sfxEnabled !== false && incoming.sfxEnabled !== 0 && incoming.sfxEnabled !== '0';
    var sfxVolume = Number(incoming.sfxVolume);
    if (!isFinite(sfxVolume)) sfxVolume = 70;
    sfxVolume = Math.max(0, Math.min(100, Math.round(sfxVolume)));
    return {
      difficulty: [1, 2, 3].indexOf(Number(incoming.difficulty)) >= 0 ? Number(incoming.difficulty) : 1,
      regionCount: regionCount,
      settleCards: settleCards,
      firstPlayer: ['random', 'p1', 'p2'].indexOf(incoming.firstPlayer) >= 0 ? incoming.firstPlayer : 'random',
      aiStrength: aiStrengthMeta(incoming.aiStrength).id,
      animation: incoming.animation === 'fast' ? 'fast' : 'standard',
      drag: incoming.drag === 'off' ? 'off' : (incoming.drag === 'on' ? 'on' : (isAndroidPlatform() ? 'off' : 'on')),
      turnTimeLimit: normalizeTurnTimeLimit(incoming.turnTimeLimit),
      musicEnabled: musicEnabled,
      musicVolume: musicVolume,
      sfxEnabled: sfxEnabled,
      sfxVolume: sfxVolume,
      nickname: typeof incoming.nickname === 'string' ? incoming.nickname.slice(0, 10) : '玩家'
    };
  }

  UI.showSettings = function (draft, opts) {
    closeSettings();
    settingsDraft = normalizeDraft(draft);
    settingsOpts = opts || {};
    settingsEl = openLayer('settings', 'overlay settings-overlay', 'settings-modal');
    settingsEl.addEventListener('click', onSettingsClick);
    settingsEl.addEventListener('input', onSettingsInput);
    renderSettings();
  };

  UI.closeSettings = function () { closeSettings(); };

  function closeSettings() {
    if (settingsEl && settingsEl.parentNode) settingsEl.parentNode.removeChild(settingsEl);
    settingsEl = null;
    settingsDraft = null;
    settingsOpts = null;
  }

  function draftConfig() {
    // 不传 deck：网页固定标准单副牌 54 张（3/5/7 区一致），牌堆不随区域数变化
    return {
      regionCount: Number(settingsDraft.regionCount),
      difficulty: Number(settingsDraft.difficulty),
      settleCards: Number(settingsDraft.settleCards),
      firstPlayer: settingsDraft.firstPlayer,
      aiStrength: settingsDraft.aiStrength
    };
  }

  function renderSettings() {
    if (!settingsEl || !settingsDraft) return;
    var e = eng();
    var s = settingsDraft;
    var cfg = draftConfig();
    var validation = e.validateConfig(cfg);
    var info = validation.info || {};
    var initial = settingsOpts && settingsOpts.initial;
    /* v1.8.1：LAN 上下文（?lan=1 大厅 / 等待房间 / 对局 / 断线恢复）不显示单机专属「困难档 AI 引擎」块 */
    var lanMode = !!(settingsOpts && settingsOpts.lanMode) || isLanView();

    var diffCards = [1, 2, 3].map(function (id) {
      var d = e.DIFFICULTIES[id];
      var checked = Number(s.difficulty) === id;
      return '<button type="button" class="choice-card' + (checked ? ' is-checked' : '') + '"' +
        ' data-setting="difficulty" data-value="' + id + '" role="radio" aria-checked="' + checked + '"' +
        ' aria-label="难度 ' + esc(d.name) + '：' + esc(d.label) + '">' +
        '<b>' + esc(d.name) + '</b><small>' + esc(d.label) + '</small></button>';
    }).join('');
    var regionSeg = [3, 5, 7].map(function (n) {
      return '<button type="button" class="seg-btn' + (Number(s.regionCount) === n ? ' is-checked' : '') + '"' +
        ' data-setting="regionCount" data-value="' + n + '" aria-pressed="' + (Number(s.regionCount) === n) + '">' +
        n + ' 区<small>' + (Math.floor(n / 2) + 1) + ' 胜</small></button>';
    }).join('');
    var regionHint = Number(s.regionCount) === 7
      ? '<p class="setting-hint">7 区为 7 局 4 胜；牌堆仍为标准 54 张，简单/标准/复杂结算三档均可选。</p>'
      : '<p class="setting-hint">3/5/7 区均使用标准单副牌 54 张（四花色 A~K + 大小王）。</p>';
    var firstSeg = [['random', '随机'], ['p1', '我先手'], ['p2', '电脑先手']].map(function (item) {
      return '<button type="button" class="seg-btn' + (s.firstPlayer === item[0] ? ' is-checked' : '') + '"' +
        ' data-setting="firstPlayer" data-value="' + item[0] + '">' + item[1] + '</button>';
    }).join('');
    var aiModes = aiStrengthModes();
    var aiSeg = aiModes.map(function (item) {
      var dis = !!item.disabled;
      return '<button type="button" class="seg-btn' + (s.aiStrength === item.id ? ' is-checked' : '') + (dis ? ' is-disabled' : '') + '"' +
        ' data-setting="aiStrength" data-value="' + item.id + '" data-testid="ai-strength-' + item.id + '"' +
        (dis ? ' disabled aria-disabled="true" title="' + esc(item.hint || '') + '"' : '') +
        ' aria-pressed="' + (s.aiStrength === item.id) + '">' + esc(item.name) + '</button>';
    }).join('');
    var aiHint = '<p class="setting-hint" data-testid="ai-strength-hint">' +
      esc(aiStrengthMeta(s.aiStrength).hint) + '</p>' +
      '<p class="setting-hint" data-testid="ai-strength-hard-note">困难档模型较大（约 4.9MB），首次加载稍慢。</p>';
    var animSeg = [['standard', '标准'], ['fast', '快速（跳过动画）']].map(function (item) {
      return '<button type="button" class="seg-btn' + (s.animation === item[0] ? ' is-checked' : '') + '"' +
        ' data-setting="animation" data-value="' + item[0] + '">' + item[1] + '</button>';
    }).join('');
    /* v2.17：拖拽操作可选（桌面默认开 / 安卓默认关） */
    var dragOn = s.drag !== 'off';
    var dragSeg = [['on', '开启'], ['off', '关闭']].map(function (item) {
      var checked = (item[0] === 'on') === dragOn;
      return '<button type="button" class="seg-btn' + (checked ? ' is-checked' : '') + '"' +
        ' data-setting="drag" data-value="' + item[0] + '" data-testid="drag-option-' + item[0] + '"' +
        ' aria-pressed="' + checked + '">' + item[1] + '</button>';
    }).join('');
    var dragSection = '<section class="setting-group"><div class="setting-label"><h3>拖拽操作</h3>' +
      '<p>拖动牌完成翻牌 / 移牌 / 放牌；' + (isAndroidPlatform() ? '安卓默认关闭' : '桌面默认开启') + '，关闭后仍可点选操作</p></div>' +
      '<div class="segmented" role="group" aria-label="拖拽操作">' + dragSeg + '</div></section>';
    /* 背景音乐：默认开启、音量 30（0 = 静音）；修改即时预览，应用/开始对局时持久化 */
    var musicEnabled = s.musicEnabled !== false;
    var musicVolume = Math.round(Number(s.musicVolume));
    if (!isFinite(musicVolume)) musicVolume = 30;
    musicVolume = Math.max(0, Math.min(100, musicVolume));
    var musicSeg = [['1', '开'], ['0', '关']].map(function (item) {
      var checked = (item[0] === '1') === musicEnabled;
      return '<button type="button" class="seg-btn' + (checked ? ' is-checked' : '') + '"' +
        ' data-setting="musicEnabled" data-value="' + item[0] + '" data-testid="music-enabled-' + item[0] + '"' +
        ' aria-pressed="' + checked + '">' + item[1] + '</button>';
    }).join('');
    var musicSection = '<section class="setting-group">' +
      '<div class="setting-label"><h3>背景音乐</h3><p>循环播放 music/1.mp3 · 默认音量 30%，调至 0 即静音（受浏览器限制，首次点击/按键后开始播放）</p></div>' +
      '<div class="music-controls">' +
        '<div class="segmented" role="group" aria-label="背景音乐开关">' + musicSeg + '</div>' +
        '<div class="music-range-wrap">' +
          '<span class="music-range-label">音量</span>' +
          '<input type="range" class="music-range" data-testid="music-volume" min="0" max="100" step="5" value="' + musicVolume + '" aria-label="背景音乐音量" aria-valuetext="' + musicVolume + '%">' +
          '<span class="music-range-val" data-testid="music-volume-val">' + musicVolume + '%</span>' +
        '</div>' +
      '</div>' +
    '</section>';
    /* 音效：默认开启、音量 70（独立于背景音乐）；即时预览，应用/开始对局时持久化 */
    var sfxEnabled = s.sfxEnabled !== false;
    var sfxVolume = Math.round(Number(s.sfxVolume));
    if (!isFinite(sfxVolume)) sfxVolume = 70;
    sfxVolume = Math.max(0, Math.min(100, sfxVolume));
    var sfxSeg = [['1', '开'], ['0', '关']].map(function (item) {
      var checked = (item[0] === '1') === sfxEnabled;
      return '<button type="button" class="seg-btn' + (checked ? ' is-checked' : '') + '"' +
        ' data-setting="sfxEnabled" data-value="' + item[0] + '" data-testid="sfx-enabled-' + item[0] + '"' +
        ' aria-pressed="' + checked + '">' + item[1] + '</button>';
    }).join('');
    var sfxSection = '<section class="setting-group">' +
      '<div class="setting-label"><h3>音效</h3><p>操作 / 发牌 / 结算音效 · 默认音量 70%（与背景音乐独立）</p></div>' +
      '<div class="music-controls">' +
        '<div class="segmented" role="group" aria-label="音效开关">' + sfxSeg + '</div>' +
        '<div class="music-range-wrap">' +
          '<span class="music-range-label">音量</span>' +
          '<input type="range" class="music-range" data-testid="sfx-volume" min="0" max="100" step="5" value="' + sfxVolume + '" aria-label="音效音量" aria-valuetext="' + sfxVolume + '%">' +
          '<span class="music-range-val" data-testid="sfx-volume-val">' + sfxVolume + '%</span>' +
        '</div>' +
      '</div>' +
    '</section>';
    /* 回合倒计时：0=关闭 / 15 / 30 / 60 秒 */
    var timerOpts = turnTimeOptions();
    var timerVal = normalizeTurnTimeLimit(s.turnTimeLimit);
    var timerLabels = { 0: '关闭', 15: '15 秒', 30: '30 秒', 60: '60 秒' };
    var timerSeg = timerOpts.map(function (n) {
      var checked = timerVal === n;
      return '<button type="button" class="seg-btn' + (checked ? ' is-checked' : '') + '"' +
        ' data-setting="turnTimeLimit" data-value="' + n + '" data-testid="timer-option-' + n + '"' +
        ' aria-pressed="' + checked + '">' + (timerLabels[n] || (n + ' 秒')) + '</button>';
    }).join('');
    var timerSection = '<section class="setting-group">' +
      '<div class="setting-label"><h3>回合倒计时</h3>' +
        '<p>仅本地玩家回合计时，超时自动结束回合；弹层/后台时暂停</p></div>' +
      '<div class="segmented timer-segmented" role="group" aria-label="回合倒计时">' + timerSeg + '</div>' +
      '<p class="setting-hint" data-testid="timer-hint">' + (timerVal > 0
        ? '每回合 ' + timerVal + ' 秒；剩余 ≤10 秒红色闪烁，≤5 秒每秒提示音'
        : '已关闭：不限制每回合思考时间') + '</p>' +
    '</section>';
    /* 结算随机性三档（引擎 SETTLE_MODES 为准；7 区也全部可用） */
    var settleNotes = { 1: '波动小 · 牌堆消耗慢', 2: '波动适中 · 推荐', 4: '双方各补 4 张 · 波动最大' };
    var settleCardsHtml = settleModes().map(function (mode) {
      var checked = Number(s.settleCards) === mode.id;
      return '<button type="button" class="choice-card settle-choice' + (checked ? ' is-checked' : '') + '"' +
        ' data-setting="settleCards" data-value="' + mode.id + '"' +
        ' data-testid="settle-mode-' + mode.id + '" role="radio"' +
        ' aria-checked="' + checked + '"' +
        ' aria-label="结算随机性 ' + esc(mode.name) + '：' + esc(mode.label) + '">' +
        '<b>' + esc(mode.name) + '</b><small>' + esc(mode.label) + '</small>' +
        '<em>' + (settleNotes[mode.id] || '') + '</em></button>';
    }).join('');
    var settleHint = '<p class="setting-hint">档位越高，单次结算补牌越多、波动越大，牌堆消耗也越快（更容易进入战略决战）。</p>';

    var feedback;
    if (!validation.ok) {
      feedback = '<div class="feedback is-error" data-testid="settings-summary">' +
        '<span class="feedback-title">配置不可用</span>' +
        validation.errors.map(function (msg) { return '<p>' + esc(msg) + '</p>'; }).join('') + '</div>';
    } else {
      var mode = settleModeMeta(s.settleCards);
      var threshold = info.endgameThreshold != null
        ? info.endgameThreshold : (2 * Number(s.regionCount));
      var gap = info.gapToEndgame != null ? info.gapToEndgame : '—';
      var comp = info.compensationDraw != null
        ? info.compensationDraw : 1;
      var deckNote = '标准 54 张（四花色 A~K + 大小王）· 简单/标准/复杂三档在 3/5/7 区均可选';
      var warnings = validation.warnings && validation.warnings.length
        ? '<p class="feedback-warn">' + validation.warnings.map(esc).join(' ') + '</p>' : '';
      feedback = '<div class="feedback is-ok" data-testid="settings-summary">' +
        '<span class="feedback-title">配置预览</span>' +
        '<p>结算随机性 <b>「' + esc(mode.name) + '」</b>（' + esc(mode.label) + '） · 区域 <b>' +
        info.regionCount + '</b> 个 · <b>' + info.winsNeeded + '</b> 胜制 · 牌堆 <b>' + info.deckSize +
        '</b> 张（四花色）</p>' +
        '<p>每方初始摸 <b>' + info.initialDraw + '</b> 张 · 后手补偿 <b>' + comp +
        '</b> 张 · 决战阈值 <b>' + threshold +
        '</b> 张（2×未结算区域数）· 预计额外消耗约 <b>' + gap + '</b> 张牌后进入战略决战</p>' +
        '<p class="feedback-note">回合倒计时：<b>' + (timerVal > 0 ? timerVal + ' 秒（超时自动结束回合）' : '关闭') + '</b></p>' +
        '<p class="feedback-note">' + esc(deckNote) + '</p>' +
        '<p class="feedback-note">' + esc(deckNote) + '</p>' +
        warnings + '</div>';
    }

    var title = initial ? '开始新对局' : '对局设置';
    var subtitle = '战前布局 → 战役消耗 → 战略决战 · 单机双人对战';
    settingsEl.innerHTML =
      '<div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">' +
        '<div class="modal-head">' +
          '<div><h2 id="settings-title">' + title + '</h2><p class="modal-sub">' + subtitle + '</p></div>' +
          '<button type="button" class="modal-x" data-settings-cancel aria-label="关闭设置">×</button>' +
        '</div>' +
        '<div class="modal-body settings-body">' +
          '<section class="setting-group setting-wide">' +
            '<div class="setting-label"><h3>难度（容错率）</h3><p>消耗 → 均衡 → 突进（影响单独结算后的摸牌方，容错率依次降低）</p></div>' +
            '<div class="choice-row" role="radiogroup" aria-label="难度（容错率）选择">' + diffCards + '</div>' +
          '</section>' +
          '<section class="setting-group"><div class="setting-label"><h3>区域数</h3></div>' +
            '<div class="segmented" role="group" aria-label="区域数">' + regionSeg + '</div>' +
            regionHint + '</section>' +
          '<section class="setting-group setting-wide">' +
            '<div class="setting-label"><h3>结算随机性</h3>' +
              '<p>单独结算时双方各从牌堆补 N 张牌后比大小，档位越高波动越大</p></div>' +
            '<div class="choice-row" role="radiogroup" aria-label="结算随机性">' + settleCardsHtml + '</div>' +
            settleHint + '</section>' +
          '<section class="setting-group"><div class="setting-label"><h3>先手</h3></div>' +
            '<div class="segmented" role="group" aria-label="先手">' + firstSeg + '</div>' +
            '<p class="setting-hint">后手在布局结束后额外补 1 张牌（固定，3/5/7 区相同）</p></section>' +
          '<section class="setting-group"><div class="setting-label"><h3>电脑强度</h3></div>' +
            '<div class="segmented" role="group" aria-label="电脑强度">' + aiSeg + '</div>' + aiHint + '</section>' +
          '<section class="setting-group"><div class="setting-label"><h3>动画</h3></div>' +
            '<div class="segmented" role="group" aria-label="动画">' + animSeg + '</div></section>' +
          dragSection +
          musicSection +
          sfxSection +
          timerSection +
          '<div class="setting-wide">' + feedback + '</div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<span class="foot-hint">设置会自动保存在本机浏览器</span>' +
          '<div class="foot-btns">' +
            (isAndroidPlatform() ? '' :
              '<button type="button" class="btn btn-ghost lan-entry-btn" data-testid="btn-lan-mode" data-lan-mode>局域网联机</button>') +
            '<button type="button" class="btn btn-ghost" data-testid="btn-settings-cancel" data-settings-cancel>取消</button>' +
            '<button type="button" class="btn btn-ghost" data-testid="btn-settings-apply" data-settings-apply>应用设置</button>' +
            '<button type="button" class="btn btn-primary" data-testid="btn-start-game" data-settings-start' +
              (validation.ok ? '' : ' disabled') + '>开始对局</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function onSettingsClick(e) {
    var target = e.target.closest('[data-setting],[data-lan-mode],[data-settings-cancel],[data-settings-apply],[data-settings-start]');
    if (!target) return;
    if (target.hasAttribute('data-setting')) {
      var key = target.getAttribute('data-setting');
      var value = target.getAttribute('data-value');
      if (key === 'musicEnabled') {
        settingsDraft.musicEnabled = value === '1';
        if (handlers.onMusicPreview) {
          handlers.onMusicPreview({ enabled: settingsDraft.musicEnabled, volume: settingsDraft.musicVolume });
        }
        renderSettings();
        return;
      }
      if (key === 'sfxEnabled') {
        settingsDraft.sfxEnabled = value === '1';
        if (handlers.onSfxPreview) {
          handlers.onSfxPreview({ enabled: settingsDraft.sfxEnabled, volume: settingsDraft.sfxVolume });
        }
        renderSettings();
        return;
      }
      if (key === 'drag') {
        settingsDraft.drag = value === 'off' ? 'off' : 'on';
        if (handlers.onDragPreview) handlers.onDragPreview({ enabled: settingsDraft.drag === 'on' });
        renderSettings();
        return;
      }
      if (key === 'difficulty' || key === 'regionCount' || key === 'settleCards' || key === 'turnTimeLimit') {
        settingsDraft[key] = Number(value);
      } else {
        settingsDraft[key] = value;
      }
      renderSettings();
      return;
    }
    if (target.hasAttribute('data-lan-mode')) {
      if (handlers.onOpenLanLobby) handlers.onOpenLanLobby();
      return;
    }
    if (target.hasAttribute('data-settings-cancel') || target.classList.contains('modal-x')) {
      if (handlers.onCancelSettings) handlers.onCancelSettings();
      return;
    }
    if (target.hasAttribute('data-settings-apply')) {
      if (handlers.onApplySettings) handlers.onApplySettings(publicDraft());
      return;
    }
    if (target.hasAttribute('data-settings-start')) {
      if (target.disabled) return;
      if (handlers.onStartGame) handlers.onStartGame(publicDraft());
      return;
    }
  }

  function onSettingsInput(e) {
    if (!settingsEl || !settingsDraft) return;
    var sfxInput = e.target && e.target.closest ? e.target.closest('[data-testid="sfx-volume"]') : null;
    if (sfxInput) {
      var sv = Math.round(Number(sfxInput.value));
      if (!isFinite(sv)) sv = 0;
      sv = Math.max(0, Math.min(100, sv));
      settingsDraft.sfxVolume = sv;
      var svalEl = settingsEl.querySelector('[data-testid="sfx-volume-val"]');
      if (svalEl) svalEl.textContent = sv + '%';
      if (sfxInput.setAttribute) sfxInput.setAttribute('aria-valuetext', sv + '%');
      if (handlers.onSfxPreview) {
        handlers.onSfxPreview({ enabled: settingsDraft.sfxEnabled !== false, volume: sv });
      }
      return;
    }
    var input = e.target && e.target.closest ? e.target.closest('[data-testid="music-volume"]') : null;
    if (!input) return;
    var vol = Math.round(Number(input.value));
    if (!isFinite(vol)) vol = 0;
    vol = Math.max(0, Math.min(100, vol));
    settingsDraft.musicVolume = vol;
    var valEl = settingsEl.querySelector('[data-testid="music-volume-val"]');
    if (valEl) valEl.textContent = vol + '%';
    if (input.setAttribute) input.setAttribute('aria-valuetext', vol + '%');
    if (handlers.onMusicPreview) {
      handlers.onMusicPreview({ enabled: settingsDraft.musicEnabled !== false, volume: vol });
    }
  }

  function publicDraft() {
    var d = deepClone(settingsDraft);
    d.difficulty = Number(d.difficulty);
    d.regionCount = Number(d.regionCount);
    d.settleCards = Number(d.settleCards);
    d.turnTimeLimit = normalizeTurnTimeLimit(d.turnTimeLimit);
    d.musicEnabled = d.musicEnabled !== false;
    var vol = Math.round(Number(d.musicVolume));
    if (!isFinite(vol)) vol = 30;
    d.musicVolume = Math.max(0, Math.min(100, vol));
    d.sfxEnabled = d.sfxEnabled !== false;
    var svol = Math.round(Number(d.sfxVolume));
    if (!isFinite(svol)) svol = 70;
    d.sfxVolume = Math.max(0, Math.min(100, svol));
    return d;
  }

  /* 顶栏音乐按钮状态（main.js 在配置/切换/应用设置后调用） */
  UI.setMusicState = function (info) {
    var btn = el.musicToggle;
    if (!btn) return;
    var enabled = !info || info.enabled !== false;
    var volume = info && info.volume != null ? Math.round(Number(info.volume)) : 30;
    if (!isFinite(volume)) volume = 0;
    volume = Math.max(0, Math.min(100, volume));
    var audible = enabled && volume > 0;
    btn.classList.toggle('is-off', !audible);
    btn.setAttribute('aria-pressed', audible ? 'true' : 'false');
    var label = '背景音乐：' + (enabled ? (volume > 0 ? '开 · 音量 ' + volume + '%' : '开 · 静音') : '关');
    btn.title = label + '（点击切换开关）';
    btn.setAttribute('aria-label', label);
  };

  /* 顶栏立即静音/恢复（主按钮）——点击后调用 handlers.onToggleSfx */
  UI.setSfxState = function (info) {
    var btn = el.sfxToggle;
    if (!btn) return;
    var enabled = !info || info.enabled !== false;
    var volume = info && info.volume != null ? Math.round(Number(info.volume)) : 70;
    if (!isFinite(volume)) volume = 0;
    volume = Math.max(0, Math.min(100, volume));
    var audible = enabled && volume > 0;
    btn.classList.toggle('is-off', !audible);
    btn.setAttribute('aria-pressed', audible ? 'true' : 'false');
    var icon = btn.querySelector('.sfx-icon');
    if (icon) icon.textContent = audible ? '🔊' : '🔇';
    var label = '音效：' + (enabled ? (volume > 0 ? '开 · 音量 ' + volume + '%' : '开 · 静音') : '关');
    btn.title = label + '（点击切换开关）';
    btn.setAttribute('aria-label', label);
  };

  /* ================================================================== *
   * 回合倒计时（v1.5；main.js 计算/驱动，UI 只负责展示）
   * ================================================================== */
  UI.renderTurnTimer = function (model) {
    var node = el.turnTimer;
    if (!node) return;
    model = model || {};
    var state = model.state || 'off';
    var total = Math.max(0, Math.round(Number(model.total) || 0));
    var remaining = Math.max(0, Number(model.remaining) || 0);
    var display = Math.max(0, Math.ceil(remaining - 0.001));
    node.setAttribute('data-state', state);
    node.setAttribute('data-total', String(total));
    node.setAttribute('data-remaining', String(display));
    var visible = state === 'running' || state === 'paused' || state === 'expired' ||
      state === 'opponent' || state === 'trustee';
    node.hidden = !visible;
    var urgent = visible && state !== 'opponent' && state !== 'trustee' && remaining <= 10;
    node.classList.toggle('is-urgent', urgent);
    node.classList.toggle('is-critical', urgent && remaining <= 5);
    node.classList.toggle('is-paused', state === 'paused');
    node.classList.toggle('is-opponent', state === 'opponent');
    node.classList.toggle('is-trustee', state === 'trustee');
    var text;
    if (state === 'trustee') text = '托管中 · 简单 AI';
    else if (state === 'opponent') text = '对方行动中';
    else if (state === 'paused') text = '⏸ ' + display + 's';
    else text = display + 's';
    if (el.turnTimerText) el.turnTimerText.textContent = text;
    if (el.turnTimerFill) {
      el.turnTimerFill.style.width = (total > 0 ? Math.max(0, Math.min(100, remaining / total * 100)) : 0) + '%';
    }
    node.setAttribute('aria-label', state === 'trustee'
      ? '托管中：本地玩家由简单 AI 代打，回合倒计时已暂停'
      : (state === 'opponent'
        ? '对方行动中'
        : (state === 'paused' ? '回合倒计时已暂停，剩余 ' + display + ' 秒' : '回合倒计时 ' + display + ' 秒')));
  };

  /* 计时暂停的弹层（设置/规则/确认/联机大厅/一键启动引导等；结算与决战动画不暂停计时） */
  UI.isTimerOverlayOpen = function () {
    return !!(activeConfirm || settingsEl || rulesEl || lanLobbyEl || lanLaunchEl ||
      lanWaitingEl || roomClosedEl || lanResumingEl);
  };

  /* ================================================================== *
   * 规则弹层
   * ================================================================== */
  var RULES_SECTIONS = [
    { title: '目标', items: [
      '牌桌上有若干区域（默认 5 个，即「五局三胜」）。双方用牌在区域里比大小，赢得更多区域的玩家获胜。',
      '一局分为三个阶段：战前布局 → 战役消耗 → 战略决战。'
    ] },
    { title: '一、战前布局', items: [
      '系统随机决定先手/后手（也可在设置中指定）。',
      '牌堆：3/5/7 区均使用标准单副牌 54 张（四花色 A~K + 大小王）；7 区为 7 局 4 胜，简单/标准/复杂结算三档均可选。',
      '双方各摸 2×区域数 张手牌（默认 5 区 10 张、7 区 14 张），各自选出区域数 张，<b>背面朝上</b>一一对应放入区域。',
      '双方布阵完成后<b>同时揭示</b>：区域中的牌一齐翻到正面。',
      '布局揭示后，后手额外补固定 1 张牌（v2.1；3/5/7 区相同，补偿先手优势）。',
      '进入战役阶段，先手回满 3 点行动点并执行第一个行动。'
    ] },
    { title: '二、战役消耗：行动点与六种行动（v1.4）', items: [
      '<b>行动点（AP）</b>：每回合开始回复到 <b>3 点</b>（不结转）；每个行动消耗不同点数。一回合内可连续执行多个行动，行动点耗尽或无可用行动时自动结束回合；也可随时点「结束回合」（Space / 0）放弃剩余行动点。',
      '<b>1 结算（3 点）</b>：令<b>任意未结算区域</b>立即结算（不再要求区域内已有正面牌）。结算时双方各从牌堆补 N 张正面牌（N=「结算随机性」：简单 1 / 标准 2 / 复杂 4），比较双方在该区域全部正面牌的数值总和，较大者赢得该区域；相等则平局。结算后区域废弃；通常消耗一整回合。',
      '<b>2 翻牌（2 点）</b>：翻开一张我方背面朝上的牌。',
      '<b>3 放牌（1 点）</b>：将一张手牌背面朝上放入一个未结算区域。',
      '<b>4 移牌（1 点）</b>：将我方一张背面牌移到另一个未结算区域（不消耗牌，可多次使用，但受行动点限制）。',
      '<b>5 摸牌（2 点）</b>：从牌堆摸一张牌到手牌。',
      '<b>6 结束回合（0 点）</b>：提前结束本回合，放弃剩余行动点，交由对方行动。',
      '<b>回合时限</b>：每回合默认 30 秒（设置中可关闭或调整为 15 / 60 秒），仅本地玩家的回合计时；倒计时归零即超时，会自动结束回合并交给对方。设置 / 规则 / 确认弹层打开或页面切到后台时暂停计时，切回后继续。',
      '每次行动后立即检查提前锁定与战略决战触发；同一玩家可能在一回合内连续行动多次。'
    ] },
    { title: '三、难度规则（容错率，仅单独结算时生效）', items: [
      '<b>消耗</b>：单独结算后<b>败者</b>摸 1 张牌（容错率最高）。',
      '<b>均衡</b>：单独结算后不摸牌。',
      '<b>突进</b>：单独结算后<b>胜者</b>摸 1 张牌（容错率最低）。',
      '区域平局时无人摸牌；战略决战摊牌不执行难度规则。',
      '「结算随机性」与「难度（容错率）」是两个独立设置：前者影响结算补牌张数，后者影响结算后的摸牌方。'
    ] },
    { title: '四、提前锁定（立即获胜）', items: [
      '任一区域结算后（单独结算或战略决战途中），若一方区域胜场达到胜场门槛（5 区 3 胜 / 3 区 2 胜 / 7 区 4 胜），该方<b>立即获胜</b>，对局随之结束。',
      '剩余未结算区域保持未结算、不再产生结果；终局面板会标注「提前锁定」并列出未结算区域。',
      '提前锁定时，手牌总和仅作记录，不参与决胜。'
    ] },
    { title: '五、战略决战', items: [
      '当牌堆剩余张数 ≤ 2 × 未结算区域数（决战阈值）时触发战略决战。',
      '触发后双方各从牌堆摸「剩余区域数」张牌（合计 2×剩余区域数，恰好把牌堆摸空），随后进入<b>最终部署</b>阶段。',
      '最终部署阶段<b>禁用摸牌与结算</b>，只能轮流执行 翻牌（2 点）/ 放牌（1 点）/ 移牌（1 点）；每回合同样有 3 点行动点，可主动「结束回合」。一方「手牌为 0 且自己场上无背面牌」时，其回合被<b>自动跳过</b>，另一方开新回合并回满行动点。',
      '双方都无牌可动后自动进入<b>最终结算</b>：按区域序号从小到大，直接比较双方该区域现有正面牌点数之和，<b>无补牌、无随机</b>，且不执行难度规则。',
      '最终结算途中仍执行提前锁定：一旦一方达到胜场门槛立即结束对局，剩余区域保持未结算。'
    ] },
    { title: '六、胜负判定', items: [
      '区域胜场先达到「⌊区域数/2⌋+1」的一方获胜（5 区 3 胜、7 区 4 胜）。',
      '提前锁定：任一区域结算后（含最终结算途中）一方达到胜场门槛，立即获胜。',
      '若所有区域结算完毕且无人达到胜场门槛：先比较双方区域胜场，<b>胜场多者获胜</b>（例如 7 区 3 : 2 即使手牌总和 0 : 0，也判 3 胜方获胜）。',
      '区域胜场相同 → 再比较双方剩余手牌的数值总和，多者获胜；只有区域胜场相同且手牌总和也相同才判平局。'
    ] },
    { title: '七、操作提示', items: [
      '快捷键：1 结算 / 2 翻牌 / 3 放牌 / 4 移牌 / 5 摸牌 / Space 或 0 结束回合；Esc 取消选择；Enter 确认弹窗；R 打开规则。',
      '点击行动按钮后按提示选择目标：合法目标会高亮，非法目标会变暗；行动按钮角标为行动点消耗。',
      '鼠标悬停、键盘聚焦（Tab）或触屏点击我方区域内的背面牌，可查看该牌真实牌面（仅自己可见）。',
      '设置中可分别调整背景音乐（默认 30%）与音效（默认 70%）的音量；顶栏 ♪ / 🔊 可一键开关。',
      '结算与决战动画可点击任意处跳过；设置中可选「快速（跳过动画）」。',
      '设置会保存在本机浏览器中，下次打开自动沿用。'
    ] }
  ];

  UI.showRules = function () {
    if (rulesEl) return;
    rulesEl = openLayer('rules', 'overlay rules-overlay', 'rules-modal');
    var body = RULES_SECTIONS.map(function (section) {
      return '<section class="rules-section"><h3>' + esc(section.title) + '</h3>' +
        section.items.map(function (item) { return '<p>' + item + '</p>'; }).join('') + '</section>';
    }).join('');
    rulesEl.innerHTML =
      '<div class="modal rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-title">' +
        '<div class="modal-head">' +
          '<div><h2 id="rules-title">游戏规则</h2><p class="modal-sub">扑克牌 · 比大小</p></div>' +
          '<button type="button" class="modal-x" data-close-rules aria-label="关闭规则">×</button>' +
        '</div>' +
        '<div class="modal-body rules-body">' + body + '</div>' +
        '<div class="modal-foot"><span class="foot-hint">牌面 J=11 · Q=12 · K=13 · 小王=14 · 大王=15</span>' +
          '<div class="foot-btns"><button type="button" class="btn btn-primary" data-testid="btn-close-rules" data-close-rules>关闭</button></div>' +
        '</div>' +
      '</div>';
    rulesEl.addEventListener('click', function (e) {
      if (e.target.closest('[data-close-rules]')) UI.closeRules();
    });
  };

  UI.closeRules = function () {
    if (rulesEl && rulesEl.parentNode) rulesEl.parentNode.removeChild(rulesEl);
    rulesEl = null;
  };

  /* ================================================================== *
   * 结算确认弹层
   * ================================================================== */
  UI.showConfirmSettle = function (data) {
    if (activeConfirm) return Promise.resolve(false);
    var diffInfo = difficultyInfo();
    var settleN = (state && state.config && state.config.settleCards) || 1;
    var mode = settleModeMeta(settleN);
    var modeName = mode ? mode.name : '标准';
    return new Promise(function (resolve) {
      var node = openLayer('confirm', 'overlay confirm-overlay', 'settle-confirm');
      node.innerHTML =
        '<div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">' +
          '<div class="modal-head"><div><h2 id="confirm-title">结算区域 ' + (data.regionId + 1) + '？</h2>' +
            '<p class="modal-sub">消耗 ' + actionCost('settle') + ' 行动点（本回合剩余 ' + currentAp() + ' 点） · 结算后该区域废弃，双方各补 ' + settleN + ' 张牌（结算随机性「' +
              esc(modeName) + '」）</p></div></div>' +
          '<div class="confirm-sums">' +
            '<div class="confirm-side"><span class="confirm-name">' + esc(playerName('p1')) + '</span><b class="confirm-value">' + data.p1Sum + '</b></div>' +
            '<span class="confirm-vs">VS</span>' +
            '<div class="confirm-side"><span class="confirm-name">' + esc(playerName('p2')) + '</span><b class="confirm-value">' + data.p2Sum + '</b></div>' +
          '</div>' +
          '<p class="confirm-note">区域当前正面牌 ' + data.faceUpCount + ' 张 · 任意未结算区域均可结算，补牌后比较双方正面牌总和</p>' +
          '<p class="confirm-note">当前难度「' + esc(diffInfo.name) + '」：' + esc(diffInfo.label) + '</p>' +
          '<div class="modal-foot"><div class="foot-btns">' +
            '<button type="button" class="btn btn-ghost" data-confirm-cancel>取消</button>' +
            '<button type="button" class="btn btn-primary" data-confirm-ok>确认结算</button>' +
          '</div></div>' +
        '</div>';
      function finish(ok) {
        if (!activeConfirm) return;
        activeConfirm = null;
        closeLayer('confirm');
        resolve(!!ok);
      }
      activeConfirm = { finish: finish };
      node.addEventListener('click', function (e) {
        if (e.target.closest('[data-confirm-ok]')) {
          sfxPlay('ui.confirm');
          finish(true);
        } else if (e.target.closest('[data-confirm-cancel]') || e.target === node) finish(false);
      });
    });
  };

  /* ================================================================== *
   * 单独结算浮层
   * ================================================================== */
  UI.showSettlement = function (ev, opts) {
    opts = opts || {};
    if (activeSettle) activeSettle.finish();
    if (!animationEnabled) return Promise.resolve(); // 快速模式：不弹分段结算层
    if (opts.deterministic || ev.deterministic) return showDeterministicSettlement(ev, opts);
    var res = ev.regionResult || {};
    var sums = ev.sums || res.sums || { p1: 0, p2: 0 };
    var winner = ev.winner || res.winner || 'tie';
    var banner = winner === 'p1' ? playerName('p1') + '赢得此区域' : winner === 'p2' ? playerName('p2') + '赢得此区域' : '平局';
    var mood = winner === 'p1' ? 'is-win' : winner === 'p2' ? 'is-lose' : 'is-tie';
    var endgame = !!opts.endgame;
    var kicker = endgame ? '战略决战 · 按点数之和结算' : '区域结算';
    var diffInfo = difficultyInfo();
    var cfgSettle = (state && state.config && state.config.settleCards) || 1;
    var settleN = Number(ev.settleCards || (res.settleCards) || cfgSettle) || 1;
    var mode = settleModeMeta(settleN);
    var modeName = mode ? mode.name : '标准';

    function beforeCards(pid) {
      var before = (ev.regionBefore && ev.regionBefore.sides && ev.regionBefore.sides[pid] &&
        ev.regionBefore.sides[pid].faceUp) || (res.faceUp && res.faceUp[pid]) || [];
      return before;
    }
    function drawnList(pid) {
      var list = ev.drawn && ev.drawn[pid];
      if (list && !Array.isArray(list)) list = [list];
      if (!Array.isArray(list)) list = (res.drawn && res.drawn[pid]) || [];
      if (list && !Array.isArray(list)) list = [list];
      return list || [];
    }
    var drawnP1 = drawnList('p1');
    var drawnP2 = drawnList('p2');
    var baseSums = { p1: 0, p2: 0 };
    ['p1', 'p2'].forEach(function (pid) {
      var before = beforeCards(pid);
      for (var i = 0; i < before.length; i++) baseSums[pid] += Number(before[i].value) || 0;
    });

    function teamHTML(pid) {
      var before = beforeCards(pid);
      var cards = '';
      for (var i = 0; i < before.length; i++) cards += miniCard(before[i], 'settle-card');
      var slots = '';
      for (var d = 0; d < settleN; d++) {
        slots += '<span class="settle-draw" data-testid="settle-draw-' + pid + '-' + d + '">' +
          '<span class="settle-draw-inner"><span class="card card-back card-mini settle-back"></span></span>' +
        '</span>';
      }
      return '<div class="settle-team side-' + pid + '">' +
        '<div class="team-head"><span class="team-name">' + esc(playerName(pid)) + '</span>' +
        '<span class="team-total">合计 <b data-testid="settle-total-' + pid + '">' + baseSums[pid] + '</b></span></div>' +
        '<div class="team-cards">' + (cards || '<span class="card-empty">—</span>') + slots + '</div>' +
      '</div>';
    }

    var note = '';
    if (endgame) {
      note = '战略决战摊牌：按当前正面牌点数之和结算，不执行难度规则';
    } else if (ev.difficultyDraw) {
      note = '难度「' + diffInfo.name + '」：' + ruleShort(diffInfo.rule) + ' → ' +
        esc(playerName(ev.difficultyDraw.playerId)) + '摸 1 张牌';
    } else if (winner === 'tie' && state && state.config.difficulty !== 2) {
      note = '区域平局：难度规则不产生摸牌';
    } else {
      note = '难度「' + diffInfo.name + '」：' + diffInfo.label;
    }

    return new Promise(function (resolve) {
      var node = openLayer('settlement', 'overlay settlement-overlay', 'settlement-overlay');
      node.setAttribute('data-anim-state', 'drawing');
      node.innerHTML =
        '<div class="settle-modal settle-anim" role="dialog" aria-modal="true" aria-label="区域结算结果">' +
          '<div class="settle-head"><span class="settle-kicker">' + kicker + '</span>' +
            '<h2>区域 ' + (ev.regionId + 1) + '</h2>' +
            '<p class="settle-sub" data-testid="settle-sub">结算随机性「' + esc(modeName) + '」：双方各补 ' +
              settleN + ' 张后比较总和</p></div>' +
          '<div class="settle-teams">' +
            teamHTML('p1') +
            '<div class="settle-vs" aria-hidden="true">VS</div>' +
            teamHTML('p2') +
          '</div>' +
          '<div class="settle-result ' + mood + ' is-hidden" data-testid="settle-result-banner">' + banner + '</div>' +
          '<p class="settle-note is-hidden">' + esc(note) + '</p>' +
          '<button type="button" class="btn btn-primary settle-continue is-hidden" data-testid="settlement-confirm">继续</button>' +
          '<p class="settle-skip">点击任意处跳过动画 / 继续</p>' +
        '</div>';

      var timers = [];
      var ended = false;
      var resultShown = false;
      var running = { p1: baseSums.p1, p2: baseSums.p2 };
      var seq = [];
      for (var i = 0; i < settleN; i++) {
        seq.push(['p1', i]);
        seq.push(['p2', i]);
      }
      var stepMs = endgame ? 150 : 220;
      var gapMs = endgame ? 45 : 70;
      var cursor = 0;

      function setState(s) { node.setAttribute('data-anim-state', s); }
      function setTotal(pid, val) {
        var b = node.querySelector('[data-testid="settle-total-' + pid + '"]');
        if (b) b.textContent = String(val);
      }
      function fillSlot(pid, d, card) {
        var slot = node.querySelector('[data-testid="settle-draw-' + pid + '-' + d + '"]');
        if (!slot) return;
        slot.classList.add('is-in');
        if (card && !card.hidden) {
          slot.innerHTML = '<span class="settle-draw-inner is-revealed">' + miniCard(card, 'settle-card is-drawn') + '</span>';
        } else {
          slot.innerHTML = '<span class="settle-draw-inner is-revealed">' +
            '<span class="card card-back card-mini settle-back"></span></span>';
        }
      }
      function revealAllRemaining() {
        for (; cursor < seq.length; cursor++) {
          var pid = seq[cursor][0];
          var d = seq[cursor][1];
          var card = (pid === 'p1' ? drawnP1 : drawnP2)[d] || null;
          fillSlot(pid, d, card);
          if (card && card.value != null) running[pid] += Number(card.value) || 0;
          setTotal(pid, running[pid]);
        }
      }
      function scheduleResult() {
        if (resultShown || ended) return;
        resultShown = true;
        setState('result');
        var rb = node.querySelector('[data-testid="settle-result-banner"]');
        if (rb) rb.classList.remove('is-hidden');
        var noteEl = node.querySelector('.settle-note');
        if (noteEl) noteEl.classList.remove('is-hidden');
        var btn = node.querySelector('[data-testid="settlement-confirm"]');
        if (btn) btn.classList.remove('is-hidden');
        setTotal('p1', sums.p1);
        setTotal('p2', sums.p2);
        if (typeof opts.onResult === 'function') {
          try { opts.onResult(); } catch (err) { /* ignore */ }
        }
        timers.push(setTimeout(finish, endgame ? 900 : 1100));
      }
      function step() {
        if (ended || resultShown) return;
        if (cursor >= seq.length) {
          setState('revealing');
          timers.push(setTimeout(scheduleResult, endgame ? 200 : 280));
          return;
        }
        var item = seq[cursor++];
        var pid = item[0];
        var d = item[1];
        var card = (pid === 'p1' ? drawnP1 : drawnP2)[d] || null;
        var slot = node.querySelector('[data-testid="settle-draw-' + pid + '-' + d + '"]');
        flyGhost(deckAnchor(), slot || node.querySelector('.settle-teams'), {
          ms: stepMs,
          html: '<span class="card card-back card-mini settle-back"></span>',
          afterMs: 0
        }).then(function () {
          if (ended || resultShown) return;
          fillSlot(pid, d, card);
          if (card && card.value != null) running[pid] += Number(card.value) || 0;
          setTotal(pid, running[pid]);
          timers.push(setTimeout(step, gapMs));
        });
      }
      function finish() {
        if (ended) return;
        ended = true;
        for (var t = 0; t < timers.length; t++) clearTimeout(timers[t]);
        timers = [];
        activeSettle = null;
        closeLayer('settlement');
        resolve();
      }
      activeSettle = { finish: finish };
      node.addEventListener('click', function (e) {
        e.preventDefault();
        if (resultShown) { finish(); return; }
        // 跳过动画：直接补齐所有补牌与最终合计，进入结果态（再点一次关闭）
        for (var t = 0; t < timers.length; t++) clearTimeout(timers[t]);
        timers = [];
        revealAllRemaining();
        scheduleResult();
      });
      setState('drawing');
      timers.push(setTimeout(step, 220));
    });
  };

  /* 新决战：无补牌确定性结算浮层（drawn 为空，不播补牌动画；保留 settlement 系列 testid） */
  function showDeterministicSettlement(ev, opts) {
    opts = opts || {};
    var res = ev.regionResult || {};
    var sums = ev.sums || res.sums || { p1: 0, p2: 0 };
    var winner = ev.winner || res.winner || 'tie';
    var banner = winner === 'p1' ? playerName('p1') + '赢得此区域' : winner === 'p2' ? playerName('p2') + '赢得此区域' : '平局';
    var mood = winner === 'p1' ? 'is-win' : winner === 'p2' ? 'is-lose' : 'is-tie';
    var endgame = !!opts.endgame;
    var kicker = endgame ? '战略决战 · 摊牌结算' : '区域结算';
    function beforeCards(pid) {
      return (ev.regionBefore && ev.regionBefore.sides && ev.regionBefore.sides[pid] &&
        ev.regionBefore.sides[pid].faceUp) || (res.faceUp && res.faceUp[pid]) || [];
    }
    function teamHTML(pid) {
      var before = beforeCards(pid);
      var cards = '';
      for (var i = 0; i < before.length; i++) cards += miniCard(before[i], 'settle-card');
      return '<div class="settle-team side-' + pid + '">' +
        '<div class="team-head"><span class="team-name">' + esc(playerName(pid)) + '</span>' +
        '<span class="team-total">合计 <b data-testid="settle-total-' + pid + '">0</b></span></div>' +
        '<div class="team-cards">' + (cards || '<span class="card-empty">—</span>') + '</div>' +
      '</div>';
    }
    var note = '按当前区域正面牌点数结算：无补牌、无随机，不执行难度规则';
    return new Promise(function (resolve) {
      var node = openLayer('settlement', 'overlay settlement-overlay', 'settlement-overlay');
      node.setAttribute('data-deterministic', '1');
      node.setAttribute('data-anim-state', 'revealing');
      node.innerHTML =
        '<div class="settle-modal settle-anim determine">' +
          '<div class="settle-head"><span class="settle-kicker">' + esc(kicker) + '</span>' +
            '<h2>区域 ' + (ev.regionId + 1) + '</h2>' +
            '<p class="settle-sub" data-testid="settle-sub">确定结算：按当前正面牌点数比较（无补牌）</p></div>' +
          '<div class="settle-teams">' + teamHTML('p1') +
            '<div class="settle-vs" aria-hidden="true">VS</div>' + teamHTML('p2') + '</div>' +
          '<div class="settle-result ' + mood + ' is-hidden" data-testid="settle-result-banner">' + banner + '</div>' +
          '<p class="settle-note is-hidden">' + esc(note) + '</p>' +
          '<button type="button" class="btn btn-primary settle-continue is-hidden" data-testid="settlement-confirm">继续</button>' +
          '<p class="settle-skip">点击任意处跳过 / 继续</p>' +
        '</div>';
      var timers = [];
      var ended = false;
      var resultShown = false;
      function setTotal(pid, val) {
        var b = node.querySelector('[data-testid="settle-total-' + pid + '"]');
        if (b) b.textContent = String(val);
      }
      function showResult() {
        if (resultShown || ended) return;
        resultShown = true;
        node.setAttribute('data-anim-state', 'result');
        setTotal('p1', sums.p1);
        setTotal('p2', sums.p2);
        var rb = node.querySelector('[data-testid="settle-result-banner"]');
        if (rb) rb.classList.remove('is-hidden');
        var noteEl = node.querySelector('.settle-note');
        if (noteEl) noteEl.classList.remove('is-hidden');
        var btn = node.querySelector('[data-testid="settlement-confirm"]');
        if (btn) btn.classList.remove('is-hidden');
        if (typeof opts.onResult === 'function') {
          try { opts.onResult(); } catch (err) { /* ignore */ }
        }
        timers.push(setTimeout(finish, endgame ? 800 : 950));
      }
      function finish() {
        if (ended) return;
        ended = true;
        for (var t = 0; t < timers.length; t++) clearTimeout(timers[t]);
        timers = [];
        activeSettle = null;
        closeLayer('settlement');
        resolve();
      }
      activeSettle = { finish: finish };
      node.addEventListener('click', function (e) {
        e.preventDefault();
        if (resultShown) { finish(); return; }
        for (var t = 0; t < timers.length; t++) clearTimeout(timers[t]);
        timers = [];
        showResult();
      });
      timers.push(setTimeout(showResult, endgame ? 620 : 520));
    });
  }

  /* ================================================================== *
   * 战略决战：触发闪屏 / 补牌动画 / 跳过提示 / 最终结算横幅
   * ================================================================== */
  UI.showEndgameSplash = function (ev, opts) {
    opts = opts || {};
    var openCount = (ev.openRegionIds || []).length;
    var drawPer = Number(ev.drawPerPlayer != null ? ev.drawPerPlayer : openCount) || 0;
    var d1 = ev.drawnCounts && ev.drawnCounts.p1 != null ? Number(ev.drawnCounts.p1) : drawPer;
    var d2 = ev.drawnCounts && ev.drawnCounts.p2 != null ? Number(ev.drawnCounts.p2) : drawPer;
    var deckCount = ev.deckCount != null ? ev.deckCount : '—';
    var threshold = ev.threshold != null ? ev.threshold : (2 * openCount);
    var drawText = d1 === d2
      ? ('双方各摸 <b>' + d1 + '</b> 张牌（共 ' + (d1 + d2) + ' 张，牌堆摸空）')
      : ('双方分别摸 <b>' + d1 + '</b> / <b>' + d2 + '</b> 张牌（共 ' + (d1 + d2) + ' 张，牌堆摸空）');
    return new Promise(function (resolve) {
      var node = openLayer('splash', 'overlay endgame-splash', 'endgame-splash');
      node.setAttribute('data-endgame-phase', 'trigger');
      node.innerHTML =
        '<div class="splash-flash" aria-hidden="true"></div>' +
        '<div class="splash-inner splash-endgame" role="dialog" aria-modal="true" aria-label="战略决战开始">' +
          '<span class="splash-kicker">决战触发 · 牌堆 ' + esc(deckCount) + ' 张</span>' +
          '<h2>战略决战</h2>' +
          '<p class="splash-lead">' + drawText + '</p>' +
          '<p class="splash-sub">之后<b>禁用摸牌 / 结算</b>，只能翻牌（2 点）/ 放牌（1 点）/ 移牌（1 点），每回合 3 行动点，可提前结束回合；无牌可翻、可放时自动跳过该方回合；' +
            '双方都无可行动后，按各区域现有正面牌点数结算（<b>无随机补牌</b>，不执行难度规则）。</p>' +
          '<p class="splash-meta">剩余 ' + openCount + ' 区 · 决战阈值 ' + esc(threshold) + ' 张（2×未结算区域数）</p>' +
          '<p class="splash-skip">点击任意处继续</p>' +
        '</div>';
      var done = false;
      var timer = setTimeout(finish, opts.autoMs || 2200);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        activeSplash = null;
        closeLayer('splash');
        resolve();
      }
      activeSplash = { finish: finish };
      node.addEventListener('click', function (e) { e.preventDefault(); finish(); });
    });
  };

  /* 决战补牌：牌从牌堆飞入双方手牌；事件仅含数量与手牌数（不含牌面） */
  UI.playEndgameDraw = function (ev) {
    if (!animationEnabled) return Promise.resolve();
    var pid = ev && ev.playerId === 'p2' ? 'p2' : 'p1';
    var count = Number(ev && ev.count) || 0;
    var handSize = ev && ev.handSize != null ? ev.handSize : null;
    var name = pid === 'p1' ? '你' : playerName('p2');
    var node = openLayer('egdraw', 'overlay endgame-draw-overlay', 'endgame-draw-overlay');
    node.setAttribute('data-anim-state', 'drawing');
    node.innerHTML =
      '<div class="eg-draw-box" role="status" aria-live="polite">' +
        '<span class="eg-draw-kicker">决战补牌</span>' +
        '<div class="eg-draw-row ' + (pid === 'p1' ? 'side-p1' : 'side-p2') + '" data-testid="endgame-draw-' + pid + '">' +
          '<span class="eg-draw-name">' + esc(name) + '</span>' +
          '<span class="eg-draw-count">+' + count + ' 张</span>' +
          '<span class="eg-draw-hand">手牌 ' + (handSize != null ? handSize : '?') + ' 张</span>' +
        '</div>' +
        '<p class="eg-draw-skip">牌堆摸空 · 即将进入最终部署</p>' +
      '</div>';
    var ghosts = Math.min(count, 4);
    var from = deckAnchor();
    var to = handAnchor(pid);
    var chain = Promise.resolve();
    for (var i = 0; i < ghosts; i++) {
      (function () {
        chain = chain.then(function () {
          return flyGhost(from, to, {
            ms: 180,
            afterMs: 30,
            html: '<span class="card card-back card-mini settle-back"></span>'
          });
        });
      })();
    }
    var total = Math.max(700, ghosts * 210 + 320);
    return chain.then(function () {
      return delay(Math.max(120, total - ghosts * 210));
    }).then(function () {
      node.setAttribute('data-anim-state', 'done');
      closeLayer('egdraw');
    });
  };

  UI.showEndgameSkip = function (ev) {
    if (!animationEnabled) return Promise.resolve();
    var pid = ev && ev.playerId === 'p2' ? 'p2' : 'p1';
    var name = playerName(pid);
    UI.toast(name + ' 无牌可翻 / 可放，回合被跳过', 'warn');
    // 短暂高亮状态横幅，E2E 可抓 endgame-skip-notice（渲染层另有持久提示条）
    var node = openLayer('egskip', 'endgame-skip-flash', 'endgame-skip-flash');
    node.setAttribute('data-testid', 'endgame-skip-notice');
    node.innerHTML = '<span class="eg-skip-dot" aria-hidden="true"></span>' + esc(name) + ' 回合被跳过 · 另一方连续行动';
    return delay(900).then(function () { closeLayer('egskip'); });
  };

  UI.showEndgameShowdown = function (ev, opts) {
    opts = opts || {};
    if (!animationEnabled) return Promise.resolve();
    return new Promise(function (resolve) {
      var node = openLayer('showdown', 'overlay endgame-showdown-overlay', 'endgame-showdown-banner');
      node.setAttribute('data-anim-state', 'showdown');
      node.innerHTML =
        '<div class="showdown-box" role="dialog" aria-modal="true" aria-label="战略决战最终结算">' +
          '<span class="showdown-kicker">双方均无牌可动</span>' +
          '<h2>最终结算</h2>' +
          '<p>按各区域现有正面牌点数之和比较（<b>无补牌 · 无随机</b>），不执行难度规则；达到胜场门槛立即锁定。</p>' +
          '<p class="showdown-meta">' + ((ev && ev.openRegionIds) ? (ev.openRegionIds.length + ' 个区域待结算') : '按区域序号依次结算') + '</p>' +
        '</div>';
      var done = false;
      var timer = setTimeout(finish, opts.autoMs || 1500);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        closeLayer('showdown');
        resolve();
      }
      node.addEventListener('click', function (e) { e.preventDefault(); finish(); });
    });
  };

  /* ================================================================== *
   * 终局面板
   * ================================================================== */
  UI.showGameOver = function (result, st, opts) {
    opts = opts || {};
    result = result || (st && st.result) || { winner: 'draw', reason: 'draw', regionWins: { p1: 0, p2: 0, ties: 0 }, handSums: { p1: 0, p2: 0 }, winsNeeded: 3 };
    st = st || state;
    if (!result) return;
    if (activeGameover) { if (activeGameover.parentNode) activeGameover.parentNode.removeChild(activeGameover); activeGameover = null; }
    var lan = opts.lan || null;
    var lanActive = !!lan;
    var winner = result.winner;
    var title = winner === 'p1' ? playerName('p1') + '获胜' : winner === 'p2' ? playerName('p2') + '获胜' : '平局';
    var mood = winner === 'p1' ? 'is-win' : winner === 'p2' ? 'is-lose' : 'is-draw';
    var rw = result.regionWins || { p1: 0, p2: 0, ties: 0 };
    var hs = result.handSums || { p1: 0, p2: 0 };
    var winsNeeded = result.winsNeeded || (st && st.config ? st.config.winsNeeded : 3);
    var unsettled = Array.isArray(result.unsettledRegions) ? result.unsettledRegions.slice() : [];
    var early = !!result.early && unsettled.length > 0;
    var forfeit = result.reason === 'forfeit';
    var reasonText = '';
    var winsEqual = rw.p1 === rw.p2;
    var handsEqual = hs.p1 === hs.p2;
    if (early) {
      reasonText = '提前锁定：区域胜场 ' + rw.p1 + ' : ' + rw.p2 + ' 达到 ' + winsNeeded +
        ' 胜门槛，剩余 ' + unsettled.length + ' 个区域未结算';
    } else if (forfeit) {
      var forfeitName = result.forfeitedBy ? playerName(result.forfeitedBy) : '一方';
      if (result.forfeitReason === 'ap-cap-zero') {
        reasonText = '认输：' + forfeitName + ' 在战略决战中行动点长期未花完，行动点上限降至 0，判负；剩余 ' +
          unsettled.length + ' 个区域未结算';
      } else {
        reasonText = '认输：' + forfeitName + ' 连续两回合无有效行动（或仅移牌），判负；剩余 ' +
          unsettled.length + ' 个区域未结算';
      }
    } else if (result.reason === 'region_wins') {
      reasonText = (winsEqual ? '区域胜场 ' + rw.p1 + ' : ' + rw.p2 : '区域胜场 ' + rw.p1 + ' : ' + rw.p2 + '，胜场多者获胜') +
        (rw.ties ? ' · 平 ' + rw.ties : '');
    } else if (result.reason === 'hand_sum') {
      reasonText = '区域胜场相同（' + rw.p1 + ' : ' + rw.p2 + (rw.ties ? ' · 平 ' + rw.ties : '') +
        '），比较手牌总和 ' + hs.p1 + ' : ' + hs.p2;
    } else if (winsEqual && handsEqual) {
      reasonText = '区域胜场与手牌总和均相同（区域 ' + rw.p1 + ' : ' + rw.p2 + (rw.ties ? ' · 平 ' + rw.ties : '') +
        '，手牌总和 ' + hs.p1 + ' : ' + hs.p2 + '）';
    } else {
      // 防御：非真平局数据也如实展示，不伪造「均相同」
      reasonText = '区域胜场 ' + rw.p1 + ' : ' + rw.p2 + (rw.ties ? ' · 平 ' + rw.ties : '') +
        '，手牌总和 ' + hs.p1 + ' : ' + hs.p2 + '（判定：平局）';
    }
    var regionCards = '';
    if (st && st.regions) {
      for (var i = 0; i < st.regions.length; i++) {
        var region = st.regions[i];
        var res = region.result;
        if (!res && region.status === 'open') {
          // 提前锁定后未结算的区域：如实显示「未结算」，不伪造平局
          regionCards += '<div class="result-region is-unsettled">' +
            '<span class="rr-name">区域 ' + (i + 1) + '</span>' +
            '<span class="rr-badge">未结算</span>' +
            '<span class="rr-sums">—</span>' +
          '</div>';
          continue;
        }
        var w = res ? res.winner : 'tie';
        var tag = w === 'p1' ? '胜' : w === 'p2' ? '负' : '平';
        var cls = w === 'p1' ? 'is-win' : w === 'p2' ? 'is-lose' : 'is-tie';
        var sm = res && res.sums ? res.sums : { p1: 0, p2: 0 };
        regionCards += '<div class="result-region ' + cls + '">' +
          '<span class="rr-name">区域 ' + (i + 1) + '</span>' +
          '<span class="rr-badge">' + tag + '</span>' +
          '<span class="rr-sums">' + sm.p1 + ' : ' + sm.p2 + '</span>' +
        '</div>';
      }
    }
    var total = Math.max(1, hs.p1 + hs.p2);
    var pct1 = Math.round(hs.p1 / total * 100);
    var highlightHand = !early && !forfeit && result.reason === 'hand_sum';
    var seed = st && st.config ? st.config.seed : null;
    var settleName = (settleModeMeta((st && st.config && st.config.settleCards) || 2) || { name: '标准' }).name;
    var footMeta = seed != null
      ? ' · 结算 ' + settleName + ' · 种子 ' + seed
      : (lan && lan.meta && lan.meta.code ? ' · 结算 ' + settleName + ' · 房间 ' + lan.meta.code : ' · 结算 ' + settleName);
    activeGameover = openLayer('gameover', 'overlay gameover-overlay', 'gameover-overlay');
    activeGameover.innerHTML =
      '<div class="gameover-modal" role="dialog" aria-modal="true" aria-label="对局结果">' +
        '<div class="gameover-head">' +
          '<span class="result-kicker">对局结束</span>' +
          (early
            ? '<span class="gameover-early-badge" data-testid="gameover-early-badge">⚡ 提前锁定</span>'
            : '') +
          (forfeit
            ? '<span class="gameover-early-badge" data-testid="gameover-forfeit-badge">认输</span>'
            : '') +
          '<h2 class="result-title ' + mood + '">' + title + '</h2>' +
          '<p class="result-reason">' + esc(reasonText) + '</p>' +
        '</div>' +
        '<div class="result-regions" style="--cols:' + ((st && st.regions) ? st.regions.length : 5) + '">' + regionCards + '</div>' +
        '<div class="hand-compare' + (highlightHand ? ' is-highlight' : '') + '">' +
          '<div class="hand-compare-head"><span>手牌总和对比</span>' +
            '<span class="hand-compare-note">' +
              (early ? '提前锁定 · 仅作记录' : forfeit ? '认输 · 仅作记录' : result.reason === 'draw' ? '区域胜场与手牌总和均相同 · 平局' : result.reason === 'hand_sum' ? '区域胜场相同，由手牌总和决胜' : '仅作记录') +
            '</span></div>' +
          '<div class="compare-row"><span class="compare-name">' + esc(playerName('p1')) + '</span>' +
            '<div class="compare-bar"><div class="compare-fill p1" style="width:' + pct1 + '%"></div></div>' +
            '<b class="compare-value">' + hs.p1 + '</b></div>' +
          '<div class="compare-row"><span class="compare-name">' + esc(playerName('p2')) + '</span>' +
            '<div class="compare-bar"><div class="compare-fill p2" style="width:' + (100 - pct1) + '%"></div></div>' +
            '<b class="compare-value">' + hs.p2 + '</b></div>' +
        '</div>' +
        lanFooterHTML(lan) +
        '<div class="modal-foot gameover-foot">' +
          '<span class="foot-hint">共 ' + (st && st.turnCount != null ? st.turnCount : '—') + ' 个战役行动' + esc(footMeta) + '</span>' +
          '<div class="foot-btns">' +
            '<button type="button" class="btn btn-primary" data-testid="btn-restart" data-gameover-restart>' +
              (lanActive ? '再来一局' : '再来一局') + '</button>' +
            (lanActive
              ? '<button type="button" class="btn btn-ghost" data-gameover-leave data-testid="btn-gameover-leave">离开房间</button>'
              : '<button type="button" class="btn btn-ghost" data-gameover-settings>调整设置</button>') +
            '<button type="button" class="btn btn-ghost" data-gameover-rules>查看规则</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    activeGameover.addEventListener('click', function (e) {
      if (e.target.closest('[data-gameover-restart]')) {
        if (lanActive) { if (handlers.onLanRematch) handlers.onLanRematch(); }
        else if (handlers.onRestart) handlers.onRestart();
      } else if (e.target.closest('[data-gameover-settings]')) { if (handlers.onOpenSettings) handlers.onOpenSettings(); }
      else if (e.target.closest('[data-gameover-leave]')) { if (handlers.onLanLeave) handlers.onLanLeave(); }
      else if (e.target.closest('[data-gameover-rules]')) { if (handlers.onOpenRules) handlers.onOpenRules(); }
    });
  };

  function lanFooterHTML(lan) {
    if (!lan) return '';
    var meta = lan.meta || {};
    var ready = meta.rematchReady || { p1: false, p2: false };
    var requested = !!lan.rematchRequested;
    var opponentReady = !!ready.p2;
    var text, cls;
    if (requested && opponentReady) { text = '双方已准备，正在开始新对局…'; cls = 'is-ready'; }
    else if (requested) { text = '已请求再来一局，等待对手确认…'; cls = 'is-waiting'; }
    else if (opponentReady) { text = '对手已准备再来一局，点击「再来一局」立刻开始'; cls = 'is-ready'; }
    else { text = '再来一局需要双方都确认'; cls = 'is-idle'; }
    return '<div class="lan-rematch ' + cls + '" data-testid="lan-rematch-status">' +
      '<span class="lan-rematch-dot" aria-hidden="true"></span>' + esc(text) + '</div>';
  }

  UI.updateGameOverLan = function (lan) {
    if (!activeGameover) return;
    var holder = activeGameover.querySelector('.lan-rematch');
    if (holder) {
      holder.outerHTML = lanFooterHTML(lan);
    }
  };

  UI.closeGameOver = function () {
    if (activeGameover && activeGameover.parentNode) activeGameover.parentNode.removeChild(activeGameover);
    activeGameover = null;
  };

  /* ================================================================== *
   * 局域网：大厅 / 等待房间 / 房间关闭
   * ================================================================== */
  function lanOriginText() {
    if (root.location && /^https?:$/.test(root.location.protocol)) return root.location.origin;
    return 'file://（联机需要 http 服务）';
  }

  UI.showLanLobby = function (options) {
    var opts = options || {};
    closeLanLobby();
    lanLobbyModel = {
      name: opts.nickname || '玩家',
      code: String(opts.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
      configSummary: opts.configSummary || '',
      availState: opts.availState || 'checking',
      info: opts.info || null,
      busy: false,
      error: ''
    };
    lanLobbyEl = openLayer('lanlobby', 'overlay lan-lobby-overlay', 'lan-lobby');
    lanLobbyEl.addEventListener('click', onLanLobbyClick);
    lanLobbyEl.addEventListener('input', onLanLobbyInput);
    lanLobbyEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var code = (lanLobbyModel && lanLobbyModel.code) || '';
        if (code.length === 5) triggerLanJoin();
        else triggerLanCreate();
      }
    });
    renderLanLobby();
  };

  UI.closeLanLobby = closeLanLobby;

  function closeLanLobby() {
    if (lanLobbyEl && lanLobbyEl.parentNode) lanLobbyEl.parentNode.removeChild(lanLobbyEl);
    lanLobbyEl = null;
    lanLobbyModel = null;
  }

  /* ---------- v1.7 一键启动引导（file:// 且本地服务器未启动时） ---------- */
  UI.showLanLaunchGuide = function (data) {
    var m = data || {};
    closeLayer('lanlaunch');
    lanLaunchModel = {
      state: m.state || 'probing',
      ports: Array.isArray(m.ports) ? m.ports.slice() : [],
      command: m.command || 'node tools/launch.js',
      port: m.port || null,
      error: m.error || ''
    };
    lanLaunchEl = openLayer('lanlaunch', 'overlay lan-launch-overlay', 'lan-launch-guide');
    lanLaunchEl.addEventListener('click', onLanLaunchClick);
    renderLanLaunchGuide();
  };

  UI.updateLanLaunchGuide = function (patch) {
    if (!lanLaunchEl || !lanLaunchModel) return;
    patch = patch || {};
    if (patch.state) lanLaunchModel.state = patch.state;
    if (patch.ports) lanLaunchModel.ports = patch.ports.slice();
    if (patch.command) lanLaunchModel.command = patch.command;
    if (Object.prototype.hasOwnProperty.call(patch, 'port')) lanLaunchModel.port = patch.port;
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) lanLaunchModel.error = patch.error || '';
    renderLanLaunchGuide();
  };

  UI.closeLanLaunchGuide = function () { closeLayer('lanlaunch'); lanLaunchEl = null; lanLaunchModel = null; };

  function onLanLaunchClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-lan-launch-close]')) {
      if (handlers.onCloseLanLaunch) handlers.onCloseLanLaunch();
      return;
    }
    if (t.closest('[data-testid="lan-copy-command"]')) {
      if (handlers.onLanCopyCommand) handlers.onLanCopyCommand();
      return;
    }
    if (t.closest('[data-testid="lan-retry-connect"]')) {
      if (!lanLaunchModel || lanLaunchModel.state === 'probing') return;
      if (handlers.onLanRetryConnect) handlers.onLanRetryConnect();
    }
  }

  function renderLanLaunchGuide() {
    if (!lanLaunchEl || !lanLaunchModel) return;
    var m = lanLaunchModel;
    var portsText = (m.ports || []).map(function (p) { return 'http://127.0.0.1:' + p; }).join(' · ');
    var probing = m.state === 'probing';
    var found = m.state === 'found';
    var statusHtml;
    if (probing) {
      statusHtml = '<span class="lan-launch-spin" aria-hidden="true"></span>' +
        '<span class="lan-launch-status-text">正在探测本地联机服务器…</span>' +
        (portsText ? '<span class="lan-launch-ports" data-testid="lan-launch-ports">' + esc(portsText) + '</span>' : '');
    } else if (found) {
      statusHtml = '<span class="lan-launch-ok" aria-hidden="true">✓</span>' +
        '<span class="lan-launch-status-text">已连接本地联机服务器（端口 ' + esc(String(m.port || '')) + '），正在进入联机大厅…</span>';
    } else {
      statusHtml = '<span class="lan-launch-fail" aria-hidden="true">!</span>' +
        '<span class="lan-launch-status-text"><b>未检测到正在运行的本地联机服务器</b>' +
        (m.error ? '：' + esc(m.error) : '') +
        '<small>已尝试：' + esc(portsText || '—') + ' · 双击「启动联机.bat」后再点「我已启动，重试」</small></span>';
    }
    lanLaunchEl.setAttribute('data-state', m.state);
    lanLaunchEl.innerHTML =
      '<div class="modal lan-launch-modal" role="dialog" aria-modal="true" aria-labelledby="lan-launch-title">' +
        '<div class="modal-head">' +
          '<div><h2 id="lan-launch-title">启动局域网联机</h2>' +
            '<p class="modal-sub">无需输入命令 · 双击一次「启动联机.bat」即可</p></div>' +
          '<button type="button" class="modal-x" data-lan-launch-close aria-label="关闭启动引导">×</button>' +
        '</div>' +
        '<div class="modal-body lan-launch-body">' +
          '<ol class="lan-launch-steps">' +
            '<li><b>双击项目目录里的「启动联机.bat」</b>' +
              '<span>会自动启动本地联机服务器，并在浏览器打开联机大厅（Windows 一键启动，无需任何命令）。</span></li>' +
            '<li><b>回到本页，点「我已启动，重试」</b>' +
              '<span>页面会自动探测并跳转到本地服务器；也可以直接使用它自动打开的浏览器页面。</span></li>' +
          '</ol>' +
          '<div class="lan-launch-status' + (probing ? ' is-probing' : found ? ' is-found' : ' is-fail') + '" data-testid="lan-launch-status">' +
            statusHtml +
          '</div>' +
          '<div class="lan-launch-cmd-row">' +
            '<code class="lan-launch-cmd" data-testid="lan-launch-command">' + esc(m.command || 'node tools/launch.js') + '</code>' +
            '<button type="button" class="btn btn-ghost" data-testid="lan-copy-command">复制启动命令</button>' +
          '</div>' +
          '<p class="lan-launch-note">「启动联机.bat」未出现时，可在本项目目录的命令行运行上面的命令。单机模式无需服务器，随时可玩。</p>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<span class="foot-hint">当前页面：file:// · 点击该入口才会尝试联机</span>' +
          '<div class="foot-btns">' +
            '<button type="button" class="btn btn-ghost" data-testid="btn-lan-launch-close" data-lan-launch-close>返回单机</button>' +
            '<button type="button" class="btn btn-primary" data-testid="lan-retry-connect"' +
              (probing ? ' disabled' : '') + '>' + (probing ? '探测中…' : '我已启动，重试') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  UI.setLanAvailability = function (state, info) {
    if (!lanLobbyModel) return;
    lanLobbyModel.availState = state;
    lanLobbyModel.info = info || null;
    renderLanLobby();
  };

  UI.setLanBusy = function (busy) {
    if (!lanLobbyModel) return;
    lanLobbyModel.busy = !!busy;
    renderLanLobby();
  };

  UI.setLanError = function (message) {
    if (!lanLobbyModel) return;
    lanLobbyModel.error = message || '';
    renderLanLobby();
  };

  function lanNameValid(name) {
    return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 10;
  }

  function triggerLanCreate() {
    if (!lanLobbyModel || lanLobbyModel.busy) return;
    if (lanLobbyModel.availState !== 'online') { UI.toast('局域网服务器不可用，请先运行 node server.js', 'warn'); return; }
    if (!lanNameValid(lanLobbyModel.name)) { UI.setLanError('请输入 1–10 个字符的昵称'); return; }
    if (handlers.onLanCreate) handlers.onLanCreate({ name: lanLobbyModel.name.trim() });
  }

  function triggerLanJoin() {
    if (!lanLobbyModel || lanLobbyModel.busy) return;
    if (lanLobbyModel.availState !== 'online') { UI.toast('局域网服务器不可用，请先运行 node server.js', 'warn'); return; }
    if (!lanNameValid(lanLobbyModel.name)) { UI.setLanError('请输入 1–10 个字符的昵称'); return; }
    if (lanLobbyModel.code.length !== 5) { UI.setLanError('房间码应为 5 位字母或数字'); return; }
    if (handlers.onLanJoin) handlers.onLanJoin({ name: lanLobbyModel.name.trim(), code: lanLobbyModel.code });
  }

  function onLanLobbyInput(e) {
    var t = e.target;
    if (!t || !lanLobbyModel) return;
    if (t.hasAttribute('data-lan-name')) {
      lanLobbyModel.name = t.value;
      lanLobbyModel.error = '';
    } else if (t.hasAttribute('data-lan-code')) {
      var next = String(t.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      t.value = next;
      lanLobbyModel.code = next;
      lanLobbyModel.error = '';
    }
  }

  function onLanLobbyClick(e) {
    var t = e.target;
    if (!t) return;
    if (t.closest('[data-lan-close]')) { if (handlers.onLanCloseLobby) handlers.onLanCloseLobby(); return; }
    if (t.closest('[data-lan-retry]')) { if (handlers.onLanRetryInfo) handlers.onLanRetryInfo(); return; }
    if (t.closest('[data-lan-create]')) { triggerLanCreate(); return; }
    if (t.closest('[data-lan-join]')) { triggerLanJoin(); return; }
  }

  function renderLanLobby() {
    if (!lanLobbyEl || !lanLobbyModel) return;
    var m = lanLobbyModel;
    var online = m.availState === 'online';
    var checking = m.availState === 'checking';
    var info = m.info;
    var statusText = checking ? '正在检测局域网服务器…'
      : online ? '服务在线' + (info && info.version ? ' · v' + info.version : '') + (info && info.rooms != null ? ' · ' + info.rooms + ' 个房间' : '')
      : '服务未连接';
    var statusCls = checking ? 'is-pending' : online ? 'is-online' : 'is-offline';

    var offlineBox = '';
    if (!online && !checking) {
      offlineBox = '<div class="lan-offline" data-testid="lan-unavailable">' +
        '<b>局域网服务未启动</b>' +
        '<p><b>最快方式：双击项目目录里的「启动联机.bat」</b>——会自动启动服务器并在浏览器打开联机大厅（无需输入命令）。</p>' +
        '<p class="lan-code-line"><code>node tools/launch.js</code></p>' +
        '<p>也可以在项目目录运行 <code>node server.js</code>，然后在同一局域网的电脑浏览器打开服务器打印的「局域网访问」地址，例如 <code>http://192.168.x.x:5200/</code>。</p>' +
        '<p class="lan-offline-note">当前页面：<code>' + esc(lanOriginText()) + '</code>' +
          (root.location && root.location.protocol === 'file:' ? ' · file:// 页面请回到设置点「局域网联机」使用一键启动引导' : '') + '</p>' +
        '<button type="button" class="btn btn-ghost" data-lan-retry>重新检测</button>' +
      '</div>';
    } else if (checking) {
      offlineBox = '<div class="lan-offline is-pending"><b>正在检测局域网服务器…</b>' +
        '<p>若长时间无响应，请双击「启动联机.bat」或运行 <code>node tools/launch.js</code>。</p></div>';
    }

    var cards = '';
    if (online) {
      cards = '<div class="lan-cards">' +
        '<section class="lan-card">' +
          '<h3>创建房间</h3>' +
          '<p>你将成为房主，使用下方当前对局设置。</p>' +
          '<div class="lan-config-summary" data-testid="lan-config-summary">' + esc(m.configSummary) + '</div>' +
          '<button type="button" class="btn btn-primary lan-wide-btn" data-testid="btn-lan-create" data-lan-create' +
            (m.busy ? ' disabled' : '') + '>' + (m.busy ? '处理中…' : '创建房间') + '</button>' +
        '</section>' +
        '<section class="lan-card">' +
          '<h3>加入房间</h3>' +
          '<p>输入朋友分享的 5 位房间码。</p>' +
          '<input type="text" class="lan-code-input" data-testid="lan-code" data-lan-code' +
            ' value="' + esc(m.code) + '" placeholder="ABC12" maxlength="5" autocomplete="off" spellcheck="false" aria-label="房间码" />' +
          '<button type="button" class="btn btn-primary lan-wide-btn" data-testid="btn-lan-join" data-lan-join' +
            (m.busy ? ' disabled' : '') + '>' + (m.busy ? '处理中…' : '加入房间') + '</button>' +
        '</section>' +
      '</div>';
    }

    lanLobbyEl.innerHTML =
      '<div class="modal lan-lobby-modal" role="dialog" aria-modal="true" aria-labelledby="lan-lobby-title">' +
        '<div class="modal-head">' +
          '<div><h2 id="lan-lobby-title">局域网联机</h2>' +
            '<p class="modal-sub">同一局域网内两台设备双人对战 · 无需外网</p></div>' +
          '<button type="button" class="modal-x" data-lan-close aria-label="关闭联机大厅">×</button>' +
        '</div>' +
        '<div class="modal-body lan-lobby-body">' +
          '<div class="lan-status-row"><span class="lan-dot ' + statusCls + '" aria-hidden="true"></span>' +
            '<span class="lan-status-text">' + esc(statusText) + '</span>' +
            (online && info && info.lanUrls && info.lanUrls.length ? '<span class="lan-lanaddr">' +
              esc(lanShareBases(info.lanUrls).slice(0, 2).join(' · ')) + '</span>' : '') +
          '</div>' +
          offlineBox +
          (online ? '<div class="lan-name-row"><label for="lan-name-input">你的昵称</label>' +
            '<input id="lan-name-input" type="text" data-testid="lan-name" data-lan-name value="' + esc(m.name) + '"' +
            ' maxlength="10" placeholder="输入昵称" autocomplete="off" /></div>' : '') +
          cards +
          (m.error ? '<div class="lan-form-error" data-testid="lan-error">' + esc(m.error) + '</div>' : '') +
          (online ? '<p class="lan-note">两台设备需连接同一局域网并在浏览器打开同一服务器地址；创建后把房间码或局域网地址发给对方即可。</p>' : '') +
        '</div>' +
        '<div class="modal-foot">' +
          '<span class="foot-hint">单机模式无需服务器，随时可用</span>' +
          '<div class="foot-btns"><button type="button" class="btn btn-ghost" data-testid="btn-lan-close" data-lan-close>返回单机</button></div>' +
        '</div>' +
      '</div>';
  }

  /* ---------------------------- 等待房间 ---------------------------- */
  UI.showWaitingRoom = function (data) {
    data = data || {};
    closeLanWaiting();
    lanWaitingModel = {
      code: data.code || '',
      meta: data.meta || null,
      lanUrls: data.lanUrls || (data.meta && data.meta.lanUrls) || [],
      myName: data.myName || '',
      role: data.role || 'host',
      configSummary: data.configSummary || ''
    };
    lanWaitingEl = openLayer('lanwaiting', 'overlay lan-waiting-overlay', 'lan-waiting-room');
    lanWaitingEl.addEventListener('click', onLanWaitingClick);
    renderWaitingRoom();
  };

  UI.updateWaitingRoom = function (meta, lanUrls) {
    if (!lanWaitingModel) return;
    if (meta) lanWaitingModel.meta = meta;
    if (lanUrls && lanUrls.length) lanWaitingModel.lanUrls = lanUrls;
    renderWaitingRoom();
  };

  UI.closeWaitingRoom = closeLanWaiting;

  function closeLanWaiting() {
    if (lanWaitingEl && lanWaitingEl.parentNode) lanWaitingEl.parentNode.removeChild(lanWaitingEl);
    lanWaitingEl = null;
    lanWaitingModel = null;
  }

  function onLanWaitingClick(e) {
    var t = e.target;
    if (!t) return;
    if (t.closest('[data-lan-cancel]')) { if (handlers.onLanLeave) handlers.onLanLeave(); return; }
    var copy = t.closest('[data-copy]');
    if (copy) { UI.copyText(copy.getAttribute('data-copy')); return; }
    if (t.closest('[data-lan-copy-code]')) { UI.copyText(lanWaitingModel ? lanWaitingModel.code : ''); return; }
  }

  function renderWaitingRoom() {
    if (!lanWaitingEl || !lanWaitingModel) return;
    var m = lanWaitingModel;
    var meta = m.meta || {};
    var p1 = (meta.players && meta.players.p1) || null;
    var p2 = (meta.players && meta.players.p2) || null;
    var hostName = (p1 && p1.name) || m.myName || '房主';
    var guestName = (p2 && p2.name) || '';
    var origin = (root.location && /^https?:$/.test(root.location.protocol)) ? root.location.origin : '';
    var urls = lanShareBases((m.lanUrls || []).concat(origin ? [origin] : []));
    var urlRows = urls.map(function (base) {
      var share = base + (m.code ? '/?room=' + m.code : '');
      return '<div class="lan-url-row"><code data-testid="lan-share-url">' + esc(share) + '</code>' +
        '<button type="button" class="lan-copy" data-copy="' + esc(share) + '" aria-label="复制地址">复制</button></div>';
    }).join('') || '<div class="lan-url-row"><code>' + esc(lanOriginText()) + '</code></div>';
    var guestState = guestName
      ? '<span class="lan-player-name">' + esc(guestName) + '</span><span class="lan-player-tag is-online">已加入</span>'
      : '<span class="lan-player-name is-waiting">等待对手加入…</span><span class="lan-player-tag is-waiting">未加入</span>';
    var isGuest = m.role === 'guest';
    var title = isGuest ? '已加入房间' : '等待对手加入';
    var subtitle = isGuest ? '正在同步对局，请稍候…' : '房间已创建 · 双方都进入后自动开始战前布局';
    lanWaitingEl.innerHTML =
      '<div class="modal lan-waiting-modal" role="dialog" aria-modal="true" aria-labelledby="lan-waiting-title">' +
        '<div class="modal-head">' +
          '<div><h2 id="lan-waiting-title">' + title + '</h2>' +
            '<p class="modal-sub">' + subtitle + '</p></div>' +
          '<span class="lan-ready-chip">' + (guestName ? '双方已就位' : '等待中') + '</span>' +
        '</div>' +
        '<div class="modal-body lan-waiting-body">' +
          '<div class="lan-room-code-block">' +
            '<span class="lan-room-code-label">房间码</span>' +
            '<div class="lan-room-code" data-testid="lan-room-code">' + esc(m.code) + '</div>' +
            '<button type="button" class="btn btn-ghost lan-copy-code" data-lan-copy-code aria-label="复制房间码">复制房间码</button>' +
          '</div>' +
          '<div class="lan-players-list">' +
            '<div class="lan-player-row"><span class="lan-player-dot is-online" aria-hidden="true"></span>' +
              '<span class="lan-player-name">' + esc(hostName) + '</span><span class="lan-player-tag">房主</span></div>' +
            '<div class="lan-player-row"><span class="lan-player-dot' + (guestName ? ' is-online' : ' is-pending') + '" aria-hidden="true"></span>' +
              guestState + '</div>' +
          '</div>' +
          (m.configSummary
            ? '<p class="lan-config-line" data-testid="lan-waiting-config">对局配置：' + esc(m.configSummary) + '</p>'
            : '') +
          '<div class="lan-share-block"><span class="lan-share-label">把下面的地址发给同一局域网的朋友</span>' + urlRows + '</div>' +
          '<p class="lan-note">提示：两台设备需要连接同一个 Wi-Fi / 局域网；若无法访问，请检查防火墙是否允许该端口。</p>' +
        '</div>' +
        '<div class="modal-foot"><span class="foot-hint">房间将在无人连接 10 分钟后自动关闭</span>' +
          '<div class="foot-btns"><button type="button" class="btn btn-ghost" data-testid="btn-lan-cancel" data-lan-cancel>取消并离开</button></div>' +
        '</div>' +
      '</div>';
  }

  /* ---------------------------- 房间关闭 ---------------------------- */
  UI.showRoomClosed = function (reason) {
    closeRoomClosed();
    var text = reason === 'peer_left' ? '对手已离开房间'
      : reason === 'timeout' ? '房间长时间无活动，已自动关闭'
      : '房间已关闭';
    roomClosedEl = openLayer('roomclosed', 'overlay lan-room-closed-overlay', 'lan-room-closed');
    roomClosedEl.innerHTML =
      '<div class="modal lan-closed-modal" role="dialog" aria-modal="true" aria-label="联机已结束">' +
        '<div class="modal-head"><div><h2>联机已结束</h2>' +
          '<p class="modal-sub">' + esc(text) + '</p></div></div>' +
        '<div class="modal-body lan-closed-body">' +
          '<p>你可以返回大厅创建/加入新房间，或继续单机对战。</p>' +
        '</div>' +
        '<div class="modal-foot"><div class="foot-btns">' +
          '<button type="button" class="btn btn-ghost" data-testid="btn-lan-back-solo" data-lan-back-solo>单机模式</button>' +
          '<button type="button" class="btn btn-primary" data-testid="btn-lan-back-lobby" data-lan-back-lobby>返回大厅</button>' +
        '</div></div>' +
      '</div>';
    roomClosedEl.addEventListener('click', function (e) {
      if (e.target.closest('[data-lan-back-lobby]')) { if (handlers.onLanReturnLobby) handlers.onLanReturnLobby(); }
      else if (e.target.closest('[data-lan-back-solo]')) { if (handlers.onLanBackSolo) handlers.onLanBackSolo(); }
    });
  };

  UI.closeRoomClosed = closeRoomClosed;

  function closeRoomClosed() {
    if (roomClosedEl && roomClosedEl.parentNode) roomClosedEl.parentNode.removeChild(roomClosedEl);
    roomClosedEl = null;
  }

  UI.showLanResuming = function (text) {
    if (lanResumingEl) return;
    lanResumingEl = openLayer('lanresuming', 'overlay lan-resuming-overlay', 'lan-resuming');
    lanResumingEl.innerHTML = '<div class="lan-resuming-box" role="dialog" aria-modal="true" aria-label="正在恢复联机">' +
      '<span class="lan-resuming-dot" aria-hidden="true"></span>' +
      '<p>' + esc(text || '正在恢复联机…') + '</p>' +
      '<span class="lan-resuming-sub">连接断开后会自动重试；若服务器已关闭，请返回单机模式。</span>' +
      '</div>';
  };

  UI.closeLanResuming = function () {
    if (lanResumingEl && lanResumingEl.parentNode) lanResumingEl.parentNode.removeChild(lanResumingEl);
    lanResumingEl = null;
  };

  UI.closeAllOverlays = function () {
    if (activeSettle) activeSettle.finish();
    if (activeSplash) activeSplash.finish();
    if (activeConfirm) activeConfirm.finish(false);
    UI.closeSettings();
    UI.closeRules();
    UI.closeGameOver();
    closeLanLobby();
    closeLanWaiting();
    closeRoomClosed();
    UI.closeLanResuming();
    for (var name in activeLayers) {
      if (Object.prototype.hasOwnProperty.call(activeLayers, name)) closeLayer(name);
    }
    activeLayers = {};
  };

  /* ================================================================== *
   * 键盘
   * ================================================================== */
  UI.hasBlockingOverlay = function () {
    return !!(activeSettle || activeSplash || activeConfirm || activeGameover || settingsEl || rulesEl ||
      lanLobbyEl || lanLaunchEl || lanWaitingEl || roomClosedEl || lanResumingEl);
  };

  UI.handleKeydown = function (e) {
    if (lanResumingEl) return true;
    if (lanLaunchEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (handlers.onCloseLanLaunch) handlers.onCloseLanLaunch();
        else UI.closeLanLaunchGuide();
      }
      return true;
    }
    if (roomClosedEl) {
      if (e.key === 'Escape') e.preventDefault();
      return true;
    }
    if (lanLobbyEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (handlers.onLanCloseLobby) handlers.onLanCloseLobby();
      }
      return true;
    }
    if (lanWaitingEl) {
      if (e.key === 'Escape') e.preventDefault();
      return true;
    }
    if (activeConfirm) {
      if (e.key === 'Escape') { e.preventDefault(); activeConfirm.finish(false); return true; }
      if (e.key === 'Enter') { e.preventDefault(); activeConfirm.finish(true); return true; }
      return true;
    }
    if (activeSettle) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activeSettle.finish();
        return true;
      }
      return true;
    }
    if (activeSplash) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activeSplash.finish();
        return true;
      }
      return true;
    }
    if (activeGameover) {
      if (e.key === 'Escape') { e.preventDefault(); return true; }
      return false;
    }
    if (settingsEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (handlers.onCancelSettings) handlers.onCancelSettings();
        return true;
      }
      return false;
    }
    if (rulesEl) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        UI.closeRules();
        return true;
      }
      return false;
    }
    return false;
  };

  /* ================================================================== *
   * 对外
   * ================================================================== */
  UI.getView = function () { return view; };
  UI.getState = function () { return state; };

  root.PokerUI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
