'use strict';
/*
 * LAN 联机服务器集成测试（零依赖，node:test）
 * 运行：node tests/lan.test.js
 * 依据：docs/LAN.md §3/§4/§5/§7.1（唯一契约）。只测不修；发现问题按「请求序列+期望/实际」报 Lead。
 *
 * 重点：
 *  - 脱敏审计：抓双方原始 SSE/HTTP 文本，用「自己视角私密牌 id」作为真值，断言对手载荷绝不出现；
 *    隐藏占位卡结构/数量校验；种子/回放随机数等间接泄漏检查。
 *  - 镜像：公共投影（guest 交换 p1↔p2）逐 seq 相等；事件级 playerId/winner/难度摸牌方镜像。
 *  - 协议/错误/状态不变；完整对局；断线重连；再来一局；离开；并发房间。
 */

const { test, before, after } = require('node:test');
const assert = require('assert');
const H = require('./lan-helpers');

let srv = null;

before(async () => {
  srv = await H.startLanServer();
});

after(async () => {
  if (srv) await srv.close();
});

/* ================================================================== */
/* 本地工具                                                            */
/* ================================================================== */

const DEFAULT_CONFIG = {
  regionCount: 5, difficulty: 1, settleCards: 2, firstPlayer: 'p1',
  // v1.2：对战固定标准 54 张；自定义牌堆仅引擎测试使用
};

function apiPath(match, suffix) { return '/api/rooms/' + match.room.code + '/' + suffix; }

/** 最近一条带 meta 的消息（update 或 presence）的 meta。 */
function latestMeta(sse) {
  for (let i = sse.events.length - 1; i >= 0; i--) {
    const j = sse.events[i].json;
    if (j && j.meta) return j.meta;
  }
  return null;
}

/** 建立一局：host 建房 + guest 加入 + 双方 SSE + 双方进入 layout 视图。 */
async function setupMatch(opts) {
  opts = opts || {};
  const host = new H.HttpClient(srv.port, 'host');
  const guest = new H.HttpClient(srv.port, 'guest');
  const cfg = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
  const room = await H.createRoom(srv.port, host, { name: opts.hostName || '房主', config: cfg });
  const hostSse = new H.SseClient(srv.port, room.code, host.token, 'host');
  await hostSse.connect();
  await hostSse.waitFor('update', 8000, 'host 首帧');
  await H.joinRoom(srv.port, guest, room.code, { name: opts.guestName || '对手' });
  const guestSse = new H.SseClient(srv.port, room.code, guest.token, 'guest');
  await guestSse.connect();
  await guestSse.waitFor('update', 8000, 'guest 首帧');
  await H.sleep(120);
  const match = {
    room, host, guest, hostSse, guestSse,
    close() { hostSse.close(); guestSse.close(); },
    async leaveAll() {
      try { await host.post(apiPath(this, 'leave'), { token: host.token }); } catch (e) { /* ignore */ }
      try { await guest.post(apiPath(this, 'leave'), { token: guest.token }); } catch (e) { /* ignore */ }
      this.close();
    },
  };
  return match;
}

function latestBoth(match) {
  const hu = match.hostSse.latestUpdate();
  const gu = match.guestSse.latestUpdate();
  assert.ok(hu && hu.state, 'host 缺少最新 update');
  assert.ok(gu && gu.state, 'guest 缺少最新 update');
  return { hu, gu, hs: hu.state, gs: gu.state };
}

/** 断言 host/guest 的公开投影一致（guest 做 p1↔p2 交换）。 */
function assertMirror(match, label) {
  const { hs, gs, hu, gu } = latestBoth(match);
  const hp = H.publicProjection(hs);
  const gp = H.publicProjection(gs, { guestSwap: true });
  const diffs = H.diffProjection(hp, gp);
  assert.deepStrictEqual(diffs.slice(0, 8), [], (label || '镜像') + ' 公开投影不一致');
  assert.strictEqual(hu.seq, gu.seq, (label || '镜像') + ' host/guest 的 seq 应一致，实际 ' + hu.seq + ' vs ' + gu.seq);
  return { hs, gs, hp, gp };
}

/** 等待双方都收到 seq > prevSeq 的 update。 */
async function waitNextBoth(match, prevSeq, label) {
  const [hu, gu] = await Promise.all([
    match.hostSse.waitFor((e) => e.event === 'update' && e.json.seq > prevSeq, 8000, label + ' host'),
    match.guestSse.waitFor((e) => e.event === 'update' && e.json.seq > prevSeq, 8000, label + ' guest'),
  ]);
  return { hu: hu.json, gu: gu.json };
}

/** 事件 → 统一「服务器规范身份」投影（host/guest 规范，与服务端 p1/p2 解耦），用于双向比较。
 * @param ev 某客户端视角的事件
 * @param viewerRole 'host' | 'guest'（该客户端在服务器的真实身份）
 */
function publicEvent(ev, viewerRole) {
  const selfPid = viewerRole === 'host' ? 'p1' : 'p2';
  const otherPid = selfPid === 'p1' ? 'p2' : 'p1';
  const hostPid = viewerRole === 'host' ? 'p1' : 'p2';
  const guestPid = hostPid === 'p1' ? 'p2' : 'p1';
  const otherRole = viewerRole === 'host' ? 'guest' : 'host';
  // 视角 p1 恒为「自己」，故按视角角色映射到服务器规范身份：
  // host 视角 p1=host/p2=guest；guest 视角 p1=guest/p2=host。
  const roleOf = (pidValue) => (pidValue === 'p1' ? viewerRole : pidValue === 'p2' ? otherRole : pidValue);
  const actor = ev.playerId ? roleOf(ev.playerId) : null;
  switch (ev.type) {
    case 'action':
      return {
        type: 'action', actor, actionType: ev.action && ev.action.type,
        regionId: ev.action && ev.action.regionId,
      };
    case 'place':
    case 'move':
    case 'draw':
    case 'extra_draw':
      return {
        type: ev.type, actor,
        regionId: ev.regionId, fromRegionId: ev.fromRegionId, toRegionId: ev.toRegionId,
        handSize: ev.handSize,
      };
    case 'flip':
      return { type: 'flip', actor, regionId: ev.regionId, cardId: ev.card && ev.card.id };
    case 'layout_reveal': {
      const layout = ev.layout || {};
      const out = { type: 'layout_reveal' };
      out[roleOf('p1') + 'Ids'] = (layout.p1 || []).map((c) => c.id).sort();
      out[roleOf('p2') + 'Ids'] = (layout.p2 || []).map((c) => c.id).sort();
      return out;
    }
    case 'settle':
    case 'endgame_settle': {
      const deterministic = ev.deterministic === true;
      return {
        type: ev.type, actor, regionId: ev.regionId,
        settleCards: ev.settleCards,
        deterministic,
        drawnCount: ev.drawnCount,
        winner: roleOf(ev.winner),
        sums: { host: ev.sums && ev.sums[hostPid], guest: ev.sums && ev.sums[guestPid] },
        drawnIds: deterministic
          ? { host: [], guest: [] }
          : {
            host: ((ev.drawn && ev.drawn[hostPid]) || []).map((c) => c.id),
            guest: ((ev.drawn && ev.drawn[guestPid]) || []).map((c) => c.id),
          },
        diffPlayer: ev.difficultyDraw ? roleOf(ev.difficultyDraw.playerId) : null,
      };
    }
    case 'battle_start':
      return { type: 'battle_start', turn: roleOf(ev.turn) };
    case 'endgame_start':
      return {
        type: 'endgame_start', openRegionIds: (ev.openRegionIds || []).slice().sort(), deckCount: ev.deckCount,
        threshold: ev.threshold, settleCards: ev.settleCards, drawPerPlayer: ev.drawPerPlayer,
        drawnCounts: ev.drawnCounts && { host: ev.drawnCounts[hostPid], guest: ev.drawnCounts[guestPid] },
      };
    case 'endgame_draw':
      return { type: 'endgame_draw', actor, count: ev.count, handSize: ev.handSize };
    case 'endgame_skip':
      return { type: 'endgame_skip', actor };
    case 'endgame_showdown':
      return {
        type: 'endgame_showdown',
        openRegionIds: (ev.openRegionIds || []).slice().sort(),
        threshold: ev.threshold, deckCount: ev.deckCount,
      };
    case 'game_over':
      return {
        type: 'game_over',
        winner: roleOf(ev.result && ev.result.winner),
        reason: ev.result && ev.result.reason,
        early: !!(ev.result && ev.result.early),
        unsettledRegions: ((ev.result && ev.result.unsettledRegions) || []).slice().sort(),
        regionWins: ev.result && {
          host: ev.result.regionWins[hostPid],
          guest: ev.result.regionWins[guestPid],
          ties: ev.result.regionWins.ties,
        },
        handSums: ev.result && {
          host: ev.result.handSums[hostPid],
          guest: ev.result.handSums[guestPid],
        },
      };
    default:
      return { type: ev.type, actor };
  }
}

/**
 * 私密牌可见性规则断言（docs/LAN.md §4.3）：
 * 仅当事人可见真实 card/cardId，对手必须收到占位/`hidden`。视角内 p1=自己。
 */
function assertPrivateEventVisibility(ev, viewerRole, label) {
  // 视图已镜像：视角内 p1 恒为「自己」、p2 为「对手」（与服务器真实身份无关）
  const actorIsSelf = ev.playerId === 'p1';
  if (ev.type === 'action' && ev.action && ev.action.cardId) {
    if (actorIsSelf) assert.notStrictEqual(ev.action.cardId, 'hidden', label + '：自己的 action.cardId 应真实');
    else assert.strictEqual(ev.action.cardId, 'hidden', label + '：对手 action.cardId 应为 hidden');
  }
  if (ev.type === 'place' || ev.type === 'move' || ev.type === 'draw' || ev.type === 'extra_draw') {
    if (ev.card) {
      if (actorIsSelf) assert.ok(!ev.card.hidden, label + '：自己的 ' + ev.type + ' 事件牌面应真实');
      else assert.ok(H.isHiddenCard(ev.card), label + '：对手的 ' + ev.type + ' 事件牌面必须为占位卡');
    }
  }
  if ((ev.type === 'settle' || ev.type === 'endgame_settle') && ev.difficultyDraw) {
    const ddSelf = ev.difficultyDraw.playerId === 'p1';
    if (ddSelf) assert.ok(!ev.difficultyDraw.card.hidden, label + '：自己难度摸牌牌面应真实');
    else assert.ok(H.isHiddenCard(ev.difficultyDraw.card), label + '：对手难度摸牌牌面必须占位');
  }
  // 结算补牌（drawn）为公开正面牌，双方都应看到真实牌面（不得被脱敏成 hidden）；
  // v1.3 摊牌结算（deterministic）时 drawn 为空数组。
  if (ev.type === 'settle' || ev.type === 'endgame_settle') {
    const deterministic = ev.deterministic === true;
    for (const pid of ['p1', 'p2']) {
      const arr = ev.drawn && ev.drawn[pid];
      assert.ok(Array.isArray(arr), label + '：' + ev.type + ' 事件 drawn.' + pid + ' 应为数组');
      const expectLen = deterministic ? 0 : ev.settleCards;
      assert.strictEqual(arr.length, expectLen, label + '：drawn.' + pid + ' 长度应等于 ' + expectLen);
      for (const c of arr) assert.ok(c && !c.hidden && c.revealed === true, label + '：结算补牌为公开牌，不应为占位/未揭示');
    }
    if (deterministic) assert.strictEqual(ev.drawnCount, 0, label + '：摊牌结算 drawnCount 应为 0');
  }
  // v1.3 决战补牌事件只含数量/手牌数，不得含牌面（手牌隐藏）
  if (ev.type === 'endgame_draw') {
    assert.strictEqual(typeof ev.count, 'number', label + '：endgame_draw 应含 count');
    assert.strictEqual(typeof ev.handSize, 'number', label + '：endgame_draw 应含 handSize');
    assert.ok(!('card' in ev), label + '：endgame_draw 不得携带牌面');
  }
  if (ev.type === 'endgame_skip' || ev.type === 'endgame_showdown') {
    assert.ok(!('card' in ev), label + '：' + ev.type + ' 不得携带牌面');
  }
}

