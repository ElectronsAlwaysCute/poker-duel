/* =========================================================================
 * 扑克牌 · 比大小 —— 规则引擎（纯逻辑，无 DOM，零依赖）
 * 契约：docs/CONTRACT.md   规则：docs/RULES.md
 * 浏览器：window.PokerEngine   Node：require('./js/engine.js')
 * ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.7.0';

  var RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var RANK_VALUES = {
    A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
    J: 11, Q: 12, K: 13, '小王': 14, '大王': 15
  };
  var SUITS = [
    { id: 's', symbol: '♠', red: false },
    { id: 'h', symbol: '♥', red: true },
    { id: 'd', symbol: '♦', red: true },
    { id: 'c', symbol: '♣', red: false }
  ];
  var DIFFICULTIES = {
    1: { id: 1, name: '消耗', label: '单独结算后败者摸牌', rule: 'loser-draw' },
    2: { id: 2, name: '均衡', label: '单独结算后不摸牌', rule: 'none' },
    3: { id: 3, name: '突进', label: '单独结算后胜者摸牌', rule: 'winner-draw' }
  };

  /* 结算随机性：双方单独结算时各从牌堆补的牌数（1=简单 / 2=标准 / 4=复杂） */
  var SETTLE_MODES = [
    { id: 1, name: '简单', label: '双方各补 1 张', cards: 1 },
    { id: 2, name: '标准', label: '双方各补 2 张', cards: 2 },
    { id: 4, name: '复杂', label: '双方各补 4 张', cards: 4 }
  ];
  var DEFAULT_SETTLE_CARDS = 2;

  /* 行动点（v1.4）：每回合开始回复到 3 点；在一个回合内可连续执行多个行动。
   * 结算消耗 3 点（=整回合）、摸牌/翻牌 2 点、移牌/放牌 1 点；「结束回合」0 点、随时可用。 */
  var AP_PER_TURN = 3;
  var ACTION_COSTS = { settle: 3, draw: 2, flip: 2, place: 1, move: 1, end_turn: 0 };

  /* 回合倒计时（v1.5）：单位秒，0 = 关闭，默认 30。
   * 引擎是纯逻辑/确定性的，不执行真实计时；由 UI/客户端读取 state.config.turnTimeLimit
   * 负责本地倒计时与超时自动结束回合（LAN 由各客户端对自己的回合计时）。 */
  var DEFAULT_TURN_TIME_LIMIT = 30;
  var TURN_TIME_LIMIT_OPTIONS = [0, 15, 30, 60];

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */
  function makeError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function hashSeed(seed) {
    if (typeof seed === 'string') {
      var h = 2166136261;
      for (var i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) || 1;
    }
    var n = Number(seed);
    if (!isFinite(n)) return 1;
    return (n >>> 0) || 1;
  }

  /* mulberry32：确定性 RNG */
  function makeRng(seed) {
    var s = hashSeed(seed);
    function next() {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function int(n) {
      if (n <= 0) return 0;
      return Math.floor(next() * n);
    }
    function shuffle(arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = int(i + 1);
        var tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    }
    function pick(arr) {
      return arr && arr.length ? arr[int(arr.length)] : undefined;
    }
    return { next: next, int: int, shuffle: shuffle, pick: pick };
  }

  function other(id) { return id === 'p1' ? 'p2' : 'p1'; }

  function isPlayerId(id) { return id === 'p1' || id === 'p2'; }

  function sumValues(cards) {
    var s = 0;
    for (var i = 0; i < cards.length; i++) s += cards[i].value;
    return s;
  }

  function emptyRegionSides() {
    return {
      p1: { faceUp: [], faceDown: [] },
      p2: { faceUp: [], faceDown: [] }
    };
  }

  /* ------------------------------------------------------------------ *
   * 牌堆
   * ------------------------------------------------------------------ */
  function buildDeck(deckSpec) {
    var spec = deckSpec || {};
    var jokers = spec.jokers !== false;
    var ranks = (Array.isArray(spec.ranks) && spec.ranks.length) ? spec.ranks.slice() : RANK_ORDER.slice();
    var suits = SUITS;
    if (Array.isArray(spec.suits) && spec.suits.length) {
      suits = SUITS.filter(function (s) { return spec.suits.indexOf(s.id) >= 0; });
    }
    var cards = [];
    for (var i = 0; i < ranks.length; i++) {
      var rank = ranks[i];
      var value = RANK_VALUES[rank];
      for (var j = 0; j < suits.length; j++) {
        var suit = suits[j];
        cards.push({
          id: suit.id + '-' + rank,
          rank: rank,
          suit: suit.id,
          suitSymbol: suit.symbol,
          red: suit.red,
          value: value,
          joker: false,
          revealed: false
        });
      }
    }
    if (jokers) {
      cards.push({ id: 'joker-S', rank: '小王', suit: null, suitSymbol: '', red: false, value: 14, joker: true, revealed: false });
      cards.push({ id: 'joker-B', rank: '大王', suit: null, suitSymbol: '', red: true, value: 15, joker: true, revealed: false });
    }
    return cards;
  }

  function createDeck(deckSpec) { return buildDeck(deckSpec); }

  function cloneDeckSpec(spec) {
    var s = spec || {};
    return {
      jokers: s.jokers !== false,
      ranks: (Array.isArray(s.ranks) && s.ranks.length) ? s.ranks.slice() : RANK_ORDER.slice(),
      suits: (Array.isArray(s.suits) && s.suits.length) ? s.suits.slice() : null
    };
  }

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */
  function defaultConfig(overrides) {
    var cfg = {
      regionCount: 5,
      difficulty: 1,
      firstPlayer: 'random',
      settleCards: DEFAULT_SETTLE_CARDS,
      deck: cloneDeckSpec(null),
      seed: null,
      playerNames: { p1: '你', p2: '电脑' },
      aiStrength: 'medium',
      turnTimeLimit: DEFAULT_TURN_TIME_LIMIT,
      endgameApCapRule: true
    };
    if (overrides) {
      if (overrides.turnTimeLimit !== undefined) cfg.turnTimeLimit = overrides.turnTimeLimit;
      if (overrides.endgameApCapRule !== undefined) cfg.endgameApCapRule = !!overrides.endgameApCapRule;
      if (overrides.regionCount !== undefined) cfg.regionCount = overrides.regionCount;
      if (overrides.difficulty !== undefined) cfg.difficulty = overrides.difficulty;
      if (overrides.firstPlayer !== undefined) cfg.firstPlayer = overrides.firstPlayer;
      if (overrides.settleCards !== undefined) cfg.settleCards = overrides.settleCards;
      if (overrides.deck !== undefined) cfg.deck = cloneDeckSpec(overrides.deck);
      if (overrides.seed !== undefined) cfg.seed = overrides.seed;
      if (overrides.aiStrength !== undefined) cfg.aiStrength = overrides.aiStrength;
      if (overrides.playerNames) {
        cfg.playerNames = {
          p1: overrides.playerNames.p1 || '你',
          p2: overrides.playerNames.p2 || '电脑'
        };
      }
    }
    cfg.regionCount = Number(cfg.regionCount);
    cfg.difficulty = Number(cfg.difficulty);
    cfg.settleCards = Number(cfg.settleCards);
    if (cfg.settleCards === 3) cfg.settleCards = 4; // 旧版「复杂=各 3 张」迁移为各 4 张
    cfg.turnTimeLimit = (cfg.turnTimeLimit === null || cfg.turnTimeLimit === undefined)
      ? DEFAULT_TURN_TIME_LIMIT : Number(cfg.turnTimeLimit);
    cfg.apPerTurn = AP_PER_TURN;
    if (Number.isFinite(cfg.regionCount)) {
      cfg.winsNeeded = Math.floor(cfg.regionCount / 2) + 1;
      cfg.initialDraw = cfg.regionCount * 2;
      cfg.layoutCount = cfg.regionCount;
      // v2.1：后手补偿改回固定 1 张（3/5/7 区均相同）
      cfg.compensationDraw = 1;
    } else {
      cfg.winsNeeded = 3;
      cfg.initialDraw = 10;
      cfg.layoutCount = 5;
      cfg.compensationDraw = 1;
    }
    return cfg;
  }

  function settleModeOf(cfg) {
    for (var i = 0; i < SETTLE_MODES.length; i++) {
      if (SETTLE_MODES[i].id === cfg.settleCards) return SETTLE_MODES[i];
    }
    return null;
  }

  function validateConfig(config) {
    var cfg = defaultConfig(config);
    var errors = [];
    var warnings = [];
    var rc = cfg.regionCount;
    var deckSize = 0;
    var ranksOk = true;

    if (!Number.isInteger(rc) || rc < 3) {
      errors.push('区域数必须是 ≥3 的整数（当前：' + cfg.regionCount + '）');
      ranksOk = false;
    }
    if (!DIFFICULTIES[cfg.difficulty]) errors.push('难度必须是 1、2 或 3');
    if (!settleModeOf(cfg)) errors.push('结算随机性必须是 1（简单）、2（标准）或 4（复杂）');
    if (cfg.firstPlayer !== 'random' && cfg.firstPlayer !== 'p1' && cfg.firstPlayer !== 'p2') {
      errors.push('先手设置不合法');
    }
    if (!Number.isInteger(cfg.turnTimeLimit) || !(cfg.turnTimeLimit === 0 ||
        (cfg.turnTimeLimit >= 5 && cfg.turnTimeLimit <= 300))) {
      errors.push('回合倒计时必须是 0（关闭）或 5-300 秒的整数（当前：' + cfg.turnTimeLimit + '）');
    }
    if (!Array.isArray(cfg.deck.ranks) || cfg.deck.ranks.length === 0) {
      errors.push('牌堆至少需要包含一种牌面');
      ranksOk = false;
    } else {
      var seen = {};
      for (var i = 0; i < cfg.deck.ranks.length; i++) {
        var r = cfg.deck.ranks[i];
        if (!Object.prototype.hasOwnProperty.call(RANK_VALUES, r) || r === '小王' || r === '大王') {
          errors.push('未知牌面：' + r);
          ranksOk = false;
          continue;
        }
        if (seen[r]) { errors.push('牌面重复：' + r); ranksOk = false; }
        seen[r] = true;
      }
    }
    var suitCount = 4;
    if (cfg.deck.suits !== null && cfg.deck.suits !== undefined) {
      if (!Array.isArray(cfg.deck.suits) || !cfg.deck.suits.length) {
        errors.push('花色设置不合法');
        ranksOk = false;
      } else {
        var validSuitIds = { s: true, h: true, d: true, c: true };
        var seenSuits = {};
        for (var si = 0; si < cfg.deck.suits.length; si++) {
          var sid = cfg.deck.suits[si];
          if (!Object.prototype.hasOwnProperty.call(validSuitIds, sid)) {
            errors.push('未知花色：' + sid);
            ranksOk = false;
          } else if (seenSuits[sid]) {
            errors.push('花色重复：' + sid);
            ranksOk = false;
          } else {
            seenSuits[sid] = true;
          }
        }
        suitCount = cfg.deck.suits.length;
      }
    }
    if (ranksOk && settleModeOf(cfg) && Number.isInteger(rc) && rc >= 3) {
      deckSize = cfg.deck.ranks.length * suitCount + (cfg.deck.jokers ? 2 : 0);
      var minDeal = 4 * rc + cfg.compensationDraw;
      var minTotal = 6 * rc + cfg.compensationDraw + 1;
      if (deckSize < minDeal) {
        errors.push('牌堆只有 ' + deckSize + ' 张，不足以发牌（至少需要 ' + minDeal + ' 张）');
      }
      if (deckSize < minTotal) {
        errors.push('牌堆只有 ' + deckSize + ' 张，无法完成 ' + rc + ' 个区域的正常对局（至少需要 ' +
          minTotal + ' 张：布局后牌堆需大于初始决战阈值 ' + (2 * rc) + '）');
      }
      if (errors.length === 0) {
        var gap = deckSize - (6 * rc + cfg.compensationDraw);
        if (gap <= 2) warnings.push('牌堆余量很小：布局后很快进入战略决战，对局较短');
        else if (gap > 30) warnings.push('牌堆余量较大：预计需要额外消耗 ' + gap + ' 张牌才会进入战略决战，对局可能较长');
      }
    }
    var info = {
      deckSize: deckSize,
      suitCount: suitCount,
      regionCount: rc,
      settleCards: cfg.settleCards,
      settleMode: settleModeOf(cfg) ? settleModeOf(cfg).name : null,
      initialDraw: cfg.initialDraw,
      layoutCount: cfg.layoutCount,
      compensationDraw: cfg.compensationDraw,
      apPerTurn: cfg.apPerTurn,
      endgameApCapRule: cfg.endgameApCapRule,
      turnTimeLimit: cfg.turnTimeLimit,
      actionCosts: {
        settle: ACTION_COSTS.settle, draw: ACTION_COSTS.draw, flip: ACTION_COSTS.flip,
        place: ACTION_COSTS.place, move: ACTION_COSTS.move, end_turn: ACTION_COSTS.end_turn
      },
      winsNeeded: cfg.winsNeeded,
      endgameThreshold: 2 * rc,
      deckAfterSetup: deckSize - 4 * rc - cfg.compensationDraw,
      gapToEndgame: deckSize - (6 * rc + cfg.compensationDraw)
    };
    return { ok: errors.length === 0, errors: errors, warnings: warnings, info: info };
  }

  /* ------------------------------------------------------------------ *
   * 日志
   * ------------------------------------------------------------------ */
  function appendLog(state, text, tone) {
    var entry = { seq: state.log.length + 1, text: text, tone: tone || 'info' };
    state.log.push(entry);
    return entry.seq;
  }

  function playerLabel(state, playerId) {
    return state.players[playerId].name;
  }

  /* ------------------------------------------------------------------ *
   * 抽牌 / 区域工具
   * ------------------------------------------------------------------ */
  function drawCard(state) {
    if (!state.deck.length) return null;
    return state.deck.shift();
  }

  function pushToDiscard(state, cards) {
    for (var i = 0; i < cards.length; i++) state.discard.push(cards[i]);
  }

  function getOpenRegionIds(state) {
    var ids = [];
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].status === 'open') ids.push(i);
    }
    return ids;
  }

  function getRegionFaceUpCount(state, regionId) {
    var region = state.regions[regionId];
    return region.sides.p1.faceUp.length + region.sides.p2.faceUp.length;
  }

  function getRegionSideSum(state, regionId, playerId) {
    return sumValues(state.regions[regionId].sides[playerId].faceUp);
  }

  function getHandSum(state, playerId) {
    return sumValues(state.players[playerId].hand);
  }

  function getEndgameThreshold(state) {
    var open = getOpenRegionIds(state).length;
    return open > 0 ? open * 2 : 0;
  }

  /* ---------------------- 行动点 / 回合（v1.4） ---------------------- */
  function actionCost(type) {
    return Object.prototype.hasOwnProperty.call(ACTION_COSTS, type) ? ACTION_COSTS[type] : null;
  }

  function isEndgameBuild(state) {
    return !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
  }

  /* 回合开始：行动点回复到 apPerTurn（未用完不结转）；重置本回合行动计数（v1.5 防拖延）。
   * v1.7：战略决战 build 阶段改用该玩家的 apCap（初始 3，随结束回合行为增减）。 */
  function beginTurn(state, playerId, events) {
    var endgameBuild = isEndgameBuild(state);
    var capRule = !!(state.config.endgameApCapRule && endgameBuild);
    var ap = state.config.apPerTurn;
    if (capRule) {
      var cap = Number(state.players[playerId].apCap);
      if (!Number.isInteger(cap) || cap < 0) cap = 3;
      ap = Math.min(cap, state.config.apPerTurn);
    }
    state.turn = playerId;
    state.players[playerId].ap = ap;
    state.turnProgress = { count: 0, productive: 0 };
    var turnStartEvent = { type: 'turn_start', playerId: playerId, ap: ap, turnCount: state.turnCount };
    if (capRule) {
      turnStartEvent.apCap = ap;
      turnStartEvent.apPerTurn = state.config.apPerTurn;
    }
    events.push(turnStartEvent);
  }

  /* 回合结束：清空行动点，交由调用方决定下一行动方。
   * v1.5 防拖延：本回合「没有真实行动」或「只进行了移牌」记一次 stall；
   * 某玩家连续 2 个自己的回合都是这种情况 → 不再跳过回合，而是认输判负。
   * v1.7：战略决战 build 阶段按 leftAp 更新 apCap（有剩 -1 / 用尽 +1，上限 3）；
   * apCap 降至 0 立即认输判负（reason=ap-cap-zero）。
   * 返回 true 表示已因认输结束对局（调用方不要再 beginTurn/推进）。 */
  function endTurn(state, playerId, events, reason) {
    var leftAp = state.players[playerId].ap;
    var progress = state.turnProgress || { count: 0, productive: 0 };
    // manual=玩家主动结束；ap=行动点用尽；no-action=引擎判定无行动可做（不算拖延）
    var voluntary = reason === 'manual' || reason === 'ap';
    var stalled = voluntary && progress.productive === 0;
    if (stalled) {
      state.players[playerId].stallCount = (state.players[playerId].stallCount || 0) + 1;
    } else if (reason !== 'no-action') {
      state.players[playerId].stallCount = 0;
    }
    state.players[playerId].ap = 0;
    state.turn = null;
    state.turnProgress = { count: 0, productive: 0 };
    var capInfo = null;
    // v1.7.1 语义修正：仅“主动结束回合”或“AP 用尽”更新上限；
    // reason='no-action' 是引擎判定无合法行动后的强制结束，不算“未花费”，不惩罚/不奖励。
    if (state.config.endgameApCapRule && isEndgameBuild(state) && reason !== 'no-action') {
      var capBefore = Number(state.players[playerId].apCap);
      if (!Number.isInteger(capBefore) || capBefore < 0) capBefore = 3;
      var capAfter = leftAp > 0 ? capBefore - 1 : capBefore + 1;
      if (capAfter > 3) capAfter = 3;
      if (capAfter < 0) capAfter = 0;
      state.players[playerId].apCap = capAfter;
      capInfo = { leftAp: leftAp, apCapBefore: capBefore, apCapAfter: capAfter, delta: capAfter - capBefore };
    }
    var why = reason === 'manual' ? '' : (reason === 'no-action' ? '（无可用行动）' : '（行动点用尽）');
    var turnEndEvent = { type: 'turn_end', playerId: playerId, reason: reason || 'manual', leftAp: leftAp };
    if (capInfo) {
      turnEndEvent.apCapBefore = capInfo.apCapBefore;
      turnEndEvent.apCapAfter = capInfo.apCapAfter;
    }
    events.push(turnEndEvent);
    appendLog(state, playerLabel(state, playerId) + ' 结束回合' + why, playerId);
    if (capInfo) {
      appendLog(state, playerLabel(state, playerId) + ' 战略决战行动点上限 ' + capInfo.apCapBefore + ' → ' +
        capInfo.apCapAfter + (capInfo.apCapAfter === 0 ? '（降至 0，判负）' : ''), playerId);
    }
    if (capInfo && capInfo.apCapAfter === 0) {
      forfeit(state, playerId, events, 'ap-cap-zero');
      return true;
    }
    if (stalled && state.players[playerId].stallCount >= 2) {
      forfeit(state, playerId, events);
      return true;
    }
    return false;
  }

  /* v1.5 认输判负：连续两回合无有效行动（或仅移牌）→ 该玩家判负，对手获胜。
   * v1.7：cause='ap-cap-zero' 表示战略决战行动点上限降至 0 判负；
   * 结果 reason 仍为 forfeit，但额外带 forfeitReason 以便区分。 */
  function forfeit(state, playerId, events, cause) {
    var winner = other(playerId);
    var openIds = getOpenRegionIds(state);
    var result = {
      winner: winner,
      reason: 'forfeit',
      early: false,
      forfeitedBy: playerId,
      unsettledRegions: openIds.slice(),
      regionWins: { p1: state.regionWins.p1, p2: state.regionWins.p2, ties: state.regionWins.ties },
      handSums: { p1: getHandSum(state, 'p1'), p2: getHandSum(state, 'p2') },
      winsNeeded: state.config.winsNeeded
    };
    if (cause) result.forfeitReason = cause;
    state.result = result;
    state.phase = 'gameover';
    state.turn = null;
    state.players.p1.ap = 0;
    state.players.p2.ap = 0;
    if (state.endgame && state.endgame.triggered && state.endgame.phase !== 'done') {
      state.endgame.phase = 'done';
    }
    if (cause === 'ap-cap-zero') {
      appendLog(state, '对局结束：' + playerLabel(state, playerId) +
        ' 战略决战行动点上限降至 0，判负认输——' + playerLabel(state, winner) + ' 获胜', 'result');
      events.push({ type: 'forfeit', playerId: playerId, reason: cause });
    } else {
      appendLog(state, '对局结束：' + playerLabel(state, playerId) +
        ' 连续两回合无有效行动（或仅移牌），判负认输——' + playerLabel(state, winner) + ' 获胜', 'result');
      events.push({ type: 'forfeit', playerId: playerId, reason: 'stall' });
    }
    events.push({ type: 'game_over', result: cloneResult(result) });
  }

  /* 当前行动方是否还有除「结束回合」以外的可用行动 */
  function hasNonEndTurnAction(state) {
    var legal = getLegalActions(state);
    for (var i = 0; i < legal.length; i++) {
      if (legal[i].type !== 'end_turn') return true;
    }
    return false;
  }

  function getRegionOrThrow(state, regionId, code) {
    var id = Number(regionId);
    if (!Number.isInteger(id) || id < 0 || id >= state.regions.length) {
      throw makeError(code || 'BAD_REGION', '区域不存在：' + regionId);
    }
    return state.regions[id];
  }

  function assertOpenRegion(region) {
    if (region.status !== 'open') throw makeError('ALREADY_SETTLED', '区域 ' + (region.id + 1) + ' 已结算');
  }

  /* 结算后废弃区域：双方所有牌（含补牌、背面牌）进弃牌堆 */
  function discardRegion(state, region) {
    pushToDiscard(state, region.sides.p1.faceUp);
    pushToDiscard(state, region.sides.p1.faceDown);
    pushToDiscard(state, region.sides.p2.faceUp);
    pushToDiscard(state, region.sides.p2.faceDown);
    region.sides = emptyRegionSides();
  }

  function snapshotRegion(region) {
    return {
      id: region.id,
      status: region.status,
      sides: {
        p1: { faceUp: region.sides.p1.faceUp.slice(), faceDown: region.sides.p1.faceDown.slice() },
        p2: { faceUp: region.sides.p2.faceUp.slice(), faceDown: region.sides.p2.faceDown.slice() }
      }
    };
  }

  function cloneResult(result) {
    var out = {
      winner: result.winner,
      reason: result.reason,
      early: !!result.early,
      forfeitedBy: result.forfeitedBy || null,
      unsettledRegions: Array.isArray(result.unsettledRegions) ? result.unsettledRegions.slice() : [],
      regionWins: { p1: result.regionWins.p1, p2: result.regionWins.p2, ties: result.regionWins.ties },
      handSums: { p1: result.handSums.p1, p2: result.handSums.p2 },
      winsNeeded: result.winsNeeded
    };
    if (result.forfeitReason) out.forfeitReason = result.forfeitReason;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 创建对局
   * ------------------------------------------------------------------ */
  function createGame(config) {
    var cfg = defaultConfig(config);
    if (cfg.seed === null || cfg.seed === undefined) {
      cfg.seed = Math.floor(Math.random() * 0x7FFFFFFF) + 1;
    }
    cfg.seed = hashSeed(cfg.seed);
    var v = validateConfig(cfg);
    if (!v.ok) throw makeError('BAD_CONFIG', v.errors.join('；'));
    var rng = makeRng(cfg.seed ^ 0x9E3779B9);
    if (cfg.firstPlayer !== 'p1' && cfg.firstPlayer !== 'p2') {
      cfg.firstPlayer = rng.int(2) === 0 ? 'p1' : 'p2';
    }
    cfg.secondPlayer = other(cfg.firstPlayer);

    var deck = buildDeck(cfg.deck);
    rng.shuffle(deck);

    var state = {
      version: VERSION,
      config: cfg,
      phase: 'layout',
      turn: null,
      turnCount: 0,
      deck: deck,
      discard: [],
      players: {
        p1: { id: 'p1', name: cfg.playerNames.p1 || '你', hand: [], regionsWon: 0, ap: 0, stallCount: 0 },
        p2: { id: 'p2', name: cfg.playerNames.p2 || '电脑', hand: [], regionsWon: 0, ap: 0, stallCount: 0 }
      },
      turnProgress: { count: 0, productive: 0 },
      regions: [],
      layout: { submitted: { p1: false, p2: false }, assignments: { p1: null, p2: null }, revealed: false },
      regionWins: { p1: 0, p2: 0, ties: 0 },
      endgame: {
        triggered: false,
        phase: null,
        threshold: 2 * cfg.regionCount,
        settleCards: cfg.settleCards,
        drawPerPlayer: 0,
        drawnCounts: { p1: 0, p2: 0 },
        skipped: { p1: false, p2: false }
      },
      result: null,
      log: [],
      _rngState: cfg.seed
    };
    if (cfg.endgameApCapRule) {
      state.players.p1.apCap = 3;
      state.players.p2.apCap = 3;
    }

    for (var i = 0; i < cfg.regionCount; i++) {
      state.regions.push({ id: i, status: 'open', sides: emptyRegionSides(), result: null });
    }
    var deckSize = deck.length;
    for (var k = 0; k < cfg.initialDraw; k++) {
      state.players.p1.hand.push(drawCard(state));
      state.players.p2.hand.push(drawCard(state));
    }

    appendLog(state, '对局开始：牌堆 ' + deckSize + ' 张 · ' + cfg.regionCount + ' 个区域 · 胜场门槛 ' + cfg.winsNeeded +
      ' · 结算随机性「' + settleModeOf(cfg).name + '」（双方各补 ' + cfg.settleCards + ' 张）· 难度「' +
      DIFFICULTIES[cfg.difficulty].name + '」', 'info');
    appendLog(state, '先手：' + playerLabel(state, cfg.firstPlayer) + '；后手：' + playerLabel(state, cfg.secondPlayer) + '（布局结束后额外摸 ' + cfg.compensationDraw + ' 张牌）', 'info');
    appendLog(state, '战前布局：双方各摸 ' + cfg.initialDraw + ' 张牌，各自选择 ' + cfg.layoutCount + ' 张背面朝上放入区域（双方完成后同时揭示）', 'info');
    appendLog(state, '行动点规则：每回合回复到 ' + AP_PER_TURN + ' 点；结算消耗 ' + ACTION_COSTS.settle + ' 点、摸牌/翻牌 ' +
      ACTION_COSTS.draw + ' 点、移牌/放牌 ' + ACTION_COSTS.place + ' 点；可随时提前结束回合', 'info');
    if (cfg.endgameApCapRule) {
      appendLog(state, '战略决战行动点上限规则：build 阶段结束回合时，未花费行动点则上限 -1（最低 0），用尽则上限 +1（最高 3）；上限降至 0 判负', 'info');
    }
    if (cfg.turnTimeLimit > 0) {
      appendLog(state, '回合倒计时：每回合 ' + cfg.turnTimeLimit + ' 秒，超时自动结束回合', 'info');
    }
    return state;
  }

  /* ------------------------------------------------------------------ *
   * 战前布局
   * ------------------------------------------------------------------ */
  function submitLayout(state, playerId, cardIds) {
    if (!state || state.phase !== 'layout') throw makeError('BAD_PHASE', '当前不在战前布局阶段');
    if (!isPlayerId(playerId)) throw makeError('BAD_ACTION', '未知玩家：' + playerId);
    if (state.layout.submitted[playerId]) throw makeError('BAD_ACTION', playerLabel(state, playerId) + ' 已经提交过布阵');
    var R = state.config.regionCount;
    if (!Array.isArray(cardIds) || cardIds.length !== R) {
      throw makeError('BAD_ACTION', '需要为 ' + R + ' 个区域各选择 1 张牌');
    }
    var hand = state.players[playerId].hand;
    var used = {};
    var cards = [];
    for (var i = 0; i < cardIds.length; i++) {
      var id = cardIds[i];
      if (used[id]) throw makeError('BAD_ACTION', '同一张牌不能放入多个区域');
      used[id] = true;
      var found = null;
      for (var j = 0; j < hand.length; j++) {
        if (hand[j].id === id) { found = hand[j]; break; }
      }
      if (!found) throw makeError('CARD_NOT_IN_HAND', '手牌中没有该牌：' + id);
      cards.push(found);
    }
    state.layout.assignments[playerId] = cards;
    state.layout.submitted[playerId] = true;
    appendLog(state, playerLabel(state, playerId) + ' 已完成布阵', playerId);
  }

  function finalizeLayout(state) {
    if (!state || state.phase !== 'layout') throw makeError('BAD_PHASE', '当前不在战前布局阶段');
    if (!state.layout.submitted.p1 || !state.layout.submitted.p2) {
      throw makeError('BAD_PHASE', '双方尚未全部完成布阵');
    }
    var events = [];
    var R = state.config.regionCount;
    var reveal = { p1: [], p2: [] };

    ['p1', 'p2'].forEach(function (pid) {
      var hand = state.players[pid].hand;
      var assigned = state.layout.assignments[pid];
      for (var i = 0; i < R; i++) {
        var card = assigned[i];
        var idx = hand.indexOf(card);
        if (idx >= 0) hand.splice(idx, 1);
        state.regions[i].sides[pid].faceUp.push(card);
        card.revealed = true;
        reveal[pid].push(card);
      }
    });
    state.layout.revealed = true;
    events.push({ type: 'layout_reveal', layout: { p1: reveal.p1.slice(), p2: reveal.p2.slice() } });

    for (var i = 0; i < R; i++) {
      appendLog(state, '区域 ' + (i + 1) + '：' + playerLabel(state, 'p1') + ' ' + formatCard(reveal.p1[i]) +
        ' vs ' + playerLabel(state, 'p2') + ' ' + formatCard(reveal.p2[i]), 'info');
    }

    var second = state.config.secondPlayer;
    // 后手补偿：固定 1 张（v2.1 改回固定；3/5/7 区一致）；
    // 每张补偿牌一个 extra_draw 事件，UI 可逐张播放动画，联机按单张脱敏。
    var extraCount = state.config.compensationDraw;
    var extraDrawn = 0;
    for (var ei = 0; ei < extraCount; ei++) {
      var extra = drawCard(state);
      if (!extra) break;
      state.players[second].hand.push(extra);
      extraDrawn++;
      events.push({ type: 'extra_draw', playerId: second, card: extra, handSize: state.players[second].hand.length });
    }
    // 日志属于公开信息：不暴露补牌牌面（联机模式下会下发给对手）
    appendLog(state, playerLabel(state, second) + '（后手）额外摸 ' + extraDrawn + ' 张牌', second);

    state.phase = 'battle';
    events.push({ type: 'battle_start', turn: state.config.firstPlayer });
    appendLog(state, '战役开始：' + playerLabel(state, state.config.firstPlayer) + ' 先行（行动点 ' + AP_PER_TURN + '）', 'warn');

    var openIds = getOpenRegionIds(state);
    if (openIds.length > 0 && state.deck.length <= getEndgameThreshold(state)) {
      // 退化自定义牌堆：布局即满足决战条件（严格配置校验下不会发生）
      triggerEndgame(state, events, state.config.firstPlayer);
    } else {
      beginTurn(state, state.config.firstPlayer, events);
    }
    return events;
  }

  /* ------------------------------------------------------------------ *
   * 结算核心（单区结算；难度摸牌由调用方处理）
   * ------------------------------------------------------------------ */
  function settleRegionCore(state, regionId) {
    var region = state.regions[regionId];
    var N = state.config.settleCards;
    var before = snapshotRegion(region);
    var drawn = { p1: [], p2: [] };
    var i, card;
    for (i = 0; i < N; i++) {
      card = drawCard(state);
      if (!card) throw makeError('DECK_INSUFFICIENT', '牌堆不足以完成区域结算');
      card.revealed = true;
      region.sides.p1.faceUp.push(card);
      drawn.p1.push(card);
    }
    for (i = 0; i < N; i++) {
      card = drawCard(state);
      if (!card) throw makeError('DECK_INSUFFICIENT', '牌堆不足以完成区域结算');
      card.revealed = true;
      region.sides.p2.faceUp.push(card);
      drawn.p2.push(card);
    }

    var sums = {
      p1: sumValues(region.sides.p1.faceUp),
      p2: sumValues(region.sides.p2.faceUp)
    };
    var winner = sums.p1 > sums.p2 ? 'p1' : (sums.p2 > sums.p1 ? 'p2' : 'tie');
    var allCards = {
      p1: region.sides.p1.faceUp.concat(region.sides.p1.faceDown),
      p2: region.sides.p2.faceUp.concat(region.sides.p2.faceDown)
    };
    var regionResult = {
      winner: winner,
      settleCards: N,
      deterministic: false,
      sums: { p1: sums.p1, p2: sums.p2 },
      faceUp: {
        p1: before.sides.p1.faceUp.slice(),
        p2: before.sides.p2.faceUp.slice()
      },
      drawn: { p1: drawn.p1.slice(), p2: drawn.p2.slice() },
      difficultyDraw: null,
      allCards: allCards
    };
    region.status = 'settled';
    region.result = regionResult;
    discardRegion(state, region);
    if (winner === 'tie') state.regionWins.ties++;
    else state.regionWins[winner]++;
    state.players.p1.regionsWon = state.regionWins.p1;
    state.players.p2.regionsWon = state.regionWins.p2;
    return {
      regionBefore: before,
      drawn: drawn,
      sums: sums,
      winner: winner,
      regionResult: regionResult
    };
  }

  function winnerLabel(state, winner) {
    if (winner === 'tie') return '平局';
    return playerLabel(state, winner);
  }

  function resultName(state, winner) {
    if (winner === 'tie') return '平局';
    return playerLabel(state, winner) + '赢得此区域';
  }

  /* ------------------------------------------------------------------ *
   * 战局推进
   * ------------------------------------------------------------------ */
  function endGame(state, events) {
    state.turn = null;
    state.players.p1.ap = 0;
    state.players.p2.ap = 0;
    var regionWins = {
      p1: state.regionWins.p1,
      p2: state.regionWins.p2,
      ties: state.regionWins.ties
    };
    var handSums = { p1: getHandSum(state, 'p1'), p2: getHandSum(state, 'p2') };
    var winsNeeded = state.config.winsNeeded;
    var openIds = getOpenRegionIds(state);
    var winner, reason;
    if (regionWins.p1 >= winsNeeded) {
      winner = 'p1'; reason = 'region_wins';
    } else if (regionWins.p2 >= winsNeeded) {
      winner = 'p2'; reason = 'region_wins';
    } else if (regionWins.p1 > regionWins.p2) {
      // v2.6 修复：所有区域结算完仍无人达到门槛时，先比区域胜场（多者胜，early=false）
      winner = 'p1'; reason = 'region_wins';
    } else if (regionWins.p2 > regionWins.p1) {
      winner = 'p2'; reason = 'region_wins';
    } else if (handSums.p1 > handSums.p2) {
      winner = 'p1'; reason = 'hand_sum';
    } else if (handSums.p2 > handSums.p1) {
      winner = 'p2'; reason = 'hand_sum';
    } else {
      winner = 'draw'; reason = 'draw';
    }
    var early = reason === 'region_wins' && openIds.length > 0;
    var result = {
      winner: winner,
      reason: reason,
      early: early,
      unsettledRegions: early ? openIds.slice() : [],
      regionWins: regionWins,
      handSums: handSums,
      winsNeeded: winsNeeded
    };
    state.result = result;
    state.phase = 'gameover';
    state.turn = null;

    var text;
    if (winner === 'draw') {
      text = '对局结束：平局（区域胜场相同 ' + regionWins.p1 + ' : ' + regionWins.p2 +
        (regionWins.ties ? ' · 平 ' + regionWins.ties : '') + '，手牌总和相同 ' + handSums.p1 + ' : ' + handSums.p2 + '）';
    } else if (reason === 'region_wins') {
      if (early) {
        text = '提前锁定：' + playerLabel(state, winner) + ' 已取得 ' + winsNeeded + ' 个区域胜利（当前 ' +
          regionWins.p1 + ' : ' + regionWins.p2 + '），对局立即结束（剩余 ' + openIds.length + ' 个区域未结算）';
      } else {
        text = '对局结束：' + playerLabel(state, winner) + '获胜（区域胜利 ' + regionWins.p1 + ' : ' + regionWins.p2 + '）';
      }
    } else {
      text = '对局结束：' + playerLabel(state, winner) + '获胜（区域胜场相同 ' + regionWins.p1 + ' : ' + regionWins.p2 +
        (regionWins.ties ? ' · 平 ' + regionWins.ties : '') + '，比较手牌总和 ' + handSums.p1 + ' : ' + handSums.p2 + '）';
    }
    appendLog(state, text, 'result');
    events.push({ type: 'game_over', result: cloneResult(result) });
  }

  /* ------------------------------------------------------------------ *
   * 战略决战（v1.3）：补牌摸空 → 最终部署 → 摊牌结算（无随机）
   * ------------------------------------------------------------------ */
  function canBuildEndgame(state, playerId) {
    if (state.players[playerId].hand.length > 0) return true;
    var openIds = getOpenRegionIds(state);
    for (var i = 0; i < openIds.length; i++) {
      if (state.regions[openIds[i]].sides[playerId].faceDown.length > 0) return true;
    }
    return false;
  }

  function markEndgameSkip(state, playerId, events) {
    if (state.endgame.skipped[playerId]) return;
    state.endgame.skipped[playerId] = true;
    events.push({ type: 'endgame_skip', playerId: playerId });
    appendLog(state, playerLabel(state, playerId) + ' 已无手牌可放、无背面牌可翻，跳过其回合', 'info');
  }

  function triggerEndgame(state, events, starterPid) {
    if (state.endgame.triggered) return false;
    var openIds = getOpenRegionIds(state);
    var X = openIds.length;
    if (!X) return false;
    var N = state.config.settleCards;
    var deckCount = state.deck.length;
    var p1Draw = Math.floor(deckCount / 2);
    var p2Draw = deckCount - p1Draw;
    state.endgame.triggered = true;
    state.endgame.phase = 'build';
    state.endgame.threshold = 2 * X;
    state.endgame.settleCards = N;
    state.endgame.drawPerPlayer = X;
    state.endgame.drawnCounts = { p1: p1Draw, p2: p2Draw };
    state.endgame.skipped = { p1: false, p2: false };
    events.push({
      type: 'endgame_start',
      openRegionIds: openIds.slice(),
      drawPerPlayer: X,
      drawnCounts: { p1: p1Draw, p2: p2Draw },
      settleCards: N,
      deckCount: deckCount,
      threshold: 2 * X
    });
    for (var i = 0; i < p1Draw; i++) {
      var c1 = drawCard(state);
      if (c1) state.players.p1.hand.push(c1);
    }
    for (var j = 0; j < p2Draw; j++) {
      var c2 = drawCard(state);
      if (c2) state.players.p2.hand.push(c2);
    }
    events.push({ type: 'endgame_draw', playerId: 'p1', count: p1Draw, handSize: state.players.p1.hand.length });
    events.push({ type: 'endgame_draw', playerId: 'p2', count: p2Draw, handSize: state.players.p2.hand.length });
    appendLog(state, '战略决战！剩余 ' + X + ' 个区域；双方各摸牌（' + playerLabel(state, 'p1') + ' ' + p1Draw +
      ' 张、' + playerLabel(state, 'p2') + ' ' + p2Draw + ' 张，牌堆摸空 ' + deckCount +
      ' 张）；最终部署阶段禁用摸牌与结算', 'warn');
    state.phase = 'battle';
    beginTurn(state, starterPid || state.config.firstPlayer, events);
    var starterId = state.turn;
    var rivalId = other(starterId);
    var starterCan = canBuildEndgame(state, starterId);
    var rivalCan = canBuildEndgame(state, rivalId);
    if (!starterCan && !rivalCan) {
      resolveShowdown(state, events);
      return true;
    }
    if (!starterCan) {
      markEndgameSkip(state, starterId, events);
      if (!rivalCan) {
        resolveShowdown(state, events);
        return true;
      }
      beginTurn(state, rivalId, events);
    }
    return true;
  }

  /* 决战最终部署阶段的「行动后」结算：AP 未用完则继续本回合，否则换人；
   * 对方已无牌可动时跳过其回合并由本方言续（等于给本方开新回合、行动点回满）。 */
  function endgameAfterAction(state, events) {
    if (state.phase !== 'battle') return false;
    var actor = state.turn;
    if (!actor) return false;
    if (regionWinsReached(state)) {
      endGame(state, events);
      return false;
    }
    var next = other(actor);
    var actorCan = canBuildEndgame(state, actor);
    var nextCan = canBuildEndgame(state, next);
    if (!actorCan && !nextCan) {
      resolveShowdown(state, events);
      return false;
    }
    if (state.players[actor].ap > 0 && hasNonEndTurnAction(state)) {
      return false; // 同一回合内继续行动
    }
    var reason = state.players[actor].ap <= 0 ? 'ap' : 'no-action';
    var forfeitedEg = endTurn(state, actor, events, reason);
    if (forfeitedEg) return false;
    if (nextCan) {
      beginTurn(state, next, events);
      return false;
    }
    // 对方已无牌可动：跳过其回合，本方开新回合并回复行动点
    markEndgameSkip(state, next, events);
    if (!actorCan) {
      resolveShowdown(state, events);
      return false;
    }
    beginTurn(state, actor, events);
    return false;
  }

  /* 主动结束回合后的行动方推进（普通战役 / 决战部署） */
  function advanceAfterTurnEnd(state, events, pid) {
    if (state.phase !== 'battle') return;
    var next = other(pid);
    if (state.endgame.triggered && state.endgame.phase === 'build') {
      var selfCan = canBuildEndgame(state, pid);
      var nextCan = canBuildEndgame(state, next);
      if (!selfCan && !nextCan) {
        resolveShowdown(state, events);
        return;
      }
      if (!nextCan) {
        markEndgameSkip(state, next, events);
        if (!selfCan) {
          resolveShowdown(state, events);
          return;
        }
        beginTurn(state, pid, events);
        return;
      }
      beginTurn(state, next, events);
      return;
    }
    beginTurn(state, next, events);
  }

  function resolveShowdown(state, events) {
    var openIds = getOpenRegionIds(state);
    state.endgame.phase = 'showdown';
    events.push({
      type: 'endgame_showdown',
      openRegionIds: openIds.slice(),
      threshold: state.endgame.threshold,
      deckCount: state.deck.length
    });
    appendLog(state, '摊牌结算！双方均无牌可翻、无牌可放，按当前正面牌点数依次结算剩余 ' +
      openIds.length + ' 个区域（无补牌、无随机）', 'warn');
    var N = state.config.settleCards;
    for (var i = 0; i < openIds.length; i++) {
      var rid = openIds[i];
      var region = state.regions[rid];
      var before = snapshotRegion(region);
      var sums = {
        p1: sumValues(region.sides.p1.faceUp),
        p2: sumValues(region.sides.p2.faceUp)
      };
      var winner = sums.p1 > sums.p2 ? 'p1' : (sums.p2 > sums.p1 ? 'p2' : 'tie');
      var allCards = {
        p1: region.sides.p1.faceUp.concat(region.sides.p1.faceDown),
        p2: region.sides.p2.faceUp.concat(region.sides.p2.faceDown)
      };
      var regionResult = {
        winner: winner,
        settleCards: N,
        deterministic: true,
        sums: { p1: sums.p1, p2: sums.p2 },
        faceUp: {
          p1: before.sides.p1.faceUp.slice(),
          p2: before.sides.p2.faceUp.slice()
        },
        drawn: { p1: [], p2: [] },
        difficultyDraw: null,
        allCards: allCards
      };
      region.status = 'settled';
      region.result = regionResult;
      discardRegion(state, region);
      if (winner === 'tie') state.regionWins.ties++;
      else state.regionWins[winner]++;
      state.players.p1.regionsWon = state.regionWins.p1;
      state.players.p2.regionsWon = state.regionWins.p2;
      var ev = {
        type: 'endgame_settle',
        regionId: rid,
        deterministic: true,
        drawnCount: 0,
        drawn: { p1: [], p2: [] },
        regionBefore: before,
        sums: sums,
        winner: winner,
        regionResult: regionResult,
        deckAfter: state.deck.length,
        logSeq: 0
      };
      events.push(ev);
      var text = '摊牌 · 区域 ' + (rid + 1) + '：' + playerLabel(state, 'p1') + ' ' + sums.p1 +
        ' : ' + sums.p2 + ' ' + playerLabel(state, 'p2') + ' → ' + resultName(state, winner);
      ev.logSeq = appendLog(state, text, winner === 'p1' ? 'p1' : (winner === 'p2' ? 'p2' : 'info'));
      if (regionWinsReached(state)) {
        state.endgame.phase = 'done';
        endGame(state, events);
        return;
      }
    }
    state.endgame.phase = 'done';
    state.turn = null;
    endGame(state, events);
  }

  function regionWinsReached(state) {
    var need = state.config.winsNeeded;
    return state.regionWins.p1 >= need || state.regionWins.p2 >= need;
  }

  /* 每次行动成功后的统一收尾：终局检查 → 决战触发 → 回合内继续 / 换人（v1.4 AP） */
  function finishAction(state, events) {
    state.turnCount++;
    var actor = state.turn;
    if (!actor) return false;
    var openIds = getOpenRegionIds(state);
    if (openIds.length === 0) {
      endGame(state, events);
      return false;
    }
    if (regionWinsReached(state)) {
      endGame(state, events);
      return false;
    }
    if (state.endgame.triggered && state.endgame.phase === 'build') {
      endgameAfterAction(state, events);
      return false;
    }
    if (state.deck.length <= getEndgameThreshold(state)) {
      triggerEndgame(state, events, other(actor));
      return true;
    }
    // 普通战役：行动点还有剩余且仍有可执行行动 → 同一玩家继续
    if (state.players[actor].ap > 0 && hasNonEndTurnAction(state)) return false;
    var reason = state.players[actor].ap <= 0 ? 'ap' : 'no-action';
    var forfeited = endTurn(state, actor, events, reason);
    if (forfeited) return false;
    beginTurn(state, other(actor), events);
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 合法行动
   * ------------------------------------------------------------------ */
  function canSettleDeck(state) {
    var openIds = getOpenRegionIds(state);
    if (!openIds.length) return false;
    return state.deck.length >= 2 * state.config.settleCards;
  }

  function getLegalActions(state) {
    if (!state || state.phase !== 'battle' || !state.turn) return [];
    if (state.endgame.triggered && state.endgame.phase !== 'build') return [];
    var pid = state.turn;
    var ap = Number(state.players[pid].ap) || 0;
    var openIds = getOpenRegionIds(state);
    var actions = [];
    var i, j;
    var inEndgameBuild = !!(state.endgame.triggered && state.endgame.phase === 'build');
    if (!inEndgameBuild && ap >= ACTION_COSTS.settle && canSettleDeck(state)) {
      // v1.4：取消「区域内正面牌 > 2 张才能结算」的限制，任意未结算区域均可结算
      for (i = 0; i < openIds.length; i++) {
        actions.push({ type: 'settle', regionId: openIds[i], cost: ACTION_COSTS.settle });
      }
    }
    if (ap >= ACTION_COSTS.flip) {
      for (i = 0; i < openIds.length; i++) {
        var rid = openIds[i];
        var faceDown = state.regions[rid].sides[pid].faceDown;
        for (j = 0; j < faceDown.length; j++) {
          actions.push({ type: 'flip', regionId: rid, cardId: faceDown[j].id, cost: ACTION_COSTS.flip });
        }
      }
    }
    if (ap >= ACTION_COSTS.place) {
      var hand = state.players[pid].hand;
      for (i = 0; i < hand.length; i++) {
        for (j = 0; j < openIds.length; j++) {
          actions.push({ type: 'place', regionId: openIds[j], cardId: hand[i].id, cost: ACTION_COSTS.place });
        }
      }
    }
    if (ap >= ACTION_COSTS.move) {
      for (i = 0; i < openIds.length; i++) {
        var fromId = openIds[i];
        var cards = state.regions[fromId].sides[pid].faceDown;
        for (var c = 0; c < cards.length; c++) {
          for (j = 0; j < openIds.length; j++) {
            if (openIds[j] === fromId) continue;
            actions.push({ type: 'move', fromRegionId: fromId, cardId: cards[c].id, toRegionId: openIds[j], cost: ACTION_COSTS.move });
          }
        }
      }
    }
    if (!inEndgameBuild && ap >= ACTION_COSTS.draw) actions.push({ type: 'draw', cost: ACTION_COSTS.draw });
    actions.push({ type: 'end_turn', cost: ACTION_COSTS.end_turn });
    return actions;
  }

  /* ------------------------------------------------------------------ *
   * 执行行动
   * ------------------------------------------------------------------ */
  function performAction(state, action) {
    if (!state || !action || typeof action.type !== 'string') {
      throw makeError('BAD_ACTION', '行动格式不合法');
    }
    if (state.phase !== 'battle') throw makeError('BAD_PHASE', '当前不在战役阶段');
    if (!state.turn) throw makeError('BAD_PHASE', '当前没有行动方');
    var inEndgameBuild = !!(state.endgame.triggered && state.endgame.phase === 'build');
    if (inEndgameBuild && (action.type === 'draw' || action.type === 'settle')) {
      throw makeError('BAD_ACTION', '战略决战阶段已禁用「摸牌」与「结算」行动，只可翻牌/放牌/移牌');
    }
    var cost = actionCost(action.type);
    if (cost === null) throw makeError('BAD_ACTION', '未知行动类型：' + action.type);
    var pid = state.turn;
    var ap = Number(state.players[pid].ap) || 0;
    if (cost > ap) {
      throw makeError('BAD_ACTION', '行动点不足：当前 ' + ap + ' 点，「' + action.type + '」需要 ' + cost + ' 点');
    }
    var events = [{ type: 'action', playerId: pid, action: action }];

    if (action.type === 'end_turn') {
      var forfeitedEnd = endTurn(state, pid, events, 'manual');
      if (forfeitedEnd) return events;
      advanceAfterTurnEnd(state, events, pid);
      return events;
    }

    state.players[pid].ap = ap - cost;
    // v1.5 防拖延：在行动执行前记录本回合真实行动数 / 推进行动数（move 不算推进）。
    // 必须在 actionSettle 等内部可能触发 endTurn 的行动之前记录，否则结算类行动会被误判为「无有效行动」。
    if (!state.turnProgress) state.turnProgress = { count: 0, productive: 0 };
    var prevProgress = { count: state.turnProgress.count, productive: state.turnProgress.productive };
    state.turnProgress.count++;
    if (action.type !== 'move') state.turnProgress.productive++;
    try {
      switch (action.type) {
        case 'settle': actionSettle(state, action, events, pid); break;
        case 'flip': actionFlip(state, action, events, pid); break;
        case 'place': actionPlace(state, action, events, pid); break;
        case 'move': actionMove(state, action, events, pid); break;
        case 'draw': actionDraw(state, action, events, pid); break;
        default: throw makeError('BAD_ACTION', '未知行动类型：' + action.type);
      }
    } catch (err) {
      // 错误原子性：行动失败时回复行动点与本回合行动计数
      state.players[pid].ap = ap;
      if (state.turnProgress) {
        state.turnProgress.count = prevProgress.count;
        state.turnProgress.productive = prevProgress.productive;
      }
      throw err;
    }
    return events;
  }

  function actionSettle(state, action, events, pid) {
    var region = getRegionOrThrow(state, action.regionId);
    assertOpenRegion(region);
    var rid = region.id;
    if (!canSettleDeck(state)) {
      throw makeError('DECK_INSUFFICIENT', '牌堆不足以完成本次结算的补牌');
    }
    var core = settleRegionCore(state, rid);

    var difficulty = DIFFICULTIES[state.config.difficulty];
    var difficultyDraw = null;
    if (core.winner !== 'tie') {
      var recipient = null;
      if (difficulty.rule === 'loser-draw') recipient = other(core.winner);
      else if (difficulty.rule === 'winner-draw') recipient = core.winner;
      if (recipient && state.deck.length > 0) {
        var card = drawCard(state);
        state.players[recipient].hand.push(card);
        difficultyDraw = { playerId: recipient, card: card };
      }
    }
    core.regionResult.difficultyDraw = difficultyDraw;

    var ev = {
      type: 'settle',
      playerId: pid,
      regionId: rid,
      settleCards: state.config.settleCards,
      regionBefore: core.regionBefore,
      drawn: core.drawn,
      sums: core.sums,
      winner: core.winner,
      difficultyDraw: difficultyDraw,
      regionResult: core.regionResult,
      deckAfter: state.deck.length,
      endgameTriggered: false,
      logSeq: 0
    };
    events.push(ev);

    var text = playerLabel(state, pid) + ' 令区域 ' + (rid + 1) + ' 立即结算（双方各补 ' +
      state.config.settleCards + ' 张）：' + playerLabel(state, 'p1') + ' ' + core.sums.p1 + ' : ' +
      core.sums.p2 + ' ' + playerLabel(state, 'p2') + ' → ' + resultName(state, core.winner);
    ev.logSeq = appendLog(state, text, core.winner === 'p1' ? 'p1' : (core.winner === 'p2' ? 'p2' : 'info'));
    if (difficultyDraw) {
      appendLog(state, '难度规则「' + difficulty.label + '」：' + playerLabel(state, difficultyDraw.playerId) + ' 摸 1 张牌', difficultyDraw.playerId);
    } else if (core.winner === 'tie' && difficulty.rule !== 'none') {
      appendLog(state, '区域平局，难度规则不产生摸牌', 'info');
    }
    var triggered = finishAction(state, events);
    ev.endgameTriggered = triggered;
  }

  function actionFlip(state, action, events, pid) {
    var region = getRegionOrThrow(state, action.regionId);
    assertOpenRegion(region);
    var rid = region.id;
    var side = region.sides[pid];
    var idx = -1;
    for (var i = 0; i < side.faceDown.length; i++) {
      if (side.faceDown[i].id === action.cardId) { idx = i; break; }
    }
    if (idx < 0) throw makeError('NO_SUCH_CARD', '该区域没有这张我方背面牌');
    var card = side.faceDown.splice(idx, 1)[0];
    card.revealed = true;
    side.faceUp.push(card);
    events.push({ type: 'flip', playerId: pid, regionId: rid, card: card, logSeq: appendLog(state, playerLabel(state, pid) + ' 在区域 ' + (rid + 1) + ' 翻开一张牌：' + formatCard(card), pid) });
    finishAction(state, events);
  }

  function actionPlace(state, action, events, pid) {
    var region = getRegionOrThrow(state, action.regionId);
    assertOpenRegion(region);
    var rid = region.id;
    var hand = state.players[pid].hand;
    var idx = -1;
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].id === action.cardId) { idx = i; break; }
    }
    if (idx < 0) throw makeError('CARD_NOT_IN_HAND', '手牌中没有该牌');
    var card = hand.splice(idx, 1)[0];
    card.revealed = false;
    region.sides[pid].faceDown.push(card);
    events.push({ type: 'place', playerId: pid, regionId: rid, card: card, logSeq: appendLog(state, playerLabel(state, pid) + ' 将一张手牌背面朝上放入区域 ' + (rid + 1), pid) });
    finishAction(state, events);
  }

  function actionMove(state, action, events, pid) {
    var from = getRegionOrThrow(state, action.fromRegionId);
    assertOpenRegion(from);
    var to = getRegionOrThrow(state, action.toRegionId);
    assertOpenRegion(to);
    if (from.id === to.id) throw makeError('BAD_ACTION', '不能移动到同一个区域');
    var side = from.sides[pid];
    var idx = -1;
    for (var i = 0; i < side.faceDown.length; i++) {
      if (side.faceDown[i].id === action.cardId) { idx = i; break; }
    }
    if (idx < 0) throw makeError('NO_SUCH_CARD', '该区域没有这张我方背面牌');
    var card = side.faceDown.splice(idx, 1)[0];
    to.sides[pid].faceDown.push(card);
    events.push({
      type: 'move', playerId: pid, fromRegionId: from.id, toRegionId: to.id, card: card,
      logSeq: appendLog(state, playerLabel(state, pid) + ' 将区域 ' + (from.id + 1) + ' 的一张背面牌移到区域 ' + (to.id + 1), pid)
    });
    finishAction(state, events);
  }

  function actionDraw(state, action, events, pid) {
    if (!state.deck.length) throw makeError('DECK_INSUFFICIENT', '牌堆已空，无法摸牌');
    var card = drawCard(state);
    state.players[pid].hand.push(card);
    events.push({
      type: 'draw', playerId: pid, card: card, handSize: state.players[pid].hand.length,
      logSeq: appendLog(state, playerLabel(state, pid) + ' 摸了一张牌（牌堆剩余 ' + state.deck.length + ' 张）', pid)
    });
    finishAction(state, events);
  }

  /* ------------------------------------------------------------------ *
   * 信息 / 展示辅助
   * ------------------------------------------------------------------ */
  function getKnownCardIds(state, playerId) {
    var known = {};
    var hand = state.players[playerId].hand;
    for (var i = 0; i < hand.length; i++) known[hand[i].id] = true;
    for (var r = 0; r < state.regions.length; r++) {
      var sides = state.regions[r].sides;
      ['p1', 'p2'].forEach(function (pid) {
        for (var k = 0; k < sides[pid].faceUp.length; k++) known[sides[pid].faceUp[k].id] = true;
        if (pid === playerId) {
          for (var f = 0; f < sides[pid].faceDown.length; f++) known[sides[pid].faceDown[f].id] = true;
        }
      });
    }
    for (var d = 0; d < state.discard.length; d++) {
      if (state.discard[d].revealed) known[state.discard[d].id] = true;
    }
    return known;
  }

  /* 该玩家视角下的未知牌（牌堆 + 对手手牌 + 对手背面牌 + 未揭示的弃牌），按固定顺序返回，不泄露牌堆顺序 */
  function getUnseenCards(state, playerId) {
    var known = getKnownCardIds(state, playerId);
    var all = buildDeck(state.config.deck);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!known[all[i].id]) out.push(all[i]);
    }
    return out;
  }

  function getKnownCards(state, playerId) {
    var known = getKnownCardIds(state, playerId);
    var all = buildDeck(state.config.deck);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (known[all[i].id]) out.push(all[i]);
    }
    return out;
  }

  function formatCard(card) {
    if (!card) return '？';
    if (card.joker) return card.rank;
    return (card.suitSymbol || '') + card.rank;
  }

  function formatCards(cards) {
    var arr = [];
    for (var i = 0; i < cards.length; i++) arr.push(formatCard(cards[i]));
    return arr.join(' ') || '无';
  }

  function getScoreLabel(state) {
    var s = state.regionWins;
    var label = playerLabel(state, 'p1') + ' ' + s.p1 + ' : ' + s.p2 + ' ' + playerLabel(state, 'p2');
    if (s.ties) label += ' · 平 ' + s.ties;
    return label;
  }

  function isGameOver(state) {
    return !!(state && state.phase === 'gameover');
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  return {
    VERSION: VERSION,
    RANK_VALUES: RANK_VALUES,
    RANKS: RANK_ORDER.slice(),
    SUITS: SUITS.map(function (s) { return { id: s.id, symbol: s.symbol, red: s.red }; }),
    DIFFICULTIES: DIFFICULTIES,
    SETTLE_MODES: SETTLE_MODES.map(function (m) { return { id: m.id, name: m.name, label: m.label, cards: m.cards }; }),
    DEFAULT_SETTLE_CARDS: DEFAULT_SETTLE_CARDS,
    AP_PER_TURN: AP_PER_TURN,
    DEFAULT_TURN_TIME_LIMIT: DEFAULT_TURN_TIME_LIMIT,
    TURN_TIME_LIMIT_OPTIONS: TURN_TIME_LIMIT_OPTIONS.slice(),
    ACTION_COSTS: {
      settle: ACTION_COSTS.settle, draw: ACTION_COSTS.draw, flip: ACTION_COSTS.flip,
      place: ACTION_COSTS.place, move: ACTION_COSTS.move, end_turn: ACTION_COSTS.end_turn
    },
    defaultConfig: defaultConfig,
    validateConfig: validateConfig,
    createGame: createGame,
    createDeck: createDeck,
    makeRng: makeRng,
    submitLayout: submitLayout,
    finalizeLayout: finalizeLayout,
    getLegalActions: getLegalActions,
    performAction: performAction,
    isGameOver: isGameOver,
    getHandSum: getHandSum,
    getOpenRegionIds: getOpenRegionIds,
    getEndgameThreshold: getEndgameThreshold,
    getRegionSideSum: getRegionSideSum,
    getRegionFaceUpCount: getRegionFaceUpCount,
    getKnownCards: getKnownCards,
    getUnseenCards: getUnseenCards,
    formatCard: formatCard,
    formatCards: formatCards,
    getScoreLabel: getScoreLabel
  };
});
