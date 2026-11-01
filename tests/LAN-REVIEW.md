# LAN 服务器独立测试报告（qa-dev · task-8）

> 被测：`server.js`（局域网权威服务器，`createLanServer`）
> 契约：`docs/LAN.md`（§3 API / §4 镜像+脱敏 / §5 可靠性 / §7.1 测试清单）
> 测试：`tests/lan.test.js`（18 项）+ `tests/lan-helpers.js`（零依赖 HTTP/SSE 客户端与审计工具）
> 运行：`node tests/lan.test.js`；`node tests/run-all.js [--games=N] [--skip-lan]`

## 0. 结论

- **18/18 通过，连续 8 次运行 0 失败**（服务器每局随机 seed，测试断言基于镜像观测与权威状态，不依赖具体牌序）。
- 全量回归：`node tests/run-all.js --games=300` → engine 51/51、edge 13/13、ai 11/11、**LAN 18/18**、sim 300 局全过，总耗时 5.3s。
- 首轮发现并上报 **2 个 P0 + 1 个 P1**，Lead 已修复并回归通过：
  1. **P0** 视图下发 `config.seed` 与 `_rngState` → 对手可用引擎在本地完整重建牌堆/双方手牌（已用攻击脚本复验：泄露时重建手牌与实际逐张一致；修复后视图 `seed=null`、无 `_rngState`，回归用例 `§4.2 脱敏结构审计` 覆盖）。
  2. **P0** 后手额外摸牌牌面经 `state.log` 泄漏给对手（`js/engine.js` finalizeLayout 旧日志含 `♥8`）→ 已改为不含牌面的公开日志，回归用例 `§4.2/§4.3 事件脱敏` 按「真值牌面不得出现在对手日志」断言。
  3. **P1** `meta` 缺少契约字段 `turn` → 已补（镜像后），回归用例 `§3.3/§4.1 加入房间` 断言 `meta.turn === state.turn`。

## 1. 脱敏审计策略（可证伪）

1. **结构审计**（`auditViewRedaction`）：每个视图逐一断言
   - 对手手牌 / 对手区域背面牌 / 牌堆 → 全部为占位卡：`hidden:true, id:/^hidden-/, rank:'?', suit:null, suitSymbol:'', red:false, value:0, joker:false, revealed:false`，且数量与对端视图的真实数量交叉一致；
   - 已揭示弃牌可为真实牌；未揭示弃牌必须是占位卡；
   - 揭示前对手 `layout.assignments` 必须为 null/空；
   - 直查 `config.seed` / `_rngState` 不得存在（间接回放泄漏）。
2. **原始载荷泄漏扫描**（`auditRawLeakage`）：保留每个客户端收到的**原始 SSE data 文本与全部 HTTP 响应原文**，用带引号的精确 token（如 `"d-5"`）搜索私密牌 id（避免占位卡 tag 子串误报，如 `hidden-allcards-2`/`hidden-discard-8`）。
   - 终局真值取**服务器权威状态**（`srv.rooms.get(code).state`）：对手手牌 + 牌堆身份 + **对手归属的未揭示弃牌**（归属由该客户端自己视角观察过的真实牌集合推断；自己的未揭示弃牌按契约允许出现在己方载荷）。
   - 中局另外用「自己视角私密牌集合」扫描对手载荷（布局阶段/揭示后）。
3. **事件脱敏**：`place/move/draw/extra_draw` 对手事件 card 必须占位；`action.cardId` 对手为 `hidden`；难度摸牌仅收取方可见；`settle.regionBefore` 对手背牌占位；逐事件断言（双向）。
4. **镜像审计**：定义「公开投影」（phase/turn/deckCount/比分/区域公开正面牌与结果/手牌数/胜因等），guest 投影做 p1↔p2 交换后与 host 投影逐字段相等；事件按 host/guest 规范身份归一化后逐批比较；`meta` 的 players/host/rematchReady/turn 镜像。
5. **服务端权威状态完整性**：终局时 `srv.rooms.state` 活跃牌 id 唯一且数量 = 牌堆构成（防状态污染/镜像串写）。