/** 同一批事件的双向镜像断言：规范化后相等 + 双方私密可见性规则各自成立。 */
function assertEventBatchMirror(hostEvents, guestEvents, label) {
  (hostEvents || []).forEach((ev) => assertPrivateEventVisibility(ev, 'host', label + ' host'));
  (guestEvents || []).forEach((ev) => assertPrivateEventVisibility(ev, 'guest', label + ' guest'));
  assert.deepStrictEqual((guestEvents || []).map((e) => publicEvent(e, 'guest')),
    (hostEvents || []).map((e) => publicEvent(e, 'host')), label + '：事件镜像不一致');
}

/** 脱敏结构审计（逐视图）：返回错误数组。 */
function auditViewRedaction(view, label) {
  const errs = [];
  const push = (m) => errs.push(label + '：' + m);
  if (!view) { push('state 为空'); return errs; }
  const st = view.state;
  const meta = view.meta || {};
  // 1) 对手手牌 / 牌堆 / 对手背面牌 / 未揭示弃牌 全部隐藏占位
  errs.push(...H.assertAllHidden(st.players.p2.hand, st.players.p2.hand.length, label + ' 对手手牌'));
  errs.push(...H.assertAllHidden(st.deck, st.deck.length, label + ' 牌堆'));
  for (const r of st.regions || []) {
    errs.push(...H.assertAllHidden(r.sides.p2.faceDown, r.sides.p2.faceDown.length, label + ' 区域' + r.id + ' 对手背面'));
  }
  for (const c of st.discard || []) {
    if (c.revealed && c.hidden) push('已揭示弃牌不应为占位：' + c.id);
    if (!c.revealed && !H.isHiddenCard(c)) push('未揭示弃牌必须占位，实际 ' + JSON.stringify(c).slice(0, 120));
  }
  // 2) 对手正面牌必须是真实牌（公开）且不为 hidden；结算补牌数组应为公开真实牌
  for (const r of st.regions || []) {
    for (const c of r.sides.p2.faceUp || []) {
      if (c.hidden) push('区域' + r.id + ' 对手正面牌不应隐藏');
    }
    if (r.result) {
      for (const pid of ['p1', 'p2']) {
        const arr = r.result.drawn && r.result.drawn[pid];
        if (!Array.isArray(arr)) push('区域' + r.id + ' result.drawn.' + pid + ' 应为数组');
        else if (r.result.deterministic) {
          // v1.3 摊牌结算：无补牌、无随机，drawn 必须为空数组
          if (arr.length !== 0) push('区域' + r.id + ' 摊牌 result.drawn.' + pid + ' 应为空数组');
          if (r.result.difficultyDraw) push('区域' + r.id + ' 摊牌不应有难度摸牌');
        } else {
          if (arr.length !== st.config.settleCards) push('区域' + r.id + ' result.drawn.' + pid + ' 长度应为 settleCards=' + st.config.settleCards);
          for (const c of arr) if (c.hidden || c.revealed !== true) push('区域' + r.id + ' result.drawn.' + pid + ' 应为公开真实牌');
        }
      }
      if (!('difficultyDraw' in r.result)) push('区域' + r.id + ' result 缺少 difficultyDraw 字段');
    }
  }
  if (typeof st.config.settleCards !== 'number' || [1, 2, 4].indexOf(st.config.settleCards) < 0) {
    push('视图 config.settleCards 非法：' + st.config.settleCards);
  }
  // 3) 布局揭示前对手 assignments 不可见
  if (st.layout && !st.layout.revealed) {
    const oppAssign = st.layout.assignments && st.layout.assignments.p2;
    if (oppAssign && oppAssign.some((c) => c && !c.hidden)) push('揭示前对手 layout.assignments 泄露');
    if (oppAssign && oppAssign.length) push('揭示前对手 layout.assignments 应为 null/空');
  }
  // 4) 间接泄漏：随机种子/内部随机状态（可用于本地复现整副牌）
  if (st.config && st.config.seed != null) push('视图泄露 config.seed=' + st.config.seed + '（可复现牌堆）');
  if (st._rngState != null) push('视图泄露 _rngState=' + st._rngState);
  // 5) 日志不得含私密牌面（额外摸牌等） —— 由专门用例按真值断言
  // 6) meta 契约字段
  for (const k of ['code', 'me', 'status', 'host', 'players', 'rematchReady', 'lanUrls', 'serverNow', 'turn']) {
    if (!(k in meta)) push('meta 缺少契约字段 ' + k);
  }
  if (meta.me !== 'p1') push('meta.me 应为 p1，实际 ' + meta.me);
  return errs;
}

/**
 * 收集某客户端「自己曾经真实持有过」的牌 id（手牌/自己背面牌/自己发起的私密事件）。
 * 用于区分「未揭示弃牌」的归属：自己的未揭示弃牌在己方视图中可保留真实身份（docs §4.2 只禁止发给对手）。
 */
function collectObservedOwnIds(sse) {
  const ids = new Set();
  for (const ev of sse.events) {
    const u = ev.json;
    if (!u || u.type !== 'update' || !u.state) continue;
    const st = u.state;
    for (const c of st.players.p1.hand || []) if (!c.hidden) ids.add(c.id);
    for (const r of st.regions || []) {
      for (const c of r.sides.p1.faceUp || []) if (!c.hidden) ids.add(c.id);
      for (const c of r.sides.p1.faceDown || []) if (!c.hidden) ids.add(c.id);
    }
    if (st.layout && st.layout.assignments && st.layout.assignments.p1) {
      for (const c of st.layout.assignments.p1) if (c && !c.hidden) ids.add(c.id);
    }
    for (const e of u.events || []) {
      if ((e.type === 'place' || e.type === 'move' || e.type === 'draw' || e.type === 'extra_draw') &&
        e.playerId === 'p1' && e.card && !e.card.hidden) ids.add(e.card.id);
      if ((e.type === 'settle' || e.type === 'endgame_settle') && e.difficultyDraw &&
        e.difficultyDraw.playerId === 'p1' && e.difficultyDraw.card && !e.difficultyDraw.card.hidden) {
        ids.add(e.difficultyDraw.card.id);
      }
    }
  }
  return ids;
}

/** 原始载荷泄漏扫描：私密牌 id 不得以 JSON 字符串值形式出现在客户端收到的任何原始文本里。
 * 用带引号的完整 token 匹配，避免占位卡 tag（如 hidden-allcards-2 / hidden-discard-8）造成子串误报。 */
function auditRawLeakage(rawText, secrets, label) {
  const leaked = [];
  for (const id of secrets) {
    const needle = '"' + id + '"';
    const idx = rawText.indexOf(needle);
    if (idx >= 0) {
      leaked.push(id + ' … ' + rawText.slice(Math.max(0, idx - 140), idx + 90).replace(/\s+/g, ' '));
    }
  }
  assert.deepStrictEqual(leaked, [], label + '：对手私密牌 id 出现在网络载荷中（脱敏泄漏）');
}

/** 提交双方布局并等待进入 battle。 */
async function submitBothLayouts(match) {
  const { hs, gs } = latestBoth(match);
  const hostLayout = hs.players.p1.hand.slice(0, hs.config.regionCount).map((c) => c.id);
  const guestLayout = gs.players.p1.hand.slice(0, gs.config.regionCount).map((c) => c.id);
  const prevSeq = match.hostSse.latestUpdate().seq;
  const r1 = await match.host.post(apiPath(match, 'layout'), { token: match.host.token, cardIds: hostLayout });
  H.assertOk(r1, 'host 提交布阵');
  const r2 = await match.guest.post(apiPath(match, 'layout'), { token: match.guest.token, cardIds: guestLayout });
  H.assertOk(r2, 'guest 提交布阵');
  await waitNextBoth(match, prevSeq, '布局揭示广播');
  return { hostLayout, guestLayout };
}

/** 通过两个客户端打完整局（使用各自镜像视图计算合法行动；v1.4 行动点感知）。 */
async function playFullGame(match, opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps || 600;
  const seen = new Set();
  const actionLog = [];
  for (let step = 0; step < maxSteps; step++) {
    const { hs } = latestBoth(match);
    if (hs.phase === 'gameover') return { seen, actionLog, steps: step };
    if (opts.stopWhen && opts.stopWhen(seen, hs)) return { seen, actionLog, steps: step };
    const actorIsHost = hs.turn === 'p1'; // host 视角 p1 = host 自己
    const actorClient = actorIsHost ? match.host : match.guest;
    const actorSse = actorIsHost ? match.hostSse : match.guestSse;
    const actorName = actorIsHost ? 'host' : 'guest';
    const view = actorSse.latestUpdate().state;
    const legal = H.legalFromView(view);
    assert.ok(legal.length > 0, '对局 ' + actorName + ' 无合法行动（step=' + step + '）');
    const pick = (t) => legal.find((a) => a.type === t);
    const inBuild = !!(view.endgame && view.endgame.triggered && view.endgame.phase === 'build');
    let action = null;
    if (inBuild) {
      // 决战 build：优先推进型；无牌可动则主动结束回合（不空转）
      action = pick('place') || pick('flip') || pick('move') || pick('end_turn');
    } else {
      // 覆盖目标优先（LAN 覆盖测）；否则周期目标覆盖五种行动；兜底推进型
      const wants = opts.coverTypes && opts.coverTypes.length
        ? opts.coverTypes.filter((t) => !seen.has(t)).concat(['place', 'flip', 'draw', 'settle'])
        : ['place', 'flip', 'settle', 'draw', 'move'];
      for (const t of wants) {
        action = pick(t);
        if (action) break;
      }
      action = action || pick('end_turn');
    }
    action = action || legal.find((a) => a.type === 'end_turn');
    assert.ok(action, '对局 ' + actorName + ' 无可用兜底行动（step=' + step + '）');
    seen.add(action.type);
    const prev = match.hostSse.latestUpdate().seq;
    const res = await actorClient.post(apiPath(match, 'action'), { token: actorClient.token, action });
    H.assertOk(res, actorName + ' 行动 ' + JSON.stringify(action));
    actionLog.push({ actor: actorName, action });
    const next = await waitNextBoth(match, prev, actorName + ' 行动广播');
    // 事件镜像：双方收到的同一 seq 事件公开投影必须一致
    assertEventBatchMirror(next.hu.events || [], next.gu.events || [], '行动广播 seq=' + next.hu.seq + ' action=' + JSON.stringify(action));
    // v1.4：AP 按 cost 扣减或新回合回满；turn 事件字段合法
    const tEnd = (next.hu.events || []).find((e) => e.type === 'turn_end');
    const tStart = (next.hu.events || []).find((e) => e.type === 'turn_start');
    if (tEnd) {
      assert.ok(['manual', 'ap', 'no-action'].includes(tEnd.reason), 'turn_end.reason 非法：' + tEnd.reason);
      assert.strictEqual(typeof tEnd.leftAp, 'number', 'turn_end.leftAp 应为数字');
    }
    if (tStart) {
      assert.strictEqual(tStart.ap, H.E.AP_PER_TURN, 'turn_start.ap 应为 3');
      assert.strictEqual(typeof tStart.turnCount, 'number', 'turn_start.turnCount 应为数字');
    }
    // 每步镜像/脱敏/占位
    const { hs: hs2, gs: gs2 } = latestBoth(match);
    assertMirror(match, '对局第 ' + (step + 1) + ' 步');
    const errs = [...auditViewRedaction({ state: hs2, meta: match.hostSse.latestUpdate().meta }, 'host'),
      ...auditViewRedaction({ state: gs2, meta: match.guestSse.latestUpdate().meta }, 'guest')];
    // seed/_rngState 已由 P0 覆盖；此处仅对运行期结构断言
    const runtimeErrs = errs.filter((e) => !/config\.seed|_rngState|meta 缺少契约字段 turn/.test(e));
    H.assertNoErrors(runtimeErrs, '对局第 ' + (step + 1) + ' 步运行期脱敏');
  }
  throw new Error('对局未在 ' + maxSteps + ' 步内结束');
}

