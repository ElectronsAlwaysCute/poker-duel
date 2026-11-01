# 工程契约（ENGINE / AI / UI 接口）

> 本文件是模块边界的唯一契约。`docs/RULES.md` 是规则事实来源。
> 任何跨模块字段/函数改动，必须由 Lead 更新本文件并通知相关成员。

## 1. 文件归属与加载顺序

| 文件 | 归属 | 说明 |
|---|---|---|
| `js/engine.js` | Lead | 纯规则引擎，无 DOM、无外部依赖；浏览器全局 `PokerEngine`，Node 可 `require` |
| `js/engine.js` | Lead | 权威规则引擎（v1.7.0；v2.17 战略决战 AP 上限；v2.1 规则：后手补偿固定 1 张） |
| `js/ai.js` | Lead | 电脑 AI（启发式，**v3.5.0-robust**：v2.12 新增反囤牌响应；v2.10 起 hard 强度在 **5 区**条件化去手写 shaping——取消 place 优先池/heavyTempo/earlyPass，3 区与 easy 保持 3.3.0 逻辑；其余同 v3.3.0 概率表 warWinProb/warSettleProbs + medium 1.5 步前瞻），依赖 `PokerEngine` 的只读接口；全局 `PokerAI`，Node 可 `require` |
| `js/ai-ml.js` | Lead | 机器学习困难档引擎（**v2.2.0**，默认引擎），UMD 全局 `PokerAIML`，依赖 `PokerAI` 的 `_internals`；内嵌 6 个信息集/世界价值模型（165 维 = 93 信息集 + 72 世界特征；V_w ensemble vw3a/b/c + vw4a/b/c logit 平均）+ 三阶段自由决策框架（布局启发式/自由搜索 / 战斗「启发式计划 + 采样世界 V_w 计划评估 planpi K=4」/ 决战 build 自适应深搜 + place→end_turn 节奏候选 + 主动空过候选）；**全区域 3/5/7 启用**，异常回退启发式 3.3.0；file:// 可加载 |
| `index.html` | ui-dev | 引用 `css/style.css`、`js/engine.js`、`js/ai.js`、`js/ai-ml.js`、`js/net.js`、`js/music.js`、`js/sfx.js`、`js/ui.js`、`js/main.js`（顺序固定） |
| `css/style.css` | ui-dev | 全部样式 |
| `js/ui.js` | ui-dev | 视图与交互层，全局 `PokerUI` |
| `js/main.js` | ui-dev | 对局控制器，驱动 engine + ai + ui |
| `js/music.js` | ui-dev | 背景音乐（v1.4）：全局 `PokerMusic`，本地 `music/1.mp3` 循环、音量 0–100、失败静默 |
| `js/sfx.js` | Lead | 音效播放器（v1.5）：全局 `PokerSFX`，本地 `sfx/*.ogg`（Kenney CC0），声音均衡、HTMLAudioElement、file:// 可用、失败静默 |
| `sfx/` | Lead | 音效素材（19 个 ogg，约 231KB）+ `LICENSES.md` + `balance.json`（均衡测量记录） |
| `tests/*` | qa-dev | Node 测试与模拟脚本 |
| `docs/*`, `README.md` | Lead | 文档 |

浏览器脚本必须用**传统 script 标签**（非 ESM），保证 `file://` 可直接打开。Node 侧（v24）通过 `module.exports` 加载。

UMD 写法约定：

```js
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () { /* ... */ return API; });
```

## 2. Engine 全局 API（`window.PokerEngine` / `require('./js/engine.js')`）

```js
E.VERSION                     // '1.7.0'
E.DIFFICULTIES                // {1:{id:1,name:'消耗',label:'单独结算后败者摸牌',rule:'loser-draw'},
                              //  2:{name:'均衡',...rule:'none'}, 3:{name:'突进',...rule:'winner-draw'}}（v1.4 标题改名）
E.SETTLE_MODES                // [{id:1,name:'简单',label:'双方各补 1 张',cards:1}, {id:2,...,cards:2}, {id:4,name:'复杂',label:'双方各补 4 张',cards:4}]
E.DEFAULT_SETTLE_CARDS        // 2
E.AP_PER_TURN                 // 3（v1.4 行动点：每回合回复到 3 点）
E.ACTION_COSTS                // {settle:3, draw:2, flip:2, place:1, move:1, end_turn:0}（v1.4）
E.DEFAULT_TURN_TIME_LIMIT     // 30（v1.5：回合倒计时默认秒数；0=关闭）
E.TURN_TIME_LIMIT_OPTIONS     // [0, 15, 30, 60]（v1.5：UI 提供/校验的倒计时档位）
E.RANK_VALUES                 // {A:1,'2':2,...,K:13,小王:14,大王:15}
E.SUITS                       // [{id:'s',symbol:'♠',red:false}, {id:'h',symbol:'♥',red:true}, {id:'d',symbol:'♦',red:true}, {id:'c',symbol:'♣',red:false}]

E.defaultConfig(overrides?) -> config          // 补全默认值、解析派生字段；不校验
E.validateConfig(config) -> {ok, errors[], warnings[], info}
   // info: {deckSize, suitCount, regionCount, settleCards, settleMode,
   //        initialDraw, layoutCount, compensationDraw, apPerTurn, endgameApCapRule, winsNeeded, deckAfterSetup, endgameThreshold, gapToEndgame,
   //        turnTimeLimit}
E.createGame(config) -> state                  // 校验不过则 throw Error（带 .code）
E.createDeck(deckSpec) -> Card[]               // 未洗牌；主要给测试用
E.makeRng(seed) -> {next(), int(n), shuffle(array), pick(array)}   // 独立 RNG，不影响对局

// 布局阶段
E.submitLayout(state, playerId, cardIds) -> void   // cardIds 长度 R，按区域序号给出；必须在手牌中且不重复
E.finalizeLayout(state) -> Event[]                 // 双方已提交后调用；放置→揭示→后手补牌（⌊R/2⌋ 个 extra_draw）→battle

// 战役阶段
E.getLegalActions(state) -> Action[]               // 返回当前行动方「按行动点过滤后」的合法行动（含 end_turn）；非 battle 阶段返回 []
E.performAction(state, action) -> Event[]          // 校验并执行；非法（含行动点不足）则 throw Error（带 .code 和中文 .message）；支持 end_turn
E.isGameOver(state) -> boolean
E.getHandSum(state, playerId) -> number
E.getOpenRegionIds(state) -> number[]
E.getEndgameThreshold(state) -> number             // 2 × 未结算区域数；无未结算区域时为 0
E.getRegionSideSum(state, regionId, playerId) -> number   // 该区域我方正面牌总和
E.getRegionFaceUpCount(state, regionId) -> number         // 双方正面牌合计
E.getKnownCards(state, playerId) -> Card[]                // 该玩家已知身份的牌（自己手牌/所有正面牌/自己的背面牌/已揭示弃牌）
E.getUnseenCards(state, playerId) -> Card[]               // 该玩家未知身份的牌（牌堆+对手手牌+对手背面牌+未揭示弃牌），固定顺序、不泄露牌堆顺序；供 AI 公平估计
E.formatCard(card) -> string                        // 例：'♠A' / '♥10' / '小王'
E.formatCards(cards) -> string

// UI 展示辅助（可选使用）
E.getScoreLabel(state) -> string                    // 例：'你 2 : 1 电脑 · 平 1'
```

### 错误对象
`throw new Error(message)` 且 `err.code` 为以下之一：
`BAD_CONFIG` / `BAD_PHASE` / `BAD_ACTION` / `BAD_REGION` / `CARD_NOT_IN_HAND` / `NO_SUCH_CARD` / `REGION_NOT_SETTLABLE` / `DECK_INSUFFICIENT` / `ALREADY_SETTLED`
（`performAction` 总是执行当前行动方，不含 playerId 参数，因此不存在 `NOT_YOUR_TURN` 路径。v1.4 起行动点不足也抛 `BAD_ACTION`；`REGION_NOT_SETTLABLE` 仅保留兼容，结算不再因正面牌数被拒。）

## 3. Config

```js
{
  regionCount: 5,          // 3 | 5 | 7（偶数亦可但默认奇数）
  difficulty: 1,           // 1 | 2 | 3：单独结算后败者摸牌 / 不摸牌 / 胜者摸牌
  settleCards: 2,          // 1=简单(双方各补1张) | 2=标准(各补2张) | 4=复杂(各补4张)；默认 2；旧值 3 迁移为 4
  firstPlayer: 'random',   // 'random' | 'p1' | 'p2'；createGame 后解析为 'p1'/'p2'
  secondPlayer: 'p2',      // 派生，createGame 写入
  winsNeeded: 3,           // 派生 = floor(regionCount/2)+1
  initialDraw: 10,         // 派生 = 2*regionCount
  layoutCount: 5,          // 派生 = regionCount
  compensationDraw: 1,     // v2.1：后手补偿固定 1 张（3/5/7 区相同），不可单独设置
  apPerTurn: 3,            // 派生 = 3（v1.4）：普通战役每回合回复的行动点数，不可单独设置
  endgameApCapRule: true,  // v1.7：战略决战 build 阶段启用 apCap 规则；false=完全退回 v1.6 行为（研究/回归用）
  turnTimeLimit: 30,       // v1.5：每回合倒计时秒数；默认 30；0=关闭；合法值 0 或 5–300 整数（UI 只提供 0/15/30/60）
  deck: { jokers: true, ranks: ['A','2','3','4','5','6','7','8','9','10','J','Q','K'],
          suits: null },      // 对战固定标准 54 张；引擎内部仍支持自定义构成（仅测试/开发工具用，网页不暴露）
  seed: null,              // null=随机（用 Math.random 生成种子并写入 config.seed）
  playerNames: { p1: '你', p2: '电脑' },
  aiStrength: 'medium'     // 'easy' | 'medium' | 'hard'（AI 用；'normal' 兼容映射为 medium；engine 不解释）
}
```

`validateConfig` 规则：
- `regionCount` 为 ≥3 的整数（默认 UI 只提供 3/5/7）。
- `difficulty` ∈ {1,2,3}；`settleCards` ∈ {1,2,4}（1/2/4=简单/标准/复杂补牌张数；旧值 3 自动迁移为 4）；`firstPlayer` ∈ {random,p1,p2}。
- `turnTimeLimit` 必须是 0（关闭）或 5–300 的整数（默认 30），否则报错「回合倒计时必须是 0（关闭）或 5-300 秒的整数」。
- `deck.ranks` 非空且均为 `RANK_VALUES` 的键；`jokers` 布尔；`deck.suits` 为 null 或非空唯一数组，元素 ∈ `s/h/d/c`。
- 牌堆张数 `D = ranks.length × suitCount + (jokers?2:0)`，`suitCount = deck.suits ? deck.suits.length : 4`。
- 报错（ok=false）：
  - `D < 4R + K`：连初始发牌（双方各 2R + 后手补偿 K）都不够；
  - `D < 6R + K + 1`：布局后牌堆不足以进行正常战役（要求布局后牌堆严格大于初始决战阈值 `2R`），其中 `K = compensationDraw = 1`（v2.1 固定）。标准 54 张对 3/5/7 区均满足（R=3: 20 / R=5: 32 / R=7: 44）。
