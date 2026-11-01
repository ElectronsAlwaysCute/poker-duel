# 局域网联机（LAN Multiplayer）协议与架构

> 目标：同一局域网内两台设备（或同一浏览器两个标签页）通过 Web 进行双人对战。
> 保持单机模式（file:// 双击）完全可用；局域网模式需要运行 Node 服务器 `server.js`。
> 本文是 LAN 功能的唯一契约。规则本身不变，仍以 `docs/RULES.md` 为准。

## 1. 总体架构

```
浏览器 A（host）                 Node 服务器 server.js（权威）                 浏览器 B（guest）
  ── HTTP POST 操作 ──▶   引擎 Engine（唯一权威状态）  ◀── HTTP POST 操作 ──
  ◀── SSE 实时推送 ───     每客户端生成「镜像+脱敏」视图    ── SSE 实时推送 ──▶
```

- **权威服务器**：Node 进程持有每个房间唯一一份 `Engine` 状态；客户端只发送动作意图，服务器校验后执行并广播。
- **零依赖**：仅使用 Node 内置模块（`http`/`fs`/`crypto`/`os`/`path`）；实时通道使用 **SSE**（浏览器 `EventSource`）+ `fetch` POST，不引入 WebSocket 库。
- **单机模式不变**：`index.html` 在 `file://` 或 `node tools/serve.js` 下仍为本地单机；LAN 模式检测到 `/api/info` 可用才启用。
- **服务器还负责静态文件**：`server.js` 同时提供本项目静态资源与 LAN API；启动后打印局域网访问地址。

## 2. 启动与访问

```bash
cd poker-duel
node server.js                 # 默认端口 5200，监听 0.0.0.0
node server.js 5200            # 指定端口
```

启动输出示例：
```
[lan] 本机访问   http://127.0.0.1:5200/
[lan] 局域网访问 http://192.168.1.23:5200/
```

- 两台设备浏览器打开同一个「局域网访问」地址（同一局域网、防火墙允许该端口）。
- 一方创建房间，另一方用房间码加入；房间创建后服务器自动生成对局（不等待时才创建引擎状态）。
- 端口冲突时换一个端口（默认 5200）。

## 3. HTTP API（JSON）

约定：所有 API 返回 JSON；失败返回 HTTP 4xx/5xx + `{ ok:false, error:{ code, message } }`。
错误码：`BAD_REQUEST` / `ROOM_NOT_FOUND` / `ROOM_FULL` / `BAD_TOKEN` / `BAD_PHASE` / `ILLEGAL_ACTION` / `SERVER_BUSY` / `ROOM_CLOSED`。

### 3.1 服务信息
`GET /api/info` →
```json
{ "ok": true, "version": "1.5.0", "engineVersion": "1.5.0",
  "lanUrls": ["http://192.168.1.23:5200"], "rooms": 2, "uptimeSec": 120 }
```

### 3.2 创建房间（host）
`POST /api/rooms`
```json
{ "name": "阿伟", "config": { "regionCount": 5, "difficulty": 1, "settleCards": 2,
  "turnTimeLimit": 30, "firstPlayer": "random" } }
```
- `settleCards` = 结算随机性（1/2/4，默认 2）；`turnTimeLimit` = 回合倒计时秒数（v1.5，默认 30，0=关闭；服务端经 engine 校验）；房主创建房间时决定，guest 使用同一配置（通过双方 `state.config` 下发）。
- 标准 54 张牌堆对 3/5/7 区域均支持 1/2/4 三档结算随机性（3/5/7 区均满足布局后牌堆 > 初始阈值 `2R`）。7 区 + 复杂会较快进入决战，属规则后果。
- `deck` 字段向后兼容但仍可省略：v1.2 起 UI 固定标准 54 张牌堆（J/Q/K/王），服务器不再依赖自定义牌堆。
→
```json
{ "ok": true, "room": { "code": "K7M2Q", "token": "<32hex>", "playerId": "p1",
  "state": null, "meta": { "status": "waiting", "me": "p1", "code": "K7M2Q",
    "lanUrls": ["http://192.168.1.23:5200"], "players": {
      "p1": { "name": "阿伟", "connected": true }, "p2": null } } } }
```
- 房间创建后处于 `waiting`，`state` 为 null；等 guest 加入后服务器创建对局并推送初始 state。
- 同一 host 最多同时保有 1 个活动房间（简单起见，创建新房间自动关闭旧房间）。