/* ================================================================== */
/* 1. 服务信息 / 静态资源                                              */
/* ================================================================== */

test('§3.1 GET /api/info 返回版本/地址/房间数；静态资源可访问', async () => {
  const res = await H.request(srv.port, 'GET', '/api/info');
  const json = H.assertOk(res, '/api/info');
  assert.strictEqual(json.version, '1.6.0', 'LAN 服务器协议版本 1.6.0（v2.1 固定补偿 1 张；引擎版本另由 engineVersion 断言）');
  assert.strictEqual(json.engineVersion, H.E.VERSION);
  assert.ok(Array.isArray(json.lanUrls) && json.lanUrls.length >= 1);
  assert.ok(json.lanUrls.some((u) => /^http:\/\/(127\.0\.0\.1|192\.168\.|10\.|172\.)/.test(u)), 'lanUrls 应含可用地址');
  assert.ok(typeof json.rooms === 'number' && json.rooms >= 0);
  assert.ok(typeof json.uptimeSec === 'number');

  const home = await H.request(srv.port, 'GET', '/');
  assert.strictEqual(home.status, 200);
  assert.ok(/扑克牌/.test(home.text), '首页应返回 index.html');
  const engineJs = await H.request(srv.port, 'GET', '/js/engine.js');
  assert.strictEqual(engineJs.status, 200);
  assert.ok(/PokerEngine/.test(engineJs.text));
  const css = await H.request(srv.port, 'GET', '/css/style.css');
  assert.strictEqual(css.status, 200);
  const traversal = await H.request(srv.port, 'GET', '/../package.json');
  assert.ok([403, 404].indexOf(traversal.status) >= 0, '路径穿越应被拒绝');
});

/* ================================================================== */
/* 2. 创建/加入房间 + 镜像                                              */
/* ================================================================== */

test('§3.2/3.3 创建房间：code 5 位合法字符、token 32hex、waiting/state=null、meta 正确', async () => {
  const host = new H.HttpClient(srv.port, 'host');
  const room = await H.createRoom(srv.port, host, { name: '阿伟', config: DEFAULT_CONFIG });
  assert.match(room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/, '房间码应为 5 位（去掉 0/O/1/I）');
  assert.match(room.token, /^[0-9a-f]{32}$/, 'token 应为 32 位 hex');
  assert.strictEqual(room.playerId, 'p1');
  assert.strictEqual(room.state, null, 'waiting 状态 state 应为 null');
  assert.strictEqual(room.meta.status, 'waiting');
  assert.strictEqual(room.meta.host, true);
  assert.strictEqual(room.meta.me, 'p1');
  assert.strictEqual(room.meta.code, room.code);
  assert.ok(room.meta.players.p1 && room.meta.players.p1.name === '阿伟');
  assert.strictEqual(room.meta.players.p2, null);
  assert.ok(Array.isArray(room.meta.lanUrls));
  // 快照（waiting）
  const snap = await host.get('/api/rooms/' + room.code, { queryToken: true });
  const sj = H.assertOk(snap, 'waiting 快照');
  assert.strictEqual(sj.state, null);
  assert.strictEqual(sj.meta.status, 'waiting');
  // 清理
  await host.post('/api/rooms/' + room.code + '/leave', { token: host.token });
});

test('§3.2/§5.1 v1.5 回合倒计时：建房 config.turnTimeLimit 透传/默认 30/0 关闭/非法拒绝/meta 暴露', async () => {
  // 1) 非法值：-5 / 1（<5）/ 301 / 30.5 → 400 BAD_REQUEST，错误文案含「回合倒计时」，且不产生房间
  for (const bad of [-5, 1, 301, 30.5]) {
    const c = new H.HttpClient(srv.port, 'bad' + bad);
    const res = await c.post('/api/rooms', { name: '非法配置', config: Object.assign({}, DEFAULT_CONFIG, { turnTimeLimit: bad }) });
    assert.strictEqual(res.status, 400, 'turnTimeLimit=' + bad + ' 应返回 400，实际 ' + res.status);
    assert.ok(res.json && res.json.error && res.json.error.code === 'BAD_REQUEST', '错误码应为 BAD_REQUEST');
    assert.ok(/回合倒计时/.test(String(res.json.error.message)), '错误信息应含「回合倒计时」：' + String(res.json.error.message));
  }

  // 2) 显式 15：state.config 透传（host 快照 / guest 快照均可见），双端一致
  const host = new H.HttpClient(srv.port, 'host15');
  const guest = new H.HttpClient(srv.port, 'guest15');
  const room = await H.createRoom(srv.port, host, {
    name: '房主', config: Object.assign({}, DEFAULT_CONFIG, { turnTimeLimit: 15 })
  });
  await H.joinRoom(srv.port, guest, room.code, { name: '客机' });
  const hostSnap = H.assertOk(await host.get('/api/rooms/' + room.code, { queryToken: true }), 'host 快照');
  const guestSnap = H.assertOk(await guest.get('/api/rooms/' + room.code, { queryToken: true }), 'guest 快照');
  assert.strictEqual(hostSnap.state && hostSnap.state.config && hostSnap.state.config.turnTimeLimit, 15,
    'host 视角 state.config.turnTimeLimit 应为 15');
  assert.strictEqual(guestSnap.state && guestSnap.state.config && guestSnap.state.config.turnTimeLimit, 15,
    'guest 视角 state.config.turnTimeLimit 应为 15');
  assert.strictEqual(guestSnap.state.config.apPerTurn, 3, 'AP 常量不受倒计时影响');

  // 3) meta 暴露（task-28 验收：buildMeta 的 config 摘要含 turnTimeLimit，guest 等待室读取）
  assert.ok(room.meta && room.meta.config, '建房响应 meta 应有 config 摘要（v1.5）');
  assert.strictEqual(room.meta.config.turnTimeLimit, 15, '建房 meta.config.turnTimeLimit 应为 15');
  assert.strictEqual(hostSnap.meta && hostSnap.meta.config && hostSnap.meta.config.turnTimeLimit, 15,
    'host 快照 meta.config.turnTimeLimit 应为 15');
  assert.strictEqual(guestSnap.meta && guestSnap.meta.config && guestSnap.meta.config.turnTimeLimit, 15,
    'guest 快照 meta.config.turnTimeLimit 应为 15（等待室显示依赖）');
  await host.post('/api/rooms/' + room.code + '/leave', { token: host.token }).catch(() => {});

  // 4) 缺省 → 30；0（关闭）合法且透传
  const hostDefault = new H.HttpClient(srv.port, 'hostDefault');
  const guestDefault = new H.HttpClient(srv.port, 'guestDefault');
  const roomDefault = await H.createRoom(srv.port, hostDefault, { name: '默认房主', config: DEFAULT_CONFIG });
  assert.ok(roomDefault.meta && roomDefault.meta.config, '缺省建房 meta 应有 config 摘要');
  assert.strictEqual(roomDefault.meta.config.turnTimeLimit, 30, '缺省 meta.config.turnTimeLimit 应为 30');
  await H.joinRoom(srv.port, guestDefault, roomDefault.code, { name: '默认客机' });
  const defaultSnap = H.assertOk(await hostDefault.get('/api/rooms/' + roomDefault.code, { queryToken: true }), '默认快照');
  assert.strictEqual(defaultSnap.state && defaultSnap.state.config && defaultSnap.state.config.turnTimeLimit, 30,
    '缺省 turnTimeLimit 应为 30');
  await hostDefault.post('/api/rooms/' + roomDefault.code + '/leave', { token: hostDefault.token }).catch(() => {});

  const hostOff = new H.HttpClient(srv.port, 'hostOff');
  const guestOff = new H.HttpClient(srv.port, 'guestOff');
  const roomOff = await H.createRoom(srv.port, hostOff, {
    name: '关闭倒计时', config: Object.assign({}, DEFAULT_CONFIG, { turnTimeLimit: 0 })
  });
  await H.joinRoom(srv.port, guestOff, roomOff.code, { name: '关闭客机' });
  const offSnap = H.assertOk(await hostOff.get('/api/rooms/' + roomOff.code, { queryToken: true }), '0 快照');
  assert.strictEqual(offSnap.state && offSnap.state.config && offSnap.state.config.turnTimeLimit, 0,
    'turnTimeLimit=0（关闭）应合法并透传');
  assert.strictEqual(offSnap.meta && offSnap.meta.config && offSnap.meta.config.turnTimeLimit, 0,
    '0（关闭）meta.config.turnTimeLimit 应为 0');
  await hostOff.post('/api/rooms/' + roomOff.code + '/leave', { token: hostOff.token }).catch(() => {});
});