- 警告（ok=true）：
  - `gapToEndgame <= 2`：布局后很快进入决战，对局较短；
  - `gapToEndgame > 30`：对局可能较长。
- `info = {deckSize, suitCount, regionCount, settleCards, settleMode, initialDraw, layoutCount, compensationDraw, apPerTurn, endgameApCapRule, actionCosts, winsNeeded, deckAfterSetup, endgameThreshold, gapToEndgame, turnTimeLimit}`
  - `compensationDraw = 1`（v2.1 固定；3/5/7 区相同）
  - `apPerTurn = 3`；`actionCosts = {settle:3, draw:2, flip:2, place:1, move:1, end_turn:0}`（v1.4）
  - `turnTimeLimit`（v1.5）：回合倒计时秒数，默认 30；0=关闭
  - `deckAfterSetup = D − 4R − K`
  - `endgameThreshold = 2R`（布局后初始值；对局中按 `2×未结算区域数` 动态计算）
  - `gapToEndgame = D − 6R − K`：布局后牌堆高出初始阈值 `2R` 的张数；标准 54 张下 R=3/5/7 分别为 35/23/11（v2.1 固定补偿 1；不随 settleCards 变化；N 只影响单独结算消耗速度）。
- 7 区同样使用标准 54 张：简单/标准/复杂三种结算随机性均合法（无「7 区仅简单」限制）。

## 4. State 形状（UI 只读；engine 内部可写）

```js
{
  version: '1.7.0',
  config: Config,                 // 见 §3；含解析后的 firstPlayer / secondPlayer / seed / turnTimeLimit
  phase: 'layout' | 'battle' | 'gameover',
  turn: null | 'p1' | 'p2',       // 战役阶段当前行动方；其他阶段 null
  turnCount: 0,                   // 已执行的战役行动数
  turnProgress: { count: 0, productive: 0 }, // v1.5：本回合真实行动数 / 推进行动数（move 不算推进；beginTurn 重置，回合结束清零）
  deck: Card[],                   // 牌堆（数组头部为牌堆顶/下一张）
  discard: Card[],                // 弃牌堆
  players: {
    p1: { id:'p1', name:'你',   hand: Card[], regionsWon: 0, ap: 3, stallCount: 0, apCap: 3 }, // ap=当前行动点（非行动方为 0）；stallCount=连续「无有效行动回合」数（v1.5 防拖延）
    p2: { id:'p2', name:'电脑', hand: Card[], regionsWon: 0, ap: 0, stallCount: 0, apCap: 3 }
  },
  regions: Region[],              // 长度 regionCount
  layout: {
    submitted:  { p1: false, p2: false },
    assignments:{ p1: null, p2: null },   // 已提交时：Card[] 长度 R，按区域序号；揭示前 UI 只能展示自己的
    revealed: false
  },
  regionWins: { p1: 0, p2: 0, ties: 0 }, // 已结算区域的胜场统计
  endgame: {
    triggered: false,             // 是否已进入战略决战（对局进入决战补牌/最终部署/摊牌阶段后恒为 true）
    phase: null,                  // null | 'build' | 'showdown' | 'done'
    threshold: 10,                // 初始 = 2×regionCount；触发后固化 = 2×当时未结算区域数
    settleCards: 2,               // 本局结算随机性（仅供参考；决战不使用补牌随机性）
    drawPerPlayer: 0,             // 决战补牌目标：剩余区域数 X（触发时写入）
    drawnCounts: { p1: 0, p2: 0 },// 实际摸到的手牌张数（牌堆不足时下调，合计 = 触发时牌堆张数）
    skipped: { p1: false, p2: false } // 决战最终部署阶段该方是否已因「无牌可翻/可放」被跳过
  },
  result: null | Result,          // 见 §6（Result 在 §4.4）
  log: LogEntry[],                // 引擎写入的中文对局日志，UI 渲染即可
  _rngState: number               // 内部随机状态，UI/AI 禁止读写
}
```

### Card
```js
{ id:'s-A' | 'h-10' | 'joker-B' | 'joker-S',
  rank:'A'|'2'|...|'K'|'小王'|'大王',
  suit:'s'|'h'|'d'|'c'|null,
  suitSymbol:'♠'|'♥'|'♦'|'♣'|'',
  red:false|true,
  value:1..15,
  joker:false|true,
  revealed:false|true }          // 是否已对双方公开：布局正面牌/翻开牌/结算补牌=true；手牌、背面牌、未揭示弃牌=false
```
- `joker-B` = 大王 value 15；`joker-S` = 小王 value 14。
- 花色顺序固定 `s h d c`，rank 顺序固定 `A 2..10 J Q K`；`id` 全局唯一。
- Card 视为不可变对象（引擎不修改既有字段；仅背面转正面时把 `revealed` 置 true）。

### Region
```js
{
  id: 0..R-1,
  status: 'open' | 'settled',
  sides: {
    p1: { faceUp: Card[], faceDown: Card[] },
    p2: { faceUp: Card[], faceDown: Card[] }
  },
  result: null | {
    winner: 'p1' | 'p2' | 'tie',
    settleCards: 1|2|4,
    deterministic: false,                        // true=决战摊牌（按现有正面点数和，无补牌/随机）
    sums: { p1: n, p2: n },
    faceUp: { p1: Card[], p2: Card[] },          // 结算前双方正面牌（快照）
    drawn: { p1: Card[], p2: Card[] },           // 单独结算：长度 = settleCards；摊牌结算：空数组 []
    difficultyDraw: null | { playerId:'p1'|'p2', card: Card },
    allCards: { p1: Card[], p2: Card[] }         // 结算前正面+背面+补牌（记录用）
  }
}
```

### Result（终局）
```js
{
  winner: 'p1' | 'p2' | 'draw',
  reason: 'region_wins' | 'hand_sum' | 'draw' | 'forfeit', // v1.5 新增 forfeit=认输判负
  early: false,                   // true=提前锁定（达到胜场门槛时立即结束，剩余区域未结算）
  forfeitedBy: null | 'p1' | 'p2',// v1.5：reason='forfeit' 时为认输方（其余为 null）
  forfeitReason: undefined | 'ap-cap-zero', // v1.7：仅 apCap 降至 0 的 forfeit 出现；普通 stall forfeit 无此字段
  unsettledRegions: [],           // early=true 或 forfeit 时为未结算区域 id 列表（升序）；否则 []
  regionWins: { p1: 2, p2: 2, ties: 1 },
  handSums: { p1: 37, p2: 35 },
  winsNeeded: 3
}
```
- `early=true` 时 `reason='region_wins'`（提前锁定），`handSums` 仅作记录，不参与决胜。
- `reason='forfeit'`（v1.5）：某玩家连续两个自己的回合都没有真实行动、或只进行了移牌，则判负认输；`winner` 为对手、`forfeitedBy` 为认输方、`early=false`，剩余区域保持 open。UI 需单独展示「认输」。
- `forfeitReason='ap-cap-zero'`（v1.7）：仅当战略决战 build 阶段 `apCap` 降至 0 时出现，用于与 stall forfeit 区分；事件 `forfeit.reason='ap-cap-zero'`。
- `reason='region_wins'` 且 `early=false`（v2.6 BUGFIX）：所有区域结算完、无人达到 `winsNeeded`，但区域胜场不同 → **多胜方获胜**（如 7 区 3:2）；此时 `unsettledRegions=[]`。
- `reason='hand_sum'`（v2.6）：仅在**区域胜场相同**时比较手牌总和，多者获胜；UI 文案需明确「区域胜场相同（a:b），比较手牌总和 x:y」。
- `reason='draw'`（v2.6）：仅当**区域胜场相同且手牌总和也相同**时出现；UI 文案必须如实写区域胜场 a:b 与手牌总和 x:y，只有两者都确实相同才可写「均相同」。
- 最终判定优先级（v2.6，替换旧「胜场不足直接比手牌」）：达到 `winsNeeded` 提前锁定 → 区域胜场多者（`region_wins`）→ 手牌总和多者（`hand_sum`）→ 平局（`draw`）。

### LogEntry
```js
{ seq: 1, text: '你 翻开了区域 3 的一张背面牌：♠K', tone: 'info'|'p1'|'p2'|'warn'|'result' }
```
日志由引擎在动作执行时追加；UI 只负责渲染与自动滚动，不允许自己编日志。

## 5. Action 与 Event

### Action（`getLegalActions` 输出 / `performAction` 输入）
```js
// v1.4：每个 Action 带 cost（行动点消耗），getLegalActions 只返回当前 AP 可支付的行动；
// end_turn 始终合法（只要当前是你的回合）。
{ type:'settle', regionId:number, cost:3 }          // 任意未结算区域均可结算（不再要求正面牌 >2）
{ type:'flip',   regionId:number, cardId:string, cost:2 }
{ type:'place',  regionId:number, cardId:string, cost:1 }
{ type:'move',   fromRegionId:number, cardId:string, toRegionId:number, cost:1 }
{ type:'draw', cost:2 }
{ type:'end_turn', cost:0 }                          // 提前结束回合（放弃剩余行动点）
```

### 回合与行动点（v1.4）
- 回合开始时 `state.players[turn].ap = config.apPerTurn (3)`；行动后扣减对应 cost。
- 行动后：若 AP 仍 >0 且存在可支付的行动 → 同一玩家继续；否则自动结束回合（`turn_end` reason=`ap`/`no-action`）并开始对方回合。
- `end_turn`：立即结束当前回合（reason=`manual`）。
- 决战 build 阶段同样恢复/消耗 AP；对方无牌可动时跳过其回合、本方开新回合并回复 AP。
- **v1.7 决战 AP 上限**：`config.endgameApCapRule` 默认 true。build 阶段回合开始 AP=`min(players[pid].apCap,3)`（初始 3）；**主动/AP 用尽结束回合**（`reason='manual'|'ap'`）时 `leftAp>0`→`apCap-1`，`leftAp==0`→`apCap+1`（最高 3）；`reason='no-action'`（引擎判定无合法行动而强制结束）**不改变 apCap**、turn_end 不带 apCap 字段；`apCap` 降至 0 立即 forfeit（`result.forfeitReason='ap-cap-zero'`）。flag=false 完全退回 v1.6 行为。

