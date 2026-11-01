/* =========================================================================
 * 扑克牌 · 比大小 —— 电脑 AI（v2：三档难度 / 精确结算概率 / 回合成本评估）
 * 契约：docs/CONTRACT.md §6   规则：docs/RULES.md
 *
 * 设计要点：
 *  - easy（简单）：粗糙启发式 + 大随机扰动，会做出明显次优选择，但不非法。
 *  - medium（中等）：使用补牌胜率估计 + 区域胜场/锁定价值的稳健启发式。
 *  - hard（困难）：在 medium 基础上做「行动 → 对手最佳回应 → 静态胜率」的两层评估；
 *      精确计算「双方各补 N 张」的差值分布（按未知牌数值计数做 DP），评估：
 *        · 结算结果对胜场门槛/提前锁定的边际价值；
 *        · 难度规则（败者/胜者摸牌）的手牌与资源收益；
 *        · 结算消耗一回合的机会成本（对手获得下一行动）；
 *        · 手牌总和决胜（tie-break）的概率。
 *      最终只叠加极小幅随机扰动。
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

  var VERSION = '2.2.0';
  var LAYOUT_STRATEGIES = ['balanced', 'top', 'keep-high', 'spread'];
  var VALUE_MAX = 15;

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

  function makeEvaluator(values, N, strength, rng) {
    if (!values.length) {
      return {
        N: N, mean: 7.5, exact: false,
        pWin: function () { return 0.5; },
        pTie: function () { return 0; },
        pLose: function () { return 0.5; }
      };
    }
    if (strength === 'hard') {
      if (values.length >= 2 * N) return makeExactDelta(values, N);
      return makeMonteDelta(values, N, 240, rng);
    }
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
  function adjustedHandDiff(board, evaluator, rule) {
    var diff = board.handDiff;
    if (rule === 'none' || !board.regions.length) return diff;
    var mean = evaluator.mean;
    for (var i = 0; i < board.regions.length; i++) {
      var pWin = evaluator.pWin(board.regions[i].diff);
      var pTie = evaluator.pTie(board.regions[i].diff);
      var pLose = clamp(1 - pWin - pTie, 0, 1);
      if (rule === 'loser-draw') diff += mean * (pLose - pWin);
      else if (rule === 'winner-draw') diff += mean * (pWin - pLose);
    }
    return diff;
  }

  function handTieWin(diff, scale) {
    scale = scale || 10;
    return 1 / (1 + Math.exp(-diff / scale));
  }

  /* 若盘面所有未结算区域按当前补牌胜率结算，我方最终获胜概率 */
  function matchWin(board, evaluator, need, rule, hard) {
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
    var tieDiff = hard ? adjustedHandDiff(board, evaluator, rule) : board.handDiff;
    var tieWin = handTieWin(tieDiff, hard ? 9 : 11);
    var value = winMass + remaining * tieWin;
    if (hard) value += clamp(board.handCountDiff, -4, 4) * 0.004;
    return clamp(value, 0, 1);
  }

  /* ------------------------------------------------------------------ *
   * HARD：对手最佳回应（单层，对手也只拿到一次行动机会）
   * 返回：对手行动后，我方最终获胜概率（对手会尽量压低它）。
   * ------------------------------------------------------------------ */
  function opponentSettleOutcomesValue(board, index, evaluator, need, rule) {
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
      vOppWin = matchWin(b1, evaluator, need, rule, true);
    }
    // 平局
    var b2 = boardWithoutRegion(board, index);
    vTie = matchWin(b2, evaluator, need, rule, true);
    // 我方赢下该区域
    var b3 = boardWithoutRegion(board, index);
    b3.myWins += 1;
    if (b3.myWins >= need) vMyWin = 1;
    else {
      if (rule === 'loser-draw') { b3.handDiff -= mean; b3.handCountDiff -= 1; b3.oppHandCount += 1; }
      else if (rule === 'winner-draw') { b3.handDiff += mean; b3.handCountDiff += 1; b3.myHandCount += 1; }
      vMyWin = matchWin(b3, evaluator, need, rule, true);
    }
    return pOppWin * vOppWin + pTie * vTie + pMyWin * vMyWin;
  }

  function opponentReplyValue(board, evaluator, need, rule) {
    var best = matchWin(board, evaluator, need, rule, true); // 对手消极应对时的上限
    var i;
    // 1) 对手结算任意可结算区域
    for (i = 0; i < board.regions.length; i++) {
      if (!board.regions[i].enabled) continue;
      var v = opponentSettleOutcomesValue(board, i, evaluator, need, rule);
      if (v < best) best = v;
    }
    // 2) 对手翻牌/放牌提升某个区域（按其期望收益估计）
    var mean = evaluator.mean;
    for (i = 0; i < board.regions.length; i++) {
      var nb = cloneBoard(board);
      nb.regions[i].diff -= mean * 0.65; // 对手增加正面牌 / 未来翻牌
      var v2 = matchWin(nb, evaluator, need, rule, true);
      if (v2 < best) best = v2;
    }
    // 3) 对手摸牌（手牌总和与资源）
    var bd = cloneBoard(board);
    bd.handDiff -= mean;
    bd.handCountDiff -= 1;
    bd.oppHandCount += 1;
    var v3 = matchWin(bd, evaluator, need, rule, true);
    if (v3 < best) best = v3;
    return clamp(best, 0, 1);
  }

  function settleActionValue(board, index, evaluator, need, rule, deckLen, N) {
    var reg = board.regions[index];
    var pWin = evaluator.pWin(reg.diff);
    var pTie = evaluator.pTie(reg.diff);
    var pLose = clamp(1 - pWin - pTie, 0, 1);
    var mean = evaluator.mean;
    var openAfter = board.regions.length - 1;
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
        var endgame = openAfter === 0 || deckAfter <= 2 * openAfter;
        v = endgame ? matchWin(nb, evaluator, need, rule, true)
          : opponentReplyValue(nb, evaluator, need, rule);
      }
      total += kind.prob * v;
    }
    return total;
  }

  /* ------------------------------------------------------------------ *
   * HARD：行动估值
   * ------------------------------------------------------------------ */
  function hardActionValue(state, playerId, action, board, evaluator, need, rule, deckLen, N, mean) {
    var i;
    if (action.type === 'settle') {
      var idx = -1;
      for (i = 0; i < board.regions.length; i++) {
        if (board.regions[i].id === action.regionId) { idx = i; break; }
      }
      if (idx < 0) return -1;
      return settleActionValue(board, idx, evaluator, need, rule, deckLen, N);
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
      return opponentReplyValue(nbF, evaluator, need, rule);
    }
    if (action.type === 'place') {
      var hc = findHandCard(state, playerId, action.cardId);
      if (!hc) return -1;
      var nbP = cloneBoard(board);
      for (i = 0; i < nbP.regions.length; i++) {
        if (nbP.regions[i].id !== action.regionId) continue;
        nbP.regions[i].diff += hc.value * 0.35; // 背面牌需再翻牌才生效 → 折算潜力
        nbP.regions[i].myHidden += 1;
        break;
      }
      nbP.handDiff -= hc.value;
      nbP.handCountDiff -= 1;
      nbP.myHandCount -= 1;
      return opponentReplyValue(nbP, evaluator, need, rule);
    }
    if (action.type === 'draw') {
      var nbD = cloneBoard(board);
      nbD.handDiff += mean;
      nbD.handCountDiff += 1;
      nbD.myHandCount += 1;
      var deckAfter = deckLen - 1;
      var endgame = deckAfter <= 2 * board.regions.length;
      if (endgame) return matchWin(nbD, evaluator, need, rule, true);
      return opponentReplyValue(nbD, evaluator, need, rule);
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
      var pReveal = gap <= 3 ? 0.7 : (gap <= 10 ? 0.55 : 0.4);
      var nbM = cloneBoard(board);
      nbM.regions[fromIdx].diff -= mv.value * pReveal;
      nbM.regions[toIdx].diff += mv.value * pReveal;
      nbM.regions[fromIdx].myHidden -= 1;
      nbM.regions[toIdx].myHidden += 1;
      return clamp(opponentReplyValue(nbM, evaluator, need, rule) - 0.006, 0, 1);
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * MEDIUM：稳健启发式
   * ------------------------------------------------------------------ */
  function mediumActionScore(state, playerId, action, board, evaluator, need, rule, deckLen, N, gap) {
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
      var score = (2 * pWin + pTie - 1) + 0.10;
      if (pWin >= 0.65) score += 0.14;
      else if (pWin >= 0.55) score += 0.05;
      else if (pWin < 0.4) score -= 0.10;
      // 提前锁定：第 need 胜价值极高；反之送对手锁定要极力避免
      if (board.myWins + 1 >= need) score += pWin * 1.2;
      if (board.oppWins + 1 >= need) score -= pLose * 1.2;
      // 结算随机性：补牌越多，领先/落后越不确定 → 小幅降低过早结算意愿
      score -= 0.012 * (N - 1);
      // 难度规则：简单=败者摸牌（落后方结算有补偿）；困难=胜者摸牌（赢下结算滚雪球）
      if (rule === 'loser-draw') score += pLose * 0.12 - pWin * 0.03;
      else if (rule === 'winner-draw') score += pWin * 0.12 - pLose * 0.03;
      // 对手背牌可反超的风险；对手手牌多也更可能反超
      score -= reg.oppHidden * 0.015;
      // 行动成本（本回合若不结算可以继续建设）
      score -= 0.01;
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
      var scoreF = (pAfter - pBefore) * 1.15;
      // v1.4：任意区域可结算，翻牌的价值主要来自直接增加区域总和
      scoreF += 0.02;
      // 区域已可结算且我方领先：先别翻，以免对手用我方翻出的压力？通常仍可翻
      if (rf.oppHidden > 0 && pAfter > 0.55) scoreF -= 0.02;
      if (gap <= 2) scoreF += 0.02; // 决战临近：正面牌直接进入终局对比
      scoreF -= 0.012;
      return scoreF;
    }
    if (action.type === 'place') {
      var hc = findHandCard(state, playerId, action.cardId);
      if (!hc) return -1;
      var rp = null;
      for (i = 0; i < board.regions.length; i++) if (board.regions[i].id === action.regionId) rp = board.regions[i];
      if (!rp) return -1;
      var pF = evaluator.pWin(rp.diff + hc.value * 0.35);
      var scoreP = (pF - evaluator.pWin(rp.diff)) * 0.55;
      scoreP += 0.06; // 放牌是开启「翻牌→可结算」链条的必要建设
      scoreP -= hc.value * 0.004; // 手牌本身的价值（终局 tie-break / 后续资源）
      if (rp.enabled && evaluator.pWin(rp.diff) < 0.5) scoreP -= 0.05; // 对手可能抢先结算
      if (gap <= 2) scoreP *= 0.5;
      scoreP -= 0.01;
      return scoreP;
    }
    if (action.type === 'draw') {
      // 摸牌主要价值：手牌资源 + 终局手牌总和 tie-break（后者只在无人提前锁定时才生效，权重低）
      var diffAfter = board.handDiff + mean;
      var scoreD = (handTieWin(diffAfter, 11) - handTieWin(board.handDiff, 11)) * 0.12;
      scoreD -= 0.02;
      if (board.myHandCount === 0) scoreD += 0.10;
      if (board.myHandCount >= 8) scoreD -= 0.01;
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
      var pv = 0.45;
      var toGain = evaluator.pWin(toM.diff + mvM.value * pv) - evaluator.pWin(toM.diff);
      var fromLoss = evaluator.pWin(fromM.diff) - evaluator.pWin(fromM.diff - mvM.value * pv);
      return 0.55 * (toGain - fromLoss) - 0.02;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * EASY：粗糙 + 高噪声（会做出明显次优选择）
   * ------------------------------------------------------------------ */
  function easyScore(state, playerId, action, rng) {
    var noise = rng.next() * 0.55;
    if (action.type === 'settle') {
      var region = state.regions[action.regionId];
      var raw = 0;
      var opp = otherId(playerId);
      raw = sumFaceUp(region.sides[playerId].faceUp) - sumFaceUp(region.sides[opp].faceUp);
      // 忽略补牌分布/锁定价值/难度收益：只看当前分差 + 大随机
      return raw / 14 + noise - 0.12;
    }
    if (action.type === 'flip') return 0.06 + noise * 0.7;
    if (action.type === 'place') return 0.05 + noise * 0.7;
    if (action.type === 'move') return 0.04 + noise * 0.5;
    if (action.type === 'draw') return 0.07 + noise * 0.8;
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * 行动选择
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * 战略决战「最终部署」（v2.2 重写）
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
  var EG_FLIP_TEMPO = 0.03;
  var EG_PLACE_TEMPO = 0.01;
  var EG_MOVE_TEMPO = 0;
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

  /* 投影最终盘面 → 我方最终胜率（区域胜率 logistic + 胜场门槛 DP；平局给 0.25 权重） */
  function endgameProjectionValue(p) {
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
      var pw = logistic(diff / EG_SCALE);
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
    return clamp(winMass + 0.25 * drawMass, 0, 1);
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

  function endgameTempo(action) {
    if (action.type === 'flip') return EG_FLIP_TEMPO;
    if (action.type === 'place') return EG_PLACE_TEMPO;
    if (action.type === 'move') return EG_MOVE_TEMPO;
    if (action.type === 'end_turn') return -0.05;
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
  function chooseForcedFlip(state, playerId, mean) {
    var legal = E.getLegalActions(state);
    var flips = [];
    var i;
    for (i = 0; i < legal.length; i++) if (legal[i].type === 'flip') flips.push(legal[i]);
    if (!flips.length) return null;
    var base = buildEndgameProjection(state, playerId, mean, true);
    var baseVal = endgameProjectionValue(base);
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
        var v = endgameProjectionValue(np);
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
  function chooseTurnOpening(state, playerId, mean, strength) {
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
    var baseVal = endgameProjectionValue(base);
    var scoredOnes = [];
    for (i = 0; i < ones.length; i++) {
      var np = cloneProjection(base);
      if (!applyProjectionAction(np, ones[i])) continue;
      scoredOnes.push({
        action: ones[i],
        proj: np,
        gain: endgameProjectionValue(np) + endgameTempo(ones[i]) - baseVal
      });
    }
    scoredOnes.sort(function (x, y) { return y.gain - x.gain; });
    if (strength !== 'hard') {
      if (scoredOnes.length && scoredOnes[0].gain > 0.02) return scoredOnes[0].action;
      return chooseForcedFlip(state, playerId, mean);
    }
    var topOnes = scoredOnes.slice(0, 8);
    var flipTempo = endgameTempo({ type: 'flip' });
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
        var sA = endgameProjectionValue(pA) + flipTempo + endgameTempo(o.action);
        if (sA > bestScore) { bestScore = sA; bestAction = f; }
      }
      // 顺序 B：先做 1 费行动，再翻牌
      for (oi = 0; oi < topOnes.length; oi++) {
        var o2 = topOnes[oi];
        var pB = cloneProjection(base);
        if (!applyProjectionAction(pB, o2.action)) continue;
        if (!applyProjectionAction(pB, f)) continue;
        var sB = endgameProjectionValue(pB) + endgameTempo(o2.action) + flipTempo;
        if (sB > bestScore) { bestScore = sB; bestAction = o2.action; }
      }
    }
    if (bestAction && bestAction.type === 'flip') return chooseForcedFlip(state, playerId, mean);
    if (bestAction) return bestAction;
    return chooseForcedFlip(state, playerId, mean);
  }

  function chooseEndgameHard(state, playerId, mean) {
    var legal = E.getLegalActions(state);
    var costs = E.ACTION_COSTS || { flip: 2, place: 1, move: 1, end_turn: 0 };
    var ap = Number(state.players[playerId].ap) || 0;
    var apPerTurn = state.config.apPerTurn || E.AP_PER_TURN || 3;
    var hasFlip = false;
    var li;
    for (li = 0; li < legal.length; li++) if (legal[li].type === 'flip') { hasFlip = true; break; }
    // 每回合保证恰好翻一张牌（推进摊牌）；顺序与 1 费行动搭配做规划
    if (hasFlip && ap >= apPerTurn) {
      var openingH = chooseTurnOpening(state, playerId, mean, 'hard');
      if (openingH) return openingH;
    }
    if (hasFlip && ap === apPerTurn - 1) {
      var forcedH = chooseForcedFlip(state, playerId, mean);
      if (forcedH) return forcedH;
    }
    var base = buildEndgameProjection(state, playerId, mean, true);
    var baseVal = endgameProjectionValue(base);
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
        score: endgameProjectionValue(np) + endgameTempo(a),
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
        var afterVal = endgameProjectionValue(f.proj);
        var seconds = endgameCandidatesFromProjection(f.proj, remain, costs);
        var bestSecond = 0;
        for (j = 0; j < seconds.length; j++) {
          var np2 = cloneProjection(f.proj);
          if (!applyProjectionAction(np2, seconds[j])) continue;
          var gain2 = endgameProjectionValue(np2) + endgameTempo(seconds[j]) - afterVal;
          if (gain2 > bestSecond) bestSecond = gain2;
        }
        plan += 0.6 * bestSecond;
      }
      plan += noiseOf(f.action, salt) * 0.004; // 近似同分时的确定性抖动
      if (plan > bestPlan) { bestPlan = plan; bestAction = f.action; }
    }
    return bestAction;
  }

  function chooseEndgameMedium(state, playerId, mean) {
    var legal = E.getLegalActions(state);
    var ap = Number(state.players[playerId].ap) || 0;
    var apPerTurn = state.config.apPerTurn || E.AP_PER_TURN || 3;
    var hasFlip = false;
    var li;
    for (li = 0; li < legal.length; li++) if (legal[li].type === 'flip') { hasFlip = true; break; }
    if (hasFlip && ap >= apPerTurn) {
      var openingM = chooseTurnOpening(state, playerId, mean, 'medium');
      if (openingM) return openingM;
    }
    if (hasFlip && ap === apPerTurn - 1) {
      var forcedM = chooseForcedFlip(state, playerId, mean);
      if (forcedM) return forcedM;
    }
    var base = buildEndgameProjection(state, playerId, mean, false);
    var baseVal = endgameProjectionValue(base);
    var salt = (Number(state.config.seed) >>> 0) + '|' + state.turnCount + '|' + playerId;
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (a.type === 'end_turn') continue;
      var np = cloneProjection(base);
      if (!applyProjectionAction(np, a)) continue;
      var score = endgameProjectionValue(np) + endgameTempo(a) + noiseOf(a, salt) * 0.02;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  /* 行动选择入口：战略决战「最终部署」分发到三档策略 */
  function chooseEndgameAction(state, playerId, strength, rng) {
    var legal = E.getLegalActions(state);
    if (!legal.length) return null;
    if (strength === 'easy') {
      // 简单档不使用移牌（保留随机翻牌/放牌，体感弱）
      var actionsOnly = legal.filter(function (a) { return a.type === 'flip' || a.type === 'place'; });
      if (!actionsOnly.length) return legal[legal.length - 1];
      return actionsOnly[rng.int(actionsOnly.length)];
    }
    var unseen = E.getUnseenCards(state, playerId);
    var values = [];
    for (var ui = 0; ui < unseen.length; ui++) values.push(unseen[ui].value);
    var mean = average(values) || 7;
    var pick = strength === 'hard'
      ? chooseEndgameHard(state, playerId, mean)
      : chooseEndgameMedium(state, playerId, mean);
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
    var noiseSalt = (Number(state.config.seed) >>> 0) + '|' + state.turnCount + '|' + playerId;
    var i, cand;

    if (state.endgame && state.endgame.triggered && state.endgame.phase === 'build') {
      return chooseEndgameAction(state, playerId, endgameStrength, rng);
    }

    if (battleStrength === 'easy') {
      // 小概率完全乱选，放大了「体感弱」；极小概率直接结束回合（浪费行动点）
      // 不用「移牌」：移牌不消耗牌，随机/循环使用会导致对局无法推进
      var easyPool = legal.filter(function (a) { return a.type !== 'move'; });
      if (!easyPool.length) return legal[legal.length - 1];
      if (rng.next() < 0.18) return easyPool[rng.int(easyPool.length)];
      if (rng.next() < 0.06) return legal[legal.length - 1]; // 通常 end_turn 在列表末尾
      var bestEasy = easyPool[0];
      var bestEasyScore = -Infinity;
      for (i = 0; i < easyPool.length; i++) {
        if (easyPool[i].type === 'end_turn') continue;
        var se = easyScore(state, playerId, easyPool[i], rng) + noiseOf(easyPool[i], noiseSalt) * 0.35;
        if (se > bestEasyScore) { bestEasyScore = se; bestEasy = easyPool[i]; }
      }
      if (rng.next() < 0.12) return easyPool[rng.int(easyPool.length)];
      return bestEasy;
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
    var evaluator = makeEvaluator(unseenValues, N, battleStrength, rng);
    var board = buildBoard(state, playerId, evaluator);

    // 行动点（v1.4）：同一回合可用 3 点；不同行动消耗不同，需按「回合计划」比较，
    // 例如「结算 3 点」= 整回合，vs「放牌 1 点 + 后续 2 点行动」。
    var costs = (E.ACTION_COSTS || {});
    var ap = Number(state.players[playerId].ap) || 0;
    var candidates = [];
    // 战役阶段移牌通常没有直接收益（移牌不改变正面总和），只有在明显正收益时才纳入候选，
    // 避免挤占结算/摸牌/翻放牌等真正推进对局的选择；决战 build 阶段另行处理（见 chooseEndgameAction）。
    var baseBoardWin = opponentReplyValue(board, evaluator, need, rule);
    for (i = 0; i < legal.length; i++) {
      cand = legal[i];
      if (cand.type === 'end_turn') continue;
      // v1.5 防拖延：上一回合已是「无有效行动/仅移牌」时，本回合避免再只移牌（否则会判负认输）
      if (cand.type === 'move' && state.players[playerId].stallCount >= 1) continue;
      var cost = cand.cost != null ? cand.cost : (costs[cand.type] || 1);
      var score;
      if (battleStrength === 'hard') {
        score = hardActionValue(state, playerId, cand, board, evaluator, need, rule, deckLen, N, evaluator.mean);
        // 在近最优解上叠加极小幅随机扰动（保持确定性随机源；不改变明显正确的选择）
        score += (rng.next() - 0.5) * 0.02 + noiseOf(cand, noiseSalt) * 0.004;
        if (cand.type === 'move' && score - baseBoardWin < 0.02) continue;
      } else {
        score = mediumActionScore(state, playerId, cand, board, evaluator, need, rule, deckLen, N, gap);
        score += noiseOf(cand, noiseSalt) * 0.06;
        if (cand.type === 'move' && score < 0.02) continue;
      }
      candidates.push({ action: cand, value: score, cost: cost });
    }
    if (!candidates.length) return legal[legal.length - 1] || null;

    if (battleStrength === 'hard') {
      // 困难档：两步规划——「本行动 + 剩余行动点内最佳后续行动」，以行动前的期望胜率为基线比较增量
      var baseWin = baseBoardWin;
      var order = candidates.map(function (c, idx) { return idx; });
      order.sort(function (a, b) { return candidates[b].value - candidates[a].value; });
      var topIdx = order.slice(0, 5);
      var followIdx = order.slice(0, 7);
      var bestH = candidates[0].action;
      var bestHPlan = -Infinity;
      for (var hi = 0; hi < topIdx.length; hi++) {
        var hc = candidates[topIdx[hi]];
        var deltaH = clamp(hc.value - baseWin, -1, 1);
        var planH = deltaH;
        var remainH = ap - hc.cost;
        if (remainH > 0) {
          var nbH = applyActionToBoard(state, playerId, hc.action, board, evaluator, deckLen);
          if (nbH) {
            var baseAfter = opponentReplyValue(nbH, evaluator, need, rule);
            var bestFollowDelta = 0;
            for (var fi = 0; fi < followIdx.length; fi++) {
              if (followIdx[fi] === topIdx[hi]) continue;
              var fc = candidates[followIdx[fi]];
              if (fc.cost > remainH) continue;
              var fv = hardActionValue(state, playerId, fc.action, nbH, evaluator, need, rule, deckLen, N, evaluator.mean);
              var fd = clamp(fv - baseAfter, -1, 1);
              if (fd > bestFollowDelta) bestFollowDelta = fd;
            }
            planH += 0.6 * bestFollowDelta;
          }
        }
        if (planH > bestHPlan) { bestHPlan = planH; bestH = hc.action; }
      }
      return bestH;
    }

    var best = candidates[0].action;
    var bestPlan = -Infinity;
    for (i = 0; i < candidates.length; i++) {
      var cur = candidates[i];
      if (cur.value > bestPlan) { bestPlan = cur.value; best = cur.action; }
    }
    return best;
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

  function hardLayout(state, playerId, rng) {
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
        score += pVal[card.value];
        placedSum += card.value;
      }
      var remainSum = 0;
      for (var t = 0; t < handLen; t++) if (!used[t]) remainSum += hand[t].value;
      // 手牌剩余总值只在无人提前锁定、最终比较手牌时有用 → 低权重
      score += remainSum * 0.0015;
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
    var hand = state.players[playerId].hand;
    var R = state.config.regionCount;
    var fallback = hand.slice(0, R).map(function (c) { return c.id; });
    try {
      if (strength === 'easy') {
        var pool = hand.slice();
        rng.shuffle(pool);
        var ids = pool.slice(0, R).map(function (c) { return c.id; });
        return validLayout(hand, ids, R) ? ids : fallback;
      }
      if (strength === 'hard') {
        var hardIds = hardLayout(state, playerId, rng);
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
