'use strict';
/*
 * v3.3.0（task-95）战役消耗阶段「单独结算」概率表模型校验
 * 概率表来源：D:\GAME\概率表.txt（M=1/2/4，d=0..20；表值 0.1% 精度）
 * 语义：P(领先方获胜) = Φ(d / √(28M))；另校验无放回修正、对称性、边界与 warSettleProbs。
 * 运行：node tests/war-prob.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const AI = require(path.join(ROOT, 'js', 'ai.js'));
const I = AI._internals;

/* 概率表.txt 表值（百分比，d=0..20） */
const TABLE = {
  1: [50.0, 57.5, 64.7, 71.5, 77.5, 82.8, 87.1, 90.7, 93.5, 95.6, 97.1, 98.1, 98.8, 99.3, 99.6, 99.8, 99.9, 99.9, 100.0, 100.0, 100.0],
  2: [50.0, 55.3, 60.5, 65.6, 70.4, 74.8, 78.9, 82.5, 85.8, 88.5, 90.9, 92.9, 94.6, 95.9, 96.9, 97.8, 98.4, 98.8, 99.2, 99.4, 99.6],
  4: [50.0, 53.8, 57.5, 61.2, 64.7, 68.2, 71.5, 74.6, 77.5, 80.2, 82.8, 85.1, 87.1, 89.0, 90.7, 92.2, 93.5, 94.6, 95.6, 96.4, 97.1]
};

test('v3.3.0 warWinProb：概率表 M=1/2/4，d=0..20 逐项校验', () => {
  assert.equal(AI.VERSION, '3.5.0-robust', 'AI VERSION 应为 3.5.0-robust（3.3.0 概率表 + v2.10 条件化 + v2.12 反囤牌响应）');
  assert.equal(typeof I.warWinProb, 'function', '应导出 _internals.warWinProb');
  assert.equal(typeof I.warSettleProbs, 'function', '应导出 _internals.warSettleProbs');
  for (const M of [1, 2, 4]) {
    const tol = M === 1 ? 0.6 : 1.0; // 百分点容差（M=1 更严）
    for (let d = 0; d <= 20; d++) {
      const got = 100 * I.warWinProb(d, M);
      const exp = TABLE[M][d];
      assert.ok(Math.abs(got - exp) <= tol,
        'M=' + M + ' d=' + d + '：表值 ' + exp.toFixed(1) + '%，模型 ' + got.toFixed(2) + '%（容差 ' + tol + 'pt）');
    }
  }
});

test('v3.3.0 warWinProb：Φ 对称性与概率表口径', () => {
  for (const M of [1, 2, 3, 4]) {
    assert.ok(Math.abs(I.warWinProb(0, M) - 0.5) < 1e-9, 'd=0 应为 50%');
    for (let d = 1; d <= 20; d++) {
      const a = I.warWinProb(d, M);
      const b = I.warWinProb(-d, M);
      assert.ok(Math.abs((a + b) - 1) < 1e-9, 'M=' + M + ' d=' + d + '：P(d)+P(-d) 应为 1，实际 ' + (a + b));
      assert.ok(a > 0.5 && b < 0.5, '领先方 >50%、落后方 <50%');
    }
  }
  // Φ 近似误差：与规范正态 CDF 关键点比对（Abramowitz-Stegun 近似）
  assert.ok(Math.abs(I.normCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(I.normCdf(1.959963984540054) - 0.975) < 1e-6);
  assert.ok(Math.abs(I.normCdf(-1.959963984540054) - 0.025) < 1e-6);
});

test('v3.3.0 warWinProb：M=0 / L 边界与无放回修正方向', () => {
  // M=0：不补牌 → 由当前领先决定
  assert.equal(I.warWinProb(5, 0), 1);
  assert.equal(I.warWinProb(-5, 0), 0);
  assert.equal(I.warWinProb(0, 0), 0.5);
  // L 边界：L<=1 或 M>=L 时退化为不补牌
  assert.equal(I.warWinProb(5, 2, 1), 1);
  assert.equal(I.warWinProb(-3, 2, 0), 0);
  assert.equal(I.warWinProb(0, 2, 1), 0.5);
  // 无放回修正：有限牌堆应把优势拉回 50%（方向校验）
  for (const [d, M] of [[6, 2], [10, 4], [3, 1]]) {
    const big = I.warWinProb(d, M);
    const finite = I.warWinProb(d, M, 20);
    assert.ok(finite < big, 'd=' + d + ' M=' + M + '：有限 L=20 的领先方胜率应低于大牌堆近似（' + finite.toFixed(4) + ' < ' + big.toFixed(4) + '）');
    assert.ok(finite > 0.5, '仍应高于 50%');
  }
  // 牌堆越大越接近表值
  const d = 6, M = 2;
  const p20 = I.warWinProb(d, M, 20);
  const p100 = I.warWinProb(d, M, 100);
  const pBig = I.warWinProb(d, M);
  assert.ok(p20 <= p100 && p100 <= pBig, '牌堆越大越接近表值');
});

test('v3.3.0 warSettleProbs：win/tie/lose 合法且与表口径一致', () => {
  for (const M of [1, 2, 4]) {
    for (let d = 0; d <= 15; d++) {
      const p = I.warSettleProbs(d, M);
      assert.ok(p.win >= 0 && p.tie >= 0 && p.lose >= 0, '概率非负');
      assert.ok(Math.abs(p.win + p.tie + p.lose - 1) < 1e-9, 'M=' + M + ' d=' + d + '：win+tie+lose 应为 1');
      // 表口径：领先方胜率 = win + tie/2（平局按 0.5 计）
      assert.ok(Math.abs((p.win + 0.5 * p.tie) - I.warWinProb(d, M)) < 1e-9,
        'M=' + M + ' d=' + d + '：win+tie/2 应等于 warWinProb');
    }
  }
  // M=0：不补牌，d=0 必平；d>0 必胜
  assert.deepEqual(I.warSettleProbs(0, 0), { win: 0, tie: 1, lose: 0 });
  assert.deepEqual(I.warSettleProbs(2, 0), { win: 1, tie: 0, lose: 0 });
  assert.deepEqual(I.warSettleProbs(-2, 0), { win: 0, tie: 0, lose: 1 });
  // 平局概率随 M 增大而下降（补牌越多越不容易恰好平分）
  const t1 = I.warSettleProbs(0, 1).tie;
  const t2 = I.warSettleProbs(0, 2).tie;
  const t4 = I.warSettleProbs(0, 4).tie;
  assert.ok(t1 > t2 && t2 > t4, 'd=0 时 tie 概率应随 M 单调下降');
});