### 回合倒计时（v1.5，客户端执行，非引擎规则）
- `config.turnTimeLimit`（默认 30s，0=关闭）；**引擎不执行真实计时**（保持纯逻辑/确定性），由 UI/客户端在「本地玩家的回合」内倒计时，归零时自动执行 `end_turn`（引擎事件仍为 `turn_end reason='manual'`，UI 用 toast/日志区分「超时自动结束回合」）。
- 计时范围：战役每个回合（含战略决战 build 阶段）；仅本地行动方（单机=人类；LAN=自己的座位）；布局阶段/终局/关闭时不计时；同一回合内多次行动不重置，新回合 `turn_start` 时重置。
- 设置/规则/确认弹层打开、页面 hidden 时暂停；关闭弹层/恢复可见后继续。LAN 下服务器不做强制超时（各客户端只对自己回合计时），属已知限制，见 `docs/LAN.md`。

### 防拖延 / 认输判负（v1.5，引擎规则）
- 每位玩家记录 `players[pid].stallCount`（公开信息）。一个**自己的回合**结束时，若本回合「没有任何真实行动」或「只进行了 `move`」，则 `stallCount+1`；有任一推进行动（settle/flip/place/draw）则清零。
- `stallCount` 达到 **2** → 该玩家立即**认输判负**，对局结束：`result.reason='forfeit'`、`winner=对手`、`forfeitedBy=该玩家`、`unsettledRegions=当前未结算区域`、`early=false`；事件流在 `turn_end` 后追加 `{type:'forfeit', playerId, reason:'stall'}` + `game_over`。
- 引擎强制跳过（决战 build 中 `endgame_skip`；reason='no-action' 的无牌可动）不计入 stall。倒计时超时自动结束的回合算「无行动」，因此连续两次超时同样会认输。
- AI 2.2 已做保护：`stallCount>=1` 时不选择 `move`（避免自己因仅移牌被判负）。

### Event（`performAction`/`finalizeLayout` 输出，供 UI 播动画）
所有事件都含 `type`；结算相关事件含 `logSeq`。

```js
// 布局阶段（finalizeLayout 返回）
{ type:'layout_reveal', layout:{ p1:Card[], p2:Card[] } }       // 双方各 R 张，按区域序
{ type:'extra_draw', playerId:'p2', card:Card, handSize:7 }     // 后手补偿：每张牌一个事件，共 ⌊R/2⌋ 个（3/5/7 区=1/2/3）；对手牌面不暴露则 UI 显示牌背
{ type:'battle_start', turn:'p1'|'p2' }

// 后手补偿事件顺序固定：layout_reveal → extra_draw × compensationDraw → battle_start；
// 第 i 个 extra_draw.handSize = 后手初始手牌数 + i。

// 回合（v1.4）：每个动作事件之后可能追加
{ type:'turn_end', playerId, reason:'manual'|'ap'|'no-action', leftAp:number,
  apCapBefore?:number, apCapAfter?:number }   // v1.7：仅 build 阶段且规则开启时带 AP 上限字段
{ type:'turn_start', playerId, ap:number, turnCount:number, apCap?:number, apPerTurn?:number } // v1.7：build 规则开启时带 apCap/apPerTurn
{ type:'turn_start', playerId, ap:number, turnCount:number }   // 新回合开始，AP 已回复

// 认输判负（v1.5）：紧跟在导致认输的 turn_end 之后；game_over.result.reason='forfeit'
{ type:'forfeit', playerId, reason:'stall'|'ap-cap-zero' } // v1.7 增加 ap-cap-zero

// 战役行动（performAction 返回，首事件固定为 action）
{ type:'action', playerId, action:Action }                    // action 可为 settle/flip/place/move/draw/end_turn
{ type:'flip',  playerId, regionId, card:Card }
{ type:'place', playerId, regionId, card:Card }                 // 对手的 card 仅 UI 层隐藏
{ type:'move',  playerId, fromRegionId, toRegionId, card:Card }
{ type:'draw',  playerId, card:Card|null, handSize:number }     // 对手摸牌时 UI 隐藏身份只显示数量

// 单独结算
{ type:'settle', playerId, regionId, settleCards,
  regionBefore: { id, sides:{p1:{faceUp,faceDown}, p2:{faceUp,faceDown}} },  // 结算前快照
  drawn: { p1:Card[], p2:Card[] },     // 数组长度 = settleCards（复杂为 4）；先 P1 的 N 张，再 P2 的 N 张
  sums: { p1:n, p2:n },
  winner: 'p1'|'p2'|'tie',
  difficultyDraw: null | { playerId, card:Card },
  regionResult: RegionResult,     // 同 region.result
  deckAfter: number,
  endgameTriggered: boolean }     // true=触发决战；提前锁定结束则为 false

// 战略决战（触发行动事件之后紧接着返回；之后每次 performAction 只产生 build 阶段事件）
{ type:'endgame_start', openRegionIds:[...], drawPerPlayer:number,   // drawPerPlayer = 剩余区域数 X
  drawnCounts:{ p1:number, p2:number },                              // 实际摸牌数（合计 = 触发时牌堆数）
  settleCards:number, deckCount:number, threshold:number }           // threshold = 2X；deckCount = 触发时牌堆
{ type:'endgame_draw', playerId:'p1'|'p2', count:number, handSize:number } // 不含牌面（手牌隐藏）

// 决战最终部署阶段：每次 performAction 返回
{ type:'action', playerId, action:Action }        // action 只能是 flip/place/move/end_turn
{ type:'flip'|'place'|'move', ... }              // 同普通行动事件
{ type:'turn_end', playerId, reason:'manual'|'ap'|'no-action', leftAp:number }  // v1.4
{ type:'turn_start', playerId, ap:number, turnCount:number }                      // v1.4
{ type:'endgame_skip', playerId }                // 该方无手牌且无背面牌，跳过其回合（同一方只发一次）
{ type:'endgame_showdown', openRegionIds:[...], threshold:number, deckCount:0 } // 双方均无行动，开始摊牌

// 摊牌结算（每个剩余区域一个，按 regionId 升序；无补牌、无随机）
{ type:'endgame_settle', regionId, deterministic:true, drawnCount:0,
  drawn:{p1:Card[],p2:Card[]},
  regionBefore:{...}, sums:{p1,p2}, winner, regionResult, deckAfter:0 }
{ type:'game_over', result:Result }
```

事件顺序保证：
- `finalizeLayout`：`layout_reveal` → `extra_draw` × K → `battle_start` → `turn_start`（先手，AP=3）。
- 普通行动流：`action` → 具体行动事件 → （若触发）`endgame_start` → `endgame_draw`(p1) → `endgame_draw`(p2) → 返回；否则按 AP 追加 `turn_end`/`turn_start`（同一玩家可能连续行动多次，事件互不重叠）。之后每次 build 行动返回 `action` → flip/place/move 事件（或 `endgame_skip`），并在需要时追加 `turn_end`/`turn_start`；双方耗尽时该次 performAction 末尾追加 `endgame_showdown` → `endgame_settle` × k → `game_over`。
- build 阶段禁用 `draw`/`settle`：`getLegalActions` 不返回它们；`performAction` 传入则抛 `BAD_ACTION`（message：战略决战阶段已禁用摸牌/结算）。
- **行动点不足**：`getLegalActions` 不返回该行动；直接调用 `performAction` 抛 `BAD_ACTION`（message 含「行动点不足」）。
- **提前锁定**：任何一次区域结算后若一方达到 `winsNeeded`，对局立即结束。单独结算事件流为 `action → settle → game_over`（无 endgame_start）；摊牌途中为 `... → endgame_settle(最后一个) → game_over`，其余区域不再结算；`result.early=true`、`result.unsettledRegions` 非空、对应区域 `status='open'`。
- `performAction` 返回时 state 已是最终状态。UI 先播动画再读 state 渲染。
- 若动作导致 gameover，`state.phase='gameover'`、`state.turn=null`。
- `finalizeLayout` 严格配置下不会立即触发决战（validateConfig 保证布局后牌堆 > 初始阈值 2R）；若引擎内部传入非法自定义牌堆，`finalizeLayout` 仍会按 `battle_start → endgame_start → ...` 处理（起手方=先手）。
- `performAction` 永远执行当前行动方（`state.turn`），不接受 playerId，因此不存在「非当前方行动」的调用路径。

## 6. AI API（`window.PokerAI` / `require('./js/ai.js')`）

```js
AI.chooseLayout(state, playerId, opts?) -> string[]   // 长度 R 的 cardId，按区域序，必须来自自己手牌且不重复
AI.chooseAction(state, playerId, opts?) -> Action     // 必须属于当前合法行动集合
```
`opts = { rng?: RngLike, strength?: 'easy'|'medium'|'hard', layoutStrategy?: ... }`；`RngLike = E.makeRng(...)` 的返回对象；缺省由 AI 内部用 `state.config.seed` 派生确定性 RNG。旧值 `'normal'` 兼容映射为 `'medium'`。