test('§3.3/§4.1 加入房间：双方进入 layout，镜像正确（各自视角 p1=自己）', async () => {  const m = await setupMatch({ hostName: '阿伟', guestName: '小明' });
  try {
    const { hs, gs } = latestBoth(m);
    assert.strictEqual(hs.phase, 'layout');
    assert.strictEqual(gs.phase, 'layout');
    assert.strictEqual(hs.players.p1.hand.length, 10);
    assert.strictEqual(gs.players.p1.hand.length, 10);
    assert.strictEqual(hs.players.p1.name, '阿伟', 'host 视角 p1 应是自己');
    assert.strictEqual(gs.players.p1.name, '小明', 'guest 视角 p1 应是自己');
    assert.strictEqual(hs.players.p2.name, '小明');
    assert.strictEqual(gs.players.p2.name, '阿伟');
    // meta
    const hm = latestMeta(m.hostSse);
    const gm = latestMeta(m.guestSse);
    assert.strictEqual(hm.me, 'p1');
    assert.strictEqual(gm.me, 'p1');
    assert.strictEqual(hm.host, true);
    assert.strictEqual(gm.host, false);
    assert.strictEqual(hm.players.p1.name, '阿伟');
    assert.strictEqual(gm.players.p1.name, '小明');
    assert.strictEqual(hm.status, 'layout');
    assert.strictEqual(gm.status, 'layout');
    assert.ok(hm.players.p1.connected && hm.players.p2.connected, '双方 SSE 连接后 connected 应为 true');
    // meta.turn（docs §4.4）
    assert.strictEqual(hm.turn, hs.turn, 'meta.turn 应镜像 state.turn（host 视角）');
    assert.strictEqual(gm.turn, gs.turn, 'meta.turn 应镜像 state.turn（guest 视角）');
    assertMirror(m, '加入后');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 3. 脱敏审计（核心）                                                 */
/* ================================================================== */

test('§4.2 脱敏结构审计：对手手牌/背面牌/牌堆/未揭示弃牌均为占位卡，无种子泄漏', async () => {
  const m = await setupMatch({});
  try {
    const { hs, gs } = latestBoth(m);
    // 数量交叉：host 看到对手手牌数 = guest 真实手牌数
    assert.strictEqual(hs.players.p2.hand.length, gs.players.p1.hand.length, 'host 视角对手手牌占位数量应等于 guest 真实手牌数');
    assert.strictEqual(gs.players.p2.hand.length, hs.players.p1.hand.length);
    assert.strictEqual(hs.deck.length, gs.deck.length, '双方视图牌堆数量应一致');
    assert.strictEqual(hs.deck.length, H.E.createDeck(hs.config.deck).length - 2 * hs.config.initialDraw, '布局前牌堆张数应为牌堆构成 - 2×初始摸牌');
    const errs = [
      ...auditViewRedaction({ state: hs, meta: m.hostSse.latestUpdate().meta }, 'host'),
      ...auditViewRedaction({ state: gs, meta: m.guestSse.latestUpdate().meta }, 'guest'),
    ];
    H.assertNoErrors(errs, '布局阶段脱敏结构');
    // 自己的手牌必须是真实牌（自己信息保留）
    for (const c of hs.players.p1.hand) assert.ok(!c.hidden && typeof c.id === 'string' && c.value > 0, '自己的手牌应保留真实牌面');
    for (const c of gs.players.p1.hand) assert.ok(!c.hidden && typeof c.id === 'string' && c.value > 0);
  } finally {
    await m.leaveAll();
  }
});

test('§4.2 脱敏原始载荷审计：对手私密牌 id 绝不出现在对端任何 SSE/HTTP 原始文本中', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p2' }) });
  try {
    const { hs, gs } = latestBoth(m);
    const hostSecrets = H.extractOwnSecrets(hs);   // host 自己的手牌等
    const guestSecrets = H.extractOwnSecrets(gs);
    assert.ok(guestSecrets.size === 10 && hostSecrets.size === 10);
    // 布局阶段先扫一轮
    auditRawLeakage(m.hostSse.allRawText() + m.host.rawHttpTexts.join('\n'), guestSecrets, '布局阶段 host 载荷');
    auditRawLeakage(m.guestSse.allRawText() + m.guest.rawHttpTexts.join('\n'), hostSecrets, '布局阶段 guest 载荷');
    // 揭示 + battle 后再扫（覆盖事件/日志/结算）
    await submitBothLayouts(m);
    await H.sleep(150);
    const { hs: hs2, gs: gs2 } = latestBoth(m);
    const hostSecrets2 = new Set([...H.extractOwnSecrets(hs2), ...H.extractOwnEventSecrets(m.hostSse.events.map((e) => e.json), hs2)]);
    const guestSecrets2 = new Set([...H.extractOwnSecrets(gs2), ...H.extractOwnEventSecrets(m.guestSse.events.map((e) => e.json), gs2)]);
    auditRawLeakage(m.hostSse.allRawText() + m.host.rawHttpTexts.join('\n'), guestSecrets2, '揭示后 host 载荷');
    auditRawLeakage(m.guestSse.allRawText() + m.guest.rawHttpTexts.join('\n'), hostSecrets2, '揭示后 guest 载荷');
  } finally {
    await m.leaveAll();
  }
});

test('§4.2/§4.3 事件脱敏：对手 place/move/draw/extra_draw/action.cardId 必须占位，难度摸牌牌面不可见', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p2' }) });
  try {
    await submitBothLayouts(m);
    await H.sleep(120);
    const allEvents = {
      host: m.hostSse.events.map((e) => e.json).filter(Boolean),
      guest: m.guestSse.events.map((e) => e.json).filter(Boolean),
    };
    function checkOpponentPrivateEvents(events, label) {
      for (const u of events) {
        for (const ev of u.events || []) {
          if (ev.type === 'place' || ev.type === 'move' || ev.type === 'draw' || ev.type === 'extra_draw') {
            if (ev.playerId === 'p2') { // 对手事件（镜像后）
              assert.ok(ev.card && H.isHiddenCard(ev.card), label + '：对手 ' + ev.type + ' 事件 card 必须为隐藏占位，实际 ' + JSON.stringify(ev.card).slice(0, 120));
            } else {
              assert.ok(ev.card && !ev.card.hidden, label + '：自己 ' + ev.type + ' 事件 card 应为真实牌');
            }
          }
          if (ev.type === 'action' && ev.playerId === 'p2' && ev.action && ev.action.cardId) {
            assert.strictEqual(ev.action.cardId, 'hidden', label + '：对手 action 事件 cardId 应为 hidden');
          }
          if (ev.type === 'settle' || ev.type === 'endgame_settle') {
            if (ev.difficultyDraw && ev.difficultyDraw.playerId === 'p2') {
              assert.ok(H.isHiddenCard(ev.difficultyDraw.card), label + '：对手难度摸牌牌面必须占位');
            }
            if (ev.regionBefore) {
              for (const c of (ev.regionBefore.sides && ev.regionBefore.sides.p2 && ev.regionBefore.sides.p2.faceDown) || []) {
                assert.ok(H.isHiddenCard(c), label + '：regionBefore 对手背面牌必须占位');
              }
            }
          }
        }
      }
    }
    checkOpponentPrivateEvents(allEvents.host, 'host 视角');
    checkOpponentPrivateEvents(allEvents.guest, 'guest 视角');
    // 后手额外摸牌日志泄漏审计（p1=后手，firstPlayer=p2）
    const { hs, gs } = latestBoth(m);
    // 真值：host 布局前 10 张手牌 - 布局 5 张 = 5 张余牌；finalize 后 R+1 张 → 多出的 1 张即后手补偿
    const hostViewBeforeLayout = m.hostSse.events.map((e) => e.json).filter((j) => j && j.state && j.state.phase === 'layout').pop();
    assert.ok(hostViewBeforeLayout, '应能找到布局阶段 host 视图');
    const preHand = new Set((hostViewBeforeLayout.state.players.p1.hand || []).map((c) => c.id));
    const postHand = (hs.players.p1.hand || []).map((c) => c.id);
    const extraIds = postHand.filter((id) => !preHand.has(id));
    assert.strictEqual(hs.config.compensationDraw, 1, 'v2.1 后手补偿固定 1 张');
    assert.strictEqual(extraIds.length, 1, 'p1 后手应补固定 1 张');
    const extraCard = H.E.createDeck(hs.config.deck).find((c) => c.id === extraIds[0]);
    const face = extraCard.joker ? extraCard.rank : extraCard.suitSymbol + extraCard.rank;
    const guestLogs = (gs.log || []).map((l) => l.text);
    const leakedLogs = guestLogs.filter((t) => /额外摸到/.test(t) && t.indexOf(face) >= 0);
    assert.deepStrictEqual(leakedLogs, [], '后手补偿牌面（' + face + '）经 state.log 泄露给对手');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 4. 布局揭示 / 事件镜像                                              */
/* ================================================================== */

test('§3.5/§4.3 双方提交布局：揭示/补牌事件镜像、进入 battle、先手镜像正确', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p1' }) });
  try {
    const { hs } = latestBoth(m);
    const prev = m.hostSse.latestUpdate().seq;
    await submitBothLayouts(m);
    await H.sleep(120);
    const { hs: hs2, gs: gs2 } = latestBoth(m);
    assert.strictEqual(hs2.phase, 'battle');
    assert.strictEqual(gs2.phase, 'battle');
    assertMirror(m, '揭示后');
    // 先手 p1（host）→ host 视角 turn p1；guest 视角 turn p2（对手先手）
    assert.strictEqual(hs2.turn, 'p1');
    assert.strictEqual(gs2.turn, 'p2');
    // 区域正面牌 = layout assignments（揭示后公开）
    assert.strictEqual(hs2.layout.revealed, true);
    for (let i = 0; i < hs2.config.regionCount; i++) {
      const hostRegion = hs2.regions[i];
      assert.strictEqual(hostRegion.sides.p1.faceUp.length, 1);
      assert.strictEqual(hostRegion.sides.p2.faceUp.length, 1);
      assert.ok(!hostRegion.sides.p1.faceUp[0].hidden, '自己的正面牌应真实');
      assert.ok(!hostRegion.sides.p2.faceUp[0].hidden, '对手正面牌应公开（真实）');
    }
    // 事件镜像（揭示批次）
    const hu = m.hostSse.events.map((e) => e.json).filter((j) => j && j.seq > prev && j.type !== 'presence');
    const gu = m.guestSse.events.map((e) => e.json).filter((j) => j && j.seq > prev && j.type !== 'presence');
    assert.ok(hu.length >= 1 && gu.length >= 1, '应有揭示批次 update');
    const lastH = hu[hu.length - 1];
    const lastG = gu[gu.length - 1];
    assert.strictEqual(lastH.seq, lastG.seq);
    const types = (lastH.events || []).map((e) => e.type);
    for (const t of ['layout_reveal', 'extra_draw', 'battle_start']) {
      assert.ok(types.indexOf(t) >= 0, '揭示批次应含事件 ' + t + '，实际 ' + types.join(','));
    }
    assertEventBatchMirror(lastH.events, lastG.events, '揭示事件');
    // 先手为 p1 时补偿发给 p2（guest），v2.1 固定 1 张：guest 自己的 card 真实，host 看到占位
    const K = gs2.config.compensationDraw;
    assert.strictEqual(K, 1, 'v2.1 后手补偿固定 1 张');
    const hExtra = (lastH.events || []).filter((e) => e.type === 'extra_draw');
    const gExtra = (lastG.events || []).filter((e) => e.type === 'extra_draw');
    assert.strictEqual(hExtra.length, K, 'host 视角应收到 ' + K + ' 个 extra_draw');
    assert.strictEqual(gExtra.length, K, 'guest 视角应收到 ' + K + ' 个 extra_draw');
    for (const e of hExtra) {
      assert.strictEqual(e.playerId, 'p2', 'host 视角补牌方为对手');
      assert.ok(H.isHiddenCard(e.card), 'host 不应看到对手补偿牌牌面');
    }
    for (const e of gExtra) {
      assert.strictEqual(e.playerId, 'p1', 'guest 视角补牌方为自己');
      assert.ok(e.card && !e.card.hidden, 'guest 应看到自己补偿牌牌面');
    }
    assert.deepStrictEqual(gExtra.map((e) => e.handSize), [gs2.config.layoutCount + 1],
      '补偿手牌数 = 布局后 R+1（固定 1 张）');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 5. 非法请求 / 错误码 / 状态不变                                     */
/* ================================================================== */

test('§3.5/§3.6/§5 错误码与非法请求：4xx + 状态不变', async () => {
  const m = await setupMatch({});
  try {
    const snap0 = await m.host.get('/api/rooms/' + m.room.code, { queryToken: true });
    const baseState = JSON.stringify(H.assertOk(snap0, '基准快照').state);

    // 坏 token
    const badToken = await H.request(srv.port, 'POST', apiPath(m, 'layout'), { body: { token: 'x'.repeat(32), cardIds: [] } });
    H.assertApiError(badToken, { status: 403, code: 'BAD_TOKEN' }, '坏 token 提交布阵');
    const badTokenGet = await H.request(srv.port, 'GET', '/api/rooms/' + m.room.code + '?token=' + 'x'.repeat(32));
    H.assertApiError(badTokenGet, { status: 403, code: 'BAD_TOKEN' }, '坏 token 快照');
    // 房间不存在
    const noRoom = await H.request(srv.port, 'GET', '/api/rooms/ZZZZZ?token=' + 'x'.repeat(32));
    H.assertApiError(noRoom, { status: 404, code: 'ROOM_NOT_FOUND' }, '房间不存在');
    // 阶段错误：layout 阶段发 action
    const { hs } = latestBoth(m);
    const layoutAction = await m.host.post(apiPath(m, 'action'), { token: m.host.token, action: { type: 'draw' } });
    H.assertApiError(layoutAction, { status: 409, code: 'BAD_PHASE' }, '布局阶段行动');
    // 布局非法卡（不在手牌）
    const wrongCard = await m.host.post(apiPath(m, 'layout'), { token: m.host.token, cardIds: ['s-K', 's-Q', 's-J', 's-10', 's-9'] });
    H.assertApiError(wrongCard, { status: 400, code: 'ILLEGAL_ACTION' }, '布局牌不在手牌');
    // 状态未变（以上全部为失败请求；含坏 token/房间不存在/阶段错误/非法布阵）
    const snap1 = await m.host.get('/api/rooms/' + m.room.code, { queryToken: true });
    assert.strictEqual(JSON.stringify(H.assertOk(snap1, '错误后快照').state), baseState, '错误请求不得改变服务器状态');
    // 重复提交
    H.assertOk(await m.host.post(apiPath(m, 'layout'), { token: m.host.token, cardIds: hs.players.p1.hand.slice(0, 5).map((c) => c.id) }), 'host 首次布阵');
    const dup = await m.host.post(apiPath(m, 'layout'), { token: m.host.token, cardIds: hs.players.p1.hand.slice(0, 5).map((c) => c.id) });
    H.assertApiError(dup, { status: 409, code: 'BAD_PHASE' }, '重复提交布阵');
    // 进入 battle 后：非轮次/非法行动/阶段错误
    await H.assertOk(await m.guest.post(apiPath(m, 'layout'), { token: m.guest.token, cardIds: latestBoth(m).gs.players.p1.hand.slice(0, 5).map((c) => c.id) }), 'guest 布阵');
    await H.sleep(150);
    await waitNextBoth(m, m.hostSse.latestUpdate().seq - 1, '进入 battle');
    const { hs: hs2 } = latestBoth(m);
    const nonTurnClient = hs2.turn === 'p1' ? m.guest : m.host;
    const nonTurnRes = await nonTurnClient.post(apiPath(m, 'action'), { token: nonTurnClient.token, action: { type: 'draw' } });
    H.assertApiError(nonTurnRes, { status: 400, code: 'ILLEGAL_ACTION' }, '非轮次行动');
    const actor = hs2.turn === 'p1' ? m.host : m.guest;
    const actorView = (hs2.turn === 'p1' ? m.hostSse : m.guestSse).latestUpdate().state;
    const legalNow = H.legalFromView(actorView);
    // v1.4：任意未结算区域均可结算；非法请求改为「不存在的区域」+「行动点不足」
    const badRegionSettle = await actor.post(apiPath(m, 'action'), { token: actor.token, action: { type: 'settle', regionId: 99 } });
    H.assertApiError(badRegionSettle, { status: 400, code: 'ILLEGAL_ACTION' }, '不存在的区域 settle');
    const drawForAp = legalNow.find((a) => a.type === 'draw');
    assert.ok(drawForAp, '应可摸牌以消耗行动点');
    const prevDraw = m.hostSse.latestUpdate().seq;
    H.assertOk(await actor.post(apiPath(m, 'action'), { token: actor.token, action: drawForAp }), '摸牌（消耗 2 点 AP）');
    await waitNextBoth(m, prevDraw, '摸牌广播');
    const apShort = await actor.post(apiPath(m, 'action'), { token: actor.token, action: { type: 'settle', regionId: 0 } });
    H.assertApiError(apShort, { status: 400, code: 'ILLEGAL_ACTION' }, '行动点不足 settle');
    assert.ok(/当前局面不合法|行动点不足/.test((apShort.json.error && apShort.json.error.message) || ''),
      '错误 message 应说明行动在当前局面不合法（含行动点不足）：' + JSON.stringify(apShort.json.error));
    // 阶段错误：battle 阶段 layout
    const lateLayout = await actor.post(apiPath(m, 'layout'), { token: actor.token, cardIds: [] });
    H.assertApiError(lateLayout, { status: 409, code: 'BAD_PHASE' }, 'battle 阶段布阵');
    // 畸形 JSON / 超大 body / 未知接口
    const malformed = await H.request(srv.port, 'POST', apiPath(m, 'action'), { body: '{bad json', token: m.host.token, omitContentType: false });
    H.assertApiError(malformed, { status: 400, code: 'BAD_REQUEST' }, '畸形 JSON');
    const huge = await H.request(srv.port, 'POST', apiPath(m, 'action'), { body: JSON.stringify({ token: m.host.token, pad: 'x'.repeat(70000) }) });
    assert.ok((huge.status >= 400 && huge.status < 500) || huge.status === 0 || huge.error, '超大 body 应返回 4xx 或断开连接，实际 ' + huge.status + ' ' + (huge.error || ''));
    const unknown = await H.request(srv.port, 'GET', '/api/nope');
    assert.ok(unknown.status >= 400, '未知 API 应返回 4xx/5xx，实际 ' + unknown.status);
    // 服务器仍正常
    H.assertOk(await H.request(srv.port, 'GET', '/api/info'), '错误后 /api/info');
    const snapAfter = await actor.get('/api/rooms/' + m.room.code, { queryToken: true });
    const after = H.assertOk(snapAfter, '错误后快照');
    assert.ok(after.seq >= 1);
    const viewH = m.hostSse.latestUpdate();
    assert.ok(viewH.state.phase === 'battle');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 6. 五种行动协议覆盖（含 move）                                      */
/* ================================================================== */

test('§3.6 五种行动逐一通过服务器校验：place/move/flip/settle/draw 事件双向可见且镜像（v1.4 AP 多行动）', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p1' }) });
  try {
    await submitBothLayouts(m);
    await H.sleep(120);
    const want = ['place', 'move', 'flip', 'settle', 'draw'];
    const { seen, steps } = await playFullGame(m, {
      maxSteps: 300,
      coverTypes: want,
      stopWhen: (s) => want.every((t) => s.has(t)),
    });
    for (const t of want) {
      assert.ok(seen.has(t), '协议覆盖缺少行动 ' + t + '，实际 ' + [...seen].join(','));
    }
    // 服务器最终状态与双方视图一致（以 host 视图快照比对）
    const snap = await m.host.get('/api/rooms/' + m.room.code, { queryToken: true });
    const sj = H.assertOk(snap, '五行动后快照');
    assert.deepStrictEqual(H.publicProjection(sj.state), H.publicProjection(m.hostSse.latestUpdate().state), '快照与 SSE 视图一致');
    console.log('[lan] 五行动协议覆盖：' + [...seen].join(',') + '（' + steps + ' 步，含 AP 多行动）');
  } finally {
    await m.leaveAll();
  }
});

test('§3.9/§5.1 v1.4 行动点与 end_turn：视图 AP 镜像、turn_start/turn_end 事件字段、end_turn 透传', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p1' }) });
  try {
    await submitBothLayouts(m);
    await H.sleep(120);
    let { hs, gs } = latestBoth(m);
    assert.strictEqual(hs.players.p1.ap, H.E.AP_PER_TURN, 'host 视角自己（p1）首回合 AP=3');
    assert.strictEqual(hs.players.p2.ap, 0, 'host 视角对手 AP=0（未轮到）');
    assert.strictEqual(gs.players.p1.ap, 0, 'guest 视角自己（p1）AP=0（未轮到）');
    assert.strictEqual(gs.players.p2.ap, H.E.AP_PER_TURN, 'guest 视角对手（p2=host）AP=3（镜像）');
    const actor = hs.turn === 'p1' ? m.host : m.guest;
    const actorSse = hs.turn === 'p1' ? m.hostSse : m.guestSse;

    // 一回合多行动：摸牌（2 点）后仍本方回合，AP=1；随后 end_turn（0 点，随时可用）
    const view = actorSse.latestUpdate().state;
    const draw = H.legalFromView(view).find((a) => a.type === 'draw');
    assert.ok(draw, '当前行动方应可摸牌');
    let prev = m.hostSse.latestUpdate().seq;
    H.assertOk(await actor.post(apiPath(m, 'action'), { token: actor.token, action: draw }), '摸牌（同回合继续）');
    let next = await waitNextBoth(m, prev, '摸牌广播');
    assert.ok(!(next.hu.events || []).some((e) => e.type === 'turn_start'), '2 点行动后 AP 未耗尽，仍同回合');
    ({ hs, gs } = latestBoth(m));
    assert.strictEqual(hs.players.p1.ap, 1, 'host 自己 AP=1（3-2）');
    assert.strictEqual(gs.players.p2.ap, 1, 'guest 视角对手 AP=1（镜像）');

    // 主动 end_turn：turn_end(manual,leftAp=1) + turn_start(下家, ap=3)，双方事件镜像
    prev = m.hostSse.latestUpdate().seq;
    H.assertOk(await actor.post(apiPath(m, 'action'), { token: actor.token, action: { type: 'end_turn', cost: 0 } }), 'end_turn 透传');
    next = await waitNextBoth(m, prev, 'end_turn 广播');
    assertEventBatchMirror(next.hu.events || [], next.gu.events || [], 'end_turn 事件');
    const tEnd = (next.hu.events || []).find((e) => e.type === 'turn_end');
    const tStart = (next.hu.events || []).find((e) => e.type === 'turn_start');
    assert.ok(tEnd && tStart, 'end_turn 应产生 turn_end + turn_start');
    assert.strictEqual(tEnd.reason, 'manual');
    assert.strictEqual(tEnd.leftAp, 1, 'leftAp 记录放弃的 1 点');
    assert.strictEqual(tStart.ap, H.E.AP_PER_TURN, '新回合 AP 回满 3');
    ({ hs, gs } = latestBoth(m));
    assert.strictEqual(hs.turn, 'p2', 'end_turn 后轮到对手（host 视角 p2）');
    assert.strictEqual(hs.players.p2.ap, 3, 'host 视角对手 AP=3');
    assert.strictEqual(gs.players.p1.ap, 3, 'guest 视角自己 AP=3（镜像）');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 7. 完整对局 + 终局镜像 + 脱敏审计                                    */
/* ================================================================== */

test('§7.1-5 两客户端按行动点轮流多行动打完整局：五种行动、事件镜像、result 镜像、终局脱敏', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p1' }) });
  try {
    await submitBothLayouts(m);
    const prev = m.hostSse.latestUpdate().seq;
    await waitNextBoth(m, prev, '进入 battle 广播');
    const { seen, steps } = await playFullGame(m, { coverTypes: ['place', 'flip', 'settle', 'draw'], maxSteps: 600 });
    const { hs, gs } = latestBoth(m);
    // 确定性策略下至少应覆盖 place/flip/settle；draw 由周期性注入保证；move 依赖局面（单独协议用例覆盖）
    for (const t of ['place', 'flip', 'settle', 'draw']) {
      assert.ok(seen.has(t), '完整对局应覆盖行动 ' + t + '，实际 ' + [...seen].join(','));
    }
    if (!seen.has('move')) console.log('[lan] 提示：本局未出现 move 行动（依赖局面，允许；move 由脱敏/合法性用例覆盖）');
    assert.strictEqual(hs.phase, 'gameover');
    assert.strictEqual(gs.phase, 'gameover');
    assertMirror(m, '终局');
    // result 镜像
    assert.ok(hs.result && gs.result);
    const hostW = hs.result.winner === 'draw' ? 'draw' : (hs.result.winner === 'p1' ? 'host' : 'guest');
    const guestW = gs.result.winner === 'draw' ? 'draw' : (gs.result.winner === 'p1' ? 'guest' : 'host');
    assert.strictEqual(hostW, guestW, '双方 result.winner 镜像应一致');
    assert.strictEqual(hs.result.winner === 'draw' ? gs.result.winner : (hs.result.winner === 'p1' ? 'p2' : 'p1'), gs.result.winner, 'winner 镜像');
    assert.strictEqual(hs.result.handSums.p1, gs.result.handSums.p2, 'handSums 镜像');
    assert.strictEqual(hs.result.handSums.p2, gs.result.handSums.p1);
    assert.strictEqual(hs.result.regionWins.p1, gs.result.regionWins.p2);
    // v1.2 提前锁定字段镜像
    assert.strictEqual(!!hs.result.early, !!gs.result.early, '双方 result.early 应一致');
    assert.deepStrictEqual((hs.result.unsettledRegions || []).slice().sort(), (gs.result.unsettledRegions || []).slice().sort(), 'unsettledRegions 应一致');
    if (hs.result.early) {
      const openH = hs.regions.filter((r) => r.status === 'open').map((r) => r.id).sort();
      assert.deepStrictEqual(openH, (hs.result.unsettledRegions || []).slice().sort(), '提前锁定时未结算区域应与 open 区域一致');
    }
    // 终局事件镜像
    const lastH = m.hostSse.latestUpdate();
    const lastG = m.guestSse.latestUpdate();
    const gameOverH = (lastH.events || []).filter((e) => e.type === 'game_over');
    const gameOverG = (lastG.events || []).filter((e) => e.type === 'game_over');
    assert.ok(gameOverH.length === 1 && gameOverG.length === 1, '终局应各收到 1 个 game_over 事件');
    assertEventBatchMirror(gameOverH, gameOverG, 'game_over 事件');
    // 终局后行动必须拒绝
    const anyToken = m.host.token;
    const after = await H.request(srv.port, 'POST', apiPath(m, 'action'), { body: { token: anyToken, action: { type: 'draw' } } });
    H.assertApiError(after, { status: 409, code: 'BAD_PHASE' }, '终局后行动');
    // 全量脱敏结构（隐藏区）
    const errs = [
      ...auditViewRedaction({ state: hs, meta: m.hostSse.latestUpdate().meta }, 'host 终局'),
      ...auditViewRedaction({ state: gs, meta: m.guestSse.latestUpdate().meta }, 'guest 终局'),
    ];
    const runtimeErrs = errs.filter((e) => !/config\.seed|_rngState|meta 缺少契约字段 turn/.test(e));
    H.assertNoErrors(runtimeErrs, '终局脱敏结构');
    // 全量原始载荷泄漏扫描：以服务器权威状态为真值
    // （终局手牌从未公开；牌堆身份/顺序从未下发；未揭示弃牌身份对双方均不可见）
    const roomAuth = srv.srv.rooms.get(m.room.code);
    assert.ok(roomAuth && roomAuth.state, '应能从服务器拿到权威房间状态（createLanServer 返回 rooms）');
    const auth = roomAuth.state;
    const activeIds = [];
    const addAll = (arr) => (arr || []).forEach((c) => activeIds.push(c.id));
    addAll(auth.deck);
    addAll(auth.discard);
    addAll(auth.players.p1.hand);
    addAll(auth.players.p2.hand);
    for (const r of auth.regions) {
      if (r.status !== 'open') continue;
      addAll(r.sides.p1.faceUp); addAll(r.sides.p1.faceDown);
      addAll(r.sides.p2.faceUp); addAll(r.sides.p2.faceDown);
    }
    assert.strictEqual(new Set(activeIds).size, activeIds.length, '服务器权威状态存在重复牌 id（状态被污染）');
    assert.strictEqual(activeIds.length, H.E.createDeck(auth.config.deck).length, '服务器权威状态牌张守恒失败');
    const unrevealedDiscardIds = auth.discard.filter((c) => !c.revealed).map((c) => c.id);
    const deckIds = auth.deck.map((c) => c.id);
    const hostOwned = collectObservedOwnIds(m.hostSse);
    const guestOwned = collectObservedOwnIds(m.guestSse);
    // 对手手牌 + 牌堆身份 + 对手归属的未揭示弃牌（自己的未揭示弃牌仅己方可见，允许出现在己方载荷）
    const oppHiddenForHost = new Set([
      ...auth.players.p2.hand.map((c) => c.id),
      ...deckIds,
      ...unrevealedDiscardIds.filter((id) => !hostOwned.has(id)),
    ]);
    const oppHiddenForGuest = new Set([
      ...auth.players.p1.hand.map((c) => c.id),
      ...deckIds,
      ...unrevealedDiscardIds.filter((id) => !guestOwned.has(id)),
    ]);
    if (oppHiddenForHost.size > 0 && oppHiddenForGuest.size > 0) {
      const hostRawAll = m.hostSse.allRawText() + m.host.rawHttpTexts.join('\n');
      const guestRawAll = m.guestSse.allRawText() + m.guest.rawHttpTexts.join('\n');
      auditRawLeakage(hostRawAll, oppHiddenForHost, '终局 host 载荷');
      auditRawLeakage(guestRawAll, oppHiddenForGuest, '终局 guest 载荷');
    } else {
      // 摊牌 0:0 结局可能已无对手手牌/牌堆等私密牌；脱敏结构审计已在上面通过
      console.log('[lan] 提示：终局已无剩余私密牌（摊牌/全结算），跳过原始载荷泄漏扫描');
    }
    console.log('[lan] 完整对局：' + steps + ' 步，已覆盖行动 ' + [...seen].join(',') +
      '，权威状态 ' + activeIds.length + ' 张牌守恒');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 7. 再来一局                                                         */
/* ================================================================== */

test('§3.7 再来一局：单方 ready 镜像、双方 ready 后新对局重置（v1.5 turnTimeLimit 保持）', async () => {
  const m = await setupMatch({ config: Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p1', turnTimeLimit: 15 }) });
  try {
    await submitBothLayouts(m);
    await H.sleep(120);
    // 用 autoplay 式流程快速打完（复用 playFullGame）
    await waitNextBoth(m, m.hostSse.latestUpdate().seq - 1, 'battle');
    await playFullGame(m);
    const { hs } = latestBoth(m);
    assert.strictEqual(hs.phase, 'gameover');
    // 单方 rematch
    const prev = m.hostSse.latestUpdate().seq;
    H.assertOk(await m.host.post(apiPath(m, 'rematch'), { token: m.host.token }), 'host 请求再来一局');
    const next = await waitNextBoth(m, prev, '单方 rematch 广播');
    assert.strictEqual(next.hu.meta.rematchReady.p1, true, 'host 视角 rematchReady.p1 应为 true');
    assert.strictEqual(next.hu.meta.rematchReady.p2, false);
    assert.strictEqual(next.gu.meta.rematchReady.p2, true, 'guest 视角 rematchReady.p2（对手）应为 true');
    assert.strictEqual(next.gu.meta.rematchReady.p1, false);
    assert.strictEqual(next.hu.state.phase, 'gameover', '单方准备后仍为终局');
    assert.strictEqual(next.gu.state.phase, 'gameover');
    // 双方 rematch → 新局
    const prev2 = m.hostSse.latestUpdate().seq;
    H.assertOk(await m.guest.post(apiPath(m, 'rematch'), { token: m.guest.token }), 'guest 请求再来一局');
    const next2 = await waitNextBoth(m, prev2, '双方 rematch 新局广播');
    assert.strictEqual(next2.hu.state.phase, 'layout', '双方准备后应开始新对局（layout）');
    assert.strictEqual(next2.gu.state.phase, 'layout');
    assert.strictEqual(next2.hu.state.regionWins.p1, 0);
    assert.strictEqual(next2.hu.state.regionWins.p2, 0);
    assert.strictEqual(next2.hu.state.players.p1.hand.length, 10);
    // v1.5：再来一局保持房间 config.turnTimeLimit
    assert.strictEqual(next2.hu.state.config.turnTimeLimit, 15, '再来一局应保持 turnTimeLimit=15（host 视角）');
    assert.strictEqual(next2.gu.state.config.turnTimeLimit, 15, '再来一局应保持 turnTimeLimit=15（guest 视角）');
    assert.strictEqual(next2.hu.meta.rematchReady.p1, false);
    assert.strictEqual(next2.hu.meta.rematchReady.p2, false);
    assertMirror(m, '再来一局新局');
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 8. 断线 presence / 重连快照                                         */
/* ================================================================== */

test('§5 断线重连：presence 通知、同 token 重连收到完整快照、seq 连续', async () => {
  const m = await setupMatch({});
  try {
    const prev = m.hostSse.latestUpdate().seq;
    // 断开 guest SSE
    m.guestSse.close();
    const presence = await m.hostSse.waitFor((e) => e.event === 'presence' && e.json.meta.players.p2 && e.json.meta.players.p2 && e.json.meta.players.p2.connected === false, 6000, 'guest 断线 presence');
    assert.strictEqual(presence.json.meta.players.p2.connected, false, 'host 应看到对手 connected=false');
    const seqBeforeReconnect = presence.json.seq;
    // 重连（同 token）
    const guestSse2 = new H.SseClient(srv.port, m.room.code, m.guest.token, 'guest2');
    await guestSse2.connect();
    const firstUpdate = await guestSse2.waitFor('update', 8000, '重连首帧 update');
    assert.ok(firstUpdate.json.state, '重连首帧应包含完整 state');
    assert.ok(firstUpdate.json.state.phase === 'layout' || firstUpdate.json.state.phase === 'battle');
    assert.ok(firstUpdate.json.seq >= seqBeforeReconnect, '重连 update seq 不应倒退');
    // GET 快照与 SSE 首帧一致（state 相同）
    const snap = await m.guest.get('/api/rooms/' + m.room.code, { queryToken: true });
    const sj = H.assertOk(snap, '重连快照');
    assert.deepStrictEqual(H.publicProjection(sj.state, { guestSwap: true }), H.publicProjection(firstUpdate.json.state, { guestSwap: true }), '快照与 SSE 首帧公开信息一致');
    assert.ok(sj.seq >= firstUpdate.json.seq, '快照 seq 不应小于最近 SSE 首帧（实际 ' + sj.seq + ' vs ' + firstUpdate.json.seq + '）');
    // host 收到 presence connected=true
    const reconnected = await m.hostSse.waitFor((e) => e.event === 'presence' && e.json.meta.players.p2 && e.json.meta.players.p2.connected === true, 6000, '重连 presence');
    assert.ok(reconnected);
    // 重连后仍可正常行动/提交
    guestSse2.close();
    m.guestSse = guestSse2; // 供 leaveAll 关闭
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 9. 离开房间                                                         */
/* ================================================================== */

test('§3.8/§5 一方 leave：对手收到 room_closed(peer_left)，房间销毁', async () => {
  const m = await setupMatch({});
  try {
    const closedP = m.guestSse.waitFor('room_closed', 6000, 'guest 收到 room_closed');
    H.assertOk(await m.host.post(apiPath(m, 'leave'), { token: m.host.token }), 'host 离开');
    const closed = await closedP;
    assert.strictEqual(closed.json.reason, 'peer_left');
    // 房间不存在
    const snap = await m.guest.get('/api/rooms/' + m.room.code, { queryToken: true });
    H.assertApiError(snap, { status: 404, code: 'ROOM_NOT_FOUND' }, '离开后快照');
    m.close();
  } finally {
    m.guestSse.close();
  }
});

/* ================================================================== */
/* 10. 并发房间互不干扰                                                */
/* ================================================================== */

test('§5 并发房间：两个房间独立引擎状态/视图，互不影响', async () => {
  const m1 = await setupMatch({ hostName: 'A', guestName: 'B' });
  const m2 = await setupMatch({ hostName: 'C', guestName: 'D' });
  try {
    assert.notStrictEqual(m1.room.code, m2.room.code, '两个房间码应不同');
    // 房间 1 提交 host 布局（只影响房 1）
    const { hs } = latestBoth(m1);
    H.assertOk(await m1.host.post(apiPath(m1, 'layout'), { token: m1.host.token, cardIds: hs.players.p1.hand.slice(0, 5).map((c) => c.id) }), '房1 host 布阵');
    await H.sleep(120);
    const s1 = m1.hostSse.latestUpdate().state;
    const s2 = m2.hostSse.latestUpdate().state;
    assert.strictEqual(s1.layout.submitted.p1, true);
    assert.strictEqual(s2.layout.submitted.p1, false, '房 2 不应受房 1 影响');
    assert.strictEqual(s2.layout.submitted.p2, false);
    const info = H.assertOk(await H.request(srv.port, 'GET', '/api/info'), '并发 /api/info');
    assert.ok(info.rooms >= 2, 'info.rooms 应包含并发房间');
    // 各自镜像仍正确
    assertMirror(m1, '并发房1');
    assertMirror(m2, '并发房2');
  } finally {
    await m1.leaveAll();
    await m2.leaveAll();
  }
});

/* ================================================================== */
/* 11. SSE 鉴权 / 重复连接                                              */
/* ================================================================== */

test('§3.4/§5 SSE：坏 token 拒绝；同 token 二次连接旧流被关闭，新流正常', async () => {
  const m = await setupMatch({});
  try {
    // 坏 token SSE
    const badSse = new H.SseClient(srv.port, m.room.code, 'f'.repeat(32), 'bad');
    let badErr = null;
    try {
      await badSse.connect();
      await H.sleep(200);
    } catch (e) {
      badErr = e;
    }
    // 服务器对 SSE 坏 token 可以在握手前返回 403（connect 抛错），也可能先 200 再发送 error 事件
    const gotErrorEvent = badSse.events.some((e) => e.event === 'error');
    assert.ok(badErr || gotErrorEvent, '坏 token SSE 应被拒绝（403 或 error 事件）');
    badSse.close();
    // 重复连接：同 token 新流应替换旧流
    const oldGuest = m.guestSse;
    const newGuest = new H.SseClient(srv.port, m.room.code, m.guest.token, 'guest-new');
    await newGuest.connect();
    await newGuest.waitFor('update', 8000, '新流首帧');
    const oldEnded = await oldGuest.waitEnded(3000);
    assert.ok(oldEnded, '同 token 二次连接后旧 SSE 流应被服务器关闭');
    newGuest.close();
  } finally {
    await m.leaveAll();
  }
});

/* ================================================================== */
/* 12. 等待房间 leave / host 快照                                      */
/* ================================================================== */

test('§3.8 waiting 房间：host 快照 state=null；leave 后房间销毁', async () => {
  const host = new H.HttpClient(srv.port, 'host');
  const room = await H.createRoom(srv.port, host, { name: '房主', config: DEFAULT_CONFIG });
  const snap = await host.get('/api/rooms/' + room.code, { queryToken: true });
  const sj = H.assertOk(snap, 'waiting 快照');
  assert.strictEqual(sj.state, null);
  assert.strictEqual(sj.meta.status, 'waiting');
  assert.strictEqual(sj.meta.players.p2, null);
  H.assertOk(await host.post('/api/rooms/' + room.code + '/leave', { token: host.token }), 'waiting 房间 leave');
  const after = await H.request(srv.port, 'GET', '/api/rooms/' + room.code + '?token=' + host.token);
  H.assertApiError(after, { status: 404, code: 'ROOM_NOT_FOUND' }, '销毁后快照');
});

test('§3.2 房间满员：第三方 join 返回 ROOM_FULL', async () => {
  const m = await setupMatch({});
  try {
    const third = new H.HttpClient(srv.port, 'third');
    const res = await third.post('/api/rooms/' + m.room.code + '/join', { name: '第三人' });
    H.assertApiError(res, { status: 409, code: 'ROOM_FULL' }, '房间满员加入');
  } finally {
    await m.leaveAll();
  }
});

test('§7.2 v1.3 结算随机性：房间 settleCards=4 透传、drawn 数组长度=4、公开可见且双向镜像', async () => {
  const cfg = Object.assign({}, DEFAULT_CONFIG, { settleCards: 4, difficulty: 2, firstPlayer: 'p1' });
  const m = await setupMatch({ config: cfg });
  try {
    const { hs } = latestBoth(m);
    assert.strictEqual(hs.config.settleCards, 4, '房间配置 settleCards 应透传到引擎');
    assert.strictEqual(hs.endgame.threshold, 2 * 5, '初始决战阈值 = 2R = 10');
    const roomSnap = await m.host.get('/api/rooms/' + m.room.code, { queryToken: true });
    const sj = H.assertOk(roomSnap, '房间快照');
    assert.ok(sj.state && sj.state.config, '快照应含 state');
    assert.strictEqual(sj.state.config.settleCards, 4, '服务器快照 config.settleCards 应透传');
    await submitBothLayouts(m);
    await H.sleep(120);

    async function act(sse, client, action, label) {
      const prev = m.hostSse.latestUpdate().seq;
      H.assertOk(await client.post(apiPath(m, 'action'), { token: client.token, action }), label);
      const next = await waitNextBoth(m, prev, label + ' 广播');
      assertEventBatchMirror(next.hu.events || [], next.gu.events || [], label);
      return next;
    }
    const legalH = () => H.legalFromView(m.hostSse.latestUpdate().state);
    const legalG = () => H.legalFromView(m.guestSse.latestUpdate().state);
    // v1.4 行动点：host 放牌(1)+翻牌(2) 同回合用尽 3 点 → 换 guest；guest 放牌(1)+摸牌(2) → 换 host 结算
    await act(m.hostSse, m.host, legalH().find((a) => a.type === 'place' && a.regionId === 0), 'host 放牌');
    await act(m.hostSse, m.host, legalH().find((a) => a.type === 'flip' && a.regionId === 0), 'host 翻牌（3 点用尽，换 guest）');
    await act(m.guestSse, m.guest, legalG().find((a) => a.type === 'place' && a.regionId === 0), 'guest 放牌');
    await act(m.guestSse, m.guest, legalG().find((a) => a.type === 'draw'), 'guest 摸牌（3 点用尽，换 host）');
    const viewHBefore = m.hostSse.latestUpdate().state;
    const preDeck = viewHBefore.deck.length;
    const settleAction = legalH().find((a) => a.type === 'settle' && a.regionId === 0);
    assert.ok(settleAction, '区域0 应可结算（v1.4 任意未结算区域均可，AP=3）');
    const next = await act(m.hostSse, m.host, settleAction, 'host 结算 N=4');
    const settleH = (next.hu.events || []).find((e) => e.type === 'settle');
    const settleG = (next.gu.events || []).find((e) => e.type === 'settle');
    assert.ok(settleH && settleG, '双方应收到 settle 事件');
    assert.strictEqual(settleH.settleCards, 4);
    assert.strictEqual(settleH.drawn.p1.length, 4, 'drawn.p1 长度 = settleCards');
    assert.strictEqual(settleH.drawn.p2.length, 4, 'drawn.p2 长度 = settleCards');
    for (const c of settleH.drawn.p1.concat(settleH.drawn.p2)) {
      assert.ok(!c.hidden && c.revealed, '结算补牌为公开正面牌，不得脱敏');
    }
    const rb = settleH.regionBefore;
    const sumH1 = rb.sides.p1.faceUp.reduce((n, c) => n + c.value, 0) + settleH.drawn.p1.reduce((n, c) => n + c.value, 0);
    assert.strictEqual(settleH.sums.p1, sumH1, 'sums 应含补牌和');
    const { hs: hs2 } = latestBoth(m);
    assert.strictEqual(hs2.deck.length, preDeck - 8, '单独结算 N=4 消耗 2N=8 张牌');
    assert.strictEqual(hs2.regions[0].status, 'settled');
    assert.strictEqual(hs2.regions[0].result.settleCards, 4);
    assert.deepStrictEqual(hs2.regions[0].result.drawn.p1.map((c) => c.id), settleH.drawn.p1.map((c) => c.id), 'result.drawn 与事件一致');
    const openCount = hs2.regions.filter((r) => r.status === 'open').length;
    assert.strictEqual(H.E.getEndgameThreshold(hs2), 2 * openCount, '结算后阈值 = 2×未结算区域数');
    // 原始载荷：结算后对手私密手牌仍不泄漏（补牌是公开牌，允许出现）
    const { gs: gs2 } = latestBoth(m);
    const hostSecrets = H.extractOwnSecrets(hs2);
    const guestSecrets = H.extractOwnSecrets(gs2);
    auditRawLeakage(m.hostSse.allRawText() + m.host.rawHttpTexts.join('\n'), guestSecrets, 'N=3 结算后 host 载荷');
    auditRawLeakage(m.guestSse.allRawText() + m.guest.rawHttpTexts.join('\n'), hostSecrets, 'N=3 结算后 guest 载荷');
    assertMirror(m, 'N=3 结算后');
  } finally {
    await m.leaveAll();
  }
});

test('§7.2 v1.2 提前锁定：双方 result.early/unsettledRegions 镜像，锁定后不再产生结算事件', async () => {
  const cfg = Object.assign({}, DEFAULT_CONFIG, { regionCount: 3, settleCards: 1, difficulty: 2, firstPlayer: 'p1' });
  let found = null;
  for (let attempt = 0; attempt < 3 && !found; attempt++) {
    const m = await setupMatch({ config: cfg });
    try {
      await submitBothLayouts(m);
      await waitNextBoth(m, m.hostSse.latestUpdate().seq - 1, 'battle');
      await playFullGame(m, { maxSteps: 400 });
      const { hs, gs } = latestBoth(m);
      assert.strictEqual(hs.phase, 'gameover');
      assert.strictEqual(!!hs.result.early, !!gs.result.early, '双方 early 镜像');
      assert.deepStrictEqual((hs.result.unsettledRegions || []).slice().sort(),
        (gs.result.unsettledRegions || []).slice().sort(), '双方 unsettledRegions 一致');
      if (hs.result.early) {
        assert.strictEqual(hs.result.reason, 'region_wins');
        const openH = hs.regions.filter((r) => r.status === 'open').map((r) => r.id).sort();
        assert.deepStrictEqual(openH, (hs.result.unsettledRegions || []).slice().sort(), '未结算区域应与 open 一致');
        const allEvents = [];
        for (const e of m.hostSse.events) {
          const j = e.json;
          if (j && Array.isArray(j.events)) allEvents.push(...j.events);
        }
        const goIdx = allEvents.map((e, i) => (e.type === 'game_over' ? i : -1)).filter((i) => i >= 0).pop();
        assert.ok(goIdx >= 0, '应收到 game_over 事件');
        const afterGo = allEvents.slice(goIdx + 1).filter((e) => ['settle', 'endgame_settle', 'game_over'].includes(e.type));
        assert.deepStrictEqual(afterGo, [], 'game_over 之后不得再有结算/终局事件');
        const endgameSettleIds = allEvents.slice(0, goIdx).filter((e) => e.type === 'endgame_settle').map((e) => e.regionId);
        for (const rid of hs.result.unsettledRegions) {
          assert.ok(endgameSettleIds.indexOf(rid) < 0, '未结算区域不应被同时结算：区域 ' + rid);
        }
        if (hs.endgame.triggered) {
          assert.strictEqual(hs.deck.length, 0, 'v1.3 决战触发后牌堆已摸空');
        }
        found = 'early';
      } else if (hs.endgame.triggered) {
        assert.strictEqual(hs.deck.length, 0, '决战未提前锁定时牌堆应耗尽');
        found = 'endgame';
      } else {
        found = 'individual';
      }
    } finally {
      await m.leaveAll();
    }
  }
  assert.ok(found, '应完成对局（R=3 简单结算）');
  console.log('[lan] v1.2 终局路径：' + found);
});

test('§7.1-10 服务器可编程启动（端口 0）+ lanUrls 正确', async () => {
  assert.ok(srv.port > 0, '端口 0 启动后应分配实际端口');
  assert.ok(Array.isArray(srv.lanUrls) && srv.lanUrls.length >= 1);
  assert.ok(srv.lanUrls.every((u) => /^http:\/\/.+:\d+$/.test(u)), 'lanUrls 格式');
});

/* ================================================================== */
/* 9. v1.3 战略决战 LAN 覆盖                                            */
/* ================================================================== */

/** 按策略驱动一步 LAN 行动：返回该步事件（host 视角）。 */
async function lanStep(match, choose) {
  const { hs } = latestBoth(match);
  assert.strictEqual(hs.phase, 'battle', '仅 battle 阶段可驱动');
  const actorIsHost = hs.turn === 'p1';
  const actorClient = actorIsHost ? match.host : match.guest;
  const view = (actorIsHost ? match.hostSse : match.guestSse).latestUpdate().state;
  const legal = H.legalFromView(view);
  assert.ok(legal.length > 0, '当前行动方无合法行动');
  const action = choose(legal, view, actorIsHost ? 'host' : 'guest');
  assert.ok(action, '策略未选出行动（合法类型：' + legal.map((a) => a.type).join(',') + '）');
  const prev = match.hostSse.latestUpdate().seq;
  H.assertOk(await actorClient.post(apiPath(match, 'action'), { token: actorClient.token, action }), 'LAN v1.3 行动');
  const next = await waitNextBoth(match, prev, 'LAN v1.3 行动广播');
  assertEventBatchMirror(next.hu.events || [], next.gu.events || [], 'v1.3 行动 seq=' + next.hu.seq + ' ' + JSON.stringify(action));
  assertMirror(match, 'v1.3 行动后');
  return { events: next.hu.events || [], action };
}

test('§7.3 v1.3 战略决战：endgame_start/draw/skip/showdown/确定性结算 双向镜像与脱敏', async () => {
  const cfg = Object.assign({}, DEFAULT_CONFIG, { regionCount: 5, settleCards: 2, difficulty: 2, firstPlayer: 'p1' });
  const m = await setupMatch({ config: cfg });
  const seen = { start: null, draws: [], skips: [], showdown: null, settles: [] };
  try {
    await submitBothLayouts(m);
    await waitNextBoth(m, m.hostSse.latestUpdate().seq - 1, 'battle');
    for (let step = 0; step < 240; step++) {
      const { hs } = latestBoth(m);
      if (hs.phase === 'gameover') break;
      const { events } = await lanStep(m, (legal) => {
        const view = m.hostSse.latestUpdate().state;
        const inBuild = !!(view.endgame && view.endgame.triggered && view.endgame.phase === 'build');
        if (!inBuild) {
          const draw = legal.find((a) => a.type === 'draw');
          return draw || H.pickPlanAction(legal);
        }
        return legal.find((a) => a.type === 'place') || legal.find((a) => a.type === 'flip') || H.pickPlanAction(legal);
      });
      for (const ev of events) {
        if (ev.type === 'endgame_start') {
          seen.start = ev;
          const X = ev.openRegionIds.length;
          assert.strictEqual(ev.drawPerPlayer, X, 'endgame_start.drawPerPlayer = X');
          assert.strictEqual(ev.threshold, 2 * X, 'endgame_start.threshold = 2X');
          assert.ok(ev.deckCount <= 2 * X, '触发时牌堆 ≤ 2X');
          assert.strictEqual(ev.drawnCounts.p1 + ev.drawnCounts.p2, ev.deckCount, 'drawnCounts 合计 = 触发时牌堆');
        } else if (ev.type === 'endgame_draw') {
          assert.ok(!('card' in ev), 'endgame_draw 不得携带牌面');
          seen.draws.push(ev);
        } else if (ev.type === 'endgame_skip') {
          assert.ok(!('card' in ev), 'endgame_skip 不得携带牌面');
          seen.skips.push(ev);
        } else if (ev.type === 'endgame_showdown') {
          seen.showdown = ev;
          assert.strictEqual(ev.deckCount, 0, 'showdown 时牌堆为 0');
          assert.strictEqual(ev.threshold, 2 * ev.openRegionIds.length, 'showdown threshold = 2X');
        } else if (ev.type === 'endgame_settle') {
          seen.settles.push(ev);
          assert.strictEqual(ev.deterministic, true, '摊牌结算 deterministic=true');
          assert.strictEqual(ev.drawnCount, 0, '摊牌 drawnCount=0');
          assert.deepStrictEqual(ev.drawn, { p1: [], p2: [] }, '摊牌 drawn 为空数组（镜像到双方）');
          assert.strictEqual(ev.regionResult.difficultyDraw, null, '摊牌不执行难度规则');
        } else if (ev.type === 'settle') {
          assert.strictEqual(ev.drawn.p1.length, cfg.settleCards, '单独结算 drawn 长度=N');
          assert.strictEqual(ev.drawn.p2.length, cfg.settleCards);
        }
      }
    }
    const { hs, gs } = latestBoth(m);
    assert.strictEqual(hs.phase, 'gameover', 'LAN 决战对局应到达终局');
    assert.ok(seen.start, '应捕获 endgame_start');
    assert.strictEqual(seen.draws.length, 2, '应捕获 p1/p2 两个 endgame_draw，实际 ' + seen.draws.length);
    assert.ok(seen.showdown, '应捕获 endgame_showdown');
    assert.ok(seen.settles.length >= 1, '应捕获摊牌结算');
    if (!seen.settles.some((e) => e.deterministic)) assert.fail('缺少 deterministic 摊牌结算');
    assert.strictEqual(!!hs.result.early, !!gs.result.early, '提前锁定 early 镜像');
    assert.deepStrictEqual((hs.result.unsettledRegions || []).slice().sort(),
      (gs.result.unsettledRegions || []).slice().sort(), 'unsettledRegions 镜像');
    assert.strictEqual(hs.endgame.triggered, true);
    assert.strictEqual(hs.deck.length, 0, '终局牌堆为空');
    assertMirror(m, 'v1.3 决战终局');
  } finally {
    await m.leaveAll();
  }
});

test('§7.4 v1.3 7 区房间：标准 54 张/初始 14 张/阈值 14，可打到摊牌', async () => {
  const cfg = Object.assign({}, DEFAULT_CONFIG, { regionCount: 7, settleCards: 4, difficulty: 2, firstPlayer: 'p1' });
  const m = await setupMatch({ config: cfg });
  try {
    const { hs } = latestBoth(m);
    assert.strictEqual(hs.config.regionCount, 7, '7 区配置透传');
    assert.strictEqual(hs.config.settleCards, 4, '7 区 + 复杂(4) 合法透传');
    assert.strictEqual(hs.players.p1.hand.length, 14, '7 区初始手牌 14');
    assert.strictEqual(hs.endgame.threshold, 14, '7 区初始阈值 = 2R = 14');
    await submitBothLayouts(m);
    await waitNextBoth(m, m.hostSse.latestUpdate().seq - 1, '7 区 battle');
    const after = latestBoth(m).hs;
    assert.strictEqual(after.deck.length, 25, '7 区布局后牌堆 25（54 - 28 - 1）');
    assert.strictEqual(after.players.p1.hand.length, 7, '先手 7 区布局后手牌 7');
    assert.strictEqual(after.players.p2.hand.length, 8, '后手 7 区布局后手牌 7 + 补偿 1 = 8');
    assert.strictEqual(after.config.compensationDraw, 1, 'v2.1 7 区后手补偿固定 1');
    assert.strictEqual(after.regions.reduce((n, r) => n + r.sides.p1.faceUp.length + r.sides.p2.faceUp.length, 0), 14, '区域正面牌 14');

    let start = null;
    for (let step = 0; step < 260; step++) {
      const view = latestBoth(m).hs;
      if (view.phase === 'gameover') break;
      const { events } = await lanStep(m, (legal) => {
        const st = m.hostSse.latestUpdate().state;
        const inBuild = !!(st.endgame && st.endgame.triggered && st.endgame.phase === 'build');
        if (!inBuild) {
          const draw = legal.find((a) => a.type === 'draw');
          return draw || H.pickPlanAction(legal);
        }
        return legal.find((a) => a.type === 'place') || legal.find((a) => a.type === 'flip') || H.pickPlanAction(legal);
      });
      const es = events.find((e) => e.type === 'endgame_start');
      if (es) {
        start = es;
        assert.deepStrictEqual(es.openRegionIds, [0, 1, 2, 3, 4, 5, 6], '7 区决战覆盖全部 7 区');
        assert.strictEqual(es.drawPerPlayer, 7, 'drawPerPlayer=7');
        assert.strictEqual(es.threshold, 14, 'threshold=14');
        assert.strictEqual(es.settleCards, 4, 'settleCards=4');
      }
    }
    const { hs: end, gs: endG } = latestBoth(m);
    assert.strictEqual(end.phase, 'gameover', '7 区 LAN 对局应到达终局');
    assert.ok(start, '7 区应触发战略决战');
    assert.deepStrictEqual({ p1: start.drawnCounts.p1, p2: start.drawnCounts.p2 },
      { p1: 7, p2: 7 }, '牌堆 14 = 双方各摸 7 张');
    assert.strictEqual(end.endgame.triggered, true);
    assert.strictEqual(end.deck.length, 0);
    assert.strictEqual(!!end.result.early, !!endG.result.early);
    assertMirror(m, '7 区 v1.3 终局');
  } finally {
    await m.leaveAll();
  }
});

test('§5/§7 v1.5 防拖延：连续两回合空过 → forfeit 事件与 result 双端镜像', async () => {
  const cfg = Object.assign({}, DEFAULT_CONFIG, { firstPlayer: 'p1' });
  const m = await setupMatch({ hostName: '房主', guestName: '客机', config: cfg });
  try {
    await submitBothLayouts(m);
    await waitNextBoth(m, m.hostSse.latestUpdate().seq - 1, 'battle start');
    async function act(client, action, label) {
      const prev = m.hostSse.latestUpdate().seq;
      H.assertOk(await client.post(apiPath(m, 'action'), { token: client.token, action }), label);
      const nx = await waitNextBoth(m, prev, label + ' 广播');
      assertEventBatchMirror(nx.hu.events || [], nx.gu.events || [], label);
      return nx;
    }
    await act(m.host, { type: 'end_turn' }, 'host 空过 1');
    let hs = m.hostSse.latestUpdate().state;
    assert.strictEqual(hs.phase, 'battle');
    assert.strictEqual(hs.players.p1.stallCount, 1, 'host 第一回合空过 stallCount=1');
    await act(m.guest, { type: 'end_turn' }, 'guest 空过');
    const fin = await act(m.host, { type: 'end_turn' }, 'host 空过 2');
    hs = m.hostSse.latestUpdate().state;
    const gs = m.guestSse.latestUpdate().state;
    assert.strictEqual(hs.phase, 'gameover');
    assert.strictEqual(hs.result.reason, 'forfeit');
    assert.strictEqual(hs.result.forfeitedBy, 'p1', 'host 视角认输方是自己 p1');
    assert.strictEqual(hs.result.winner, 'p2', 'host 视角胜者为对手 p2');
    assert.strictEqual(gs.result.forfeitedBy, 'p2', 'guest 视角认输方是 p2（镜像后的对手）');
    assert.strictEqual(gs.result.winner, 'p1', 'guest 视角胜者是自己 p1');
    assert.deepStrictEqual(hs.result.unsettledRegions, gs.result.unsettledRegions, '未结算区域双端一致');
    const evH = (fin.hu.events || []).find((e) => e.type === 'forfeit');
    const evG = (fin.gu.events || []).find((e) => e.type === 'forfeit');
    assert.ok(evH && evG, '双方都应收到 forfeit 事件');
    assert.strictEqual(evH.playerId, 'p1');
    assert.strictEqual(evG.playerId, 'p2');
    assert.ok((fin.hu.events || []).some((e) => e.type === 'game_over'), 'host 应收到 game_over');
    const bad = await m.host.post(apiPath(m, 'action'), { token: m.host.token, action: { type: 'end_turn' } });
    assert.ok(bad.status >= 400 && bad.status < 500, '终局后行动应被拒绝（4xx，实际 ' + bad.status + '）');
    assertMirror(m, 'forfeit 终局');
  } finally {
    await m.leaveAll();
  }
});