### 3.3 加入房间（guest）
`POST /api/rooms/:code/join` `{ "name": "小明" }`
→ `{ ok:true, room:{ code, token, playerId:"p2", state, meta } }`（此时 state 已是布局阶段）
- 服务器创建引擎状态（seed 随机）→ 广播给双方 `update`（events 含 `battle_start` 前无；初始阶段无事件）。
- host 若已断线仍可加入；room 状态由 `waiting` → `layout`。

### 3.4 SSE 实时通道
`GET /api/rooms/:code/stream?token=<token>`（`text/event-stream`）
- 连接成功立即推送一条当前视图；之后每次状态变化推送 `update`。
- 消息格式：
```
id: 12
event: update
data: {"seq":12,"type":"update","state":{...},"meta":{...},"events":[...]}

: ping
```
- `type` 取值：
  - `update`：`{seq,type,state,meta,events[]}`（events 为自上次以来发生的事件，用于动画；可能为空数组）
  - `presence`：`{type:'presence', meta}`（连接状态变化，无状态变化时也可发）
  - `room_closed`：`{type:'room_closed', reason:'peer_left'|'closed'|'timeout'}`
  - `error`：`{type:'error', code, message}`（如 token 失效，随后关闭连接）
- 心跳注释行 `: ping` 每 15s 一次；客户端断线自动重连（EventSource 原生行为），重连成功后服务器重发完整 state（客户端以 state 为准重新渲染，不补播缺失动画）。

### 3.5 提交布阵
`POST /api/rooms/:code/layout` `{ "token": "...", "cardIds": ["h-K", "..."] }`
- 仅 `layout` 阶段；长度必须等于区域数、牌来自自己手牌、不重复（引擎校验）。
- 双方都提交后服务器调用 `finalizeLayout`，把揭示/补牌事件通过 SSE 广播，进入 `battle`。
- 返回 `{ ok:true, submitted:true }`；对手尚未提交时客户端显示「等待对手布阵…」。

### 3.6 提交行动
`POST /api/rooms/:code/action` `{ "token": "...", "action": { "type":"draw" } }`
- 仅 `battle` 阶段、仅当前行动方、必须是合法行动（`Engine.getLegalActions` 同源校验后 `performAction`）。
- v1.4：同一回合可连续提交多条（受行动点限制）；`{ "type":"end_turn" }` 随时可提交以结束当前回合。行动点不足/非法返回 `ILLEGAL_ACTION`。
- 成功后把事件通过 SSE 广播给双方，返回 `{ ok:true }`。
- 客户端收到 `update` 后播放 `events` 动画再渲染。

### 3.7 再来一局
`POST /api/rooms/:code/rematch` `{ "token": "..." }`
- 双方都请求后，服务器用相同房间配置、新随机 seed 创建新对局，广播 `{type:'update', meta:{status:'layout',rematchReady:false}, state, events:[]}`。
- 单方请求时另一侧收到 `meta.rematchReady = {p1:true,p2:false}` 用于显示「对手已准备再来一局」。

### 3.8 离开 / 查询
- `POST /api/rooms/:code/leave` `{token}` → 广播对手 `room_closed`（reason: peer_left），房间销毁。
- `GET /api/rooms/:code?token=` → 当前快照（断线重连使用，返回同 SSE `update` 的 data 结构）。

## 4. 视图生成：镜像 + 脱敏（防作弊核心）

服务器为每个客户端生成**独立视图**后再发送。共享规则：