**三档强度语义（v1.2 引入，v1.3 适配新决战，v1.4 适配行动点，v2.2 强化移牌/弃区，v3.0 CEM 优化/长远规划/波动）**：
- `easy`（简单）：明显弱化——粗糙启发式 + 大噪声 + epsilon 随机 + 随机布局，忽略部分结算概率/难度收益/手牌总和，允许次优甚至错误选择，但仍必须合法且能完成对局；不使用 `move`；不会主动做无意义的 `end_turn`（避免自杀式低级错误）。
- `medium`（中等）：稳健启发式——精确补牌分布 DP + 对手最佳回应（单步，hard-lite）、区域胜场/提前锁定价值、难度收益与剩余 AP 收益；不做整回合计划搜索；中等波动；允许高价值 `move`（背面牌潜在点数转移的边际收益为正时）。默认档。
- `hard`（困难）：精确补牌 DP + 对手最佳回应 + **整回合计划搜索（v3.0：枚举 1~3 个建设行动组成的计划，叶片用「行动 → 对手最佳回应」的盘面胜率估值；结算计划与建设计划在同一胜率尺度比较）** + **决战邻近投影长期项（v3.0：`deck − 2×未结算区域` 变小时向最终决战盘面投影混合，按最终归属而非当前正面和建设/移牌）** + 参数化对手模型；`move` 纳入候选（集中背面牌、主动放弃赢不了的区域）；极小波动。布局阶段枚举选牌组合 + 参数化目标（区域胜率/留手牌总和）。
- 波动（v3.0）：先 CEM 收敛、后叠加小幅波动；幅度按档位 easy > medium > hard（`TRAINED` 参数中 `waveAmp/waveEps`：hard≈0.004/0.005、medium≈0.03/0、easy≈0.25/0.08），随机源为 `hashUnit(seed|turnCount|player|actionKey|salt)` 的确定性哈希，不读取隐藏信息；同 seed 同局面决策完全一致，不同 seed 产生有界差异；`stallCount>=1` 时不会因波动选择 `move`。
- 训练：CEM（交叉熵法）自对弈优化（`tools/train-ai.js`），训练 / 验证 / holdout 种子三层隔离，只按独立验证集选 checkpoint，收敛后单独校准波动；参数为 `js/ai.js` 中可读的 `TRAINED.{hard,medium,easy}` 对象（由训练生成，测试可经 `AI._internals.TRAINED` / `AI._internals.TRAINED_META` 读取）。算法、参数空间、收敛曲线、过拟合诊断、holdout 与未达标项见 [`docs/AI-OPTIMIZATION.md`](AI-OPTIMIZATION.md)。
- 行动点（v1.4）：AI 的 `chooseAction` 每次只返回**当前回合内的下一步行动**（主循环会继续调用直到回合结束）；合法集合已按 AP 过滤，AI 可在「结算 3 点」与「放/翻/摸 + 剩余点数的后续动作」之间权衡；无正收益时返回 `end_turn`。
- 移牌（v2.2）：`medium`/`hard` 会使用 `move`；`easy` 不使用。决战 build 阶段 `hard`/`medium` 用「最终投影盘面」评估（我方正面+背面牌值全量计入、手牌按理想落区计入、对手未知牌按未见牌均值摊到各区域，区域胜率 + 胜场门槛 DP），因此会用移牌主动放弃赢不了的区域、把牌集中到能赢的区域；为保证对局终止，build 阶段每回合首个行动若仍有背面牌，AI 优先翻一张「移动机会成本最小」的牌（`easy` 在翻/放中随机，天然推进）。
- 防拖延保护（v1.5）：`state.players[pid].stallCount>=1` 时 AI 不选择 `move`（优先选择翻/放/摸/结算等推进行动），避免因「连续两回合仅移牌」被认输判负；实测 AI 自对弈 0 次 forfeit。
- AI 必须对 `settleCards`（1/2/4）、`difficulty`、`regionCount`、`apPerTurn` 配置自适应。启发式 `PokerAI.VERSION = '3.5.0-robust'`（v2.12：中等档反囤牌响应（公开信息检测对手囤牌→提高推进/结算优先级）；v2.10：hard 强度在 **5 区**条件化去手写 shaping（place 优先池/heavyTempo/earlyPass；3 区与 easy 保持 3.3.0 行为），v2.1 行为：战斗阶段可主动提前结束回合、3 区决战 build 优先连续放牌；v1.7 的 3.1.0 参数/结构保留为冻结对照 `tools/baseline-ai-3.1.0.js`）；测试可用 `_internals`（估值/投影/计划辅助函数）做白盒断言。
- v2.4 ML 引擎（`window.PokerAIML` / `require('./js/ai-ml.js')`）：**`PokerAIML.VERSION = '2.1.0'`**，接口不变（`hasModel()/getModelMeta()/createPolicy(heuristicAI, opts?)/defaultPolicy()`）；策略对象 `{VERSION, kind, chooseLayout, chooseAction, getStats, options}`；默认 `opts = {lambda:0.85, margin:0.002, topPlans:5, heuristicTop:5, worlds:2, mlRegions:null, strength:'hard'}`；**全区域（3/5/7）启用 ML**，异常/无模型/非法行动时回退启发式 3.3.0（`aiEngineState().fallsBack=true`）。**v2.3 = ML 2.0.0：世界模型 V_w + 采样世界计划评估（planpi）**：① **世界模型 V_w**：输入 93 信息集特征 + 72 世界特征 = **165 维**，H32 MLP × **3 model ensemble（vw1a/vw1b/vw1c，logit 平均；val AUC 0.8645-0.8676）**，输出「假设该采样世界为真」的终局价值；搜索时只在 `sampleWorld`（仅用 `E.getUnseenCards` 的公开信息 determinization）采样世界上读取隐藏槽位，**信息公平**；② **战斗 planpi**：保留启发式 top-5 计划候选与 margin 覆盖逻辑，叶评分改为 `mean_w[λw·V_w(叶_w) + λi·V_info(叶)] + λh·H`（K=3 采样世界，λw=0.4/λi=0.45/λh=0.15），显著优于默认计划才覆盖；③ **布局/决战 build** 沿用 v2.2 统一自由框架（布局全 C(2R,R) 子集搜索实测 96/96 与启发式一致 subsetDiff=0；build 全合法行动自由搜索 + 回合级 productive 护栏，0 stall/0 forfeit）。ML 决策绝不读取对手隐藏牌值/牌堆顺序；同 seed 确定；模块异常/无模型/非法行动时由控制器安全回退启发式。接入由 `js/main.js` 根据设置 `aiEngine`（`heuristic`|`ml`，默认 `ml`）选择；单机困难档生效，easy/medium/LAN 不使用。方法/数据见 [`docs/AI-ML.md`](AI-ML.md) §17。

**信息公平约束（AI 必须遵守）**：
- 只能使用自己的手牌、公开的正面牌/区域状态/比分/牌堆张数/弃牌堆/日志/config；
- 禁止读取：对手手牌内容、牌堆顺序、未揭示的双方布局分配、对手背面牌身份；
- 禁止修改 state、禁止消耗 engine 的对局随机数（自己的蒙特卡洛/随机必须用 `opts.rng` 或本地 RNG）。

## 7. UI / main.js 集成要求（ui-dev 负责实现）

### 7.1 对局流程
1. 设置界面 → `Engine.validateConfig` 校验并展示 `gapToEndgame`/`endgameThreshold`/结算随机性等提示 → `Engine.createGame(config)`。
2. 布局阶段：显示玩家 10 张手牌 + 5 个区域槽位；玩家选 5 张并按区域顺序提交（`submitLayout`）；AI 用 `AI.chooseLayout` 提交（AI 不得看到玩家已提交的分配）；`finalizeLayout` 返回事件，UI 播「放牌/揭示 + 后手补牌」动画。
3. 战役阶段循环：
   - 玩家回合：UI 收集意图 → 控制器转成 Action → `performAction` → 播事件动画 → `render(state)`；**同一回合可能连续多个行动**（AP 未用完时操作权不切换，直到 AP 耗尽/无可用行动/玩家点「结束回合」）；
   - 电脑回合：延迟 → `AI.chooseAction` → `performAction` → 动画 → 若仍是电脑回合（AP 剩余）继续调度，直到回合结束；
   - 动画/电脑回合期间禁止玩家操作（busy 锁）。
4. 单独结算动画：补牌张数 = `config.settleCards`（1/2/4），从事件 `drawn.p1/p2` 数组逐张展示，可跳过的分段动画。
5. 战略决战：`endgame_start`（双方各摸剩余区域数 X 张、牌堆摸空）+ `endgame_draw` ×2 → UI 播决战补牌动画；build 阶段禁用摸牌/结算，只显示翻牌/放牌/移牌，并展示跳过回合（`endgame_skip`）；双方耗尽后 `endgame_showdown` → 无补牌确定性结算（`endgame_settle[deterministic]`）。
6. 终局：播摊牌动画 → 终局面板（区域胜负、提前锁定、手牌总和、胜因）→「再来一局 / 调整设置 / 查看规则」。提前锁定时剩余区域显示「未结算」。

### 7.2 调试与自动化接口（E2E 测试依赖，必须实现）
```js
window.PokerDebug = {
  version: '1.5.0',
  startGame(configOverrides?) -> state,   // 用当前设置/覆盖项立刻开一局，返回 state 引用（支持 turnTimeLimit 覆盖）
  getState() -> state,
  startLayoutDemo() -> void,              // 进入一局并停在布局阶段
  submitLayoutByIndexes(indexes?) -> void,// 布局阶段：默认选前 R 张并确认（含 AI 布局、揭示）
  dispatch(action) -> Event[],            // 人类合法行动直接执行（不播动画或快速播放）
  autoPlayToEnd() -> Result,              // 双方 AI 快速自对弈到终局并返回 result
  setAnimationEnabled(bool) -> void,      // true=正常动画，false=瞬时
  setAiDelay(ms) -> void,
  getResult() -> Result|null,
  setTurnTimeLimit(sec) -> TimerState,    // v1.5：运行时覆盖当前局倒计时秒数（0=关闭；不影响已保存设置）
  timerState() -> {enabled,total,remaining,running,paused,expired,localPlayerId},  // v1.5
  setAutoplay(bool) -> TrusteeState,      // v1.6：开关「托管」（v1.7 起单机与联机均可用；简单 AI 代打本地玩家）
  autoplayState() -> {enabled,active,aiStrength,phase,turn,busy,pending,paused,pauseReason,lan,banner,button},  // v1.6/v1.7
  aiEngineState() -> {engine, available, mlVersion, fallsBack, defaults, gate, gateReason, usingMl, lan, regionCount, strength, heuristicStrength, stats, warned}  // v2.5：三档职责（简单=稳健启发式/中等=最强启发式/困难=机器学习）；设置面板无引擎二选一，状态供调试/E2E
}
window.PokerApp = { getState, startGame, getController }  // 可选调试入口
```
- ML 引擎（v2.6 = ML 2.2.0）：**仅困难档使用**（简单档=稳健启发式、中等档=最强启发式）；`PokerAIML` 不可用/异常/返回非法行动/非单机时自动回退最强启发式；`startGame({aiEngine})` 与 `PokerDebug.setAIEngine` 仅作内部调试/对照，设置面板不暴露；`PokerAIML` 不可用/模块异常/返回非法行动/非单机困难档时自动回退启发式 3.3.0（`fallsBack=true`, `gateReason` 如 `lan|engine|strength|unavailable|exception|illegal-action`）；**全区域 3/5/7 均启用 ML（`gate.mlRegions=null`，无区域门控）**，R3 仍用配置专家路由 + λ=0.55、R5 用 ensemble + λ=0.85；**v2.6 行为：世界模型 V_w（165 维，vw3a/b/c + vw4a/b/c 六模型 logit ensemble）+ 战斗采样世界计划评估 planpi（K=4，λw=0.4/λi=0.45/λh=0.15）；决战 build 自适应深搜（首行动 beam8/budget200、同回合后续 beam6/budget120，特征/投影缓存 + 直通 performAction）+ place→end_turn 节奏候选（0.08 校准 bonus，debug 可用 env `V26_PASS_BONUS` 覆盖）+ 主动空过候选；布局沿用启发式（内置布局 ML 搜索因 cloneState 布局提交标记问题未启用，见 AI-ML §20 已知限制）**；`PokerDebug.aiEngineState()` 暴露 `mlVersion='2.2.0'`、`gate`/`gateReason`/`stats`（`mlChoices/heuristicChoices/...`）供 E2E 验证 ML 确实被使用。
- 托管（v1.6/v1.7）：`autoplayState().aiStrength` 固定 `'easy'`；`active` 表示当前生效（单机或联机、非 `?autoplay=1`、未终局、轮到自己/布局/对手在线）；`paused` 在设置/规则/确认弹层打开、页面隐藏、对手离线/重连中或非本人回合时为 true，`pauseReason` 为字符串（如 `overlay|hidden|opponent-offline|not-local-turn|rematch-wait`，实现可扩展）；**联机模式允许 `setAutoplay(true)`**，行动走 LAN 提交管线；托管状态**不持久化**、新局默认关闭、终局/离开房间自动复位。
- 动画关闭时所有 UI 更新应为同步/微任务完成，`PokerDebug.dispatch` 返回后 state 已更新。
- v1.5 音效模块 `window.PokerSFX` 见 §7.5；`PokerDebug` 不依赖音效（无音效环境不得报错）。

