/* =========================================================================
 * 扑克牌 · 比大小 —— 电脑 AI（v3.0：可训练参数 + 智能优化收敛 + 分档波动）
 * 契约：docs/CONTRACT.md §6   规则：docs/RULES.md   训练：tools/train-ai.js
 *
 * v3.0 相对 v2.2 的变化：
 *  - 引入 TRAINED 参数常量（由 tools/train-ai.js 的 CEM 交叉熵法自对弈优化生成，
 *    见 docs/AI-OPTIMIZATION.md）：三档分别收敛，参数可读、可复现；
 *  - hard：在 v2.2 精确补牌分布 DP / 对手最佳回应 / 回合内两步规划的基础上，
 *    新增「决战邻近投影混合」长期项（战役阶段就按决战最终盘面给建设/移牌估值）、
 *    可训练对手回应模型与回合规划权重，并新增更强的回合内两步行计划口径；
 *  - medium：稳健启发式参数化收敛（结算门槛/锁定价值/难度收益/手牌总和/行动成本）；
 *  - easy：保持明显最弱（大噪声 + epsilon 随机），但移除「无意义结束回合」等
 *    自杀式低级错误，仍不使用 move（契约约定）；
 *  - 波动：收敛后单独校准（easy > medium > hard），随机源由 state/seed/turn/行动键
 *    派生（hashUnit），同一 seed 决策完全确定。
 *
 * 公平性：只使用该玩家视角可见的信息（自己手牌、公开正面牌、背面牌数量、
 *         牌堆/手牌张数、弃牌、日志、config）；禁止读取对手手牌/背面牌身份/牌堆顺序。
 * 纯函数：不修改 state、不消耗引擎随机数；随机性仅来自 opts.rng 或由 seed 派生。
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../js/engine.js'));
  } else {
    root.PokerAI = factory(root.PokerEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  if (!E) throw new Error('PokerAI 依赖 PokerEngine');

  var VERSION = '3.1.0';
  var LAYOUT_STRATEGIES = ['balanced', 'top', 'keep-high', 'spread'];
  var VALUE_MAX = 15;

  /* ------------------------------------------------------------------ *
   * TRAINED：智能优化算法（CEM）收敛得到的策略参数（按档位分别收敛）
   * 生成方式：node tools/train-ai.js --tier=hard|medium|easy（固定种子集、
   * 双向座位、与对应 2.2 基线对打；日志见 tools/training-logs/）。
   * 训练期 wave 参数为 0（纯确定性策略）；收敛后单独校准波动幅度。
   * ------------------------------------------------------------------ */
  var TRAINED_META = {
    algorithm: 'CEM',
    version: '2026-10-25-br',
    trainer: 'tools/train-ai.js + best-response 校准（task-53，仅 hard 战斗/估值 17 维，holdout vs 冻结 hard30 52.8%）',
    doc: 'docs/AI-OPTIMIZATION.md'
  };

  var TRAINED = {
    hard: {
      /* CEM 收敛（第二轮：每候选≈360局、3套训练种子轮换、按独立验证集选 best；canon 六配置；日志 tools/training-logs/hard-run2.log） */
      settleBias: -0.044253,
      settleLookahead: 1,
      oppImproveFactor: 0.777479,
      oppDrawFactor: 1.323236,
      oppReplyBlend: 0.781366,
      placePotential: 0.196857,
      moveRevealNear: 0.763324,
      moveRevealMid: 0.581138,
      moveRevealFar: 0.587801,
      moveSubtract: -0.001698,
      followWeight: 0.6,
      planTempo: -0.013827,
      moveMinGain: 0.034738,
      planProjBlend: 0.282357,
      planProjStartGap: 7,
      handCountCoef: 0.009516,
      tieScale: 3,
      tieRuleWeight: 1.052154,
      layoutPValCoef: 1.047196,
      layoutRemainCoef: 0.003315,
      egScale: 4.723532,
      egTieWeight: 0.220708,
      egFlipTempo: 0.079788,
      egPlaceTempo: -0.00865,
      egEndTurnTempo: -0.062453,
      egFollowWeight: 0.602168,
      waveAmp: 0,
      waveEps: 0,
    },
    medium: {
      /* CEM 收敛（hard-lite：精确补牌 DP + 单步对手回应；每候选≈600局、3套训练种子轮换、按验证集选 best；日志 tools/training-logs/medium-*.json） */
      exactSettle: true,
      settleBias: 0.019864,
      settleLookahead: 0,
      oppImproveFactor: 0.375466,
      oppDrawFactor: 0.914814,
      oppReplyBlend: 0.991893,
      placePotential: 0.407664,
      moveRevealNear: 0.760255,
      moveRevealMid: 0.748793,
      moveRevealFar: 0.404857,
      moveSubtract: 0.005846,
      moveMinGain: 0.029365,
      handCountCoef: 0.003898,
      tieRuleWeight: 0.279227,
      settleBaseCoef: 1.489925,
      settleConst: 0.019088,
      winHighBonus: 0.147512,
      winMedBonus: 0.038615,
      lowWinPenalty: 0.160239,
      lockBonus: 1.164787,
      oppLockPenalty: 1.123595,
      nVariancePenalty: 0.012947,
      ruleWeight: 0.090253,
      oppHiddenPenalty: 0.012522,
      settleCost: 0.021837,
      flipGainCoef: 1.207147,
      flipConst: 0.037136,
      flipRisk: 0.041656,
      flipGapBonus: 0.02199,
      flipCost: 0.005049,
      placeGainCoef: 0.710626,
      placeConst: 0.038709,
      placeHandCoef: 0.001703,
      placeRisk: 0.041989,
      placeGapScale: 0.45415,
      placeCost: 0.007277,
      drawTieCoef: 0.136936,
      drawConst: 0.024539,
      drawEmptyHand: 0.121044,
      drawManyPenalty: 0.014597,
      moveGainCoef: 0.589893,
      moveCost: 0.013927,
      movePotential: 0.502059,
      tieScale: 7.209519,
      egScale: 5.387792,
      egTieWeight: 0.462071,
      egFlipTempo: -0.000924,
      egPlaceTempo: 0.026531,
      egEndTurnTempo: -0.027898,
      egFollowWeight: 0.6,
      waveAmp: 0.1,
      waveEps: 0.04,
    },
    easy: {
      /* 简单档（托管用）：大噪声 + epsilon 随机 + 随机布局；不做无意义结束回合，但不训练过强（保持明显最弱） */
      noiseAmp: 0.72,
      epsilon: 0.45,
      settleDiffCoef: 0.0714,
      settleConst: -0.12,
      actionNoise: 0.85,
      layoutRandom: 1,
      waveAmp: 0.25,
      waveEps: 0.08,
    }
  };

  /* 训练/测试用：返回某档参数的深拷贝（避免调用方污染训练常量） */
  function copyParams(src) {
    var out = {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    return out;
  }
  function defaultParams(strength) {
    return copyParams(TRAINED[normalizeStrength(strength)]);
  }
  /* 解析本次决策使用的参数：opts.params 为内部训练钩子（按档位覆盖） */
  function resolveParams(strength, opts) {
    strength = normalizeStrength(strength);
    if (opts && opts.params && opts.params[strength]) return opts.params[strength];
    return TRAINED[strength];
  }

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function otherId(id) { return id === 'p1' ? 'p2' : 'p1'; }
  function normalizeStrength(s) {
    if (s === 'easy' || s === 'hard') return s;
    return 'medium';
  }
  function deriveRng(state, playerId, salt) {
    var seed = (Number(state.config.seed) >>> 0) ^
      (playerId === 'p2' ? 0x9E3779B9 : 0x85EBCA6B) ^
      Math.imul(salt || 1, 0x27D4EB2F) ^
      Math.imul(state.turnCount || 0, 0x165667B1);
    return E.makeRng(seed >>> 0);
  }
  function actionKey(a) {
    if (!a) return 'null';
    if (a.type === 'draw') return 'draw';
    if (a.type === 'settle') return 'settle:' + a.regionId;
    if (a.type === 'flip') return 'flip:' + a.regionId + ':' + a.cardId;
    if (a.type === 'place') return 'place:' + a.regionId + ':' + a.cardId;
    if (a.type === 'move') return 'move:' + a.fromRegionId + ':' + a.cardId + ':' + a.toRegionId;
    return a.type;
  }
  /* 与顺序无关的确定性抖动：同一行动键在同一局面下永远得到同样的噪声，
     使 AI 决策不受手牌顺序/合法行动枚举顺序影响（便于隐藏信息独立性测试）。 */
  function hashUnit(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }
  function noiseOf(action, salt) {
    return hashUnit(actionKey(action) + '|' + salt) - 0.5;
  }
  function findHandCard(state, playerId, cardId) {
    var hand = state.players[playerId].hand;
    for (var i = 0; i < hand.length; i++) if (hand[i].id === cardId) return hand[i];
    return null;
  }
  function findFaceDownCard(state, playerId, regionId, cardId) {
    var arr = state.regions[regionId].sides[playerId].faceDown;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === cardId) return arr[i];
    return null;
  }
  function chooseSmall(n, k) {
    if (k < 0 || k > n) return 0;
    if (k > n - k) k = n - k;
    var r = 1;
    for (var i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return Math.round(r);
  }
  function average(values) {
    if (!values.length) return 7.5;
    var s = 0;
    for (var i = 0; i < values.length; i++) s += values[i];
    return s / values.length;
  }

  /* ------------------------------------------------------------------ *
   * 结算补牌差值分布
   * delta = （我方补 N 张总和）−（对方补 N 张总和），从「未知牌」中不放回抽取。
   * 精确版：按数值计数做组合 DP（未知牌数量通常 ≤ 40，N ≤ 3，状态很小）。
   * 蒙特卡洛版：供中等档使用，样本少、速度快。
   * ------------------------------------------------------------------ */
  function makeEvaluatorFromProbs(probs, span, N, mean) {
    var W = probs.length;
    var gt = new Float64Array(W + 1); // gt[k] = P(delta > k - span)
    gt[W] = 0;
    for (var k = W - 1; k >= 0; k--) gt[k] = gt[k + 1] + (k + 1 < W ? probs[k + 1] : 0);
    return {
      N: N,
      mean: mean,
      exact: true,
      pWin: function (diff) {
        var k = Math.round(span - diff);
        if (k < 0) return 1;
        if (k >= W) return 0;
        return gt[k];
      },
      pTie: function (diff) {
        var k = Math.round(-diff + span);
        if (k < 0 || k >= W) return 0;
        return probs[k];
      },
      pLose: function (diff) {
        var w = this.pWin(diff);
        var t = this.pTie(diff);
        return clamp(1 - w - t, 0, 1);
      }
    };
  }

  function makeExactDelta(values, N) {
    var span = VALUE_MAX * N;
    var W = 2 * span + 1;
    var A = N + 1;
    var B = N + 1;
    var count = A * B * W;
    var cur = new Float64Array(count);
    var next = new Float64Array(count);
    var counts = new Array(VALUE_MAX + 1);
    var i;
    for (i = 0; i <= VALUE_MAX; i++) counts[i] = 0;
    for (i = 0; i < values.length; i++) {
      var v = values[i];
      if (v >= 1 && v <= VALUE_MAX) counts[v]++;
    }
    function idx(a, b, d) { return (a * B + b) * W + (d + span); }
    cur[idx(0, 0, 0)] = 1;
    var total = 0;
    for (var value = 1; value <= VALUE_MAX; value++) {
      var c = counts[value];
      if (!c) continue;
      next.fill(0);
      for (var a = 0; a <= N; a++) {
        for (var b = 0; b <= N; b++) {
          var base = (a * B + b) * W;
          var maxI = Math.min(c, N - a);
          for (var di = 0; di < W; di++) {
            var w = cur[base + di];
            if (!w) continue;
            var d = di - span;
            for (var iTake = 0; iTake <= maxI; iTake++) {
              var wi = chooseSmall(c, iTake);
              if (!wi) continue;
              var rem = c - iTake;
              var maxJ = Math.min(rem, N - b);
              for (var jTake = 0; jTake <= maxJ; jTake++) {
                var nd = d + (iTake - jTake) * value;
                next[idx(a + iTake, b + jTake, nd)] += w * wi * chooseSmall(rem, jTake);
              }
            }
          }
        }
      }
      var tmp = cur; cur = next; next = tmp;
    }
    var probs = new Float64Array(W);
    for (var d2 = -span; d2 <= span; d2++) {
      probs[d2 + span] = cur[idx(N, N, d2)];
      total += probs[d2 + span];
    }
    if (total > 0) for (var p = 0; p < W; p++) probs[p] /= total;
    return makeEvaluatorFromProbs(probs, span, N, average(values));
  }

  function makeMonteDelta(values, N, samples, rng) {
    var span = VALUE_MAX * N;
    var W = 2 * span + 1;
    var probs = new Float64Array(W);
    var ok = 0;
    for (var s = 0; s < samples; s++) {
      var pool = values.slice();
      var len = pool.length;
      var sumMe = 0;
      var sumOpp = 0;
      var picks = Math.min(2 * N, len);
      for (var i = 0; i < picks; i++) {
        var j = i + rng.int(len - i);
        var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        if (i < N) sumMe += pool[i]; else sumOpp += pool[i];
      }
      var delta = sumMe - sumOpp;
      if (delta < -span) delta = -span;
      if (delta > span) delta = span;
      probs[delta + span]++;
      ok++;
    }
    if (ok > 0) for (var p = 0; p < W; p++) probs[p] /= ok;
    var ev = makeEvaluatorFromProbs(probs, span, N, average(values));
    ev.exact = false;
    return ev;
  }

  function makeEvaluator(values, N, strength, rng, exact) {
    if (!values.length) {
      return {
        N: N, mean: 7.5, exact: false,
        pWin: function () { return 0.5; },
        pTie: function () { return 0; },
        pLose: function () { return 0.5; }
      };
    }
    if ((strength === 'hard' || exact) && values.length >= 2 * N) return makeExactDelta(values, N);
    if (strength === 'hard') return makeMonteDelta(values, N, 240, rng);
    return makeMonteDelta(values, N, 72, rng);
  }

  /* ------------------------------------------------------------------ *
   * 盘面模型（供 hard 的两层评估使用）
   * ------------------------------------------------------------------ */
  function sumFaceUp(cards) {
    var s = 0;
    for (var i = 0; i < cards.length; i++) s += cards[i].value;
    return s;
  }

  function buildBoard(state, playerId, evaluator) {
    var opp = otherId(playerId);
    var openIds = E.getOpenRegionIds(state);
    var regions = [];
    for (var i = 0; i < openIds.length; i++) {
      var id = openIds[i];
      var region = state.regions[id];
      var mySide = region.sides[playerId];
      var oppSide = region.sides[opp];
      var mySum = sumFaceUp(mySide.faceUp);
      var oppSum = sumFaceUp(oppSide.faceUp);
      regions.push({
        id: id,
        diff: mySum - oppSum,
        faceUpCount: mySide.faceUp.length + oppSide.faceUp.length,
        enabled: true, // v1.4：任意未结算区域均可结算（不再要求正面牌 > 2 张）
        myHidden: mySide.faceDown.length,
        oppHidden: oppSide.faceDown.length
      });
    }
    var myHandSum = E.getHandSum(state, playerId);
    var myHandCount = state.players[playerId].hand.length;
    var oppHandCount = state.players[opp].hand.length;
    var oppHandSum = oppHandCount * evaluator.mean;
    return {
      myWins: state.regionWins[playerId],
      oppWins: state.regionWins[opp],
      regions: regions,
      handDiff: myHandSum - oppHandSum,
      handCountDiff: myHandCount - oppHandCount,
      myHandSum: myHandSum,
      myHandCount: myHandCount,
      oppHandCount: oppHandCount
    };
  }

  function cloneBoard(board) {
    var regions = new Array(board.regions.length);
    for (var i = 0; i < board.regions.length; i++) {
      var r = board.regions[i];
      regions[i] = {
        id: r.id, diff: r.diff, faceUpCount: r.faceUpCount, enabled: r.enabled,
        myHidden: r.myHidden, oppHidden: r.oppHidden
      };
    }
    return {
      myWins: board.myWins, oppWins: board.oppWins, regions: regions,
      handDiff: board.handDiff, handCountDiff: board.handCountDiff,
      myHandSum: board.myHandSum, myHandCount: board.myHandCount,
      oppHandCount: board.oppHandCount
    };
  }

  function boardWithoutRegion(board, index) {
    var nb = cloneBoard(board);
    nb.regions.splice(index, 1);
    return nb;
  }

  /* 未来单独结算的难度摸牌会改变最终手牌总和（用于手牌总和决胜估计） */
  function adjustedHandDiff(board, evaluator, rule, P) {
    var diff = board.handDiff;
    if (rule === 'none' || !board.regions.length) return diff;
    var mean = evaluator.mean;
    var w = P ? P.tieRuleWeight : 1;
    for (var i = 0; i < board.regions.length; i++) {
      var pWin = evaluator.pWin(board.regions[i].diff);
      var pTie = evaluator.pTie(board.regions[i].diff);
      var pLose = clamp(1 - pWin - pTie, 0, 1);
      if (rule === 'loser-draw') diff += w * mean * (pLose - pWin);
      else if (rule === 'winner-draw') diff += w * mean * (pWin - pLose);
    }
    return diff;
  }

  function handTieWin(diff, scale) {
    scale = scale || 10;
    return 1 / (1 + Math.exp(-diff / scale));
  }

  /* 若盘面所有未结算区域按当前补牌胜率结算，我方最终获胜概率 */
  function matchWin(board, evaluator, need, rule, hard, P) {
    if (board.myWins >= need) return 1;
    if (board.oppWins >= need) return 0;
    var size = need + 1;
    var cur = new Float64Array(size * size);
    var next = new Float64Array(size * size);
    cur[board.myWins * size + board.oppWins] = 1;
    var winMass = 0;
    var loseMass = 0;
    var r, m, o;
    for (r = 0; r < board.regions.length; r++) {
      var reg = board.regions[r];
      var pWin = evaluator.pWin(reg.diff);
      var pTie = evaluator.pTie(reg.diff);
      var pLose = clamp(1 - pWin - pTie, 0, 1);
      next.fill(0);
      for (m = 0; m < need; m++) {
        for (o = 0; o < need; o++) {
          var prob = cur[m * size + o];
          if (!prob) continue;
          if (m + 1 >= need) winMass += prob * pWin;
          else next[(m + 1) * size + o] += prob * pWin;
          if (o + 1 >= need) loseMass += prob * pLose;
          else next[m * size + o + 1] += prob * pLose;
          next[m * size + o] += prob * pTie;
        }
      }
      var tmp = cur; cur = next; next = tmp;
    }
    var remaining = 0;
    for (m = 0; m < need; m++) {
      for (o = 0; o < need; o++) remaining += cur[m * size + o];
    }
    var tieDiff = hard ? adjustedHandDiff(board, evaluator, rule, P) : board.handDiff;
    var tieWin = handTieWin(tieDiff, hard ? (P ? P.tieScale : 9) : 11);
    var value = winMass + remaining * tieWin;
    if (hard) value += clamp(board.handCountDiff, -4, 4) * (P ? P.handCountCoef : 0.004);
    return clamp(value, 0, 1);
  }

  /* ------------------------------------------------------------------ *
   * HARD：对手最佳回应（单层，对手也只拿到一次行动机会）
   * 返回：对手行动后，我方最终获胜概率（对手会尽量压低它）。
   * ------------------------------------------------------------------ */
  function opponentSettleOutcomesValue(board, index, evaluator, need, rule, P) {
    var reg = board.regions[index];
    var oppDiff = -reg.diff;
    var pOppWin = evaluator.pWin(oppDiff);
    var pTie = evaluator.pTie(oppDiff);
    var pMyWin = clamp(1 - pOppWin - pTie, 0, 1);
    var mean = evaluator.mean;
    var vOppWin, vTie, vMyWin;
    // 对手赢下该区域
    var b1 = boardWithoutRegion(board, index);
    b1.oppWins += 1;
    if (b1.oppWins >= need) vOppWin = 0;
    else {
      if (rule === 'loser-draw') { b1.handDiff += mean; b1.handCountDiff += 1; b1.myHandCount += 1; }
      else if (rule === 'winner-draw') { b1.handDiff -= mean; b1.handCountDiff -= 1; b1.oppHandCount += 1; }
      vOppWin = matchWin(b1, evaluator, need, rule, true, P);
    }
    // 平局
    var b2 = boardWithoutRegion(board, index);
    vTie = matchWin(b2, evaluator, need, rule, true, P);
    // 我方赢下该区域
    var b3 = boardWithoutRegion(board, index);
    b3.myWins += 1;
    if (b3.myWins >= need) vMyWin = 1;
    else {
      if (rule === 'loser-draw') { b3.handDiff -= mean; b3.handCountDiff -= 1; b3.oppHandCount += 1; }
      else if (rule === 'winner-draw') { b3.handDiff += mean; b3.handCountDiff += 1; b3.myHandCount += 1; }
      vMyWin = matchWin(b3, evaluator, need, rule, true, P);
    }
    return pOppWin * vOppWin + pTie * vTie + pMyWin * vMyWin;
  }

  function opponentReplyValue(board, evaluator, need, rule, P) {
    var passive = matchWin(board, evaluator, need, rule, true, P); // 对手消极应对时的上限
    var best = passive;
    var mean = evaluator.mean;
    var improveFactor = P ? P.oppImproveFactor : 0.65;
    var drawFactor = P ? P.oppDrawFactor : 1;
    var i;
    // 1) 对手结算任意可结算区域
    for (i = 0; i < board.regions.length; i++) {
      if (!board.regions[i].enabled) continue;
      var v = opponentSettleOutcomesValue(board, i, evaluator, need, rule, P);
      if (v < best) best = v;
    }
    // 2) 对手翻牌/放牌提升某个区域（按其期望收益估计）
    for (i = 0; i < board.regions.length; i++) {
      var nb = cloneBoard(board);
      nb.regions[i].diff -= mean * improveFactor;
      var v2 = matchWin(nb, evaluator, need, rule, true, P);
      if (v2 < best) best = v2;
    }
    // 3) 对手摸牌（手牌总和与资源）
    var bd = cloneBoard(board);
    bd.handDiff -= mean * drawFactor;
    bd.handCountDiff -= 1;
    bd.oppHandCount += 1;
    var v3 = matchWin(bd, evaluator, need, rule, true, P);
    if (v3 < best) best = v3;
    var blend = P ? P.oppReplyBlend : 1;
    return clamp((1 - blend) * passive + blend * best, 0, 1);
  }

  function settleActionValue(board, index, evaluator, need, rule, deckLen, N, P) {
    var reg = board.regions[index];
    var pWin = evaluator.pWin(reg.diff);
    var pTie = evaluator.pTie(reg.diff);
    var pLose = clamp(1 - pWin - pTie, 0, 1);
    var mean = evaluator.mean;
    var openAfter = board.regions.length - 1;
    var lookahead = P ? P.settleLookahead : 0;
    var total = 0;
    var kinds = [
      { prob: pWin, who: 'me' },
      { prob: pTie, who: 'tie' },
      { prob: pLose, who: 'opp' }
    ];
    for (var k = 0; k < kinds.length; k++) {
      var kind = kinds[k];
      if (kind.prob <= 0) continue;
      var nb = boardWithoutRegion(board, index);
      var drawn = false;
      if (kind.who === 'me') {
        nb.myWins += 1;
        if (rule !== 'none') {
          drawn = true;
          if (rule === 'winner-draw') { nb.handDiff += mean; nb.handCountDiff += 1; nb.myHandCount += 1; }
          else { nb.handDiff -= mean; nb.handCountDiff -= 1; nb.oppHandCount += 1; }
        }
      } else if (kind.who === 'opp') {
        nb.oppWins += 1;
        if (rule !== 'none') {
          drawn = true;
          if (rule === 'loser-draw') { nb.handDiff += mean; nb.handCountDiff += 1; nb.myHandCount += 1; }
          else { nb.handDiff -= mean; nb.handCountDiff -= 1; nb.oppHandCount += 1; }
        }
      }
      var v;
      if (nb.myWins >= need) v = 1;
      else if (nb.oppWins >= need) v = 0;
      else {
        var deckAfter = deckLen - 2 * N - (drawn ? 1 : 0);
        var endgame = openAfter === 0 || deckAfter <= 2 * openAfter + lookahead;
        v = endgame ? matchWin(nb, evaluator, need, rule, true, P)
          : opponentReplyValue(nb, evaluator, need, rule, P);
      }
      total += kind.prob * v;
    }
    return total;
  }

  /* ------------------------------------------------------------------ *
   * HARD：行动估值
   * ------------------------------------------------------------------ */
  /* 决战邻近投影混合：deck - 2*open 越小，越应该按「最终决战盘面」给建设/移牌估值。
   * projCtx = { base: 投影, baseVal: 当前投影价值, weight: 混合权重 }，由 chooseAction 构造。 */
  function projectionBlendWeight(deckLen, openCount, P) {
    if (!P || !P.planProjBlend) return 0;
    var startGap = P.planProjStartGap;
    var gap = deckLen - 2 * openCount;
    if (gap > startGap) return 0;
    var w = P.planProjBlend * (startGap - gap + 1) / (startGap + 1);
    return clamp(w, 0, 1);
  }

  function projectionActionValue(projCtx, action) {
    if (!projCtx || !projCtx.base) return null;
    var np = cloneProjection(projCtx.base);
    if (!applyProjectionAction(np, action)) return null;
    return endgameProjectionValue(np, projCtx.P);
  }

  function hardActionValue(state, playerId, action, board, evaluator, need, rule, deckLen, N, mean, P, projCtx) {
    P = P || TRAINED.hard;
    var i;
    var value;
    if (action.type === 'settle') {
      var idx = -1;
      for (i = 0; i < board.regions.length; i++) {
        if (board.regions[i].id === action.regionId) { idx = i; break; }
      }
      if (idx < 0) return -1;
      return clamp(settleActionValue(board, idx, evaluator, need, rule, deckLen, N, P) + P.settleBias, 0, 1);
    }
    if (action.type === 'flip') {
      var card = findFaceDownCard(state, playerId, action.regionId, action.cardId);
      if (!card) return -1;
      var nbF = cloneBoard(board);
      for (i = 0; i < nbF.regions.length; i++) {
        if (nbF.regions[i].id !== action.regionId) continue;
        nbF.regions[i].diff += card.value;
        nbF.regions[i].faceUpCount += 1;
        nbF.regions[i].enabled = true;
        break;
      }
      value = opponentReplyValue(nbF, evaluator, need, rule, P);
      var pw = projectionBlendWeight(deckLen, board.regions.length, P);
      if (pw > 0) {
        var pv = projectionActionValue(projCtx, action);
        if (pv != null) value = (1 - pw) * value + pw * pv;
      }
      return value;
    }
    if (action.type === 'place') {
      var hc = findHandCard(state, playerId, action.cardId);
      if (!hc) return -1;
      var nbP = cloneBoard(board);
      for (i = 0; i < nbP.regions.length; i++) {
        if (nbP.regions[i].id !== action.regionId) continue;
        nbP.regions[i].diff += hc.value * P.placePotential; // 背面牌需再翻牌才生效 → 折算潜力
        nbP.regions[i].myHidden += 1;
        break;
      }
      nbP.handDiff -= hc.value;
      nbP.handCountDiff -= 1;
      nbP.myHandCount -= 1;
      value = opponentReplyValue(nbP, evaluator, need, rule, P);
      var pw2 = projectionBlendWeight(deckLen, board.regions.length, P);
      if (pw2 > 0) {
        var pv2 = projectionActionValue(projCtx, action);
        if (pv2 != null) value = (1 - pw2) * value + pw2 * pv2;
      }
      return value;
    }
    if (action.type === 'draw') {
      var nbD = cloneBoard(board);
      nbD.handDiff += mean;
      nbD.handCountDiff += 1;
      nbD.myHandCount += 1;
      var deckAfter = deckLen - 1;
      var endgame = deckAfter <= 2 * board.regions.length;
      if (endgame) return matchWin(nbD, evaluator, need, rule, true, P);
      return opponentReplyValue(nbD, evaluator, need, rule, P);
    }
    if (action.type === 'move') {
      var mv = findFaceDownCard(state, playerId, action.fromRegionId, action.cardId);
      if (!mv) return -1;
      var fromIdx = -1, toIdx = -1;
      for (i = 0; i < board.regions.length; i++) {
        if (board.regions[i].id === action.fromRegionId) fromIdx = i;
        else if (board.regions[i].id === action.toRegionId) toIdx = i;
      }
      if (fromIdx < 0 || toIdx < 0) return -1;
      // 移牌不改变正面总和，把背面牌的潜在点数按「未来会翻开」的概率从 A 区转到 B 区，
      // 用于把分散/无望区域的牌集中到关键区域（主动弃区）。
      var openCount = board.regions.length || 1;
      var gap = deckLen - 2 * openCount;
      var pReveal = gap <= 3 ? P.moveRevealNear : (gap <= 10 ? P.moveRevealMid : P.moveRevealFar);
      var nbM = cloneBoard(board);
      nbM.regions[fromIdx].diff -= mv.value * pReveal;
      nbM.regions[toIdx].diff += mv.value * pReveal;
      nbM.regions[fromIdx].myHidden -= 1;
      nbM.regions[toIdx].myHidden += 1;
      value = clamp(opponentReplyValue(nbM, evaluator, need, rule, P) - P.moveSubtract, 0, 1);
      var pw3 = projectionBlendWeight(deckLen, board.regions.length, P);
      if (pw3 > 0) {
        var pv3 = projectionActionValue(projCtx, action);
        if (pv3 != null) value = (1 - pw3) * value + pw3 * pv3;
      }
      return value;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * MEDIUM：稳健启发式（参数化收敛）
   * ------------------------------------------------------------------ */
  function mediumActionScore(state, playerId, action, board, evaluator, need, rule, deckLen, N, gap, P) {
    P = P || TRAINED.medium;
    var mean = evaluator.mean;
    var i;
    if (action.type === 'settle') {
      var idx = -1;
      for (i = 0; i < board.regions.length; i++) {
        if (board.regions[i].id === action.regionId) { idx = i; break; }
      }
      if (idx < 0) return -1;
      var reg = board.regions[idx];
      var pWin = evaluator.pWin(reg.diff);
      var pTie = evaluator.pTie(reg.diff);
      var pLose = clamp(1 - pWin - pTie, 0, 1);
      // 基础：本区域期望收益 + 「结算才能得分」的推进/锁定价值
      var score = (2 * pWin + pTie - 1) * P.settleBaseCoef + P.settleConst;
      if (pWin >= 0.65) score += P.winHighBonus;
      else if (pWin >= 0.55) score += P.winMedBonus;
      else if (pWin < 0.4) score -= P.lowWinPenalty;
      // 提前锁定：第 need 胜价值极高；反之送对手锁定要极力避免
      if (board.myWins + 1 >= need) score += pWin * P.lockBonus;
      if (board.oppWins + 1 >= need) score -= pLose * P.oppLockPenalty;
      // 结算随机性：补牌越多，领先/落后越不确定 → 小幅降低过早结算意愿
      score -= P.nVariancePenalty * (N - 1);
      // 难度规则：简单=败者摸牌（落后方结算有补偿）；困难=胜者摸牌（赢下结算滚雪球）
      if (rule === 'loser-draw') score += pLose * P.ruleWeight - pWin * P.ruleWeight * 0.25;
      else if (rule === 'winner-draw') score += pWin * P.ruleWeight - pLose * P.ruleWeight * 0.25;
      // 对手背牌可反超的风险；对手手牌多也更可能反超
      score -= reg.oppHidden * P.oppHiddenPenalty;
      // 行动成本（本回合若不结算可以继续建设）
      score -= P.settleCost;
      return score;
    }
    if (action.type === 'flip') {
      var card = findFaceDownCard(state, playerId, action.regionId, action.cardId);
      if (!card) return -1;
      var rf = null;
      for (i = 0; i < board.regions.length; i++) if (board.regions[i].id === action.regionId) rf = board.regions[i];
      if (!rf) return -1;
      var pAfter = evaluator.pWin(rf.diff + card.value);
      var pBefore = evaluator.pWin(rf.diff);
      var scoreF = (pAfter - pBefore) * P.flipGainCoef;
      scoreF += P.flipConst;
      if (rf.oppHidden > 0 && pAfter > 0.55) scoreF -= P.flipRisk;
      if (gap <= 2) scoreF += P.flipGapBonus; // 决战临近：正面牌直接进入终局对比
      scoreF -= P.flipCost;
      return scoreF;
    }
    if (action.type === 'place') {
      var hc = findHandCard(state, playerId, action.cardId);
      if (!hc) return -1;
      var rp = null;
      for (i = 0; i < board.regions.length; i++) if (board.regions[i].id === action.regionId) rp = board.regions[i];
      if (!rp) return -1;
      var pF = evaluator.pWin(rp.diff + hc.value * P.placePotential);
      var scoreP = (pF - evaluator.pWin(rp.diff)) * P.placeGainCoef;
      scoreP += P.placeConst; // 放牌是开启「翻牌→可结算」链条的必要建设
      scoreP -= hc.value * P.placeHandCoef; // 手牌本身的价值（终局 tie-break / 后续资源）
      if (rp.enabled && evaluator.pWin(rp.diff) < 0.5) scoreP -= P.placeRisk; // 对手可能抢先结算
      if (gap <= 2) scoreP *= P.placeGapScale;
      scoreP -= P.placeCost;
      return scoreP;
    }
    if (action.type === 'draw') {
      // 摸牌主要价值：手牌资源 + 终局手牌总和 tie-break（后者只在无人提前锁定时才生效，权重低）
      var diffAfter = board.handDiff + mean;
      var scoreD = (handTieWin(diffAfter, P.tieScale) - handTieWin(board.handDiff, P.tieScale)) * P.drawTieCoef;
      scoreD -= P.drawConst;
      if (board.myHandCount === 0) scoreD += P.drawEmptyHand;
      if (board.myHandCount >= 8) scoreD -= P.drawManyPenalty;
      if (gap === 1) {
        // 摸牌立即触发决战：按当前盘面期望决定
        var bt = matchWin(board, evaluator, need, rule, false);
        scoreD = bt > 0.55 ? 0.9 : (bt < 0.4 ? -0.6 : 0.05);
      } else if (gap <= 3) {
        if (board.myWins > board.oppWins) scoreD += 0.02;
        else if (board.myWins < board.oppWins) scoreD -= 0.02;
      }
      return scoreD;
    }
    if (action.type === 'move') {
      var mvM = findFaceDownCard(state, playerId, action.fromRegionId, action.cardId);
      if (!mvM) return -1;
      var fromM = null, toM = null;
      for (i = 0; i < board.regions.length; i++) {
        if (board.regions[i].id === action.fromRegionId) fromM = board.regions[i];
        else if (board.regions[i].id === action.toRegionId) toM = board.regions[i];
      }
      if (!fromM || !toM) return -1;
      // 中等档只在高价值时移牌：背面牌潜在值转移对区域胜率的边际收益（再扣节奏成本）
      var pv = P.movePotential;
      var toGain = evaluator.pWin(toM.diff + mvM.value * pv) - evaluator.pWin(toM.diff);
      var fromLoss = evaluator.pWin(fromM.diff) - evaluator.pWin(fromM.diff - mvM.value * pv);
      return P.moveGainCoef * (toGain - fromLoss) - P.moveCost;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * EASY：粗糙启发式 + 大噪声（明显最弱，但不犯「无意义结束回合」等低级错误）
   * ------------------------------------------------------------------ */
  function easyScore(state, playerId, action, rng, P) {
    P = P || TRAINED.easy;
    var noise = rng.next() * P.noiseAmp;
    if (action.type === 'settle') {
      var region = state.regions[action.regionId];
      var opp = otherId(playerId);
      var raw = sumFaceUp(region.sides[playerId].faceUp) - sumFaceUp(region.sides[opp].faceUp);
      // 忽略补牌分布/锁定价值/难度收益：只看当前分差 + 大随机
      return raw * P.settleDiffCoef + P.settleConst + noise;
    }
    if (action.type === 'flip') return 0.06 + noise * P.actionNoise;
    if (action.type === 'place') return 0.05 + noise * P.actionNoise;
    if (action.type === 'move') return 0.04 + noise * P.actionNoise;
    if (action.type === 'draw') return 0.07 + noise * P.actionNoise;
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * 行动选择
   * ------------------------------------------------------------------ */
  /* 战略决战「最终部署」（v2.2 重写，v3.0 参数化）
   * 禁用摸牌/结算；可用 翻牌(2) / 放牌(1) / 移牌(1) / 结束回合(0)。
   * 关键事实：触发摊牌要求「双方手牌=0 且自己场上背面牌=0」，因此决战里每张手牌最终都会
   * 被放到某个区域并翻开、每张背面牌最终都会被翻开——最终区域点数 = 正面牌 + 该区背面牌
   * （+ 之后放进来的牌）。因此决策本质是「把牌分配到哪个区域」：
   *  - 投影最终盘面：我方按真实牌值全量计入；对手未知牌按未见牌均值摊到各区域；
   *  - 区域胜率用 logistic，胜场门槛用 DP 计算最终胜率（胜/平/负）；
   *  - 翻牌只推进摊牌（不改变最终归属）→ 小的推进收益；放牌/移牌改变分配 → 按投影胜率增量估值；
   *  - 困难档两步规划（本行动 + 剩余 AP 内最佳后续），并给翻牌小的推进收益，避免
   *    「只移不翻」或来回移动导致对局无法推进；困难/中等档会用移牌主动放弃赢不了的区域。
   * ------------------------------------------------------------------ */
  var EG_SCALE = 5;

  function logistic(x) { return 1 / (1 + Math.exp(-x)); }

  /* 构造「最终盘面」投影（只含 open 区域）。includeHandIdeal=true 时把「手牌最终会放到哪里」的
   * 贪心理想落区也计入投影基线（困难档使用，能正确比较「放牌」与「移牌/弃区」的机会成本）；
   * 中等档用 false（更短视，保持档位差距）。 */
  function buildEndgameProjection(state, playerId, mean, includeHandIdeal) {
    var opp = otherId(playerId);
    var openIds = E.getOpenRegionIds(state);
    var X = openIds.length || 1;
    var oppHandCount = state.players[opp].hand.length;
    var regions = [];
    var hidden = [];
    var hand = [];
    var i, k;
    for (i = 0; i < openIds.length; i++) {
      var rid = openIds[i];
      var region = state.regions[rid];
      var mySum = 0, oppSum = 0, hiddenSum = 0;
      for (k = 0; k < region.sides[playerId].faceUp.length; k++) mySum += region.sides[playerId].faceUp[k].value;
      for (k = 0; k < region.sides[opp].faceUp.length; k++) oppSum += region.sides[opp].faceUp[k].value;
      var fd = region.sides[playerId].faceDown;
      for (k = 0; k < fd.length; k++) {
        hiddenSum += fd[k].value;
        hidden.push({ cardId: fd[k].id, value: fd[k].value, regionId: rid });
      }
      // 对手未知牌：场上背面牌按各区数量计入，手牌平均摊到所有区域（最终都会翻开）
      var oppProjected = oppSum + (region.sides[opp].faceDown.length + oppHandCount / X) * mean;
      regions.push({ id: rid, my: mySum + hiddenSum, opp: oppProjected });
    }
    var myHand = state.players[playerId].hand;
    for (i = 0; i < myHand.length; i++) hand.push({ cardId: myHand[i].id, value: myHand[i].value });
    // 手牌最终都会放下并翻开：先做一次贪心的「理想落区」分配并计入投影基线。
    // 这样「放牌」落到理想区是中性、落到坏区是负收益，避免把「迟早要放的牌」误当成额外收益，
    // 从而低估移牌/主动弃区的价值。
    if (includeHandIdeal) {
      hand.sort(function (a, b) { return b.value - a.value || (a.cardId < b.cardId ? -1 : 1); });
      for (var h = 0; h < hand.length; h++) {
        var hCard = hand[h];
        var bestRi = 0, bestDelta = -Infinity;
        for (var r = 0; r < regions.length; r++) {
          var diff0 = regions[r].my - regions[r].opp;
          var deltaWin = logistic((diff0 + hCard.value) / EG_SCALE) - logistic(diff0 / EG_SCALE);
          if (deltaWin > bestDelta) { bestDelta = deltaWin; bestRi = r; }
        }
        hCard.idealRegionId = regions[bestRi].id;
        regions[bestRi].my += hCard.value;
      }
    }
    return {
      regions: regions,
      hidden: hidden,
      hand: hand,
      myWins: state.regionWins[playerId],
      oppWins: state.regionWins[opp],
      need: state.config.winsNeeded
    };
  }

  function cloneProjection(p) {
    var regions = new Array(p.regions.length);
    for (var i = 0; i < p.regions.length; i++) {
      regions[i] = { id: p.regions[i].id, my: p.regions[i].my, opp: p.regions[i].opp };
    }
    var hidden = new Array(p.hidden.length);
    for (var j = 0; j < p.hidden.length; j++) {
      hidden[j] = { cardId: p.hidden[j].cardId, value: p.hidden[j].value, regionId: p.hidden[j].regionId };
    }
    var hand = new Array(p.hand.length);
    for (var k = 0; k < p.hand.length; k++) {
      hand[k] = {
        cardId: p.hand[k].cardId,
        value: p.hand[k].value,
        idealRegionId: p.hand[k].idealRegionId
      };
    }
    return { regions: regions, hidden: hidden, hand: hand, myWins: p.myWins, oppWins: p.oppWins, need: p.need };
  }

  function projRegionIndex(p, rid) {
    for (var i = 0; i < p.regions.length; i++) if (p.regions[i].id === rid) return i;
    return -1;
  }

  /* 投影最终盘面 → 我方最终胜率（区域胜率 logistic + 胜场门槛 DP；平局给固定权重） */
  function endgameProjectionValue(p, P) {
    var egScale = (P && P.egScale != null) ? P.egScale : EG_SCALE;
    var tieWeight = (P && P.egTieWeight != null) ? P.egTieWeight : 0.25;
    var need = p.need;
    if (p.myWins >= need) return 1;
    if (p.oppWins >= need) return 0;
    var size = need + 1;
    var cur = new Float64Array(size * size);
    var next = new Float64Array(size * size);
    cur[p.myWins * size + p.oppWins] = 1;
    var winMass = 0;
    var drawMass = 0;
    var i, m, o, prob;
    for (i = 0; i < p.regions.length; i++) {
      var diff = Math.max(-30, Math.min(30, p.regions[i].my - p.regions[i].opp));
      var pw = logistic(diff / egScale);
      if (pw < 0.02) pw = 0.02;
      else if (pw > 0.98) pw = 0.98;
      var pl = 1 - pw;
      next.fill(0);
      for (m = 0; m < need; m++) {
        for (o = 0; o < need; o++) {
          prob = cur[m * size + o];
          if (!prob) continue;
          if (m + 1 >= need) winMass += prob * pw;
          else next[(m + 1) * size + o] += prob * pw;
          if (o + 1 >= need) continue; // 对方达到门槛：该分支判负
          next[m * size + o + 1] += prob * pl;
        }
      }
      var tmp = cur;
      cur = next;
      next = tmp;
    }
    for (m = 0; m < need; m++) {
      for (o = 0; o < need; o++) drawMass += cur[m * size + o];
    }
    return clamp(winMass + tieWeight * drawMass, 0, 1);
  }

  /* 把行动作用到投影副本上（就地修改，返回 p 或 null） */
  function applyProjectionAction(p, action) {
    var i;
    if (action.type === 'flip') {
      for (i = 0; i < p.hidden.length; i++) {
        // 规划时按 cardId 匹配即可：先移牌再翻同一张牌时，行动里的 regionId 是移动前的旧值
        if (p.hidden[i].cardId === action.cardId) {
          p.hidden.splice(i, 1); // 翻开后不可再移动；投影点数不变（背面牌本来就全量计入）
          return p;
        }
      }
      return null;
    }
    if (action.type === 'place') {
      var hi = -1;
      for (i = 0; i < p.hand.length; i++) if (p.hand[i].cardId === action.cardId) { hi = i; break; }
      if (hi < 0) return null;
      var ri = projRegionIndex(p, action.regionId);
      if (ri < 0) return null;
      var card = p.hand.splice(hi, 1)[0];
      var idealRi = projRegionIndex(p, card.idealRegionId);
      if (idealRi >= 0 && idealRi !== ri) {
        // 没放到理想区域：从理想区域扣掉，改加到实际区域
        p.regions[idealRi].my -= card.value;
        p.regions[ri].my += card.value;
      } else if (idealRi < 0) {
        p.regions[ri].my += card.value;
      }
      // 放到理想区域时投影已计入该价值，不重复增加；放入后成为背面牌，可被移牌调整
      p.hidden.push({ cardId: card.cardId, value: card.value, regionId: action.regionId });
      return p;
    }
    if (action.type === 'move') {
      var mi = -1;
      for (i = 0; i < p.hidden.length; i++) {
        if (p.hidden[i].cardId === action.cardId && p.hidden[i].regionId === action.fromRegionId) { mi = i; break; }
      }
      if (mi < 0) return null;
      var fromIdx = projRegionIndex(p, action.fromRegionId);
      var toIdx = projRegionIndex(p, action.toRegionId);
      if (fromIdx < 0 || toIdx < 0) return null;
      var mv = p.hidden[mi];
      p.regions[fromIdx].my -= mv.value;
      p.regions[toIdx].my += mv.value;
      mv.regionId = action.toRegionId;
      return p;
    }
    return null;
  }

  function endgameTempo(action, P) {
    P = P || TRAINED.hard;
    if (action.type === 'flip') return P.egFlipTempo != null ? P.egFlipTempo : 0.03;
    if (action.type === 'place') return P.egPlaceTempo != null ? P.egPlaceTempo : 0.01;
    if (action.type === 'move') return 0;
    if (action.type === 'end_turn') return P.egEndTurnTempo != null ? P.egEndTurnTempo : -0.05;
    return 0;
  }

  /* 从投影状态生成候选行动（用于两步规划的第二步行） */
  function endgameCandidatesFromProjection(p, ap, costs) {
    var out = [];
    var i, j;
    if (ap >= costs.flip) {
      for (i = 0; i < p.hidden.length; i++) {
        out.push({ type: 'flip', regionId: p.hidden[i].regionId, cardId: p.hidden[i].cardId, cost: costs.flip });
      }
    }
    if (ap >= costs.place) {
      for (i = 0; i < p.hand.length; i++) {
        for (j = 0; j < p.regions.length; j++) {
          out.push({ type: 'place', cardId: p.hand[i].cardId, regionId: p.regions[j].id, cost: costs.place });
        }
      }
    }
    if (ap >= costs.move) {
      for (i = 0; i < p.hidden.length; i++) {
        for (j = 0; j < p.regions.length; j++) {
          if (p.regions[j].id === p.hidden[i].regionId) continue;
          out.push({
            type: 'move', cardId: p.hidden[i].cardId,
            fromRegionId: p.hidden[i].regionId, toRegionId: p.regions[j].id, cost: costs.move
          });
        }
      }
    }
    return out;
  }

  /* 决战推进保障（v2.2）：每回合第一次行动若还有背面牌，优先翻一张「最不后悔」的牌。
   * 翻牌不改变最终投影点数，但会锁定该牌所在区域；如果双方都只移牌/放牌，可能永远不翻牌
   * 导致对局无法进入摊牌（实测出现过无限循环）。这里选「移动机会成本最小」的牌翻掉：
   * 既保证每回合至少推进一张牌（对局必然终止），又尽量不损失后续调整空间。 */
  function chooseForcedFlip(state, playerId, mean, P) {
    var legal = E.getLegalActions(state);
    var flips = [];
    var i;
    for (i = 0; i < legal.length; i++) if (legal[i].type === 'flip') flips.push(legal[i]);
    if (!flips.length) return null;
    var base = buildEndgameProjection(state, playerId, mean, true);
    var baseVal = endgameProjectionValue(base, P);
    var best = null;
    var bestRegret = Infinity;
    for (i = 0; i < flips.length; i++) {
      var a = flips[i];
      var curRegion = -1;
      for (var k = 0; k < base.regions.length; k++) {
        if (base.regions[k].id === a.regionId) { curRegion = k; break; }
      }
      if (curRegion < 0) continue;
      var bestMoveVal = baseVal;
      for (var r = 0; r < base.regions.length; r++) {
        if (r === curRegion) continue;
        var np = cloneProjection(base);
        if (!applyProjectionAction(np, {
          type: 'move', cardId: a.cardId,
          fromRegionId: a.regionId, toRegionId: base.regions[r].id
        })) continue;
        var v = endgameProjectionValue(np, P);
        if (v > bestMoveVal) bestMoveVal = v;
      }
      var regret = bestMoveVal - baseVal;
      if (regret < bestRegret - 1e-9 ||
        (Math.abs(regret - bestRegret) <= 1e-9 && best && a.cardId < best.cardId)) {
        bestRegret = regret;
        best = a;
      }
    }
    return best;
  }

  /* 决战每回合「开局」：本回合必须包含恰好一次翻牌（保证摊牌必然推进），
   * 困难档在「先翻牌→再做 1 费行动」与「先做 1 费行动→再翻牌」两种顺序、以及翻哪张牌之间规划；
   * 中等档用简化版（明显有利的 1 费行动优先，否则先翻最少后悔的牌）。 */
  function chooseTurnOpening(state, playerId, mean, strength, P) {
    P = P || TRAINED[strength === 'hard' ? 'hard' : 'medium'];
    var legal = E.getLegalActions(state);
    var flips = [];
    var ones = [];
    var i;
    for (i = 0; i < legal.length; i++) {
      if (legal[i].type === 'flip') flips.push(legal[i]);
      else if (legal[i].type === 'place' || legal[i].type === 'move') ones.push(legal[i]);
    }
    if (!flips.length) return null;
    var base = buildEndgameProjection(state, playerId, mean, strength === 'hard');
    var baseVal = endgameProjectionValue(base, P);
    var scoredOnes = [];
    for (i = 0; i < ones.length; i++) {
      var np = cloneProjection(base);
      if (!applyProjectionAction(np, ones[i])) continue;
      scoredOnes.push({
        action: ones[i],
        proj: np,
        gain: endgameProjectionValue(np, P) + endgameTempo(ones[i], P) - baseVal
      });
    }
    scoredOnes.sort(function (x, y) { return y.gain - x.gain; });
    if (strength !== 'hard') {
      if (scoredOnes.length && scoredOnes[0].gain > 0.02) return scoredOnes[0].action;
      return chooseForcedFlip(state, playerId, mean, P);
    }
    var topOnes = scoredOnes.slice(0, 8);
    var flipTempo = endgameTempo({ type: 'flip' }, P);
    var bestAction = null;
    var bestScore = -Infinity;
    var fi, oi;
    for (fi = 0; fi < flips.length; fi++) {
      var f = flips[fi];
      // 顺序 A：先翻牌，再用剩余 1 点做最佳 1 费行动
      var afterFlip = cloneProjection(base);
      if (!applyProjectionAction(afterFlip, f)) continue;
      for (oi = 0; oi < topOnes.length; oi++) {
        var o = topOnes[oi];
        var pA = cloneProjection(afterFlip);
        if (!applyProjectionAction(pA, o.action)) continue;
        var sA = endgameProjectionValue(pA, P) + flipTempo + endgameTempo(o.action, P);
        if (sA > bestScore) { bestScore = sA; bestAction = f; }
      }
      // 顺序 B：先做 1 费行动，再翻牌
      for (oi = 0; oi < topOnes.length; oi++) {
        var o2 = topOnes[oi];
        var pB = cloneProjection(base);
        if (!applyProjectionAction(pB, o2.action)) continue;
        if (!applyProjectionAction(pB, f)) continue;
        var sB = endgameProjectionValue(pB, P) + endgameTempo(o2.action, P) + flipTempo;
        if (sB > bestScore) { bestScore = sB; bestAction = o2.action; }
      }
    }
    if (bestAction && bestAction.type === 'flip') return chooseForcedFlip(state, playerId, mean, P);
    if (bestAction) return bestAction;
    return chooseForcedFlip(state, playerId, mean, P);
  }

  function chooseEndgameHard(state, playerId, mean, P) {
    P = P || TRAINED.hard;
    var legal = E.getLegalActions(state);
    var costs = E.ACTION_COSTS || { flip: 2, place: 1, move: 1, end_turn: 0 };
    var ap = Number(state.players[playerId].ap) || 0;
    var apPerTurn = state.config.apPerTurn || E.AP_PER_TURN || 3;
    var hasFlip = false;
    var li;
    for (li = 0; li < legal.length; li++) if (legal[li].type === 'flip') { hasFlip = true; break; }
    // 每回合保证恰好翻一张牌（推进摊牌）；顺序与 1 费行动搭配做规划
    if (hasFlip && ap >= apPerTurn) {
      var openingH = chooseTurnOpening(state, playerId, mean, 'hard', P);
      if (openingH) return openingH;
    }
    if (hasFlip && ap === apPerTurn - 1) {
      var forcedH = chooseForcedFlip(state, playerId, mean, P);
      if (forcedH) return forcedH;
    }
    var base = buildEndgameProjection(state, playerId, mean, true);
    var baseVal = endgameProjectionValue(base, P);
    var firsts = [];
    var i, j;
    for (i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (a.type === 'end_turn') continue;
      var np = cloneProjection(base);
      if (!applyProjectionAction(np, a)) continue;
      var cost = a.cost != null ? a.cost : (costs[a.type] || 1);
      firsts.push({
        action: a,
        cost: cost,
        score: endgameProjectionValue(np, P) + endgameTempo(a, P),
        proj: np
      });
    }
    if (!firsts.length) return null;
    firsts.sort(function (x, y) { return y.score - x.score; });
    var top = firsts.slice(0, 6);
    var salt = (Number(state.config.seed) >>> 0) + '|' + state.turnCount + '|' + playerId;
    var bestAction = top[0].action;
    var bestPlan = -Infinity;
    for (i = 0; i < top.length; i++) {
      var f = top[i];
      var remain = ap - f.cost;
      var plan = f.score - baseVal;
      if (remain > 0) {
        var afterVal = endgameProjectionValue(f.proj, P);
        var seconds = endgameCandidatesFromProjection(f.proj, remain, costs);
        var bestSecond = 0;
        for (j = 0; j < seconds.length; j++) {
          var np2 = cloneProjection(f.proj);
          if (!applyProjectionAction(np2, seconds[j])) continue;
          var gain2 = endgameProjectionValue(np2, P) + endgameTempo(seconds[j], P) - afterVal;
          if (gain2 > bestSecond) bestSecond = gain2;
        }
        plan += (P.egFollowWeight != null ? P.egFollowWeight : 0.6) * bestSecond;
      }
      plan += noiseOf(f.action, salt) * P.waveAmp; // 波动（收敛后校准；训练期 0）
      if (plan > bestPlan) { bestPlan = plan; bestAction = f.action; }
    }
    return bestAction;
  }

  function chooseEndgameMedium(state, playerId, mean, P) {
    P = P || TRAINED.medium;
    var legal = E.getLegalActions(state);
    var ap = Number(state.players[playerId].ap) || 0;
    var apPerTurn = state.config.apPerTurn || E.AP_PER_TURN || 3;
    var hasFlip = false;
    var li;
    for (li = 0; li < legal.length; li++) if (legal[li].type === 'flip') { hasFlip = true; break; }
    if (hasFlip && ap >= apPerTurn) {
      var openingM = chooseTurnOpening(state, playerId, mean, 'medium', P);
      if (openingM) return openingM;
    }
    if (hasFlip && ap === apPerTurn - 1) {
      var forcedM = chooseForcedFlip(state, playerId, mean, P);
      if (forcedM) return forcedM;
    }
    var base = buildEndgameProjection(state, playerId, mean, false);
    var baseVal = endgameProjectionValue(base, P);
    var salt = (Number(state.config.seed) >>> 0) + '|' + state.turnCount + '|' + playerId;
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (a.type === 'end_turn') continue;
      var np = cloneProjection(base);
      if (!applyProjectionAction(np, a)) continue;
      var score = endgameProjectionValue(np, P) + endgameTempo(a, P) + noiseOf(a, salt) * P.waveAmp;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  /* 行动选择入口：战略决战「最终部署」分发到三档策略 */
  function chooseEndgameAction(state, playerId, strength, rng, P) {
    var legal = E.getLegalActions(state);
    if (!legal.length) return null;
    if (strength === 'easy') {
      // 简单档不使用移牌（保留随机翻牌/放牌，体感弱）
      var actionsOnly = legal.filter(function (a) { return a.type === 'flip' || a.type === 'place'; });
      if (!actionsOnly.length) return legal[legal.length - 1];
      if (rng.next() < P.epsilon) return actionsOnly[rng.int(actionsOnly.length)];
      // 简单档：偏好翻牌（保证推进），但仍有大量随机
      var flipsOnly = actionsOnly.filter(function (a) { return a.type === 'flip'; });
      if (flipsOnly.length && rng.next() < 0.7) return flipsOnly[rng.int(flipsOnly.length)];
      return actionsOnly[rng.int(actionsOnly.length)];
    }
    var unseen = E.getUnseenCards(state, playerId);
    var values = [];
    for (var ui = 0; ui < unseen.length; ui++) values.push(unseen[ui].value);
    var mean = average(values) || 7;
    var pick = strength === 'hard'
      ? chooseEndgameHard(state, playerId, mean, P)
      : chooseEndgameMedium(state, playerId, mean, P);
    if (!pick) pick = legal[legal.length - 1];
    return pick;
  }

  /* v1.4：把一次行动的估计效果应用到 board 副本，用于「本行动 + 剩余行动点后续行动」的两步规划 */
  function applyActionToBoard(state, playerId, action, board, evaluator, deckLen) {
    var nb = cloneBoard(board);
    var i;
    if (action.type === 'flip') {
      var card = findFaceDownCard(state, playerId, action.regionId, action.cardId);
      if (!card) return null;
      for (i = 0; i < nb.regions.length; i++) {
        if (nb.regions[i].id !== action.regionId) continue;
        nb.regions[i].diff += card.value;
        nb.regions[i].faceUpCount += 1;
        if (nb.regions[i].myHidden > 0) nb.regions[i].myHidden -= 1;
        break;
      }
      return nb;
    }
    if (action.type === 'place') {
      var hc = findHandCard(state, playerId, action.cardId);
      if (!hc) return null;
      for (i = 0; i < nb.regions.length; i++) {
        if (nb.regions[i].id !== action.regionId) continue;
        nb.regions[i].diff += hc.value * 0.35;
        nb.regions[i].myHidden += 1;
        break;
      }
      nb.handDiff -= hc.value;
      nb.handCountDiff -= 1;
      nb.myHandCount -= 1;
      nb.myHandSum -= hc.value;
      return nb;
    }
    if (action.type === 'move') {
      var mv = findFaceDownCard(state, playerId, action.fromRegionId, action.cardId);
      if (!mv) return null;
      var fromIdx = -1, toIdx = -1;
      for (i = 0; i < nb.regions.length; i++) {
        if (nb.regions[i].id === action.fromRegionId) fromIdx = i;
        else if (nb.regions[i].id === action.toRegionId) toIdx = i;
      }
      if (fromIdx < 0 || toIdx < 0) return null;
      var openCount = nb.regions.length || 1;
      var gap = deckLen - 2 * openCount;
      var pReveal = gap <= 3 ? 0.7 : (gap <= 10 ? 0.55 : 0.4);
      nb.regions[fromIdx].diff -= mv.value * pReveal;
      nb.regions[toIdx].diff += mv.value * pReveal;
      if (nb.regions[fromIdx].myHidden > 0) nb.regions[fromIdx].myHidden -= 1;
      nb.regions[toIdx].myHidden += 1;
      return nb;
    }
    if (action.type === 'draw') {
      var mean = evaluator.mean;
      nb.handDiff += mean;
      nb.handCountDiff += 1;
      nb.myHandCount += 1;
      return nb;
    }
    return null; // settle 消耗整回合（无后续）；end_turn 不会进入规划
  }

  /* 简单档行动选择：大噪声启发式 + epsilon 随机，但不使用 move、不主动浪费回合 */
  function chooseEasyBattle(state, playerId, legal, rng, P, noiseSalt) {
    var pool = legal.filter(function (a) { return a.type !== 'move'; });
    var real = pool.filter(function (a) { return a.type !== 'end_turn'; });
    if (!real.length) return legal[legal.length - 1] || null;
    var scored = [];
    for (var i = 0; i < real.length; i++) {
      scored.push({
        action: real[i],
        score: easyScore(state, playerId, real[i], rng, P) + noiseOf(real[i], noiseSalt) * P.actionNoise
      });
    }
    scored.sort(function (x, y) { return y.score - x.score; });
    if (rng.next() < P.epsilon) return real[rng.int(real.length)];
    // 波动：极小概率选次优（训练期 easy waveEps 固定很小；easy 的「波动」主要来自噪声）
    if (P.waveEps > 0 && scored.length > 1 && hashUnit(noiseSalt + '|eps') < P.waveEps) return scored[1].action;
    return scored[0].action;
  }

  function chooseAction(state, playerId, opts) {
    opts = opts || {};
    if (!state || state.phase !== 'battle' || state.turn !== playerId) return null;
    var legal = E.getLegalActions(state);
    if (!legal.length) return null;
    var rng = opts.rng || deriveRng(state, playerId, state.turnCount + 1);
    var strength = normalizeStrength(opts.strength || (state.config && state.config.aiStrength) || 'medium');
    // 内部/测试用：可分别覆盖战役与决战档位（不改变公开契约默认行为）
    var battleStrength = normalizeStrength(opts.battleStrength || strength);
    var endgameStrength = normalizeStrength(opts.endgameStrength || strength);
    var battleParams = resolveParams(battleStrength, opts);
    var endgameParams = resolveParams(endgameStrength, opts);
    var noiseSalt = (Number(state.config.seed) >>> 0) + '|' + state.turnCount + '|' + playerId;
    var i, cand;

    if (state.endgame && state.endgame.triggered && state.endgame.phase === 'build') {
      return chooseEndgameAction(state, playerId, endgameStrength, rng, endgameParams);
    }

    if (battleStrength === 'easy') {
      return chooseEasyBattle(state, playerId, legal, rng, battleParams, noiseSalt);
    }

    var N = state.config.settleCards || 2;
    var need = state.config.winsNeeded;
    var rule = (E.DIFFICULTIES[state.config.difficulty] || {}).rule || 'none';
    var deckLen = state.deck.length;
    var openCount = E.getOpenRegionIds(state).length;
    var gap = deckLen - 2 * openCount;
    var unseen = E.getUnseenCards(state, playerId);
    var unseenValues = new Array(unseen.length);
    for (i = 0; i < unseen.length; i++) unseenValues[i] = unseen[i].value;
    var evaluator = makeEvaluator(unseenValues, N, battleStrength, rng, !!battleParams.exactSettle);
    var board = buildBoard(state, playerId, evaluator);

    // 行动点（v1.4）：同一回合可用 3 点；不同行动消耗不同，需按「回合计划」比较，
    // 例如「结算 3 点」= 整回合，vs「放牌 1 点 + 后续 2 点行动」。
    var costs = (E.ACTION_COSTS || {});
    var ap = Number(state.players[playerId].ap) || 0;
    var candidates = [];
    var baseBoardWin = opponentReplyValue(board, evaluator, need, rule, battleParams);
    // 决战邻近投影上下文（hard 长期项）：deck-2*open 较小时把建设/移牌估值向最终决战盘面混合
    var projCtx = null;
    if (battleStrength === 'hard' && battleParams.planProjBlend > 0) {
      var pwBase = projectionBlendWeight(deckLen, openCount, battleParams);
      if (pwBase > 0) {
        var proj = buildEndgameProjection(state, playerId, evaluator.mean, true);
        projCtx = { base: proj, baseVal: endgameProjectionValue(proj, battleParams), weight: pwBase, P: battleParams };
      }
    }
    // 战役阶段移牌通常没有直接收益（移牌不改变正面总和），只有在明显正收益时才纳入候选，
    // 避免挤占结算/摸牌/翻放牌等真正推进对局的选择；决战 build 阶段另行处理（见 chooseEndgameAction）。
    for (i = 0; i < legal.length; i++) {
      cand = legal[i];
      if (cand.type === 'end_turn') continue;
      // v1.5 防拖延：上一回合已是「无有效行动/仅移牌」时，本回合避免再只移牌（否则会判负认输）
      if (cand.type === 'move' && state.players[playerId].stallCount >= 1) continue;
      var cost = cand.cost != null ? cand.cost : (costs[cand.type] || 1);
      // v3.0：hard 与 medium 共用「行动 → 对手最佳回应」估值（medium = hard-lite：
      // 精确补牌 DP + 单步对手回应，但没有整回合计划搜索；hard 额外做整回合计划搜索）。
      var score = hardActionValue(state, playerId, cand, board, evaluator, need, rule, deckLen, N, evaluator.mean, battleParams, projCtx);
      // 波动：在近最优解上叠加噪声（确定性 hash；训练期 0，收敛后按档位校准）
      score += noiseOf(cand, noiseSalt) * battleParams.waveAmp;
      if (cand.type === 'move' && score - baseBoardWin < battleParams.moveMinGain) continue;
      candidates.push({ action: cand, value: score, cost: cost });
    }
    if (!candidates.length) return legal[legal.length - 1] || null;

    if (battleStrength === 'hard') {
      // 困难档（v3.0）：**整回合计划搜索**——在 AP 预算内枚举 1~3 个建设行动组成回合计划，
      // 叶片用「行动 → 对手最佳回应」的盘面胜率估值；结算计划直接与建设计划在同一胜率尺度比较。
      // 这样 AP 分配、结算时机、先建设还是先结算按「回合结束时盘面价值」统一决策（长期规划）。
      var baseWin = baseBoardWin;
      var order = candidates.map(function (c, idx) { return idx; });
      order.sort(function (a, b) { return candidates[b].value - candidates[a].value; });
      var topIdx = order.slice(0, 5);
      var followIdx = order.slice(0, 8);
      var scoredPlans = [];
      for (var hi = 0; hi < topIdx.length; hi++) {
        var hc = candidates[topIdx[hi]];
        var planVal;
        var planSteps = 0;
        if (hc.action.type === 'settle') {
          // 结算消耗整回合：价值 = 结算后的期望胜率（已含对手回应/锁定/难度摸牌）
          planVal = hc.value;
        } else {
          var curBoard = applyActionToBoard(state, playerId, hc.action, board, evaluator, deckLen);
          if (!curBoard) continue;
          // 计划内已消耗的牌（手牌/背面牌）不能再次使用：模拟 applyActionToBoard 基于真实 state 取牌，
          // 若不去重，贪心扩展可能重复放同一张牌，虚高计划价值。
          var usedCards = {};
          if (hc.action.cardId) usedCards[hc.action.cardId] = true;
          var curVal = hc.value;
          var remain = ap - hc.cost;
          var steps = 0;
          while (remain > 0 && steps < 2) {
            var bestFollow = null, bestFollowVal = curVal;
            for (var fi = 0; fi < followIdx.length; fi++) {
              var fc = candidates[followIdx[fi]];
              if (fc.cost > remain) continue;
              if (fc.action === hc.action) continue;
              if (fc.action.cardId && usedCards[fc.action.cardId]) continue;
              var nb2 = applyActionToBoard(state, playerId, fc.action, curBoard, evaluator, deckLen);
              if (!nb2) continue;
              var v2 = hardActionValue(state, playerId, fc.action, curBoard, evaluator, need, rule,
                deckLen, N, evaluator.mean, battleParams, projCtx);
              if (v2 > bestFollowVal + 1e-9) { bestFollowVal = v2; bestFollow = fc; }
            }
            if (!bestFollow) break;
            curBoard = applyActionToBoard(state, playerId, bestFollow.action, curBoard, evaluator, deckLen);
            if (!curBoard) break;
            if (bestFollow.action.cardId) usedCards[bestFollow.action.cardId] = true;
            curVal = bestFollowVal;
            remain -= bestFollow.cost;
            steps++;
          }
          planSteps = 1 + steps;
          planVal = curVal + (battleParams.planTempo || 0) * planSteps;
        }
        scoredPlans.push({ action: hc.action, score: planVal, delta: planVal - baseWin });
      }
      scoredPlans.sort(function (a, b) { return b.score - a.score; });
      return pickWithWave(scoredPlans, battleParams, state, playerId, noiseSalt);
    }

    // medium：hard-lite —— 直接取单步估值最优（无整回合计划搜索），叠加较大波动
    candidates.sort(function (a, b) { return b.value - a.value; });
    return pickWithWave(candidates, battleParams, state, playerId, noiseSalt);
  }

  /* 波动：极小概率选次优（epsilon 式探索），训练期 waveEps=0 时恒选最优。
   * 随机源 = seed/turn/player 派生 hash，与隐藏信息无关；同一 seed 完全确定。 */
  function pickWithWave(sorted, P, state, playerId, noiseSalt) {
    if (!sorted.length) return null;
    if (P.waveEps > 0 && sorted.length > 1 && hashUnit(noiseSalt + '|eps') < P.waveEps) {
      // 安全护栏：不得因此选择 move（stallCount>=1 时）或非法行动
      var pick = sorted[1].action;
      if (pick.type === 'move' && state.players[playerId].stallCount >= 1) return sorted[0].action;
      return pick;
    }
    return sorted[0].action;
  }

  /* ------------------------------------------------------------------ *
   * 战前布局
   * ------------------------------------------------------------------ */
  function validLayout(hand, ids, R) {
    if (!Array.isArray(ids) || ids.length !== R) return false;
    var handIds = {};
    var used = {};
    for (var i = 0; i < hand.length; i++) handIds[hand[i].id] = true;
    for (var j = 0; j < ids.length; j++) {
      if (!handIds[ids[j]] || used[ids[j]]) return false;
      used[ids[j]] = true;
    }
    return true;
  }

  function mediumLayout(state, playerId, opts, rng) {
    var hand = state.players[playerId].hand.slice();
    var R = state.config.regionCount;
    var strategy = opts.layoutStrategy || 'balanced';
    if (LAYOUT_STRATEGIES.indexOf(strategy) < 0) strategy = 'balanced';
    var sorted = hand.slice().sort(function (a, b) {
      if (b.value !== a.value) return b.value - a.value;
      return a.id < b.id ? -1 : 1;
    });
    var chosen = [];
    var i;
    if (strategy === 'top') {
      chosen = sorted.slice(0, R);
    } else if (strategy === 'keep-high') {
      chosen = sorted.slice(1, R + 1);
    } else if (strategy === 'spread') {
      var lo = 0, hi = sorted.length - 1;
      while (chosen.length < R) {
        chosen.push(sorted[lo]);
        if (chosen.length < R) chosen.push(sorted[hi]);
        lo++;
        hi--;
      }
    } else {
      for (i = 0; i < R; i++) chosen.push(sorted[i * 2]);
    }
    if (chosen.length !== R) chosen = sorted.slice(0, R);
    var assign = chosen.slice();
    rng.shuffle(assign);
    return assign.map(function (c) { return c.id; });
  }

  function hardLayout(state, playerId, rng, P) {
    P = P || TRAINED.hard;
    var hand = state.players[playerId].hand;
    var R = state.config.regionCount;
    var N = state.config.settleCards || 2;
    var unseen = E.getUnseenCards(state, playerId);
    var unseenValues = new Array(unseen.length);
    for (var u = 0; u < unseen.length; u++) unseenValues[u] = unseen[u].value;
    var evaluator = makeEvaluator(unseenValues, N, 'hard', rng);
    // 对手布局牌的数值分布 ≈ 未知牌中随机一张
    var counts = new Array(VALUE_MAX + 1);
    var vi;
    for (vi = 0; vi <= VALUE_MAX; vi++) counts[vi] = 0;
    for (vi = 0; vi < unseenValues.length; vi++) counts[unseenValues[vi]]++;
    var totalOpp = unseenValues.length || 1;
    var pVal = new Array(VALUE_MAX + 1);
    for (vi = 1; vi <= VALUE_MAX; vi++) {
      var acc = 0;
      for (var oppV = 1; oppV <= VALUE_MAX; oppV++) {
        var w = counts[oppV];
        if (!w) continue;
        acc += (w / totalOpp) * evaluator.pWin(vi - oppV);
      }
      pVal[vi] = acc;
    }
    // 枚举 C(2R, R) 种选牌组合（R≤7，最多 3432 种）
    var bestIds = null;
    var bestScore = -Infinity;
    var current = [];
    var handLen = hand.length;
    function consider() {
      var score = 0;
      var used = {};
      var placedSum = 0;
      for (var k = 0; k < current.length; k++) {
        var card = hand[current[k]];
        used[current[k]] = true;
        score += pVal[card.value] * P.layoutPValCoef;
        placedSum += card.value;
      }
      var remainSum = 0;
      for (var t = 0; t < handLen; t++) if (!used[t]) remainSum += hand[t].value;
      // 手牌剩余总值只在无人提前锁定、最终比较手牌时有用 → 低权重
      score += remainSum * P.layoutRemainCoef;
      if (score > bestScore + 1e-12) {
        bestScore = score;
        bestIds = current.map(function (idx) { return hand[idx].id; });
      }
    }
    function walk(start) {
      if (current.length === R) { consider(); return; }
      var needCount = R - current.length;
      for (var i = start; i <= handLen - needCount; i++) {
        current.push(i);
        walk(i + 1);
        current.pop();
      }
    }
    walk(0);
    if (!bestIds) return mediumLayout(state, playerId, {}, rng);
    // 区域展示顺序随机（同一组牌对区域无差别）
    rng.shuffle(bestIds);
    return bestIds;
  }

  function chooseLayout(state, playerId, opts) {
    opts = opts || {};
    if (!state || state.phase !== 'layout') return [];
    if (state.layout.submitted[playerId]) return [];
    var rng = opts.rng || deriveRng(state, playerId, 7);
    var strength = normalizeStrength(opts.strength || (state.config && state.config.aiStrength) || 'medium');
    var P = resolveParams(strength, opts);
    var hand = state.players[playerId].hand;
    var R = state.config.regionCount;
    var fallback = hand.slice(0, R).map(function (c) { return c.id; });
    try {
      if (strength === 'easy') {
        var pool = hand.slice();
        // 简单档：大比例随机布局（保持明显弱）；layoutRandom<1 时混合 top 策略
        if (P.layoutRandom < 1 && rng.next() > P.layoutRandom) {
          var sortedEasy = pool.slice().sort(function (a, b) { return b.value - a.value; });
          var idsTop = sortedEasy.slice(0, R).map(function (c) { return c.id; });
          rng.shuffle(idsTop);
          return validLayout(hand, idsTop, R) ? idsTop : fallback;
        }
        rng.shuffle(pool);
        var ids = pool.slice(0, R).map(function (c) { return c.id; });
        return validLayout(hand, ids, R) ? ids : fallback;
      }
      if (strength === 'hard') {
        var hardIds = hardLayout(state, playerId, rng, P);
        return validLayout(hand, hardIds, R) ? hardIds : fallback;
      }
      var medIds = mediumLayout(state, playerId, opts.layoutStrategy ? opts : {}, rng);
      return validLayout(hand, medIds, R) ? medIds : fallback;
    } catch (err) {
      return fallback;
    }
  }

  return {
    VERSION: VERSION,
    LAYOUT_STRATEGIES: LAYOUT_STRATEGIES.slice(),
    chooseLayout: chooseLayout,
    chooseAction: chooseAction,
    /* 供自对弈/调参/测试使用 */
    _internals: {
      TRAINED: TRAINED,
      TRAINED_META: TRAINED_META,
      defaultParams: defaultParams,
      deriveRng: deriveRng,
      hashUnit: hashUnit,
      makeExactDelta: makeExactDelta,
      makeMonteDelta: makeMonteDelta,
      makeEvaluator: makeEvaluator,
      buildBoard: buildBoard,
      matchWin: matchWin,
      opponentReplyValue: opponentReplyValue,
      settleActionValue: settleActionValue,
      mediumActionScore: mediumActionScore,
      hardActionValue: hardActionValue,
      easyScore: easyScore,
      handTieWin: handTieWin,
      normalizeStrength: normalizeStrength,
      // v2.2 决战投影规划（测试用）
      buildEndgameProjection: buildEndgameProjection,
      cloneProjection: cloneProjection,
      endgameProjectionValue: endgameProjectionValue,
      applyProjectionAction: applyProjectionAction,
      endgameCandidatesFromProjection: endgameCandidatesFromProjection,
      chooseEndgameHard: chooseEndgameHard,
      chooseEndgameMedium: chooseEndgameMedium,
      chooseTurnOpening: chooseTurnOpening,
      chooseForcedFlip: chooseForcedFlip
    }
  };
});