### 4.1 镜像（always：让每个客户端“自己 = p1”）
- host 视角：直接使用 p1/p2。
- guest 视角：将 p1↔p2 **整体交换**：`players`（含 `hand`、`ap`、`stallCount`）、`regions[].sides`、`regionWins`、`players[].regionsWon`、`layout.submitted/assignments`、`config.firstPlayer/secondPlayer/playerNames`、`state.turn`、`state.result`（winner/handSums/regionWins/**forfeitedBy**）全部交换；`turnProgress` 为当前行动方的回合内计数，镜像后保持数值不变。
- 目标：客户端 UI 永远把「自己」当作 p1、「对手」当作 p2；客户端提交动作无需任何换算。
- 单机模式不含镜像。

### 4.2 脱敏（两种模式共用原则；LAN 必须严格执行）
以下内容**绝不能**出现在发给对手的 JSON 中：
- 对手手牌的身份/数值/顺序；对手区域背面牌的身份；牌堆顺序/身份；未揭示的布局分配；未揭示的弃牌身份。
- **随机种子与内部 RNG 状态**（`config.seed`、`_rngState`）：拿到种子即可重建整副牌与双方手牌，属于间接全量泄漏；下发视图必须 `config.seed=null`。
- 对手单独摸牌（行动①难度摸牌/行动⑤摸牌/后手补偿牌）的具体牌面。
- 牌堆/手牌数组用**占位卡**表示数量：`{ id:"hidden-N", hidden:true, rank:"?", suit:null, suitSymbol:"", red:false, value:0, joker:false, revealed:false }`。
- 自己的手牌/背面牌完整保留（自己信息）。
- 已公开信息保留：所有正面牌、结算补牌、翻开的牌、终局 handSums、难度摸牌对象（不含牌面）。
- `state.log` 文本为公开日志（引擎日志本身不含隐藏牌面），可直接发送。
- `layout.assignments`：揭示前仅本方；揭示后双方均为公开（与区域正面牌一致）。

### 4.3 事件脱敏
按 `event.type`：
- `flip` / `settle` / `layout_reveal` / `game_over` / `endgame_start` / `endgame_draw` / `endgame_skip` / `endgame_showdown` / `battle_start`：公开（settle 的 `regionResult.difficultyDraw.card` 对非收取方改为占位）。
- `settle` 的 `drawn` 为**数组** `{p1:Card[], p2:Card[]}`（长度 = settleCards），属于公开补牌，服务器**不得**替换为占位卡；`regionBefore` 中对手背面牌仍按隐藏处理。
- `endgame_settle` 为决战摊牌确定性结算：`deterministic=true`、`drawnCount=0`、`drawn` 为空数组（不摸牌，全部牌已在前置 `regionBefore`/摊牌时公开），按原样镜像即可。
- `endgame_draw` 只含 `playerId/count/handSize`（不含牌面，手牌仍隐藏）；`endgame_skip` 只含 `playerId`。
- 提前锁定：`game_over.result.early=true` 时 `result.unsettledRegions` 为未结算区域 id 列表（镜像不改变区域编号）；房间进入 `gameover`。
- `place` / `move` / `draw` / `extra_draw` / 行动预置 `action`：**仅当事人**保留真实 `card`/`cardId`/`action` 细节；对手收到占位卡或 `cardId:"hidden"`。
  - 后手补偿为 `⌊R/2⌋` 个独立的 `extra_draw` 事件（3/5/7 区 = 1/2/3 个），逐张镜像/脱敏，事件数量与张数对双方一致（对手只见到占位卡）。
- 所有事件都做镜像（playerId/winner/难度摸牌方/区域快照 sides）。
- **行动点（v1.4）**：`state.players[].ap` 属公开信息（镜像时随 players 整体交换）；事件 `turn_start{playerId,ap,turnCount}` / `turn_end{playerId,reason,leftAp}` 全公开、逐条按 playerId 镜像；`end_turn` 行动本身公开（无隐藏信息），服务器按 `getLegalActions` 同源校验。
- 同一回合内可能连续收到多条 `action` 事件（均属同一 `playerId`），SSE 顺序即行动顺序；`turn_end` 之后才轮到对方。

### 4.4 meta（每个客户端）
```js
meta = {
  code:"K7M2Q",
  me: "p1",                       // 恒为 p1（镜像后）
  status: "waiting|layout|battle|gameover",
  host: true|false,
  players: { p1:{name,connected}, p2:{name,connected}|null },
  rematchReady: { p1:false, p2:false },
  lanUrls: [...],
  turn: "p1"|"p2",                // 镜像后
  serverNow: 0
}
```
单机模式没有 meta。

## 5. 可靠性 / 生命周期

- 房间码 5 位大写字母+数字（去掉 0/O/1/I）；token 32 hex；`crypto.randomBytes` 生成。
- 断线：SSE 断开 → 标记 connected=false，广播 presence；对手 UI 显示「对手已断开，等待重连…」并禁用操作。
- 重连：客户端保存 `{code, token}` 到 `sessionStorage`，刷新/断线后用同 token 重新 GET 快照 + SSE，恢复对局；
  服务器保留房间 **10 分钟**（无连接活动/双方离线后），超时清理。
- 离线超时：任一已加入玩家 **3 分钟**没有任何请求/SSE 视为掉线超时（服务器记录 `lastSeen`；有 SSE 连接的玩家由心跳保活），
  房间被销毁并通知另一方 `room_closed`（reason:`timeout`），避免对手无限等待。
- presence 消息只带 `meta` 不带 `state`：客户端必须以最近一条 `update` 作为状态来源（`meta.turn` 为镜像后的行动方）。
- 防作弊：下发视图不含随机种子（`config.seed=null` 且无 `_rngState`）；`state.log` 只包含公开信息（摸牌/额外补牌不写牌面）。
- 双方都离开 → 立即销毁房间。
- 房主退出（显式 leave）→ 房间销毁，guest 收到 `room_closed`。
- 服务器重启：所有房间丢失（内存态）；客户端收到连接失败后提示「服务器已重启，请重新建房」。
- 并发：一个服务器支持多个房间；每个房间独立引擎状态。
- 安全：动作全部服务器校验（阶段/回合/合法性/身份）；token 不匹配返回 BAD_TOKEN；不含任何账号系统。
- **回合倒计时（v1.5）**：倒计时由各客户端**只对自己的回合**执行（读取 `state.config.turnTimeLimit`）；超时自动提交 `{type:'end_turn'}`，服务器照常广播 `turn_end/turn_start`，双端状态一致。服务器**不执行强制超时**（不因思考超时判负/代打），属于已知限制（双方客户端均正常时体验一致；故意改客户端可绕过）。
- **防拖延/认输（v1.5）**：`players[].stallCount` 公开随 state 下发；连续两回合无有效行动/仅移牌由引擎判定后推送 `forfeit` 事件与 `game_over.result.reason='forfeit'`（含 `forfeitedBy`），服务器只需按通用规则镜像——`forfeitedBy` 用 `swapId`、`forfeit.playerId` 通用交换、`players[].stallCount` 随 players 整体交换；双端 `turnProgress` 数值一致。服务器不额外判定认输（权威规则仍在引擎）。
- 畸形 JSON/超大 body（>64KB）返回 BAD_REQUEST 并断开。
- SSE 连接数：每 token 仅保留最新一条流（重连时关闭旧流）。

## 6. 客户端集成要求

### 6.1 模式选择
- 启动页提供：**单机对战**（现有流程不变）/ **局域网联机**（新增大厅）。
- 只有 `GET /api/info` 可用（HTTP 服务运行且同源）时才启用联机入口；否则提示「请用 node server.js 启动局域网服务器」并给出命令。
- URL 参数：`?room=K7M2Q` 打开后自动填入加入房间面板；`?lan=1` 直接打开联机大厅。

### 6.2 新增文件与职责（建议拆分）
- `server.js`（Lead 实现）：静态服务 + 全部 `/api` + SSE + 房间管理 + 镜像脱敏。
- `js/net.js`（新增，UMD/全局 `PokerNet`）：`available()` / `createRoom()` / `joinRoom()` / `connect()` / `submitLayout()` / `sendAction()` / `rematch()` / `leave()` / `getSnapshot()`；封装 SSE、自动重连、sessionStorage 恢复、错误码转中文提示。
- `js/main.js`：新增 `game.mode = 'solo'|'lan'`；联机模式下所有动作/布阵走 `PokerNet`，不调度 AI；收到 SSE `update` 后 `UI.playEvents(events)` → `UI.render(state, view)`。
- `js/ui.js`：新增联机大厅/等待房间/断线提示/重连中/房间码展示/复制地址；文案与头像改用 `playerNames`（禁止硬编码「电脑/你」，单机下 playerNames 仍为 你/电脑，显示不变）；新增 `view.lan` 驱动状态条。
- `index.html`：在 ui/main 之前加载 `js/net.js`；增加房间/联机状态容器（或由 ui.js 动态创建）。

### 6.3 交互流程
1. **创建**：输入昵称 → 创建房间 → 显示 5 位房间码 + 局域网地址 + 复制按钮 →「等待对手加入…」。
2. **加入**：输入昵称 + 房间码（或带 `?room=` 自动填）→ 加入 → 双方进入布局。
3. **布局**：各自选 5 张背面放置 → 提交 → 「已提交，等待对手布阵…」→ 双方都提交后同时揭示。
4. **战役**：轮到己方时可用行动；等待时显示「等待 对手名 行动…」；对方断线显示等待重连。
5. **回合倒计时（v1.5）**：只在己方回合显示（`turn-timer`），对手回合显示「对方行动中」；超时自动结束回合并提示；倒计时配置来自 `state.config.turnTimeLimit`（房间创建时确定）。
6. **终局**：显示结果（镜像后己方视角）；「再来一局」需双方确认（显示对手准备状态）；「离开房间」返回大厅。
7. **退出**：关闭页面/离开 → 对手收到提示；会话结束回到大厅。

### 6.4 单机模式回归要求
- `file://` 双击、`node tools/serve.js` 下单机流程完全不变（AI、autoplay、PokerDebug、设置持久化、URL 参数）。
- 联机入口在 file:// 下不可用或给出启动服务器提示。

## 7. 验收清单（QA 独立验证）

### 7.1 Node 集成测试（`tests/lan.test.js`，零依赖）
1. `GET /api/info`、创建房间返回 token/code；`waiting` 状态 `state=null`。
2. 加入房间后双方都收到 `layout` 视图；host 视角 p1=host、guest 视角 p1=guest（镜像）。
3. **脱敏审计**：抓取双方收到的原始 SSE/JSON 文本，断言：对手手牌 id/rank 不出现；牌堆顺序不出现（占位卡数量正确）；布局揭示前对手 assignment 不出现；难度摸牌牌面不出现（对手视角）。
4. 双方提交布局 → 揭示事件，进入 battle（先手正确）。
5. 通过两个 HTTP 客户端轮流发送合法 action，完整打完一局（含决战/提前锁定），双方 state 镜像一致、result winner 镜像正确、`result.early/unsettledRegions` 一致；`drawn` 为数组且公开补牌不是占位卡；服务器状态与客户端视图的公开信息一致。
6. 非法请求：错误 token、非当前方行动、非法行动、错误阶段 → 4xx 且状态不变；未授权客户端无法推进对手回合。
7. 断线重连：断开后重连同 token 收到完整 state；presence 广播正确。
8. 再来一局：双方 rematch 后新对局（新 seed，状态重置）；单方 rematch 时 meta.rematchReady 正确。
9. 离开房间：对手收到 `room_closed`，房间销毁。
10. 并发房间互不干扰；服务器可被 `createLanServer({port:0})` 以编程方式启动（测试用）。

### 7.2 浏览器 E2E（两个标签页/两个 session）
1. host 创建房间 → 显示房间码/地址；guest 用房间码加入 → 双方进入布局。
2. 双方各自完成布局（背面放置）→ 同时揭示 → 后手补偿 `⌊R/2⌋` 张。
3. 轮流行动：各自轮次可操作、非轮次不可操作；五种行动至少各走一次（可分工）。
4. 结算/决战/终局在双方视角均正确（胜者/分数镜像、名字正确）；双方点击再来一局后新局开始。
5. 断线/重连：guest 刷新页面（sessionStorage 恢复）后回到对局；host 看到断线/恢复提示。
6. 单机模式回归：file:// 或静态服务器下单机完整一局 + autoplay 无回归；LAN API 不可用时的提示。
7. console 无未捕获异常；1440×900 与 1280×800 下大厅/对局/终局无溢出。
8. v1.5：房间配置含倒计时（默认 30s），双端各自回合倒计时正确、超时自动 end_turn 后双端同步；音效在联机下正常（关闭后无声），倒计时 tick/超时音效不重复播放。
9. v1.5 防拖延/认输：双端 `players[].stallCount` 同步；一方连续两回合空过/仅移牌后 `forfeit` 事件与 `result.reason='forfeit'/forfeitedBy` 双端镜像正确（认输方在各自视角都是「自己」或「对手」的正确身份）；悬停/拖动等 UI 改动不影响联机权限校验。

## 8. 非目标
- 不做公网穿透、账号系统、观战、聊天、排名、断点续玩（服务器重启恢复）。
- 不做 WebSocket；不做移动端专门适配（沿用桌面布局）。