### 7.3 DOM 测试钩子（qa/Lead 的 E2E 需要，必须实现）
根节点 `#app`。关键元素加 `data-testid`：
- `phase-banner`、`turn-indicator`、`deck-count`、`threshold-count`、`score-p1`、`score-p2`、`score-ties`
- 行动按钮：`action-settle` `action-flip` `action-place` `action-move` `action-draw`（含快捷键 1~5）；`btn-end-turn`（v1.4 提前结束回合，快捷键 Space）
- 行动点：`action-points`（v1.4，文本如「行动点 2 / 3」，带 `data-ap`）
- 手牌容器 `hand`，每张牌 `hand-card` + `data-card-id`；对手手牌数 `opp-hand-count`
- 区域：`region-0` … `region-{R-1}`；每区域 `region-{i}-p1-sum`、`region-{i}-p2-sum`、`region-{i}-status`；我方背面牌 `data-card-id`，悬停浮层 `own-back-tooltip`（v1.4）
- 布局：`layout-panel`（`data-anim-state="dealing|revealing|revealed"`）、`layout-slot-0…`、`btn-confirm-layout`、`btn-clear-layout`、`layout-hint`
- 设置：`settle-mode-1` `settle-mode-2` `settle-mode-4`（结算随机性 1/2/4 张）、`ai-strength-easy` `ai-strength-medium` `ai-strength-hard`、`ai-strength-hint`、`settings-summary`；**v2.5 起不再提供 `ai-engine-*` / `ai-engine-hint` / `settings-ai-engine`**（三档职责见 §AI 契约）。
- 对局信息：`deck-count`、`threshold-count`、`compensation-draw`（v1.3.1：文本「后手补偿 K 张（⌊区域数/2⌋）」）
- 决战：`endgame-splash`、`endgame-draw-p1`、`endgame-draw-p2`、`endgame-build-banner`、`endgame-skip-notice`、`endgame-showdown-banner`
- 输入开关（v2.11.2）：URL 参数 `?drag=0`（或 `window.__POKER_DISABLE_DRAG=true`）**禁用拖拽**（Android APP 默认使用；桌面默认开启拖拽，点击选牌→点槽位仍可用）
- 手机模式弹窗（v2.12.2）：Android APP 的「选择游戏模式」（右上角齿轮）原生弹窗含「返回」「退出」按钮（非网页 DOM，无 data-testid）；游戏设置面板内不再有 Android 专属按钮。
- 手机横屏布局（v2.11.1，视口高 ≤560px 启用）：顶栏 `[data-testid="btn-mobile-info"]`（「信息」按钮，切换 `body.is-mobile-info-open`）；侧栏抽屉内 `[data-mobile-info-close]`（「关闭 ✕」）；手牌 `.hand` 位于牌桌右侧 104px 列（`.seat-player`/`.seat-inner` 为 `display:contents`）；桌面 1440×900 / 1280×800 布局不变
- 弹层：`settlement-overlay`（`data-anim-state="drawing|revealing|result"`；摊牌时 `data-deterministic="1"`）、`settle-draw-p1-0..{N-1}`、`settle-draw-p2-0..{N-1}`、`settle-total-p1`、`settle-total-p2`、`settle-result-banner`、`settlement-confirm`、`endgame-splash`、`gameover-overlay`、`gameover-early-badge`、`settings-modal`、`rules-modal`、`toast`
- 背景音乐（v1.4）：`btn-music-toggle`（顶栏 ♪ 开关）、`music-volume`（音量滑杆 0–100）、`music-volume-val`（百分比文本）、`music-enabled-0`/`music-enabled-1`（设置面板开/关）；全局模块 `window.PokerMusic`（`configure({enabled,volume})` / `setEnabled` / `setVolume` / `state()` / `play` / `pause`），本地循环 `music/1.mp3`，播放失败静默。
- 回合倒计时（v1.5）：`turn-timer`（`data-total`/`data-remaining`/`data-state="idle|running|paused|expired|off|opponent|trustee"`，`.is-urgent` ≤10s；v1.6 托管时 `data-state="trustee"`）、`timer-option-0`/`timer-option-15`/`timer-option-30`/`timer-option-60`（设置面板倒计时档位，`data-setting="turnTimeLimit"` `data-value`）；超时 toast 文案 `timeout-toast`（或复用 `toast` 且文本含「超时」）；调试见 §7.2。
- 音效（v1.5）：`btn-sfx-toggle`（顶栏 🔊 开关，`aria-pressed`）、`sfx-enabled-0`/`sfx-enabled-1`（设置面板开/关）、`sfx-volume`（音量滑杆 0–100）、`sfx-volume-val`（百分比文本）；全局模块 `window.PokerSFX`（见 §7.5）。
- 拖动支持（v1.6，取代 v1.5 的「背面牌→其他区域=move」单一语义）：
  - 布局：手牌→空槽位 = 放置；槽位牌→手牌区/玩家座位 = 取回。`data-draggable="hand|slot"`。
  - 战役：手牌→区域 = `place`；我方背面牌（`data-draggable="back"`）**拖回源区域 = `flip`（2 AP）**、**拖到其他开放区域 = `move`（1 AP）**。落点合法性一律用 `E.getLegalActions` 校验后提交，UI 不硬编码规则（决战 build 阶段同样适用）。
  - 悬停动作钩子：拖动时悬停区域写 `data-drop-action="flip|move|place"`、`data-drop-valid="true|false"`，并加 class `is-drop-hover` + `is-drop-valid|is-drop-invalid` + `is-drop-flip|is-drop-move|is-drop-place`；动作徽标 `[data-testid="drop-action-badge"]`（合法文本含「翻开 · 2 AP」「移牌 · 1 AP」「放牌 · 1 AP」，非法暗红含原因）。
  - Drag ghost：`[data-testid="drag-ghost"]`，带 `data-drag-kind="hand|back|slot"`；默认映射提示 `[data-testid="drag-ghost-action"]`；拖动源牌加 `.is-drag-source`。
  - 非法落点松手：`ui.error` + 明确 toast（优先级：决战最终结算 > AP 不足 > 区域已结算 > 其他），不改变对局状态；拖动结束后的 click 需抑制（约 500ms），避免重复触发点击流程。
- 托管（v1.6，v1.7 起 LAN 可用）：`[data-testid="btn-autoplay"]`（单机/联机对局的布局与战役阶段显示；`?autoplay=1`、终局、无对局时隐藏；文案「托管」↔「取消托管」、`aria-pressed`、`.is-active`）；`[data-testid="autoplay-banner"]`（激活时显示，`data-phase="layout|battle"`、`data-mode="solo|lan"`、`data-ai-strength="easy"`）；托管期间 `body.is-trustee`、本地手牌/行动按钮/拖拽置灰并忽略操作（按钮 disabled 且 title/aria 含「托管中」）、`turn-timer[data-state="trustee"]` 显示「托管中 · 简单 AI」且本地倒计时暂停；设置/规则/确认弹层或页面隐藏时暂停调度。调试接口见 §7.2。
- 联机零命令引导（v1.7）：`[data-testid="lan-launch-guide"]`（`data-state="probing|found|not-found"`）、`lan-launch-status`、`lan-launch-ports`、`lan-launch-command`、`lan-copy-command`、`lan-retry-connect`、`btn-lan-launch-close`；file:// 页面点击「局域网联机」时探测本机已启动的服务器（端口顺序：`localStorage['poker-duel-lan-port']` → 5200 → 5211），可达则跳转 `http://127.0.0.1:<port>/?lan=1`，不可达显示引导。启动器 `tools/launch.js` / `启动联机.bat` / `start-lan.bat` 由 Lead 维护。
- 认输（v1.5）：`gameover-overlay` 在 `result.reason='forfeit'` 时显示「认输（连续两回合无有效行动/仅移牌）」；`stallCount=1` 时 `toast` 提示「本回合无有效行动：再空过一回合或仅移牌将判负（认输）」。
- 按钮：`btn-start-game`、`btn-restart`、`btn-settings`、`btn-rules`、`btn-settings-apply`、`btn-settings-cancel`、`btn-close-rules`
- 日志：`log-list`

### 7.4 本地存储
- `localStorage['poker-duel-settings-v1']`：设置 JSON（难度、结算随机性 settleCards、区域数、先手、AI 强度、动画速度、回合倒计时 `turnTimeLimit`、背景音乐 `musicEnabled`/`musicVolume`、音效 `sfxEnabled`/`sfxVolume`、昵称可选）。
- 旧版本存档中的 `deck` 字段读取时忽略/归一化为标准 54 张；`aiStrength:'normal'` 迁移为 `'medium'`；缺失 `settleCards` 时默认 2；旧值 `settleCards:3` 迁移为 4（复杂档）；缺失背景音乐字段时默认 `musicEnabled:true`、`musicVolume:30`（v1.4，沿用同一 storage key，不新增 key）；缺失倒计时/音效字段时默认 `turnTimeLimit:30`、`sfxEnabled:true`、`sfxVolume:70`（v1.5）。
- URL 测试参数（v1.4）：`?music=0|1` 覆盖背景音乐开关、`?volume=0..100` 覆盖音量（不写入 localStorage，直到应用设置/开局）。
- URL 测试参数（v1.5）：`?timer=0|15|30|60` 覆盖回合倒计时、`?sfx=0|1` 覆盖音效开关、`?sfxvol=0..100` 覆盖音效音量（同样不写 localStorage）。
- v2.5：设置面板不提供 AI 引擎选项；内部调试钩子 `?aiengine=heuristic|ml` 与 `PokerDebug.setAIEngine` 保留（仅供自动化/对照，不作为用户设置；缺省恒为 ml）。内部字段 `aiEngine` 不参与 UI 展示。
- 不得写入其他 key；读取失败/损坏时回退默认设置。
- v1.6：托管（`autoplay`/`trustee`）状态**不写入 localStorage**，每局默认关闭、终局自动复位；其余设置字段不变。
- v1.7：新增 `localStorage['poker-duel-lan-port']`（file:// 页面探测本地联机服务器时记录/优先尝试上次成功端口；独立 key，不写入设置 JSON；写入失败静默）。

