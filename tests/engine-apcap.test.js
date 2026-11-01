'use strict';
/*
 * v1.7 战略决战行动点上限规则测试（task-147）
 * 规则：endgame build 阶段结束回合时，leftAp>0 → 该玩家 apCap-1；
 *       leftAp==0 → apCap+1（最高 3）；apCap 降至 0 → 该玩家 forfeit（reason 可区分）。
 * flag=false 必须保持 v1.6 行为（不产生 apCap 字段/事件/日志差异）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));
const h = require(path.join(ROOT, 'tests', 'helpers.js'));

function makeEndgame(opts) {
  opts = opts || {};
  const R = opts.regionCount || 5;
  const flag = opts.rule !== false;
  const state = E.createGame(E.defaultConfig({
    seed: opts.seed || 20261028,
    regionCount: R,
    settleCards: 2,
    difficulty: 2,
    firstPlayer: 'p1',
    endgameApCapRule: flag
  }));
  const ids = (pid) => state.players[pid].hand.slice(0, R).map((c) => c.id);
  E.submitLayout(state, 'p1', ids('p1'));
  E.submitLayout(state, 'p2', ids('p2'));
  E.finalizeLayout(state);
  // 强制进入战略决战 build（不改变卡牌/区域，只切换阶段与行动方）
  state.phase = 'battle';
  state.endgame.triggered = true;
  state.endgame.phase = 'build';
  state.endgame.threshold = 2 * R;
  state.endgame.settleCards = 2;
  state.endgame.drawPerPlayer = R;
  state.endgame.drawnCounts = { p1: 0, p2: 0 };
  state.endgame.skipped = { p1: false, p2: false };
  state.turn = 'p1';
  state.players.p1.ap = opts.ap == null ? 3 : opts.ap;
  if (flag) state.players.p1.apCap = opts.cap == null ? 3 : opts.cap;
  state.turnProgress = { count: 0, productive: 0 };
  return state;
}

function endTurnAction(state) {
  const a = E.getLegalActions(state).find((x) => x.type === 'end_turn');
  assert.ok(a, '应始终有 end_turn');
  return a;
}

test('v1.7 config：endgameApCapRule 默认开启，显式 false 关闭；apCap 初始 3', () => {
  assert.strictEqual(E.VERSION, '1.7.0');
  const on = E.defaultConfig({ seed: 1 });
  assert.strictEqual(on.endgameApCapRule, true);
  assert.strictEqual(on.apPerTurn, 3);
  const off = E.defaultConfig({ seed: 1, endgameApCapRule: false });
  assert.strictEqual(off.endgameApCapRule, false);

  const sOn = E.createGame(on);
  assert.strictEqual(sOn.players.p1.apCap, 3);
  assert.strictEqual(sOn.players.p2.apCap, 3);

  const sOff = E.createGame(off);
  assert.ok(!Object.prototype.hasOwnProperty.call(sOff.players.p1, 'apCap'), 'flag=false 不应新增 apCap 状态字段');
  assert.ok(!Object.prototype.hasOwnProperty.call(sOff.players.p2, 'apCap'));
});

test('v1.7 endgame build：leftAp>0 → apCap-1；turn_end 字段/日志/下一回合 AP', () => {
  const s = makeEndgame({ cap: 3, ap: 2 });
  const events = E.performAction(s, endTurnAction(s));
  const te = events.find((e) => e.type === 'turn_end');
  assert.deepStrictEqual({ playerId: te.playerId, reason: te.reason, leftAp: te.leftAp }, { playerId: 'p1', reason: 'manual', leftAp: 2 });
  assert.strictEqual(te.apCapBefore, 3);
  assert.strictEqual(te.apCapAfter, 2);
  assert.strictEqual(s.players.p1.apCap, 2, '未花费 AP → 上限 -1');
  assert.strictEqual(s.phase, 'battle');
  assert.strictEqual(s.turn, 'p2');
  assert.strictEqual(s.players.p2.ap, 3, '对手新回合 AP=3（其 cap 尚未降低）');
  assert.ok(s.log.some((l) => /战略决战行动点上限 3 → 2/.test(l.text)), '应有上限变化日志');
});

test('v1.7 endgame build：leftAp==0 → apCap+1；最高恢复到 3', () => {
  const s = makeEndgame({ cap: 2, ap: 0 });
  const events = E.performAction(s, endTurnAction(s));
  const te = events.find((e) => e.type === 'turn_end');
  assert.strictEqual(te.leftAp, 0);
  assert.strictEqual(te.apCapBefore, 2);
  assert.strictEqual(te.apCapAfter, 3);
  assert.strictEqual(s.players.p1.apCap, 3);

  const s2 = makeEndgame({ cap: 3, ap: 0 });
  E.performAction(s2, endTurnAction(s2));
  assert.strictEqual(s2.players.p1.apCap, 3, '上限不能超过 3');
});

test('v1.7 endgame build：下一自己的回合按 apCap 回复（不是固定 3）', () => {
  const s = makeEndgame({ cap: 3, ap: 2 });
  E.performAction(s, endTurnAction(s)); // p1 结束，cap 3→2，轮到 p2
  assert.strictEqual(s.turn, 'p2');
  const p2End = E.getLegalActions(s).find((a) => a.type === 'end_turn');
  const events2 = E.performAction(s, p2End); // p2 有剩 AP，cap3→2；回到 p1
  assert.strictEqual(s.turn, 'p1');
  assert.strictEqual(s.players.p1.ap, 2, 'p1 新回合 AP 应等于其 apCap=2');
  const p1Start = events2.find((e) => e.type === 'turn_start' && e.playerId === 'p1');
  assert.ok(p1Start);
  assert.strictEqual(p1Start.ap, 2);
  assert.strictEqual(p1Start.apCap, 2);
});

test('v1.7 endgame build：apCap 降至 0 → 该玩家 forfeit，result 可区分原因', () => {
  const s = makeEndgame({ cap: 1, ap: 3 });
  const events = E.performAction(s, endTurnAction(s));
  assert.strictEqual(s.phase, 'gameover');
  assert.strictEqual(s.turn, null);
  assert.ok(s.result, '应有 result');
  assert.strictEqual(s.result.winner, 'p2');
  assert.strictEqual(s.result.reason, 'forfeit');
  assert.strictEqual(s.result.forfeitedBy, 'p1');
  assert.strictEqual(s.result.forfeitReason, 'ap-cap-zero');
  assert.strictEqual(s.players.p1.ap, 0);
  assert.strictEqual(s.players.p1.apCap, 0);
  assert.strictEqual(s.endgame.phase, 'done');
  const forfeitEv = events.find((e) => e.type === 'forfeit');
  assert.ok(forfeitEv);
  assert.strictEqual(forfeitEv.playerId, 'p1');
  assert.strictEqual(forfeitEv.reason, 'ap-cap-zero');
  const go = events.find((e) => e.type === 'game_over');
  assert.ok(go);
  assert.strictEqual(go.result.reason, 'forfeit');
  assert.strictEqual(go.result.forfeitReason, 'ap-cap-zero');
  assert.deepStrictEqual(E.getLegalActions(s), []);
});

test('v1.7 修正：no-action 强制结束不改变 apCap（无牌可动不惩罚）', () => {
  const s = makeEndgame({ cap: 3, ap: 3 });
  // p1 手牌清空，只留 1 张背面牌；翻掉最后一张后无任何非 end_turn 行动 →
  // endgameAfterAction 以 reason='no-action' 强制结束回合。
  const card = s.players.p1.hand.pop();
  s.players.p1.hand = [];
  s.regions[0].sides.p1.faceDown.push(card);
  const flip = E.getLegalActions(s).find((a) => a.type === 'flip');
  assert.ok(flip, '应有最后一张背面牌可翻');
  const events = E.performAction(s, flip);
  const te = events.find((e) => e.type === 'turn_end');
  assert.ok(te);
  assert.strictEqual(te.reason, 'no-action');
  assert.ok(!Object.prototype.hasOwnProperty.call(te, 'apCapBefore'), 'no-action 不应输出 cap 字段');
  assert.strictEqual(s.players.p1.apCap, 3, 'no-action 不应改变 apCap');
  assert.ok(!s.log.some((l) => /战略决战行动点上限 \d/.test(l.text)), 'no-action 不应有新规则日志');
});

test('v1.7 普通战役不受影响：不结算 apCap、不产生新字段', () => {
  const s = E.createGame(E.defaultConfig({ seed: 7, firstPlayer: 'p1' }));
  const ids = (pid) => s.players[pid].hand.slice(0, s.config.regionCount).map((c) => c.id);
  E.submitLayout(s, 'p1', ids('p1'));
  E.submitLayout(s, 'p2', ids('p2'));
  E.finalizeLayout(s);
  assert.strictEqual(s.endgame.triggered, false);
  s.turn = 'p1';
  s.players.p1.ap = 2;
  s.turnProgress = { count: 0, productive: 0 };
  const beforeCap = s.players.p1.apCap;
  const events = E.performAction(s, E.getLegalActions(s).find((a) => a.type === 'end_turn'));
  const te = events.find((e) => e.type === 'turn_end');
  assert.strictEqual(te.leftAp, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(te, 'apCapBefore'), '大战役 turn_end 不应带 apCap 字段');
  assert.strictEqual(s.players.p1.apCap, beforeCap);
  assert.strictEqual(s.turn, 'p2');
  assert.strictEqual(s.players.p2.ap, 3);
});

test('v1.7 flag=false：与 v1.6 旧行为一致（无 apCap 字段/事件/日志）', () => {
  const s = makeEndgame({ rule: false, ap: 2 });
  const events = E.performAction(s, endTurnAction(s));
  const te = events.find((e) => e.type === 'turn_end');
  assert.deepStrictEqual(te, { type: 'turn_end', playerId: 'p1', reason: 'manual', leftAp: 2 });
  assert.ok(!Object.prototype.hasOwnProperty.call(s.players.p1, 'apCap'));
  assert.strictEqual(s.turn, 'p2');
  assert.strictEqual(s.players.p2.ap, 3, '旧规则：下一回合 AP 仍为 apPerTurn=3');
  assert.ok(!events.some((e) => e.type === 'forfeit' || e.type === 'game_over'));
  assert.ok(!events.some((e) => e.type === 'turn_start' && 'apCap' in e));
  assert.ok(!s.log.some((l) => /行动点上限/.test(l.text)), 'flag=false 不应有新增规则日志');
});

test('v1.7 确定性：同 seed 同 flag 的 AP 上限轨迹一致', () => {
  const a = makeEndgame({ cap: 3, ap: 1 });
  const b = makeEndgame({ cap: 3, ap: 1 });
  const ea = E.performAction(a, endTurnAction(a));
  const eb = E.performAction(b, endTurnAction(b));
  assert.strictEqual(JSON.stringify(ea), JSON.stringify(eb));
  assert.strictEqual(a.players.p1.apCap, b.players.p1.apCap);
  assert.strictEqual(a.players.p1.apCap, 2);
});

test('v1.7 全流程 24 局（canon6 × 2 seed × flag on/off）：无异常、无非法动作、局面不变量', () => {
  const configs = [
    { regionCount: 3, settleCards: 1, difficulty: 1 },
    { regionCount: 3, settleCards: 2, difficulty: 2 },
    { regionCount: 5, settleCards: 1, difficulty: 2 },
    { regionCount: 5, settleCards: 2, difficulty: 1 },
    { regionCount: 7, settleCards: 2, difficulty: 2 },
    { regionCount: 7, settleCards: 4, difficulty: 3 }
  ];
  let games = 0;
  for (const rule of [true, false]) {
    for (let ci = 0; ci < configs.length; ci++) {
      for (let si = 1; si <= 2; si++) {
        const c = configs[ci];
        const seed = 4100 + ci * 17 + si * 3;
        const state = E.createGame(E.defaultConfig(Object.assign({}, c, {
          seed,
          firstPlayer: 'random',
          aiStrength: 'hard',
          endgameApCapRule: rule
        })));
        const R = state.config.regionCount;
        E.submitLayout(state, 'p1', state.players.p1.hand.slice(0, R).map((x) => x.id));
        E.submitLayout(state, 'p2', state.players.p2.hand.slice(0, R).map((x) => x.id));
        E.finalizeLayout(state);
        let guard = 0;
        while (!E.isGameOver(state) && guard++ < 4000) {
          const legal = E.getLegalActions(state);
          assert.ok(legal.length > 0, 'battle 应有合法行动 seed=' + seed);
          const action = h.pickAction(E, state, legal, {
            prefer: ['settle', 'place', 'flip', 'move', 'draw', 'end_turn'],
            index: seed + guard
          });
          assert.ok(legal.some((x) => JSON.stringify(x) === JSON.stringify(action)), '策略行动必须合法');
          E.performAction(state, action);
        }
        assert.ok(E.isGameOver(state), '全流程应在 guard 内结束 seed=' + seed);
        h.assertInvariants(E, state, 'apcap sim seed=' + seed + ' rule=' + rule);
        games++;
      }
    }
  }
  assert.strictEqual(games, 24);
});
