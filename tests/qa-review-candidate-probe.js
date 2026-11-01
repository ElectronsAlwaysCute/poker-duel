'use strict';
/* task-115 QA 独立复核：候选行为/确定性/信息公平/stall-forfeit/性能（每决策与每局） */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/GAME/poker-duel';
const E = require(path.join(ROOT, 'js/engine.js'));
const CANON6 = require(path.join(ROOT, 'tools/ai-benchmark.js')).CANON6_CONFIGS;
const CAND = require(path.join(ROOT, 'tools/tmp-v28/medium/cand-medium-pure-v1.js'));
const BASE = require(path.join(ROOT, 'tools/tmp-v28/medium/base-ai3.js'));
const PURE = require(path.join(ROOT, 'tools/tmp-v28/medium/pure-safe-v1.js'));
function keyOf(a) { return JSON.stringify(a || null); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function play(mod, seed, cfg, collectTimes) {
  const st = E.createGame(E.defaultConfig({ regionCount: cfg.regionCount, settleCards: cfg.settleCards, difficulty: cfg.difficulty, firstPlayer: 'random', seed }));
  E.submitLayout(st, 'p1', mod.chooseLayout(st, 'p1', { strength: 'hard', rng: E.makeRng(seed ^ 0x1111) }));
  E.submitLayout(st, 'p2', mod.chooseLayout(st, 'p2', { strength: 'hard', rng: E.makeRng(seed ^ 0x2222) }));
  E.finalizeLayout(st);
  const times = []; let guard = 0, seq = [];
  while (!E.isGameOver(st) && guard++ < 8000) {
    const legal = E.getLegalActions(st);
    if (!legal.length) break;
    const t0 = process.hrtime.bigint();
    const a = mod.chooseAction(st, st.turn, { strength: 'hard' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (collectTimes) times.push(ms);
    const m = legal.find((l) => keyOf(l) === keyOf(a));
    if (!m) return { err: 'illegal' };
    seq.push(keyOf(m));
    E.performAction(st, m);
  }
  if (!E.isGameOver(st)) return { err: 'unfinished' };
  return { seq, times, result: st.result, forfeit: st.result.reason === 'forfeit', illegal: 0 };
}
function q(sorted, p) { if (!sorted.length) return null; return +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3); }
const out = { generatedAt: new Date().toISOString(), versions: { cand: CAND.VERSION, base: BASE.VERSION, pure: PURE.VERSION }, players: {}, determinism: {}, fairness: {}, perDecisionMs: {}, perGameMs: {} };
// 20 局每模块用于行为/确定性/性能
for (const [name, mod] of [['cand', CAND], ['base', BASE], ['pure', PURE]]) {
  const results = [];
  const gameTimes = [];
  for (let i = 0; i < 20; i++) {
    const cfg = CANON6[i % CANON6.length];
    const seed = 930000 + i;
    const t0 = process.hrtime.bigint();
    const r = play(mod, seed, cfg, true);
    gameTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    results.push(r);
  }
  const times = [];
  for (const r of results) if (r.times) times.push(...r.times);
  const ts = times.slice().sort((a, b) => a - b);
  const gs = gameTimes.slice().sort((a, b) => a - b);
  out.perDecisionMs[name] = { n: ts.length, p50: q(ts, 0.5), p95: q(ts, 0.95), p99: q(ts, 0.99), max: ts.length ? +ts[ts.length - 1].toFixed(3) : null };
  out.perGameMs[name] = { n: gs.length, p50: q(gs, 0.5), p95: q(gs, 0.95), p99: q(gs, 0.99), max: gs.length ? +gs[gs.length - 1].toFixed(3) : null };
  out.players[name] = { games: results.length, illegal: results.filter((r) => r.err === 'illegal').length, unfinished: results.filter((r) => r.err === 'unfinished').length, forfeits: results.filter((r) => r.forfeit).length, draws: results.filter((r) => r.result && r.result.winner === 'draw').length };
}
// 确定性：同 seed 两次结果/序列一致（候选与基座）
for (const [name, mod] of [['cand', CAND], ['base', BASE]]) {
  const cfg = CANON6[3];
  const a = play(mod, 930123, cfg, false), b = play(mod, 930123, cfg, false);
  out.determinism[name] = { sameResult: JSON.stringify(a.result) === JSON.stringify(b.result), sameSeq: JSON.stringify(a.seq) === JSON.stringify(b.seq), turns: a.seq ? a.seq.length : null };
}
// 信息公平：从候选对局状态打乱隐藏信息后决策应相同（只使用信息集）
function hiddenPositions(st) {
  const ids = new Set(E.getUnseenCards(st, 'p2').map((c) => c.id));
  const refs = [];
  for (const zone of [st.deck, st.players.p1.hand, st.discard || []]) for (const c of zone) if (c && ids.has(c.id)) refs.push(c);
  for (const r of st.regions) for (const c of r.sides.p1.faceDown) if (c && ids.has(c.id)) refs.push(c);
  return refs;
}
(function fairness() {
  const st0 = E.createGame(E.defaultConfig({ regionCount: 7, settleCards: 2, difficulty: 1, firstPlayer: 'random', seed: 930555 }));
  E.submitLayout(st0, 'p1', CAND.chooseLayout(st0, 'p1', { strength: 'hard', rng: E.makeRng(11) }));
  E.submitLayout(st0, 'p2', CAND.chooseLayout(st0, 'p2', { strength: 'hard', rng: E.makeRng(22) }));
  E.finalizeLayout(st0);
  let guard = 0, checked = 0, mism = 0;
  while (!E.isGameOver(st0) && guard++ < 800 && checked < 40) {
    if (st0.phase === 'battle') {
      const a = CAND.chooseAction(st0, 'p2', { strength: 'hard' });
      for (let t = 0; t < 3; t++) {
        const s2 = clone(st0);
        const refs = hiddenPositions(s2);
        const copies = refs.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit, value: c.value }));
        for (let i = copies.length - 1; i > 0; i--) { const j = (i * 7 + t * 13) % (i + 1); const tmp = copies[i]; copies[i] = copies[j]; copies[j] = tmp; }
        for (let i = 0; i < refs.length; i++) { refs[i].id = copies[i].id; refs[i].rank = copies[i].rank; refs[i].suit = copies[i].suit; refs[i].value = copies[i].value; }
        const b = CAND.chooseAction(s2, 'p2', { strength: 'hard' });
        if (keyOf(b) !== keyOf(a)) { mism++; break; }
      }
      checked++;
    }
    const legal = E.getLegalActions(st0);
    if (!legal.length) break;
    const act = CAND.chooseAction(st0, st0.turn, { strength: 'hard' });
    const m = legal.find((l) => keyOf(l) === keyOf(act));
    if (!m) break;
    E.performAction(st0, m);
  }
  out.fairness.cand = { checked, mismatched: mism };
})();
fs.writeFileSync(path.join(ROOT, 'tests', 'qa-review-candidate-probe.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 8000));
console.log('QA-REVIEW-CANDIDATE-PROBE DONE');