### 7.5 音效模块契约（v1.5，`window.PokerSFX`）
- 加载顺序：`js/sfx.js` 在 `js/music.js` 之后、`js/ui.js` 之前；传统 script，UMD 风格但不依赖 engine/ai。
- API：
```js
PokerSFX.VERSION            // '1.0.0'
PokerSFX.SOUND_NAMES        // 19 个音效名（见下）
PokerSFX.configure({enabled?:boolean, volume?:number 0-100}) -> state
PokerSFX.setEnabled(bool) -> state
PokerSFX.setVolume(0-100) -> state
PokerSFX.play(name, opts?) -> boolean      // opts.volume 为本次相对音量 0..1；可能因关闭/限流返回 false（静默）
PokerSFX.stopAll() -> void
PokerSFX.preload() / load() -> Promise<{loaded,failed,total}>   // 预载全部音频（可用于等待资源）
PokerSFX.state() -> {supported,enabled,volume,unlocked,loaded,failed,total,playing,names}
PokerSFX.debugState() -> 调试详情（见下）
PokerSFX.getManifest() -> {name:{file,gain,trimDb,rmsDb,peakDb,duration,minInterval,maxConcurrent}}
```
- 音效名：`ui.click`、`ui.confirm`、`ui.error`、`card.place`、`card.move`、`card.flip`、`card.draw`、`card.shuffle`、`settle.go`、`settle.win`、`settle.lose`、`settle.tie`、`turn.start`、`turn.warning`、`turn.timeout`、`endgame.start`、`game.win`、`game.lose`、`game.draw`。
- 实现约束：HTMLAudioElement（不用 fetch/WebAudio/base64），因此 `file://` 可用；文件位于 `sfx/*.ogg`；首次用户手势解锁（pointerdown/keydown/touchstart 预载）；失败静默、不抛错、不写 console；每个音效有 `minInterval` 限流与并发上限（同名重播时从头发声）。
- 音量均衡：构建期已用 headless Edge 解码测量，按「有效段 RMS → -20dBFS、峰值 ≤ -1dBFS」预计算 `gain` 并叠加人工 `trimDb`；运行时只乘主音量（默认 70），UI 不得再乘系数。短促敲击类峰值先到上限、RMS 低于 -20dBFS 属预期。
- `debugState()` 字段：`{version,supported,enabled,volume,unlocked,targetRmsDb,peakCeilDb,loaded,failed,total,played:{name:count},blocked:{disabled,throttled,policy,unknown,error},loadErrors:[],sounds:{name:{file,gain,trimDb,rmsDb,peakDb,duration,minInterval,maxConcurrent,outRmsDb,outPeakDb,peakLimited,balanceOk,loaded,failed,error,playing,played}}}`。
- 事件映射约定（UI 实现）：`place→card.place`、`move→card.move`、`flip→card.flip`、`draw/extra_draw→card.draw`、布局揭示/发牌→`card.shuffle`、`battle_start/turn_start(本地)→turn.start`、结算开始→`settle.go`、结算结果→`settle.win/lose/tie`、`endgame_start→endgame.start`、`game_over→game.win/lose/draw`、按钮→`ui.click`、确认→`ui.confirm`、非法操作→`ui.error`、倒计时≤5s→`turn.warning`、超时→`turn.timeout`。

## 8. 确定性 / 可测试性

- 相同 `seed` + 相同动作序列 ⇒ 完全相同的对局（AI 决策也必须确定性：用 `opts.rng` 或由 seed 派生）。
- engine 不使用 `Date.now()` / `Math.random()`（`seed:null` 时用 `Math.random()` 生成一次种子即可）。
- engine 无 DOM 引用，可在 Node 中纯跑。
- 每步操作后必须满足不变量（qa 会检查）：54/自定义张数守恒、区域牌数一致、回合交替、牌堆非负、终局后不再接受动作。

## 9. 版本与变更

- VERSION 1.6.0（引擎，v2.1 规则：后手补偿固定 1 张）/ 启发式 AI 3.3.0 / **ML 引擎 2.1.1** / server 1.6.0；**项目版本 v2.5**（ML：世界模型 V_w 165 维 3-model ensemble + 采样世界计划评估 planpi，全区域 3/5/7 启用；开发集 dev n=2400 69.37%、fresh holdout 69.09%、7 区 70.3%）。契约变更需 Lead 更新本文件，并在共享任务/消息中通知 ui-dev、qa-dev。
- v1.2：新增 `settleCards`（结算随机性）、`SETTLE_MODES`、提前锁定（`result.early/unsettledRegions`）、`drawn` 改为数组、AI 三档 `easy/medium/hard`。
- v1.3：结算随机性改为 1/2/4（复杂 = 双方各 4 张，旧 `settleCards:3` 读取时迁移为 4）；战略决战重构为「触发（牌堆 ≤ 2×剩余区域数 X）→ 双方各摸 X 张摸空牌堆 → 决战构筑（禁用摸牌/结算、无牌可用自动跳过）→ 摊牌无随机确定性结算」；新增 state.endgame、`getEndgameThreshold`、`canBuildEndgame`、`markEndgameSkip`、`triggerEndgame`、`endgameAfterAction`、`resolveShowdown`、事件 `endgame_start/endgame_draw/endgame_skip/endgame_showdown/endgame_settle`；7 区域 + 54 张全档位合法；AI 新增 `chooseEndgameAction`。
- v1.3.1（规则微调）：后手补偿改为 `⌊区域数/2⌋` 张（3/5/7 区 = 1/2/3 张），新增派生字段 `config.compensationDraw` / `info.compensationDraw`；`finalizeLayout` 发 `⌊R/2⌋` 个 `extra_draw` 事件；校验下界改为 `D ≥ 6R + K + 1`（K=⌊R/2⌋），`deckAfterSetup = D − 4R − K`、`gapToEndgame = D − 6R − K`（标准 54 张下 R=3/5/7 = 35/22/9）。UI 修复（v1.3.1）：对手摸牌/补牌飞行动画一律牌背；区域背面牌区固定可见、不可被裁切。
- v1.4（行动点 + 结算条件取消）：
  - 新增行动点：`config.apPerTurn=3`、`E.AP_PER_TURN`、`E.ACTION_COSTS`、`state.players[pid].ap`；结算 3 / 摸牌·翻牌 2 / 移牌·放牌 1 / 结束回合 0；每回合开始回复到 3 点（不结转）；一回合可连续行动。
  - 新增 `end_turn` 行动（提前结束回合）与事件 `turn_end`/`turn_start`；`getLegalActions` 按 AP 过滤并始终包含 `end_turn`，每个 Action 带 `cost`。
  - 取消「结算要求区域内正面牌合计 > 2 张」的限制：任意未结算区域均可结算（`canSettleDeck` 仍是唯一公共校验）。
  - AI 按 AP 规划（行动 + 剩余点数后续收益）、不使用移牌；决战 build 阶段 AI 重新按「牌值落区 + 提前锁定」评估。
- v1.5（回合倒计时 + 音效 + AI 2.2）：
  - 新增配置 `turnTimeLimit`（秒，默认 30，0=关闭，合法 0 或 5–300 整数）、`E.DEFAULT_TURN_TIME_LIMIT`、`E.TURN_TIME_LIMIT_OPTIONS`、`info.turnTimeLimit`；引擎不执行计时，由 UI/客户端读取并在本地回合倒计时、超时自动 `end_turn`（`turn_end.reason` 仍为 `'manual'`）。
  - 新增 `js/sfx.js` / `window.PokerSFX` 与 `sfx/` 素材（19 个 Kenney CC0 ogg，构建期响度均衡）；`PokerSFX` 契约见 §7.5；UI 新增音效开关/音量设置（`sfxEnabled`/`sfxVolume`，默认 true/70）与 URL `?sfx`/`?sfxvol`。
  - AI 2.2：`medium`/`hard` 开始使用 `move`；决战 build 阶段改用「最终投影盘面 + 胜场门槛 DP + 两步规划」评估，并每回合保证翻一张牌（防止只移不翻的无限循环）；`easy` 仍不使用 `move`。
  - 防拖延/认输（v1.5）：新增 `players[pid].stallCount`、`state.turnProgress`、`result.reason='forfeit'` / `result.forfeitedBy`、事件 `forfeit`；某玩家连续两个自己的回合「无真实行动或仅移牌」→ 判负认输（不是跳过回合）；引擎强制跳过/无牌可动不计；AI 有保护不会因仅移牌自杀。
  - 拖动支持（v1.5，UI）：布局手牌→槽位/取回、战役手牌→区域（place）、我方背面牌→区域（move）支持 Pointer Events 拖拽；点击流程保留。
  - 版本断言：engine/server `1.5.0`、AI `2.2.0`；测试中旧的「AI 不使用 move」断言需按 §6 更新。
- v1.6（拖动增强 + AI 3.0 + 托管；引擎规则不变，engine/server 仍 1.5.0）：
  - 拖动：我方背面牌拖回源区域 = `flip`（2 AP），拖到其他开放区域 = `move`（1 AP）；悬停动作钩子 `data-drop-action`/`data-drop-valid` + `drop-action-badge`；非法落点明确提示且不改变状态（§7.3）。
  - AI 3.0（`js/ai.js`）：三档用 CEM 自对弈优化（训练/验证/holdout 隔离），收敛后叠加小幅确定性波动；hard 新增整回合计划搜索 + 决战邻近投影长期项 + 参数化对手模型，medium 新增精确补牌 DP + 单步对手最佳回应，easy 重新校准；参数/算法/收敛数据见 [`docs/AI-OPTIMIZATION.md`](AI-OPTIMIZATION.md) 与 `AI.TRAINED`。
  - 托管（v1.6，单人）：`btn-autoplay` / `autoplay-banner`；开启后由 easy AI 代打本地玩家（布局/战役/决战 build），本地操作忽略、倒计时暂停，`PokerDebug.setAutoplay/autoplayState`；LAN 不支持；不持久化（§7.2/§7.3/§7.4）。
  - 新增训练/基准工具 `tools/train-ai.js`、`tools/ai-benchmark.js`、`tools/baseline-ai-2.2.0.js`；新增 `tests/e2e/v6-features-e2e.js`；AI `VERSION = '3.0.0'`。
- v1.7（联机托管 + 联机零命令启动 + AI 最优解研究；引擎规则与 AI 行为不变）：
  - 联机托管：`isTrusteeActive` 放开 LAN；LAN 布局走 `confirmLanLayout → net.submitLayout`，行动走 `commitAction → commitLanAction` 并等待 SSE 更新（防重复/防本地改 state）；对手掉线 `pauseReason='opponent-offline'` 暂停、重连恢复；终局/新局/离开房间复位；`autoplay-banner` 增加 `data-mode="solo|lan"`；不持久化（§7.2/§7.3/§7.4）。
  - 联机零命令启动：新增 `tools/launch.js`、`启动联机.bat`、`start-lan.bat`（自动选空闲端口、启动服务器、打开浏览器进入 `?lan=1`）；file:// 页面探测本机服务器并跳转/显示 `lan-launch-guide` 引导（§7.3/§7.4）。
  - 困难 AI 研究：PIMC（12 组方案）与布局对手建模在当前运行时预算下未超越 v3.0 启发式，PIMC 不集成；据此对冻结 3.0 做 best-response CEM，只重校准 hard 的 17 维战斗/估值参数 → **AI 3.1.0**（相对 3.0 +2.8pt 镜像胜率，结构/性能/API 不变；报告见 [`docs/AI-PIMC.md`](AI-PIMC.md)、计划见 [`docs/AI-PIMC-PLAN.md`](AI-PIMC-PLAN.md)、参数/数据见 `docs/AI-OPTIMIZATION.md` §11）。
  - 新增测试/工具：`tests/e2e/v7-features-e2e.js`、`tools/pimc-probe.js`、`tools/layout-probe.js`、`tools/baseline-ai-3.0.0.js`。