## 2. LAN.md §7.1 清单覆盖

| §7.1 | 用例 | 结果 |
|---|---|---|
| 1 info / 创建 token+code / waiting state=null | `§3.1`、`§3.2/3.3 创建房间` | ✅ |
| 2 加入后双方 layout；host/guest 均视自己为 p1 | `§3.3/§4.1 加入房间` | ✅ |
| 3 脱敏审计（对手手牌/牌堆/布局分配/难度摸牌） | `§4.2 脱敏结构`、`§4.2 原始载荷`、`§4.2/§4.3 事件脱敏` | ✅ |
| 4 双方提交布局→揭示→battle，先手镜像 | `§3.5/§4.3 双方提交布局`（含 extra_draw 可见性、事件镜像） | ✅ |
| 5 两客户端轮流行动完整对局（含决战/终局镜像） | `§3.6 五行动协议覆盖`、`§7.1-5 完整对局`（镜像逐 seq、事件镜像、result/handSums/regionWins 镜像、终局后拒绝行动） | ✅ |
| 6 非法请求 4xx + 状态不变 | `§3.5/§3.6/§5 错误码`（坏 token/非轮次/非法行动/阶段错误/房间不存在/满员/畸形 JSON/>64KB/未知接口；快照前后 state 全等） | ✅ |
| 7 断线重连 presence/快照 | `§5 断线重连`（断开→对端 presence connected=false→同 token 重连→完整 state+seq、快照一致性、恢复 presence） | ✅ |
| 8 rematch（单方 ready 镜像、双方后新局重置） | `§3.7 再来一局` | ✅ |
| 9 leave→room_closed(peer_left)、房间销毁 | `§3.8/§5 一方 leave`（对端收到 room_closed，之后 404） | ✅ |
| 10 并发房间 + 端口 0 编程启动 | `§5 并发房间`、`§7.1-10 编程启动` | ✅ |
| 5（补充）五种行动各一次 | `§3.6 五行动协议覆盖`：place→move→flip→settle→draw 逐步通过服务器校验，事件双向镜像 | ✅ |
| 补充 | 静态资源（/、/js/engine.js、/css）、路径穿越拒绝；SSE 坏 token 拒绝、同 token 二次连接旧流被关闭 | ✅ |

## 3. 已知限制 / P3 观察（非缺陷）

1. **10 分钟房间 TTL 与 15s 心跳**未做长等待测试（耗时原因）；逻辑代码存在，建议 Lead 自测或后续补短 TTL 可配置钩子。
2. 占位卡 id 形如 `hidden-discard-8-undefined`（`sanitizeStateFor` 中 `hiddenCard('discard-' + i)` 少传第二个参数导致 tag 里出现 `undefined`）。仅内部占位 id，**不泄露任何信息**，但建议改为 `hiddenCard('discard', i)` 以统一格式（P3 清理项）。
3. 快照 `GET /api/rooms/:code` 返回 `{ok:true, seq, type, state, events, meta}`，比 SSE `data` 多 `ok` 包装字段（超集，不违反「同 data 结构」）。
4. `leave` 时离开者自身也会收到 `room_closed`（随后房间销毁）；不影响对手提示。
5. 房间创建上限 200（MAX_ROOMS）未做压力测试。

## 4. 复现

```bash
cd poker-duel
node tests/lan.test.js              # LAN 集成测试（18 项）
node tests/run-all.js --games=300   # 旧单机回归 + LAN + 模拟
node server.js 5200                 # 手工联调（浏览器 http://127.0.0.1:5200/）
```

测试用 `createLanServer().listen(0,'127.0.0.1')` 以端口 0 启动，结束后 `close()`；SSE 客户端保留原始 data 文本用于审计；audit 失败时输出泄漏 id 与载荷上下文。