- v1.8（困难档机器学习引擎 + 引擎切换；引擎规则不变，engine/server 仍 1.5.0）：
  - ML 路线：新增 `js/ai-ml.js`（PokerAIML v0.2.1，价值模型 + 一步前瞻计划重排，5 区门控）与 `tools/ml/` 管线；相对冻结启发式 3.1.0 镜像胜率约 **+5.2pt**（55.23%，n=3600），对真实 medium/easy 持平；信息公平/确定性/性能达标（p95≈4.2-4.9ms）。
  - 引擎切换：设置 `aiEngine`（默认 `ml`）+ URL `?aiengine=` + `PokerDebug.setAIEngine/aiEngineState`；仅单机困难档生效；`PokerAIML` 不可用/门控不通过/异常时回退 3.1.0；启发式 3.1.0 作为冻结对比基线保留（`tools/baseline-ai-3.1.0.js`）。
  - 架构路线负结果：决战短搜索/两层回合搜索均显著弱于 3.1.0（46.6%/34.7%、43.0%，oracle 89.3% 证明 determinization 必要），见 `docs/AI-OPTIMIZATION.md` §12。
  - 新增测试：v1.8 引擎切换 E2E；文档 `docs/AI-ML.md`、`docs/AI-ML-PLAN.md`。
- v1.9（迭代式自对弈 League 研究；**无产品行为/版本变化**，AI 3.1.0 / ML 0.2.1 / engine/server 1.5.0 均不变）：
  - 3 代 League（每代 8500 局混合对手池、H24 价值模型、~100 万行、训练/验证/tune/holdout 隔离）+ 探索性数据 + 区域专家 + per-config 组合；按独立 holdout 晋升规则均未产生可复现提升（最佳 hybrid 56.10% vs v0.2.1 同 seed 55.59%，+0.5pt 不显著，medium/easy -2pt），**未晋升/未采纳**。
  - 结论：当前「一步前瞻 + 同候选空间价值修正」路线确认饱和；生产默认困难 AI 保持 ML v0.2.1（门控 [5]），启发式 3.1.0 对比开关不变；契约/接口/存储/门控无变化。
  - 研究数据/计划：`docs/AI-ML.md` §11/§12、`docs/AI-LEAGUE-PLAN.md`、`tools/training-logs/ml-league-*`/`ml-explore-*`。
- v2.0（困难档 AI 升级：ML 1.0.0；引擎规则/AI 3.1.0 启发式/server 均不变）：
  - `js/ai-ml.js` 升级 **PokerAIML 1.0.0**：双价值模型概率 ensemble（v0.2.1 H16 + g2a H24）+ 按 config 路由的 R3 专家（R3N1D1/R3N2D2/R3N4D3，H24）+ 区域 λ（R3=0.55 / R5=0.85）+ 决战 build 的 V+投影混合决策（λ=0.7/margin=0.005/maxEvals=10）。默认 `{lambda:0.85, margin:0.002, mlRegions:[3,5]}`；`main.js` 的 `ML_POLICY_OPTS` 同步；UI 提示改为「3/5 区配置启用」。
  - 强度（canon6 双向、去平、同 seed 冻结基线）：**vs 冻结 3.1.0 61.3%（n=12000，seed 500000/550000/600000/610000/620000，CI [60.4,62.2]）**；同 seed v0.2.1 约 55.3% → +6.1pt。**vs 冻结上一代 ML v0.2.1 镜像 53.8%（n=3600，seed 621000/628000，CI [52.3,55.4]）** → +3.8pt。vs medium 约 62.2%（v0.2.1 约 62.7）、easy 约 83.0%（v0.2.1 约 84.4），无显著退化（点估计 -0.5/-1.4pt，CI 重叠）。
  - 确定性修复（发布门禁）：特征 evaluator RNG 由共享 FEATURE_RNG 改为公开 state 派生的 featureRngOf；build 与 battle 同受 region 门控（7 区回退 3.1.0，实测 694 次 build 决策 0 diff）；infer mode 2/3 修正为 ensemble-all（route-miss 不再误命中单模型）。官方 `--mode=checks` PASS；冻结文件 `js/ai-ml.js` sha256 `6A41466B…`（162530B）。
  - 性能/公平/确定性：决策 p95 5.6-5.8ms / max 34-41ms（Node eval）；浏览器隔离 p95 7.6ms / max 33.0ms；信息公平（信息集特征 + clone 模拟，不读隐藏牌/牌堆顺序）、同 seed 确定、异常安全回退 3.1.0；7 区回退不变。方法与数据见 [`docs/AI-ML.md`](AI-ML.md) §13；QA 报告见 `tests/e2e/REPORT.md` §25/§26。
  - 测试：`tests/e2e/v8-engine-e2e.js` 更新 E3.2 门控 [3,5]、E7（3 区启用 ML、7 区回退）；新增训练/研究工具保留在 `tools/ml/`、`tools/training-logs/`（研究中间产物交付前清理）。
- v2.1（规则回归 + AI 行为升级）：
  - **规则**：`compensationDraw` 改回**固定 1 张**（3/5/7 区相同，不再 ⌊R/2⌋）；引擎 `VERSION 1.6.0`、server `1.6.0`。初始状态：3 区先手 3/后手 4 手牌、牌堆 41；5 区 5/6、牌堆 33；7 区 7/8、牌堆 25。gapToEndgame = 54−6R−1 = 35/23/11。
  - **AI 行为**：困难/中等 AI（启发式 3.3.0 + ML 2.1.0）① 战斗阶段可在本回合已有推进行动、剩余 AP 不提升局面时**主动提前结束回合**（放弃剩余 AP，不触发 stall/认输）；② 决战 build 阶段**优先连续放牌**（一回合 2-3 张），手牌放完后再翻牌，不再强制每回合先翻一张；终局推进/摊牌仍保证，无死循环。
  - 接口/存储/门控不变；`main.js`/UI 文案同步后手补偿固定 1 张；测试需更新补偿相关断言（engine/edge/sim/lan/E2E）。ML/启发式行为指标见 [`docs/AI-ML.md`](AI-ML.md) §15 与 `tests/e2e/REPORT.md`。
- v2.2（ML 困难档升级：新规则重训 + 三阶段统一自由决策框架；引擎规则/AI 启发式/server 均不变）：
  - `js/ai-ml.js` 升级 **PokerAIML 1.6.0**：5 个价值模型用引擎 1.6.0（补偿固定 1 张）数据重训——D1 新规则 3.1.0 自对弈 2800 局（47.9 万行）、gen20 自由策略轨迹 8500 局（114.5 万行）、gen22 on-policy 轨迹 8500 局（111.1 万行），从 c2 模型 fine-tune（lr=4e-4/ep=10）；模型结构不变（H16 + 4×H24 ensemble/专家路由 + 门控 [3,5]）。
  - **三阶段统一自由决策框架**：三阶段共享同一评估栈（信息集 V + 启发式 H/投影 + 采样世界公平 + margin 覆盖 + 确定性回退），差异仅动作空间/预算：布局=全 C(2R,R) 子集 × 2 顺序搜索 + K=2 对手布局采样（实测启发式子集已最优 subsetDiff=0）；决战 build=全部合法行动（flip/place/move/end_turn）自由搜索 + 回合级 productive 护栏（0 stall/0 forfeit）；战斗=保留旧强重排（全自由搜索经独立评估为负结果：vs 3.1.0 40-51%、延迟 31-79ms，不采用）。
  - 强度（canon6 双向、去平、同 seed 冻结基线）：开发集 n=2400（seed900000+901000）**64.0%**［62.0,65.9］（上一代 1.1.0 同 seed 62.8%，+1.2pt）；fresh holdout seed920000/921000（n=1200×2）64.3%/65.3%（旧版 61.1%/待补）；相对内部无自由化强基线 c2（66.0%）低约 2pt（自由化代价，§16 权衡表）。
  - 行为/性能：决战 build 首行动 move≈70%/flip≈17%/place≈12%（旧版固定 FM 62%），Top 模式 41%，0 stall/0 forfeit/0 非法；build 决策 p95 5-7ms、布局 p95 2.4ms；官方 `--mode=checks` PASS；`tests/ai-behavior.test.js` 断言更新为 v2.2 自由/安全语义。
  - 负结果如实记录：战斗全自由搜索不可行；布局全子集搜索 subsetDiff=0；on-policy 单代重训 +0.16pt（噪声）。方法与数据见 [`docs/AI-ML.md`](AI-ML.md) §16；QA 报告见 `tests/e2e/REPORT.md` §28。
- v2.6（ML 2.2.0：决战 build 自适应深搜 + place→end_turn 节奏 + 性能优化；引擎终局判定修复；学习/搜索多方向负结果）：见 [`docs/AI-ML.md`](AI-ML.md) §20、[`docs/AI-ML-PLAN-v2.6.md`](AI-ML-PLAN-v2.6.md)
  - `js/engine.js` 修复终局判定：门槛锁定 → **区域胜场多者（`region_wins`，`early=false`）** → 手牌总和（`hand_sum`）→ 平局（`draw`）；原实现漏比区域胜场，导致「所有区域结算完、胜场 3:2、无人到 7 区门槛 4 胜」被判平局。新增 `tests/engine-endgame-judgment.test.js`（6 用例）+ v3 E2E scenario14 终局面板回归。
  - `js/ai-ml.js` 升级 **PokerAIML 2.2.0**（sha256 `A736CC2F…57D04B`，593,429B）：① 决战 build 自适应深搜（首行动 beam8/budget200、同回合后续 beam6/budget120；E1：dev n=2400 +1.8pt / full27 +2.8pt）；② 性能优化（buildValueOf/buildProjectionOf 状态签名缓存 + buildApply 直通 performAction，决策语义不变）；③ **place→end_turn 放牌节奏候选**（回合首决策比较「连续行动到回合末」与「放一张立即结束」的 blend 叶值，后者高出 0.08 校准 bonus 才采用；A/B 配对 +2.75pt n=600，build 回合出现率 30.9%、最长连续 12；debug env `V26_PASS_BONUS`）；④ 主动空过候选保留；世界模型/planpi 不变；全区域启用；信息公平/确定性不变。
  - 负结果：端局精确求解（-5~-25pt，预算内仅 1-2 ply）、选择性 2-ply（-1.2pt）、布局搜索扩展（-0.85pt；同时确认产品布局 ML 搜索因 cloneState 布局提交标记从未生效、修复后中性）、信念加权（似然区分度弱）、新特征/新一代 on-policy 重训（-1.3~-3.2pt）、强制 place 首行动（-34pt）。
  - 强度：见 [`docs/AI-ML.md`](AI-ML.md) §20（新引擎口径；旧 2.1.1 数据仅作历史参照）。
- v2.5（ML 2.1.1：决战 build 搜索 beam6/budget120；继续优化与智能度评估；负结果 vw5/K5/buildWorlds1/passmargin）见 docs/AI-ML.md §19
- v2.4（ML 困难档升级：ML 2.1.0 = 6 世界模型 ensemble + planpi K=4 + 决战 build 主动空过候选；启发式 3.3.0 = 概率表 warProb + medium 1.5 步前瞻；UI v2.4 = 区域滚动条 + 己方暗牌半透明；训练数据全 27 配置覆盖）：
  - `js/ai-ml.js` 升级 **PokerAIML 2.1.1**（sha256 `50BE4C06…A003`，587,388B）：6 个 165 维世界模型 logit 平均 ensemble（vw3 on-policy×3 + vw4 anti-specialist×3），planpi K=4，决战 build 将 end_turn 作为候选交给 V/投影评分（学习驱动的主动空过，stall 安全护栏）；全区域启用；信息公平/确定性不变。
  - `js/ai.js` 升级 **3.3.0**（sha256 `b6052987…6d0e66c`）：`_internals.warWinProb/warSettleProbs` 概率表模型（Φ + 无放回修正 + 平局），medium 概率驱动 1.5 步前瞻；**hard 决策与 3.2.0 逐条 0 diff**。
  - 强度（canon6 双向去平 vs 冻结 3.1.0）：开发集 n=2400 71.18%（2.0.0 69.37%）；全 27 配置 n=1512 70.39%；holdout n=2400 68.46%；对 6 特化全 27 配置 64.4-69.4%（均值 66.9%）；镜像 vs ML 2.0.0 57.11%。可测指标：全信息 oracle 上界 81.5%（gap 11.1pt）、LBR 近似最高反制 49.7%。详见 docs/AI-ML.md §18。
- v2.3（ML 困难档升级：ML 2.0.0 = 世界模型 V_w + 采样世界计划评估 planpi；引擎规则/启发式/server 均不变）：
  - `js/ai-ml.js` 升级 **PokerAIML 2.0.0**（sha256 `D1BEF917…B183F`，421,330B）：在 v2.2 三阶段统一自由框架上新增**世界模型 V_w**——输入 = 93 信息集特征 + 72 世界特征（`tools/ml/world-features.js`，WORLD_ONLY_DIM=72）= **165 维**，MLP H32，**3 个多样性模型 ensemble（vw1a/vw1b/vw1c，logit 平均；val AUC 0.8645/0.8654/0.8676）**；世界模型默认内联/自动加载，`V23_WORLD_MODES`（env `V23_WORLD_MODELS`）可覆盖。
  - **战斗 planpi（采样世界计划评估）**：保留启发式 top-5 计划候选与 margin 覆盖逻辑，叶评分改为 `mean_{w=1..K}[λw·V_w(叶_w) + λi·V_info(叶)] + λh·H`，K=3 采样世界（`sampleWorld` 仅用公开信息 determinization，**不读真实隐藏牌/牌堆顺序**），λw=0.4/λi=0.45/λh=0.15；仅在明显优于默认计划（margin）时覆盖，异常/无计划安全回退旧重排。
  - 布局/决战 build 沿用 v2.2 统一自由框架（布局 96/96 与启发式一致 subsetDiff=0；build 全合法行动自由 + 回合级 productive 护栏，0 stall/0 forfeit）。
  - **门控变更：全区域（3/5/7）启用 ML**（`mlRegions=null`，7 区不再回退启发式；7 区新增启用后 vs 冻结 3.1.0 n=600 = **70.3%**）；异常回退启发式 3.3.0 不变。CONFIG/STATE/EVENT 契约不变，`hasModel()/getModelMeta()/createPolicy()/defaultPolicy()` 接口不变。
  - 强度（canon6 双向、去平、同 seed 冻结基线）：**开发集 dev n=2400 = 69.37%**（seed900000/901000）；**fresh holdout n=2400 = 69.09%**；vs 冻结上一代 ML 1.6.0 镜像约 51.5%、medium 60.79；7 区 n=600 = 70.3%。方法与数据见 [`docs/AI-ML.md`](AI-ML.md) §17；独立评估由 ml-eval-dev 提供。
  - 行为/性能/测试：战斗首行动 5-6 类（draw/flip/place/move/settle/end_turn，planpi 实测 draw≈46%/flip≈33%/place≈13%/move≈3%/settle≈4%）、build 自由、布局 96/96 与启发式一致；0 stall/0 forfeit/0 非法；p95≈15ms（planpi），官方 `--mode=checks` PASS；确定性/信息公平保持；测试钩子 `PokerDebug.aiEngineState().mlVersion` 断言更新为 `2.0.0`，门控断言由「3/5 区」改为「全区域 3/5/7 可用」（7 区不再有 `region-gate` 回退）。

## 10. 局域网联机扩展（v1.1，向后兼容）

> 协议、接口、镜像/脱敏规则以 **`docs/LAN.md`** 为唯一事实来源；本节只说明对既有模块边界的影响。

| 文件 | 归属 | 说明 |
|---|---|---|
| `server.js` | Lead | 零依赖权威服务器：静态文件 + 房间/SSE + 规则引擎（Node require `js/engine.js`）+ 每客户端「镜像+脱敏」视图 |
| `js/net.js` | ui-dev | 浏览器联机客户端：`window.PokerNet`（fetch + EventSource + 自动重连 + sessionStorage 恢复） |
| `js/main.js` | ui-dev | 新增 `game.mode='solo'|'lan'`；LAN 下不调度 AI、动作/布阵走 `PokerNet` |
| `js/ui.js` | ui-dev | 新增联机大厅/等待房间/断线提示；文案与头像改用 `state.config.playerNames` |

对既有契约的影响：
- **单机模式完全不变**：`Engine`/`AI`/`PokerDebug`/URL 参数/`localStorage` key 均保持原语义。
- **LAN 客户端拿到的 state 是镜像+脱敏视图**：客户端永远把自己当 p1、对手当 p2；`config.seed=null`；`config.settleCards`、`config.turnTimeLimit` 正常下发；
  对手手牌/背面牌/牌堆/未揭示弃牌为占位卡 `{hidden:true, id:"hidden-*", rank:"?", value:0, ...}`；对手手牌等只能使用 `.length`。
- v1.5：房间创建 payload 的 `config.turnTimeLimit` 由服务器校验并透传到 state.config（默认 30）；倒计时由**各客户端只对自己的回合**执行（服务器不做强制超时），见 `docs/LAN.md` 已知限制。
- v1.5 防拖延/认输：`players[].stallCount` 属公开信息随 state 下发（镜像时随 players 整体交换）；`game_over.result.forfeitedBy` 镜像时交换；`forfeit` 事件按通用规则交换 `playerId`；LAN 断言双端 `stallCount/turnProgress/result` 一致。
- `Engine.getLegalActions(镜像视图)` 在客户端仍可用于按钮禁用/目标高亮（只依赖自己手牌与公开信息），但**动作必须由服务器校验执行**。
- `meta`（LAN 专用，单机无）：`{code, me:'p1', host, status, turn, players:{p1:{name,connected},p2:{name,connected}}, rematchReady, lanUrls, serverNow}`。
- `state.log` 保持公开信息（引擎保证不写隐藏牌面）；LAN 客户端直接展示。
- 事件流在 LAN 下由服务器按客户端镜像/脱敏后随 SSE `update` 下发；`events` 可能为空数组；`presence` 消息不含 state。
- 结算事件 `drawn` 为数组，属公开信息，服务器不得把已揭示的补牌替换成占位卡；`regionBefore` 中对手背面牌仍按隐藏处理。
- 提前锁定在 LAN 下照常：`game_over` 事件带 `result.early/unsettledRegions`，房间进入 `gameover` 状态，双方可再来一局。

## 变更记录：v2.10（中等档启发式条件化去硬编码战术）

- `js/ai.js` → **VERSION `3.4.0-cond`**，sha256 `4056EFFBA1E13806E9A95195F82A77B01A0E2AEB6650536B69E3406FA5CFC3D2`，92,072B（备份 3.3.0：`tools/tmp-v28/medium-r3/ai-3.3.0-backup.js`，sha `B6052987…`）。
- 变更（仅 hard 强度 + `regionCount===5`）：①决战 build 取消「place 优先池」→ `places+flips+moves` 全合法行动按投影评分；②决战 heavy tempo → 0；③战斗 `earlyPassAction` → 不使用。3 区与 `easy` 档行为/参数不变。
- 依据（用户决策「条件化集成」）：pure-safe 在 5 区 +4.5~+5.5pt；R3 保持产品逻辑后整体 fresh seeds **+4.38 / +5.33pt**（vs 旧 3.3.0，0 非法/0 forfeit、R3 精确 50.00）。规则本身不变（引擎 1.6.0 不变）。
- 测试：`tests/ai.test.js`（版本断言 3.4.0-cond；§6 决战 build 断言按新规则：medium 保持连续放牌、hard(5区) 仅要求真实推进）、`tests/war-prob.test.js` 版本断言已更新；`tests/run-all.js --skip-sim` 全通过。
- 设置文案：中等档 hint 改为「最强启发式：整回合计划搜索、锁定价值；5 区决战为纯评分池决策（默认）」。详见 README v2.10 段、`tools/training-logs/ml-v2.10-manifest.json`。

## 变更记录：v2.12（中等档启发式反囤牌鲁棒性）

- `js/ai.js` → **VERSION `3.5.0-robust`**，sha256 `5E8396E0E459B0BC6D50D566F40A5BCE74E056E6CB46618ED0082A1B1F94CF0D`，95,102B（回退 3.4.0-cond `4056EFFB…` / 3.3.0 `B6052987…`）。
- 变更（3 hunks +58/−2）：`chooseAction` 拆为 `chooseActionCore` + 反 hoard 包装；用公开信息（对手 battle 摸牌≥2、结算 0、手牌≥10）检测囤牌信号，命中时提高 settle/flip/place 优先级（优先高价值区域），否则逐位保持 3.4.0-cond；不改规则/引擎/隐藏信息/RNG。
- 验收：vs draw-hoard 头 n=600 局 **71.43%**（hoard 28.57% ≤55%）；vs 现产品 hard n=1200 对 **50.00% Δ0**（R3/R5 50.00、action 计数逐项相同）；vs ML Δ0（trigger 0/760）；p95 1.48ms；0 非法/0 forfeit。
- 测试：`tests/ai.test.js` / `tests/war-prob.test.js` 版本断言更新为 3.5.0-robust；`run-all --skip-sim`、`v3-e2e 191/0` 通过。规则不变（用户决策）；详见 `tools/tmp-v28/robust-medium/INTEGRATION-PACK-ROBUST.md`。
