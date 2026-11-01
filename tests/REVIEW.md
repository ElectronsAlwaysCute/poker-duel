# 引擎独立验收报告 · 规则核对清单

> 验收人：qa-dev（独立于引擎实现者）
> 事实来源：`docs/RULES.md`（规则唯一事实源）、`docs/CONTRACT.md`（接口契约）、`docs/UI-SPEC.md`（前端验收）
> 本目录测试为**零依赖**（仅 Node 内置 `node:test` / `node:assert`），可直接运行。
> 本文件随每次回归更新；`P0/P1/P2` 为问题严重级别（P0 规则错误 / P1 崩溃或契约破坏 / P2 边界或文档偏差）。
>
> **清理说明（v1.3 交付）：** 文中引用的旧截图（v1.x/v2/v3，如 `art/qa-*.png`、`art/qa-v2-*.png`、`art/qa-v3-*.png` 等）已作为中间文件清理；最终验收以 §10–§12 与 `art/qa-v4-*.png`（45 张）为准。

## 0. 运行方式与当前结果（v1.2 · 2026-10-24）

```bash
cd poker-duel
node tests/run-all.js              # 一键：引擎 + 边界 + AI + 模拟 300 局 + LAN 集成
node tests/run-all.js --games=2000 # 完整模拟（默认 2000 局）
node tests/engine.test.js          # 主规则套件（51 项）
node tests/edge.test.js            # 边界/合成局面套件（14 项）
node tests/ai.test.js              # AI 合法性与信息公平（12 项，easy/medium/hard）
node tests/lan.test.js             # 局域网服务器集成（20 项，零依赖 createLanServer）
node tests/sim.js --games=300      # AI 自对弈大规模模拟（配置矩阵含 settleCards 维度）
node tools/fuzz.js --games=150     # 随机合法行动模糊测试
node tools/selfplay.js --games=200 --p1strength=hard --p2strength=medium   # 三档强度交叉
```

**最近一次全量回归（v1.2，engine 1.2.0 / AI 2.0.0 / server 1.1.0）：全部通过 ✔**

| 套件 | 用例 | 结果 | 耗时 |
|---|---|---|---|
| `tests/engine.test.js` | 51 | 51 pass / 0 fail | ~0.2s |
| `tests/edge.test.js` | 14 | 14 pass / 0 fail | ~0.02s |
| `tests/ai.test.js` | 12 | 12 pass / 0 fail | ~0.2s |
| `tests/lan.test.js` | 20 | 20 pass / 0 fail | ~4.2s |
| `tests/sim.js --games=300` | 114 合法配置（跳过 75 非法组合） | 异常 0 / 复现失败 0 | ~0.5s |
| `tools/fuzz.js --games=150` | 150 局 | 失败 0（决战 39 / 提前锁定 83） | ~1s |

模拟 300 局关键统计（基础 seed=1，确定性种子，矩阵含 settleCards 1/2/3）：

- P1/P2/平 = 45.3% / 54.0% / 0.7%；先手胜率 49.7%（先手为 P1 比例 55.0%）。
- 决战触发 10.3% / 全部单独结算 89.7%；其中提前锁定 37.7%；平均 12.0 行动/回合，最大 28。
- 行动占比：place 38.3%、flip 34.4%、settle 26.1%、draw 1.2%、move 0.0%（该矩阵下 AI 未使用移牌）。
- 难度摸牌对象分布 p1 301 / p2 296 / 无摸牌 342，逐笔核对符合 RULES §7。
- 同 seed 完全复现 20/20；隐藏信息无关性抽查 12/12。
- 三档强度交叉（200 局/项，标准 54、5 区、settle=2、difficulty=1）：hard 先手 vs medium 63.5%，medium 先手 vs hard 73.5%；medium vs easy 79.4%，easy vs medium 11.6%；hard vs medium（difficulty=3）58.0%、（settle=1）66.0%、（settle=3）61.5% —— 与 Lead 自测数据一致，满足 hard>medium≥55%、medium>easy≥65% 的目标。

## 1. RULES §9「实现裁定」逐条核对

| # | 裁定内容 | 对应测试 | 结论 |
|---|---|---|---|
| 1 | 先手随机（可配置），后手 +1 牌补偿 | engine「createGame 先手固定生效；随机先手由 seed 决定且可复现」「finalizeLayout 先手 p2 时后手 p1 补 1 张」 | ✅ 符合 |
| 2 | 「超过 2 张正面牌」= 双方正面牌合计 ≥3 | engine「仅当区域正面牌合计 > 2 时可结算」；sim 每局合法行动穷举比对 | ✅ 符合 |
| 3 | 单独结算的难度摸牌可触发决战（任何行动后立即检查） | engine「单独结算 + 难度摸牌使牌堆恰好降至 2×剩余区域」；edge 合成精确版 | ✅ 符合 |
| 4 | 平局时无人摸牌（三档难度均如此） | engine「平局：三档难度均无人摸牌」；edge 合成平局 | ✅ 符合（回归了 `regionWins.ties` 计数修复） |
| 5 | 同时结算不执行难度规则 | engine「摸牌使牌堆降至阈值→同时结算」；sim 每局校验 endgame 事件无 difficultyDraw | ✅ 符合 |
| 6 | 结算抽牌先 P1 后 P2 | engine「结算：抽 2 张（先 P1 后 P2）」；sim 逐区校验 | ✅ 符合 |
| 7 | 手牌总和只算手牌 | engine「hand_sum 终局」；edge 合成精确终局 | ✅ 符合 |
| 8 | 已单独结算区域计入最终比分、牌进弃牌堆 | engine「结算：区域废弃进弃牌堆」「终局判定 region_wins」；sim 牌张守恒 | ✅ 符合 |
| 9 | 「5 局 3 胜」为默认，3/5/7 通用化（胜场门槛/摸牌数） | engine「validateConfig 3/5/7」「defaultConfig 派生字段」 | ✅ 符合（winsNeeded=⌊R/2⌋+1） |
| 10 | 牌堆可自定义；阈值恒 = 2×未结算区域数 | engine「validateConfig 52/自定义牌堆」；edge「deck.suits」「小牌堆 34/38」 | ✅ 符合 |
| 11 | 无手牌上限/行动上限；摸牌恒合法 | engine「getLegalActions 穷举」；sim 每步校验「battle 阶段牌堆 > 阈值」 | ✅ 符合 |
| 12 | 初始摸牌 = 2R、布局数 = R | engine「createGame 3/5/7 初始牌数」「布局后手牌 5/6」 | ✅ 符合 |
| 13 | 同一区域可放多张背面牌，结算时不计数值并随区域废弃 | engine「含背面牌结算」；edge「合成背面牌结算」 | ✅ 符合 |
| 14 | 区域全部单独结算完、从未触发决战 → 直接判定 | engine「区域全部单独结算完」；edge 合成精确版（断言最后一个 settle 事件后直接 `game_over`、无 `endgame_start`、牌堆可非空） | ✅ 符合 |
| 15 | 牌堆过小时开局即满足决战：合法但退化 | edge「退化配置 N=6R+2（R=3,20 张）」；`N=6R+1` 在牌堆构成上不可达（见 §5.3） | ✅ 符合（可达部分） |
| 16 | 双方手牌 0 时 0:0 → 平局 | edge「双方手牌为 0 → 0:0 相等判平」 | ✅ 符合 |

## 2. 规则条款覆盖（RULES 正文）

| 条款 | 验收点 | 对应测试 |
|---|---|---|
| §2 牌与数值 | A=1…K=13、小王=14、大王=15；花色不参与比较；54 张构成 | engine「常量/ createDeck / formatCard」 |
| §4 战前布局 | 双方各 2R 张→各选 R 张按区域序正面放置→揭示→后手 +1→先手先行 | engine「submitLayout / finalizeLayout / 先手 p2」 |
| §5 行动1 结算 | 正面牌合计 >2 才可结算；双方各抽 N=settleCards 张（先 P1 连续 N 张、再 P2 连续 N 张）；sums 含补牌；平局；难度摸牌；区域废弃；结果入比分 | engine「结算基本/N=2 drawn 数组/含背面/结算非法」「难度 1/2/3」；edge 合成精确 | 
| §5 行动2 翻牌 | 仅我方背面牌、翻后计入总和、可使区域变为可结算 | engine「flip 效果 / 非法翻转」 |
| §5 行动3 放牌 | 手牌→区域背面、不计和、手牌空则不可放 | engine「place 效果 / 无牌可放（合法集合不含 place）」 |
| §5 行动4 移牌 | 仅我方背面牌、目标为另一未结算区域、仍背面 | engine「move 效果 / 同区/已结算/非法牌」 |
| §5 行动5 摸牌 | 牌堆顶、可能触发决战 | engine「draw 效果」「摸牌触发决战」 |
| §6 决战触发 | 行动后 `D ≤ 2N×X` 立即同时结算（N=settleCards）；区域升序；不执行难度 | engine「摸牌触发/难度摸牌触发/同时结算」；edge 阈值+1 合成 |
| §6.1 提前锁定 | 单独结算/决战途中达到 winsNeeded 立即结束；剩余区域保持 open；result.early/unsettledRegions | engine 终局判定；edge 两条提前锁定合成用例；sim 每局校验 |
| §6 最终判定 | 区域胜场 ≥⌊R/2⌋+1 优先；否则手牌总和；仍相等判平 | engine 三类判定；edge 合成精确终局 |
| §7 难度 | 1 败者摸、2 不摸、3 胜者摸；平局无人摸 | engine 三档 + 平局；sim 每笔 settle 事件校验对象 |
| §8 配置 | regionCount/difficulty/settleCards/firstPlayer/deck(ranks/jokers/suits)/seed/playerNames/aiStrength | engine「validateConfig / createGame」；edge「deck.suits」 |
| §8 确定性 | 同 seed + 同操作 = 全同；engine 不用 Date.now、Math.random 仅生成种子一次 | engine「同 seed 完全复现」「引擎实现约束（静态扫描）」 |
| §10 非目标 | 无外部依赖、无 DOM、无网络 | engine 静态扫描 + 全测试 Node 直接 require |

## 3. 边界与不变量（重点回归项）

1. **牌张守恒**：每一步断言 `牌堆+弃牌堆+双方手牌+未结算区域正反面 = 牌堆构成张数`，且牌 id 全局唯一、value 与 RANK_VALUES 一致（engine 每步、edge/sim 每步）。
2. **回合严格交替**：未终局时行动后必然换手；sim 每步校验。
3. **区域和与 API 一致**：`getRegionSideSum/getRegionFaceUpCount/getOpenRegionIds/getEndgameThreshold/getHandSum` 每步与实际牌面交叉核对。
4. **决战边界**：正常对局中决战必在「行动后牌堆恰 = 2N×X」触发；未提前锁定时触发后恰好消耗 2N×X、牌堆归零（数学证明 + 三种触发路径 + 合成精确用例）；**v1.2 起决战途中可提前锁定，此时牌堆剩余 = 2N×未结算区域数**。
5. **结局不变量**：`endgame.triggered=false` 时也允许全部区域单独结算完结束（牌堆可非空）；`endgame.triggered=true` 且未提前锁定时牌堆必为 0；提前锁定时允许存在 open 区域且 `result.unsettledRegions` 必须与之完全一致。
6. **错误原子性**：非法操作抛错后 state 必须逐字节不变（含 BAD_ACTION/BAD_REGION/BAD_PHASE/ALREADY_SETTLED/REGION_NOT_SETTLABLE/CARD_NOT_IN_HAND/NO_SUCH_CARD/DECK_INSUFFICIENT）。
7. **终局锁**：终局后 `getLegalActions=[]`，performAction/submitLayout/finalizeLayout 全部抛 `BAD_PHASE`。
8. **平局计数回归**：区域平局使 `regionWins.ties` 递增（曾出现 `regionWins.tie=NaN` 的真 bug，Lead 已修复）；edge 合成精确平局断言 `ties===1` 且为有限数字，终局 `result.regionWins` 与 state 一致。
9. **布局公平**：提交阶段双方分配互不可见；AI `chooseLayout` 在「对手已提交不同分配」时输出不变。

## 4. AI 独立验收（CONTRACT §6）

| 验收项 | 方法 | 结果 |
|---|---|---|
| 布局合法 | 3/5/7 区域 × 三难度 × 双方 × 4 种布局策略：长度 R、来自自己手牌、不重复（7 区自动用简单结算） | ✅ |
| 行动合法 | 开局/有背面牌/区域可结算/已结算一区/决战前等局面 × easy/medium/hard × 多随机种子，逐一比对 `getLegalActions` 穷举集合 | ✅ |
| 确定性 | 同 opts.rng、缺省 seed 派生、同 seed 整局自对弈三种方式 | ✅ |
| 纯函数 | chooseLayout/chooseAction 调用前后 state JSON 全等（sim 每步 + AI 套件） | ✅ |
| 信息公平 | 构造「仅隐藏信息不同」的副本：反转牌堆顺序、对手手牌顺序、对手背面牌顺序、弃牌堆顺序 → AI 决策必须不变（三档强度各验证）；另验证 `getUnseenCards` 互补/不泄露牌堆顺序 | ✅ |
| 可终止 | AI 自对弈全部在安全上限内结束，终局结果合法；提前锁定/决战/全单独结算三条路径均覆盖 | ✅ |
| 强度档位 | easy/medium/hard 均完成整局且行动合法；旧值 normal 映射 medium 决策一致；三档交叉胜率满足 hard>medium≥55%、medium>easy≥65% | ✅ |
| 性能 | medium 档单次决策 ≲2ms、hard ≲15ms（sim/selfplay 300+200 局均在秒级完成） | ✅ |

## 5. 疑点、澄清与非缺陷记录

### 5.1 已向 Lead 提出并确认的口径

| 议题 | 结论（Lead 确认） |
|---|---|
| A. 行动1 牌堆安全条件里「可能的难度摸牌(0或1)」 | 难度 1/3 保守按可能摸 1 张扣减；正常对局恒成立，仅极小牌堆退化时有影响。测试按此断言。 |
| B. 决战触发时牌堆是否恰为 2X | 正常配置下必在「行动后 D 恰=2X」触发，触发后牌堆归零；测试已断言。 |
| C. `getLegalActions` 是否穷举 | 是（settle/flip/place/move 全展开 + 恒有 draw）；测试用规则推导的期望集合逐项比对。 |
| D. 错误码映射 | 无 `NOT_YOUR_TURN` 路径（performAction 永远执行当前方）；move 同区→BAD_ACTION；move 到已结算→ALREADY_SETTLED；flip 非我方背面→NO_SUCH_CARD；place 非手牌→CARD_NOT_IN_HAND。测试按此断言。 |
| E. 布局前后牌数 | 布局前牌堆 34、双方各 10；finalize 后牌堆 33、先手 5 / 后手 6、区域正面牌 10。测试已断言。 |
| F. 随机先手 | 由 seed 决定且可复现；测试只断言同 seed 全同与两种先手均出现，不依赖具体算法。 |
| G. Result.reason 语义 | region_wins / hand_sum / draw 三值；测试按规则重算期望并逐一断言。 |

### 5.2 非缺陷观察（P2/P3，已确认不影响规则正确性）

1. **`validateConfig` 无法表达「空牌面」非法配置**：`defaultConfig` 对 `deck.ranks: []` 会补全为默认 13 种牌面（“补全默认值”语义），因此该非法输入被静默修正为合法默认牌堆。UI 侧若允许「全部牌面取消勾选」，需自行阻止或提示（建议 E2E 检查设置面板全不选时按钮禁用/提示）。
2. **`N = 6R+1` 立即决战分支不可达**：合法牌堆张数 = `4×|ranks|×|suits| + 2×jokers` 恒为偶数，而 `6R+1` 恒为奇数；且 `validateConfig` 已要求 `N ≥ 6R+1`。因此 `finalizeLayout` 内的「布局后立即决战」分支在当前配置体系下是防御性死代码；最小可达退化配置是 `N = 6R+2`（已验证 R=3、20 张：开局牌堆 = 阈值+1，首次摸牌即决战并恰好耗尽）。`N=6R+2` 布局后不立即决战，符合 Lead 说明。
3. **`state.endgame.threshold` 为初始值（2N·R）不随区域结算更新**：契约 §4 已注明「动态展示用 `E.getEndgameThreshold`」。若 UI 误用该字段渲染「决战阈值」，会显示旧值——列为 E2E 重点检查项（`threshold-count`）。
4. **`NOT_YOUR_TURN` 错误码未被使用**：CONTRACT §2 已注明无该路径，测试不断言。
5. **AI 移牌使用率低（约 1.5%）**：属策略设计选择，非规则缺陷；move 的规则正确性由引擎单测与合法集合穷举覆盖。
6. **AI `chooseAction` 在「非战斗阶段 / 非其回合 / 无合法行动」返回 `null`**：契约签名描述为 Action，但调用前置条件不满足时返回 null 是防御性行为；模拟与自对弈中不会触发（lead 已确认 AI 稍后落地时保持此行为）。UI 只应在 battle 且轮到该方时调用。

### 5.3 白盒合成测试说明

`tests/edge.test.js` 中「合成精确终局」类用例通过 `helpers.synthBattle` 从 `createGame` 的合法骨架出发，直接改写 CONTRACT §4 允许 engine 内部写的字段（deck/hands/regions/turn），以精确到达自然操作难以构造的规则边界（完全平局、手牌总和判定、区域胜场判定、背面牌不计和、恰在 2X 触发等）。此类用例跳过「牌张守恒」断言（因为只放置了参与该边界的部分牌），但会断言规则判定结果本身。所有自然对局路径另有 engine/sim 的逐步守恒校验。

## 6. 缺陷报告格式（发现问题时）

每条缺陷附：「seed + 配置 + 操作序列（canonical action trace）+ 期望/实际 + 最小复现片段」，并标注 P0（规则错误）/P1（崩溃、契约破坏）/P2（边界、文档偏差）。本目录测试失败信息已内置 `describeState` 与 `reproInfo`（含 seed、config、actionTrace），可直接粘贴复现。

## 7. 已知限制

- `tests/sim.js` 默认矩阵覆盖 54 种合法配置组合（3 难度 × 3/5/7 区域 × 7 种牌堆，牌堆不足的组合自动跳过并报告）。使用 `--decks`/`--regions`/`--difficulty` 可收窄；`--seed` 可换基础种子；`--random-seeds` 使用随机种子（复现时使用报告中打印的 seed）。
- 隐藏信息抽查为抽样（默认 12 次），非形式化证明；AI 源码层面的信息使用约定由 `getKnownCards/getUnseenCards` 接口 + 动态无关性测试共同保障。
- 浏览器层（DOM/交互/视觉/持久化）验收见 `tests/e2e/`（task-4 / task-15，另行产出报告）。

## 8. v1.2 新规则独立核对（task-14 阶段 B · 2026-10-24）

> 契约来源：`docs/RULES.md` §5/§6/§8/§9、`docs/CONTRACT.md` §3/§4/§5/§6（v1.2 更新后）。以下结论由独立测试推导，不按实现反推。

| # | 新规则/契约点 | 核对方法 | 结论 |
|---|---|---|---|
| 1 | `config.settleCards` ∈ {1,2,3}，默认 2；`E.SETTLE_MODES`/`E.DEFAULT_SETTLE_CARDS` 导出 | engine「常量」「defaultConfig」；ASSERT 数组内容与 cards 字段 | ✅ |
| 2 | 单独结算：先连续抽 N 张给 P1、再连续抽 N 张给 P2；`event.drawn`/`region.result.drawn` 为 `{p1:Card[]×N,p2:Card[]×N}`；sums 含补牌和；牌张守恒 | engine「结算 N=2 drawn 数组」；edge 合成精确断言 drawn 顺序/长度/sums；sim 每笔 settle 校验数组长度 | ✅ |
| 3 | 决战阈值 `2N×未结算区域数`；`info.endgameThreshold=2N·R`；`gapToEndgame = D−4R−2N·R−1` | engine/edge validateConfig 公式断言（R3/5/7 × N1/2/3）；sim 每步 `deck > 2N×open` 检查 | ✅ |
| 4 | 配置校验：`settleCards` 越界报错；`D < 4R+1` 与 `D < 4R+2N·R+2` 报错；7 区仅 N=1 合法 | engine「非法配置」「3/5/7 与 52/自定义牌堆」；edge 小牌堆 34/38 与 N=2 非法断言 | ✅ |
| 5 | 决战触发时牌堆恰好 = 2N×X；未提前锁定时恰好耗尽为 0 | edge「阈值+1 摸牌」「单独结算+难度摸牌」「反例」；engine 触发路径；sim 事件 deckAfter 递减断言 | ✅ |
| 6 | 提前锁定：单独结算达成 winsNeeded 立即 gameover，不进入决战；事件流无 `endgame_start` | edge「单独结算提前锁定」合成精确（action→settle→game_over）；invariant 断言 | ✅ |
| 7 | 提前锁定：决战逐区结算中达成门槛立即中断，剩余区域 status 仍 open；`result.early/unsettledRegions` 正确；锁定后无后续 endgame_settle | edge「决战途中提前锁定」；engine 终局判定；sim 每局 unsettledRegions 与 open 一致性；LAN 提前锁定用例事件流断言 | ✅ |
| 8 | 只有全部区域结算完且无人达标才比较手牌总和/平局；提前锁定时 handSums 仅记录 | edge「全部单独结算完」「合成决战 hand_sum/draw」；invariant 按 early 分支重算 | ✅ |
| 9 | `settle`/`endgame_settle` 事件带 settleCards；`endgame_start` 带 settleCards/threshold=2N×open；`game_over.result` 带 early/unsettledRegions | engine/edge 事件字段断言；sim 事件校验；LAN 事件镜像断言 | ✅ |
| 10 | LAN：房间 config settleCards 透传；drawn 数组镜像且为公开牌（不得脱敏成 hidden）；提前终局在双方视角一致；原有 18 项回归 | lan.test 新增 2 项（N=3 透传/drawn 镜像/公开可见；R3-N1 提前锁定事件流）；原 18 项更新后全绿 | ✅ |
| 11 | AI 三档 easy/medium/hard（旧 normal→medium）；合法/确定性/信息公平；对 settleCards/difficulty/regionCount 自适应 | ai.test 12 项（三档合法性、normal 别名、三档整局、打乱隐藏信息三档一致）；fuzz 20/20 公平性抽查 | ✅ |
| 12 | 确定性/不变量/牌张守恒按新规则更新（允许提前锁定留下 open 区域） | helpers.invariantErrors v1.2 重写（early/unsettled/drawn 数组/阈值公式/牌张守恒口径）；sim 每步/终局断言 | ✅ |

本轮未发现新的规则实现缺陷；v1.0 阶段确认的口径（§5.1）除公式更新为 N 外均继续成立。

## 9. 阶段 A：用户报「对局结束后点击调整设置被遮挡」BUG 复现结论

- 复现环境：真实 Edge（browser-skill）+ `node tools/serve.js 5193` + `http://127.0.0.1:5193/?autoplay=1&fast=1&seed=424242`（视口 1440×900 级）。
- 步骤与结果：自动演示至终局面板 → 点「调整设置」→ 设置弹层显示在终局面板**之上**且可操作；点「取消」→ 终局面板仍在；再点「调整设置」→「开始对局」→ 正常进入战前布局；点「查看规则」→ 规则弹窗同样在终局之上、可关闭；console 无 error/未捕获异常。
- 结论：**当前代码无法复现该 BUG**。根因假设（终局面板 z-index:50 盖住无 z-index 的 settings/rules 弹层）与现行 CSS 一致，但修复已在当前代码中：`css/style.css`「弹层层级」段声明 `settlement 46 < splash 48 < gameover 50 < settings/rules 52 < confirm 55 < LAN 58+`。真实浏览器观察层级：点击后设置/规则为最上层（L1 focus），终局面板降为下层（occluded）。
- 证据截图：`art/qa-bug-gameover-panel-1440x900.png`、`art/qa-bug-gameover-settings-1440x900.png`、`art/qa-bug-gameover-rules-1440x900.png`。
- 建议：请 ui-dev/Lead 确认该修复的提交时间点与用户测试用的构建版本（若用户测的是旧构建，则本项可标记「已修复」）；task-15 E2E 将保留「终局→调整设置/查看规则→取消→开始对局」回归用例防回归。

## 10. v1.3 新规则独立核对（task-19 阶段 B · 2026-10-24）

> 契约来源：`docs/RULES.md` §2/§4/§5/§6/§8、`docs/CONTRACT.md` §2/§3/§4/§5/§6（v1.3 最终口径：54 张 / 7 区全档 / 触发 2X / 各摸 X / 复杂性=4）。以下结论由独立测试与最大化模拟推导，不按引擎实现反推。
>
> **注**：后手补偿与 gap 数值已在 v1.3.1 调整（后手补偿=⌊R/2⌋，gap=35/22/9），见 §11；§10 中「后手 +1 张 / gap 35/23/11 / 布局后牌堆 25/33」等旧数值以 §11 为准，其余结论继续成立。

### 10.1 运行结果（最终版）

| 套件 | 结果 |
|---|---|
| `tests/run-all.js --games=300` | **全部通过 ✔**（engine 56 / edge 12 / ai 15 / lan 22 / sim 300 局），耗时 ~6s |
| `tools/fuzz.js --games=150` | 失败 0（触发决战 44 局 / 提前锁定 85 局；AI 信息公平 20/20） |
| `tests/sim.js --games=300` | 异常 0；决战率 35.0%、提前锁定 46.3%；同 seed 复现 20/20；隐藏信息抽查 12/12 |
| `tools/selfplay.js` | 三档强度交叉统计（发布说明引用 Lead 数据） |

### 10.2 规则/契约逐条核对

| # | 新规则/契约点 | 核对方法 | 结论 |
|---|---|---|---|
| 1 | `settleCards` ∈ **{1,2,4}**，默认 2；旧值 3 迁移为 4；`E.SETTLE_MODES` id/cards = 1/2/4 | engine「常量」断言 SETTLE_MODES 内容 + 无 3 档；engine「非法配置」断言 0/5 报错、3 迁移为 4（ok=true/info=4） | ✅ |
| 2 | 7 区仍标准 **54 张**：initialDraw=14、布局后牌堆 25、阈值 14；3/5/7 × N=1/2/4 全部合法；`info.gapToEndgame = D−6R−1`（54 张下 R=3/5/7 → 35/23/11，与 N 无关） | engine「3/5/7 区域 × 1/2/4 全合法」矩阵逐项断言；edge 7 区边界；sim 配置矩阵全部 7 区组合参与模拟 | ✅ |
| 3 | 决战触发：action 后 `deck ≤ 2×openRegionCount`（与 N 无关）；触发时 `endgame_start{openRegionIds,drawPerPlayer:X,drawnCounts:{p1:⌊deck/2⌋,p2:deck−⌊deck/2⌋},deckCount,threshold:2X,settleCards}` + `endgame_draw`×2（先 p1 后 p2），补牌后 deck=0 | engine/edge 合成精确（恰 2X、单独结算后 <2X、难度摸牌后触发）；sim 每步/事件字段断言；LAN 双端事件镜像断言 | ✅ |
| 4 | 决战 build：getLegalActions 只含 flip/place/move（无 settle/draw）；performAction 传 draw/settle 抛 `BAD_ACTION`（message 含禁用说明）；每次行动 turnCount+1、跳过不计 | engine「build 禁用」；edge「getLegalActions 不含 draw/settle + 拒绝 + 状态原子性」；sim 每步断言；fuzz 每步非法行动拒绝 | ✅ |
| 5 | 自动跳过：一方 hand=0 且己方场上背面=0 时 `endgame_skip{playerId}` 每方最多一次、`state.endgame.skipped` 置真、对方连续行动；双方耗尽立即 `endgame_showdown` | engine 全流程 + edge 全流程（同方最多一条 skip、skipped 标记、行动序列相邻重复）；sim 跳过事件与 skipped 一致性 | ✅ |
| 6 | 摊牌：`endgame_settle{deterministic:true,drawnCount:0,drawn:{p1:[],p2:[]}}`，按现有正面点数求和判胜、不执行难度规则；逐区 regionId 升序；提前锁定立即中断、剩余区域保持 open | engine「摊牌全流程」「难度1/3 无难度摸牌」；edge「摊牌确定性」「摊牌途中提前锁定」；invariant 摊牌分支校验；sim 摊牌事件逐字段 | ✅ |
| 7 | 提前锁定：单独结算后达成 winsNeeded 立即终局（无 endgame_start）；摊牌途中达成立即中断；`result.early/unsettledRegions` 与 open 区域一致；终局结束后无任何行动/事件 | engine/edge 合成精确 + 终局判定；invariant；sim 每局一致性与 game_over 后事件检查 | ✅ |
| 8 | 全部结算完无人达标：手牌总和（摊牌时通常 0:0）→ draw；`endgame.phase='done'`、终局 turn=null | engine「hand_sum」「draw」分支；edge §9#14；fuzz/sim 终局校验 | ✅ |
| 9 | 事件顺序：触发行动事件 → endgame_start → endgame_draw(p1) → endgame_draw(p2) → build 行动/跳过 → endgame_showdown → settles → game_over；deck 在触发后恒 0 | engine 事件序列断言；sim 每批事件顺序；LAN 双端事件镜像（公开投影一致） | ✅ |
| 10 | 单独结算 `drawn` 数组长度 = settleCards（复杂=4）；事件/RegionResult 一致；弃牌堆增加「区域全部牌 + 2N」、牌堆 −2N（难度摸牌另计；牌堆为空时难度摸牌不执行） | engine 结算 N=2 详细断言；lan.test N=4 透传；sim 逐笔 settle 断言 + 空牌堆难度摸牌豁免 | ✅ |
| 11 | AI：`chooseEndgameAction` 只选 flip/place；正常 chooseAction 在 build 阶段也不选 draw/settle/move；三档合法/确定/信息公平；easy 也能结束 | ai.test 新增 build 阶段五项（只选 flip/place、合法、同 rng 确定、隐藏信息无关、三档完成整局）；sim 每步 build AI 行动类型断言 | ✅ |
| 12 | LAN：`endgame_start/draw/skip/showdown` 镜像与脱敏（endgame_draw 不含牌面）；`endgame_settle` deterministic 原样镜像（drawn 空数组）；7 区房间 54 张/14 手牌/阈值 14 可打到摊牌 | lan.test 新增 §7.3/§7.4（双端事件镜像+脱敏、7 区配置/开局数/X=7 决战） | ✅ |
| 13 | 不变量口径：牌张守恒（含决战补牌进手牌）、阈值 API=2×open、endgame 结构字段、终局 deck=0、摊牌后手牌 0:0 | helpers.invariantErrors v1.3 重写；engine/edge/ai/sim 全部启用以身校验 | ✅ |

### 10.3 已发现并修复的缺陷（QA 独立复现）

- **【已修复】摊牌结算中终局 `state.endgame.phase` 卡在 `'showdown'`**：摊牌途中提前锁定或最后一区才达胜场门槛时，`resolveShowdown` 提前 `endGame()` 返回未置 `'done'`；非提前锁定的 region_wins 终局也出现 phase='showdown'。最小复现：`node tests/engine.test.js` 的「§6 决战：7 区触发…」「§8 确定性…」；或 R=5 N=2 seed=987654321 摸牌流对局。已报 Lead 并修复（现 56/56 通过，invariant 对 early 允许 showdown/done、非 early 严格要求 done）。
- 本轮未发现其他规则实现缺陷；旧断言（2N×X 阈值、决战自动补牌、7 区仅简单、settleCards=3、endgame_settle drawn 长度）已全部按 v1.3 改写。

### 10.4 测试改造清单

- `tests/helpers.js`：不变量 v1.3（阈值 2×open、endgame 结构、摊牌 deterministic、终局 deck=0/手牌 0:0）、Runner 决战回合容错、synthBattle endgame 字段。
- `tests/engine.test.js`：56 项（配置矩阵/初始数/迁移/新决战全流程/跳过/摊牌/7 区/提前锁定/确定性）。
- `tests/edge.test.js`：整文件重写为 v1.3 合成精确边界（12 项）。
- `tests/ai.test.js`：15 项（build 阶段 AI 行为 + 三档强度 + 信息公平 + 自对弈覆盖决战）。
- `tests/lan.test.js`：22 项（N=4 透传、endgame 事件镜像/脱敏、7 区 LAN 房间、提前锁定、重连）。
- `tests/sim.js`：配置矩阵（R3/5/7 × N1/2/4 × D1/2/3 × 7 种牌堆）、决战事件/跳过/摊牌校验、空牌堆难度摸牌豁免。
- `tools/fuzz.js`（Lead 维护）：v1.3 事件流校验，150 局通过。

## 11. v1.3.1 后手补偿按区域数（task-23 · 2026-10-24）

> 契约来源：`docs/RULES.md` §4/§8/裁定 #27、`docs/CONTRACT.md` §2/§3/§4/§5/§9（v1.3.1 最终口径：后手补偿 = ⌊R/2⌋ 张）。§10 中「后手 +1 张 / gap 35/23/11」的数值已被本节取代；其余 v1.3 结论继续成立。

### 11.1 规则与数值

| # | 契约点 | 核对方法 | 结论 |
|---|---|---|---|
| 1 | `config.compensationDraw = ⌊R/2⌋`（R3/5/7 = 1/2/3），派生自 regionCount、不可单独设置；`validateConfig().info.compensationDraw` 暴露 | engine「defaultConfig」「validateConfig 矩阵」断言；createGame 状态 config 断言 | ✅ |
| 2 | 初始（createGame）：双方各 2R 张手牌、牌堆 54−4R；布局后：先手 R、后手 R+K、区域正面 2R、牌堆 54−4R−K（54 张下 41/32/23） | engine 新增「R=3/R=7 后手补偿 K 张」用例逐项断言 + R5 主用例；LAN 7 区房间断言 | ✅ |
| 3 | `finalizeLayout` 事件流：`layout_reveal` → `extra_draw` × K → `battle_start`；每个 `extra_draw = {type,playerId,card,handSize}`，第 i 个 handSize = R+i；补偿牌依次取牌堆顶；日志只记张数不泄露牌面 | engine 事件序列/牌面 id/handSize/日志断言；LAN 揭示批次断言（每张镜像 + 对手占位） | ✅ |
| 4 | `validateConfig` 下界：`D ≥ 4R+K` 且 `D ≥ 6R+K+1`（54 张对 R3/5/7 需 19/32/46，均满足）；`deckAfterSetup = D−4R−K`、`gapToEndgame = D−6R−K` → **35/22/9**（不随 N 变化） | engine 矩阵/边界用例（R5 D=32 非法、D=33 合法 gap=1；R7 D=46 边界 gap=1 警告）；edge 下界用例；sim 配置矩阵 validateConfig 自动跳过非法组合 | ✅ |
| 5 | LAN：揭示后布阵事件镜像、后手 K 张补偿每张对手视角为占位卡（不得泄漏）、自己的牌面真实；7 区房间揭示后手牌 7 vs 10、牌堆 23、阈值 14，X=7 决战不变 | lan.test 揭示批次用例（K=2 个 extra_draw、每张 hidden/real）、黑盒日志泄漏审计、§7.4 7 区数值更新 | ✅ |
| 6 | 其余规则不变：阈值 2R、决战触发 2X、各摸 X、build 禁用/跳过/摊牌 deterministic、提前锁定、结算消耗 2N | engine/edge/ai/sim/lan 全量回归 | ✅ |

### 11.2 运行结果（v1.3.1）

| 套件 | 结果 |
|---|---|
| `node tests/run-all.js --games=300` | **全部通过 ✔**（engine **57** / edge 12 / ai 15 / lan 22 / sim 300 局），~7.4s |
| `node tools/fuzz.js --games=150` | 失败 0（触发决战 41 局 / 提前锁定 91 局；AI 信息公平 20/20） |
| `node tests/sim.js --games=300` | 异常 0；决战率 34.7%、提前锁定 48.0%；同 seed 复现 20/20；隐藏信息 12/12 |
| `node tools/lan-smoke.js` | **ALL PASS ✔**（双人整局/重连/rematch/离房/并发房间） |
| `node tests/e2e/v3-e2e.js` | **98/98 通过**、0 失败、15 张截图（8 场景，UI ready 后重跑） |
| `node tests/e2e/v3-lan-e2e.js` | **64/64 通过**、0 失败、19/19 截图（7+1 场景组，提前锁定第 3 次房间命中） |

### 11.3 测试改造清单（v1.3.1）

- `tests/engine.test.js`（57 项）：validateConfig 数值/边界/gap；createGame compensationDraw；finalizeLayout 事件流改为 `extra_draw×K`（R5 主用例 + 新增 R3/R7 K=1/3 用例，含 handSize 递增/牌堆顶顺序/日志脱敏/初始手牌）。
- `tests/edge.test.js`：下界改为 `D ≥ 6R+K+1`（R3 边界 20 不变，语义更新）；退化配置标题/断言使用 K 公式；validateConfig.info.compensationDraw。
- `tests/ai.test.js`（15 项）：无需数值改动（布局/行动驱动均为动态状态），全量通过。
- `tests/lan.test.js`（22 项）：揭示批次 extra_draw 数量=K、每张脱敏/真实断言、handSize 递增；后手补偿日志泄漏审计按 K 张；7 区房间揭示后牌堆 23、手牌 7/10、compensationDraw=3。
- `tests/sim.js`：无需硬编码数值（矩阵/断言均动态），300 局通过；R7 仅 46/52/54 张牌堆配置合法（其余自动 skipped）。
- `tests/helpers.js`：synthBattle 复制 `config.compensationDraw`；其余 v1.3 不变量不变。
- E2E v3（`v3-e2e.js`/`v3-lan-e2e.js`）：UI 适配完成后已更新并全量重跑（2026-10-24）：设置预览「后手补偿 2/3 张 + gap 22/9 + 阈值 10/14」、规则弹窗 ⌊R/2⌋ 文案、布局面板「后手补 K 张」、对局信息 `compensation-draw`、揭示后手牌/牌堆（5 区 5/7 + 32、7 区 7/10 + 23）、补偿逐张飞牌 ghost 牌面/牌背 + 双端 toast、LAN 双端镜像；v1.3.1 数值变化导致旧平局种子失效，已重搜 R7/N4 平局 seed=18；LAN 提前锁定改为最多 6 个房间。结果见 `tests/e2e/REPORT.md` §10。

## 12. v1.4 行动点 / 结束回合 / 任意区域结算（task-25 · 2026-10-24）

> 契约来源：`docs/RULES.md` §5.1/§9 #28-#30、`docs/CONTRACT.md` §2/§5/§6。§10/§11 中「每行动换手」「正面牌 >2 才能结算」的旧语义已被本节取代；后手补偿（v1.3.1）等其余结论继续成立。

### 12.1 规则与契约点

| # | 契约点 | 核对方法 | 结论 |
|---|---|---|---|
| 1 | `config.apPerTurn=3`；`state.players[pid].ap`（当前行动方 3，回合开始回满、不结转）；`E.AP_PER_TURN`、`E.ACTION_COSTS={settle:3,draw:2,flip:2,place:1,move:1,end_turn:0}`；`info.apPerTurn/actionCosts` | engine 常量/defaultConfig/validateConfig 断言；createGame/finalizeLayout 状态 AP 断言 | ✅ |
| 2 | `getLegalActions()` 只返回 AP 可支付行动且始终含 `{type:'end_turn',cost:0}`；Action 带 cost；AP 不足 performAction 抛 BAD_ACTION（message 含「行动点不足」）且不扣 AP | engine「按 AP 过滤/穷举」用例、AP 不足白盒用例、invariant AP 校验；edge 决战部署合法集合 | ✅ |
| 3 | 一回合多行动：place×3、draw+place、flip+place、settle 整回合（3 点）；AP 耗尽自动换人（reason=ap）、无可用行动自动换人（reason=no-action） | engine 多行动/无行动用例（白盒 build 阶段）、Runner 逐步 AP/回合一致性断言 | ✅ |
| 4 | `end_turn` 任意时刻合法（cost 0），事件 `turn_end{playerId,reason:'manual',leftAp}` + `turn_start{playerId,ap,turnCount}`；turnCount 只统计真实行动 | engine end_turn 用例；LAN end_turn 透传 + 事件镜像用例 | ✅ |
| 5 | 结算不再要求区域正面牌 >2：任意未结算区域可结算（仅牌堆 ≥2N、AP≥3、非决战 build） | engine 自然局面 5 区全可结算 + synth 0/1/2 张正面牌用例；LAN 非法请求改为「区域不存在/AP 不足」 | ✅ |
| 6 | 决战 build 同样 3 AP/回合；跳过条件=无手牌且无背面牌；跳过后对方开新回合回满 AP；摊牌条件不变 | engine build AP 多行动/跳过回满/摊牌用例；edge build 合法集合含 end_turn；sim/LAN 全程校验 | ✅ |
| 7 | AI：按 AP 规划、不使用 move、可返回 end_turn、endgame build 重新评估；同 seed 确定、隐藏信息无关 | ai.test 自对弈/多局面/信息公平/build 用例；sim 每步 AI move 断言；lan 完整对局 | ✅ |
| 8 | 容错率难度标题改名：1=消耗（败者摸牌）/2=均衡（不摸牌）/3=突进（胜者摸牌），枚举值不变；AI 强度仍为简单/中等/困难 | engine `E.DIFFICULTIES[].name` 断言；Node 其余断言不依赖旧名称（AI 强度名未变） | ✅ |
| 9 | 已知限制：人类可反复 move 无限拖延（AI 不用 move）；测试/fuzz 需避免无限 move | Runner/pick 策略避开空转；fuzz 150 局无 move 死循环（随机行动仍能推进） | ✅ |
| 10 | 版本号 bump：`E.VERSION='1.4.0'`、`state.version='1.4.0'`、`server.js VERSION='1.4.0'`、`PokerDebug.version` 动态取引擎版本 | engine 常量/createGame 断言、lan `/api/info` server/engine 版本断言（Node 端 3 处已改 1.4.0）；E2E PokerDebug.version 断言同步 1.4.0（UI ready 后重跑） | ✅ |

### 12.2 运行结果（v1.4 · Node 层）

| 套件 | 结果 |
|---|---|
| `node tests/run-all.js --games=300` | **全部通过 ✔**（engine **60** / edge 12 / ai 15 / lan **23** / sim 300 局），6.7–6.8s；版本断言已同步 **1.4.0**（`E.VERSION`/`state.version`/server `/api/info`） |
| `node tools/fuzz.js --games=150` | 失败 0（触发决战 34 局 / 提前锁定 88 局，平均行动数 29.8；AI 信息公平 20/20） |
| `node tests/sim.js --games=300` | 异常 0；P1/P2/平 43.3%/54.0%/2.7%，先手胜率 40.0%；决战率 32.3%、提前锁定 46.3%；行动占比 settle 14.8 / flip 37.0 / place 37.2 / move 0 / draw 0.6 / end_turn 10.4；同 seed 复现 20/20；隐藏信息 12/12 |
| `node tools/lan-smoke.js` | **ALL PASS ✔**（双人整局/重连/rematch/离房/并发房间） |
| E2E v3 单机（`v3-e2e.js`） | **183/183 通过 ✔**（13 场景，24 张 `art/qa-v4-*.png`）：难度改名/AI 强度、规则弹窗、AP 显示/角标/多行动/耗尽换人/不足禁用、结束回合按钮 + Space/0 快捷键、任意区域结算（白盒 0/1/2 张正面牌）、己方背面牌悬停提示 + 对手不泄露、AI 连续行动、决战 AP/build grid/跳过后回满、7 区、提前锁定/平局、两个 UI BUG 回归、双分辨率；console 零未捕获异常 |
| E2E 联机（`v3-lan-e2e.js`） | **84/84 通过 ✔**（21 张截图）：双端 AP 镜像、cost 角标、end_turn 禁用态/透传/快捷键、UI 直接结算（-9=8+难度1）、同回合 place+draw 换人 + 对手 ghost 牌背、决战 AP-aware、7 区、提前锁定、重连/rematch/房间关闭、1440/1280 双分辨率 |

### 12.3 测试改造清单（v1.4）

- `tests/helpers.js`：`canonicalAction` 支持 end_turn；`invariantErrors` 新增 AP 范围/账单/合法性断言（cost 与 `E.ACTION_COSTS` 一致、可支付、始终含 end_turn、任意区域 settle、gameover AP 清 0）；`Runner` 新增 AP/回合一致性校验（`_assertTurnConsistency`：同回合 AP 扣减、换人必有 turn_end→turn_start、AP 回满、end_turn 不加 turnCount、错误原子性）；`Runner.run` 支持 `opts.pick` 策略（避免 build 阶段空转 end_turn）；`synthBattle` 初始化 `players.ap`（支持 `spec.ap/aps` 边界）；describeState/reproInfo 增加 AP。
- `tests/engine.test.js`（**60 项**）：新增「行动点：初始/扣减/不足/end_turn/AP 耗尽换人」「无可用行动 no-action」「任意区域可结算（0/1/2 张）」「决战 build AP/多行动/跳过回满」用例；改写 getLegalActions 穷举（AP 过滤 + cost + end_turn、开局 32 条合法行动）、五种行动（同回合继续/AP 扣减）、难度（直接结算不再构造 3 张正面牌）、决战触发/turn_start、终局/原子性/确定性/每个合法行动可执行；DIFFICULTIES 断言改「消耗/均衡/突进」+ AP 常量。
- `tests/edge.test.js`：决战最终部署合法集合加入 end_turn（仍禁 draw/settle）。
- `tests/ai.test.js`（15 项）：自对弈改 AP 语义（同回合连续行动、end_turn 不计 turnCount、新回合 AP 回满、build 允许 end_turn、永不 move、步数上限提升）；局面构造改直接 performAction/白盒（不再假设每行动换人）；新增 playToGameOver/apPolicyPick。
- `tests/lan.test.js`（**23 项**）：错误码用例改「区域不存在 settle + 摸牌后 AP 不足 settle」；五行动协议覆盖改为 AP 多行动驱动（coverTypes 优先覆盖 move）；完整对局按 AP 多行动 + turn_end/turn_start 字段/镜像断言；新增「§3.9/§5.1 v1.4 行动点与 end_turn：视图 AP 镜像、turn_start/turn_end 事件字段、end_turn 透传」；脱敏审计支持摊牌 deterministic（drawn 空数组）。
- `tests/sim.js`：playGame 回合断言改 AP 语义（同回合 AP 扣减、换人 turn_start/AP 回满、end_turn 不增 turnCount、build 允许 end_turn、AI 不用 move）；maxActions 默认 800→3000；统计新增 end_turn。
- 版本号（Lead 已 bump 1.4.0）：`tests/engine.test.js` 的 `E.VERSION`/`state.version`、`tests/lan.test.js` 的 `/api/info` server 版本断言已改 1.4.0；E2E 的 `PokerDebug.version` 与 `/api/info` 断言同步 1.4.0。
- E2E v3（`v3-e2e.js` **183 项** / `v3-lan-e2e.js` **84 项**，UI ready 后重写并全量重跑）：新增 SNAP 字段 `ap/actionCosts/apActorVisible/endTurnExists/settleable/confirmText/ownBackTip/boardDisplay/aps/difficultyNames/aiStrengthNames`；新增/改写场景覆盖 AP、end_turn、任意区域结算、己方背面牌悬停、AI 连续行动、两个 UI BUG 回归；v1.3.1 补偿数值合并保留；驱动修正（p2 回合 `PokerDebug.dispatch` 会先自动跑 AI → 白盒强制 p1 或 `dispatch(null)`）；v1.3.1/v1.4 数值变化后重搜种子（提前锁定 seed=1、摊牌平局 seed=24）；动画忙碌期先 `waitIdle`/等按钮可用。截图 45 张 `art/qa-v4-*.png`；报告见 `tests/e2e/REPORT.md` §11、清单见 `tests/e2e/CHECKLIST.md` §15。

## 13. v1.5 测试计划：回合倒计时 / 音效 / 困难 AI 移牌（task-33 准备稿 · 2026-10-24）

> **状态**：准备稿（task-33）。接口就绪（Lead 发「接口就绪」）后按 §13.7 执行并在本章回填结果；本节只写计划与断言口径，不代表已通过。
> **需求来源**：task-28（engine/server turnTimeLimit）、task-29（sfx 素材 + `js/sfx.js`）、task-30（倒计时 UI）、task-31（音效设置/事件接入）、task-32（AI 2.2 move 规划）。规则契约以 Lead 更新后的 `docs/CONTRACT.md`、`docs/RULES.md`、`docs/LAN.md` 为准。
> **代码快照（准备时）**：`js/engine.js` 已 bump **1.5.0** 且含 `turnTimeLimit`（`defaultConfig=30`、`validateConfig` 0/5–300 整数、`info.turnTimeLimit`、开局日志）；`js/ai.js` 仍 **2.1.0**（endgame hard 仍排除 move）；`server.js` 仍 **1.4.0**；`main.js`/`ui.js` 的 timer 接口在准备期间落地（`PokerDebug.timerState/setTurnTimeLimit` 已可用、`[data-testid="turn-timer"]` 雏形已见，详见 §13.5.1），sfx 尚未接入；`js/sfx.js` 与 `sfx/` 正式素材尚未落地（`sfx/_src/` 已见 Kenney casino 音源）。

### 13.1 需求 → 验收点映射

| # | 用户需求 | 实现方 | 自动化层级 | 验收入口 |
|---|---|---|---|---|
| R1 | 每回合倒计时默认 30s（可关/15/30/60） | task-28（配置）+ task-30（UI/计时/超时） | Node（配置/透传）+ E2E 单机/LAN | §13.2、§13.4 |
| R2 | 公共素材库音效 + 音量均衡 | task-29（素材/播放器）+ task-31（设置/事件） | 能力探测 + E2E 单机/LAN | §13.5 |
| R3 | 困难 AI 会用移牌主动放弃区域 | task-32（AI 2.2） | Node（AI/自对弈/sim/fuzz） | §13.3 |
| R4 | 回归：v1.4 全部行为不退化 | 全体 | Node 全量 + E2E v3 两套 | §13.6、§13.7 |

### 13.2 引擎 / 服务器契约断言清单（Node，task-28）

**engine（`tests/engine.test.js` 新增用例，「§2 常量」段落）**

1. `E.DEFAULT_TURN_TIME_LIMIT === 30`；`E.TURN_TIME_LIMIT_OPTIONS` deepEqual `[0,15,30,60]`；`E.VERSION === '1.5.0'`。
2. `E.defaultConfig()` 返回 `turnTimeLimit: 30`；`E.defaultConfig({turnTimeLimit:15})` 覆盖生效；`null/undefined` 回落 30。
3. `E.createGame()` → `state.config.turnTimeLimit === 30`；`state.version === '1.5.0'`。
4. `validateConfig` 合法值：`0/15/30/60` 全部 `ok:true`，`info.turnTimeLimit` 与输入一致；默认配置 `info.turnTimeLimit===30`（5/7 区同样）。
5. `validateConfig` 非法值：`-5`、`301`、`30.5`、`1`、`4`、`NaN` → `ok:false` 且 errors 含「回合倒计时必须是 0（关闭）或 5-300 秒的整数」；错误信息含当前值。
6. 边界：`5`、`300` 合法；`0` 表示关闭（合法）。
7. `turnTimeLimit` 不影响发牌/布局/行动：同 seed 下 `turnTimeLimit:0` 与 `30` 的初始状态牌张/手牌/区域完全一致（引擎纯逻辑，不执行计时）；`createGame` 日志含「回合倒计时：每回合 30 秒，超时自动结束回合」，`turnTimeLimit:0` 时无此行。
8. 引擎不产生计时事件/字段：`performAction` 事件流无 timer 相关 type；`state` 无剩余秒数（确定性断言不受影响）。

**server（`tests/lan.test.js`）**

9. `/api/info` → `version === '1.5.0'` 且 `engineVersion === H.E.VERSION`（1.5.0）。
10. 建房 payload `config.turnTimeLimit`：缺省 → `room.config.turnTimeLimit===30`；显式 `0/15/60` → 原值透传；`-5/301/30.5` → 建房失败（错误码沿用现有 CONFIG 校验路径）。
11. `meta.config.turnTimeLimit` 双端可见且等于 engine `state.config.turnTimeLimit`；`buildMeta` 的 config 摘要（大厅/等待室）含倒计时。
12. 重连快照/重开（rematch）后 `turnTimeLimit` 保持与房间配置一致。
13. 现有 23 项 LAN 协议/脱敏/镜像用例不受影响（除版本断言 §13.6）。

### 13.3 AI 2.2 断言清单（Node，task-32）

> 现有「AI 不使用 move」断言是 v1.4 的保护（move 无消耗可能死循环）；v2.2 改为**按档位**断言，并新增「必须用 move」的构造用例与终止性检查。

**版本/接口**
1. `AI.VERSION === '2.2.0'`；`_internals` 仍暴露所需函数（不破坏现有调用）。

**「不用 move」旧断言改写**（精确位置见 §13.6）
2. `tests/ai.test.js:104`（自对弈）、`:237`（各档局面）、`:431`、`:500`：easy 仍断言「永不 move」；medium/hard 改为「动作合法且不含非法 move」；不得再断言 medium/hard 永不 move。
3. `tests/sim.js:242`「AI 不应使用 move」：改为按 `config.aiStrength`：easy 断言不 move；medium/hard 允许 move 但必须满足「对局在 maxActions 内终止、牌张守恒、无无进展循环」。
4. `tests/e2e/v3-e2e.js:1112`「AI 不使用 move（build 连续行动）」：v2.2 后该断言失效 → 改为「AI 动作全部合法」，move 单独在 v5 脚本断言。

**新增能力断言**
5. endgame build 构造局面（白盒 `synthBattle`）：A 区我方背面 2、B 区我方背面 8、AP=3、手牌为空 → hard 应选 `move` 2→B（或等价收益的 move/flip 组合），且最终投影优于此前的区域归属；easy 在同局面不选 move。
6. 普通战役构造局面：hard 在「移动背面牌到可赢区域」明显正收益时可选 move；在无正收益时优先 draw/place/flip/settle/end_turn 推进（不出现连续 move 空转：连续 20 行动与对局总长上限校验）。
7. 信息公平：仅改对手**未知**牌（hand hidden 值/未揭示布局）不影响 hard/medium 的选择（同 seed 概率复现）；只允许读自己手牌/自己背面牌真值/公开正面牌/未见牌集合。
8. 确定性：同 seed、同局面 → 同动作；不同 `turnTimeLimit` 不改变 AI 选择（AI 不感知计时）。
9. 合法性：`chooseAction` 返回值必须 ∈ `getLegalActions()`（含 end_turn、AP 可支付）；AI 不产生非法 move（源区无我方背面牌/目标区非法/同区）。
10. 终止性：自对弈 6000 步上限内完成（现有）；`tools/fuzz.js --games=150` 0 失败；sim 300 局 0 超限。
11. 性能：hard `chooseAction` 单次 P95 ≤ 30ms（Node 计时循环 100 次，本机参考值；超阈值报警而非硬失败，避免 CI 抖动）。
12. 指标（Lead 提供 selfplay 数据，QA 复核）：hard vs medium / medium vs easy / hard vs easy 各 ≥300 局 0 异常、同 seed 复现；hard 在进决战对局中的 move 使用率 > 50%（目标口径以 task-32 为准）；简单/中等/困难三档均可完成整局。

### 13.4 倒计时 UI 断言清单（E2E 单机，task-30）

**testid/调试钩子依赖（ui-dev 提供，缺失即记 FAIL 并回报）**
`[data-testid="turn-timer"]`（属性 `data-total` / `data-remaining` / `data-state=idle|running|paused|expired|off|opponent`）；`.is-urgent`（≤10s）；设置 `[data-setting="turnTimeLimit"][data-value="0|15|30|60"]`；`PokerDebug.setTurnTimeLimit(sec)`；`PokerDebug.timerState()` → `{enabled,total,remaining,running,paused,expired,localPlayerId}`；`PokerDebug.startGame({turnTimeLimit})`；URL `?timer=0|15|30|60`；toast 文案「⏱ 超时，自动结束回合」。

| # | 断言 | 说明 |
|---|---|---|
| T1 | 默认 30：`state.config.turnTimeLimit===30`；`timerState()` total=30、enabled=true；DOM `data-total="30"`、文本含「30s」 | 新开局/开始对局后立即检查 |
| T2 | 设置面板 4 档（关闭/15/30/60）可见，默认选中 30；选择 15 后预览/摘要显示 15 且 `PokerDebug.startGame` 新局 `config.turnTimeLimit===15` | 设置写 `poker-duel-settings-v1.turnTimeLimit` |
| T3 | 持久化：选 15 → 刷新 → 设置面板仍 15、新局 config=15；关闭（0）刷新后仍关闭 | 复用 v3 持久化流程 |
| T4 | URL `?timer=15` 生效（临时覆盖）；`?timer=0` → `data-state="off"` 且无倒计时文本 | 不要求写 localStorage |
| T5 | 计时仅本地玩家回合：p1 回合 `data-state="running"` 且 remaining 递减；AI/对手回合显示「对方行动中」或 `data-state="opponent"`/隐藏；布局阶段与终局不显示倒计时 | 单机=人类 p1 |
| T6 | 新回合重置满时间：`turn_start` 后 remaining≈total（允许 1s 渲染误差）；同一回合连续行动（place/draw/end_turn 前）不重置 | 与 v1.4 多行动合并检查 |
| T7 | ≤10s `.is-urgent` 出现；≤5s 每秒 `turn.warning` 计数 +1（若 PokerSFX 可用；sfx 关闭时判空不报错） | 用 `setTurnTimeLimit(12)` 加速到 ≤10s |
| T8 | 超时自动结束回合：`setTurnTimeLimit(2)` → ≤6s 内 turn 切换、`turnCount` 不因超时增加、对方回合开始时 AP=3；toast 文案正确；新回合 timer 重置 | 检查 `PokerDebug.getState().turn` 与 timerState |
| T9 | 暂停/恢复：设置或规则弹层打开 → `timerState().paused===true` 且 remaining 冻结（±1s）；关闭后继续递减；页面 `document.hidden` 时暂停、恢复可见后继续 | CDP 可 `Emulation.setPageVisibility`/`Runtime.evaluate` 触发 visibilitychange 兜底 |
| T10 | 动画不暂停计时（任务要求）：标准动画下计时连续；超时仅触发一次 end_turn（busy 时忽略重复提交，不产生重复 action） | busy 期间超时边界 |
| T11 | 关闭倒计时（0）：无 timer 元素或 `data-state="off"`，对局可正常结束；不出现超时 toast | |
| T12 | 布局/终局/决战 build 阶段 timer 不显示或 idle（决战 build 属于 battle，规则上应计时 → 以 Lead/契约口径为准，准备稿按「battle 计时」断言） | 需确认契约 |
| T13 | 双分辨率 1440×900 / 1280×800：timer 不溢出、不遮挡行动点/按钮；截图 `art/qa-v5-timer-*.png` | |
| T14 | console 无未捕获异常（含 `window.PokerSFX` 不存在时的判空保护） | 全场景累计 |

**LAN 预留（合并进 `v3-lan-e2e.js` 定时段）**：建房大厅/等待室配置摘要含倒计时；host/guest 各自回合计时、对手回合显示「对方行动中」；host 超时自动 end_turn → 双端 `turn`/`turn_start`/AP 同步（以服务端 action 为准，不要求两端同时到期）；断线重连后 timer 依据新 `turn_start` 重置；同回合多 action 不重置。

### 13.5 音效断言清单（task-29 + task-31）

**接口依赖**：`window.PokerSFX`（`VERSION`、`SOUND_NAMES`、`configure`、`setEnabled`、`setVolume`、`state()`、`play(name,opts)`、`stopAll`、`debugState()`）；`debugState()` 至少含 `contextState`、`unlocked`、`assets{name:{rms,peak,gain,trim}}`、`played{name:count}`、`enabled`、`volume`。设置 testid：`sfx-enabled-0|1`、`sfx-volume`、`sfx-volume-val`、`btn-sfx-toggle`（aria-pressed）；URL `?sfx=0|1`、`?sfxvol=0..100`；持久化 `sfxEnabled/sfxVolume`。

| # | 断言 | 说明 |
|---|---|---|
| S1 | 素材齐全：`sfx/` 下 task-29 约定的 ≈18 个 ogg 均存在（>=1KB）、`sfx/LICENSES.md` 有来源/CC0 声明、`PokerSFX.SOUND_NAMES` 与文件/manifest 一一对应 | 名称集合：ui.click/ui.confirm/ui.error/card.place/card.move/card.flip/card.draw/card.shuffle/settle.go/settle.win/settle.lose/settle.tie/turn.start/turn.warning/turn.timeout/endgame.start/game.win/game.lose/game.draw（以 Lead 最终清单为准） |
| S2 | headless 音频能力：新增启动参数下 `new AudioContext().state==='running'`（无手势）、`decodeAudioData` 成功（合成 WAV 时长正确）、播放时 AnalyserNode RMS>0；`--mute-audio` 下同样验证（能力探测脚本 `tests/e2e/v5-e2e.js` 场景 0，结果回填本行） | 见 §13.5.1 探测结果 |
| S3 | 均衡：`debugState().assets` 每音效响度在目标 ±3dB（目标约 -20dBFS RMS、peak ≤0.9；若 debugState 返回线性 rms 则先换算）、每音效 trim 已生效 | 口径待 CONTRACT §7.5 明确 |
| S4 | 设置 UI：开关默认启用（70）、`sfx-enabled-0/1` 可切换、滑杆 0–100 即时更新 `sfx-volume-val` 与 `state().volume`；顶栏 `btn-sfx-toggle` 与设置双向同步（aria-pressed） | |
| S5 | 持久化：关闭音效+音量 35 → 刷新后仍关闭/35；URL `?sfx=0`、`?sfxvol=50` 生效 | |
| S6 | 事件映射：place→card.place、move→card.move、flip→card.flip、draw/extra_draw→card.draw、洗牌/揭示→card.shuffle、battle_start→turn.start、settle→settle.go 后按 winner win/lose/tie、endgame_start→endgame.start、game_over→game.win/lose/draw、超时→turn.timeout、按钮→ui.click 计数 +1 | 用 `debugState().played` 前后差值断言；每次只驱动一个事件 |
| S7 | 不重复播放：点「结算确认」只应有 `settle.go`（不额外 `ui.click`）；失败操作播 `ui.error` 且不播其他 | |
| S8 | 关闭音效后 `play()` 不增加 played 计数（或计数仍加但无实际播放 → 以 debugState 的 played/unlocked 定义为准，准备稿按「计数不增加」断言）；重新开启后恢复 | |
| S9 | 失败静默：素材 404/解码失败（CDP 拦截 sfx 请求）→ console 无未捕获异常、游戏主流程可继续 | 仅 E2E 探测，可选 |
| S10 | file:// 单机：`index.html` 加载 `js/sfx.js` 后 `PokerSFX` 存在且不抛错（加载方式须为经典脚本/内嵌资源，不能用 fetch） | 若 Lead 用 `<audio>`+相对路径需确认 file:// 可加载 |
| S11 | 双端 LAN：双方各自音效互不影响同步；音效设置不写入房间配置 | |
| S12 | 截图：`art/qa-v5-sfx-settings-1440x900.png`、`art/qa-v5-sfx-toolbar-1440x900.png` | |

#### 13.5.1 E2E 基础设施（已做）与探测结果

- `tests/e2e/cdp.js`：`launchEdge` 新增 `--autoplay-policy=no-user-gesture-required`；`--mute-audio` 改为可配（`{muteAudio:false}` 时不加，默认仍静音输出；WebAudio 图/分析不受影响）。其余参数不变。
- 探测脚本：`tests/e2e/v5-e2e.js` 场景 0（能力探测，可直接运行；不依赖 v1.5 UI 接口）。探测项：AudioContext 初始化/resume、`decodeAudioData` 合成 WAV、BufferSource+AnalyserNode 播放采样 RMS/peak、OfflineAudioContext 渲染、`PokerSFX` 存在性与 `debugState` 可读性、`PokerDebug.timerState/setTurnTimeLimit` 存在性、engine `turnTimeLimit` 常量/校验。
- **探测实测结果（2026-10-24，`SOLO_BASE=http://127.0.0.1:5195 node tests/e2e/v5-e2e.js --probe-only`，跑了两次；第二次为 UI 计时接口落地后）**：
  - 结果：第一次 **PASS=16 / FAIL=0 / SKIP=2**（timer API、PokerSFX 未就绪）；第二次 **PASS=17 / FAIL=0 / SKIP=1**（`PokerDebug.timerState/setTurnTimeLimit` 已可用，SKIP 仅剩 PokerSFX）。证据 `art/qa-v5-capability.json`（时间戳为第二次，记录 live 快照）、截图 `art/qa-v5-capability-1440x900.png`。
  - AudioContext：`--mute-audio` 与 unmuted 两种启动均 `initialState='running'`、`stateAfterResume='running'`（免手势策略生效），sampleRate=48000、baseLatency=0.01。
  - `decodeAudioData`：合成 0.25s/440Hz WAV 解码成功（duration=0.250、1 声道、12000 样本）。
  - 播放链路：实时 BufferSource→Analyser 采样 peak=0.24 / RMS≈0.14（ctxState=running）；`--mute-audio` **不影响** Analyser 数据（两种模式 peak 均为 0.24），也不影响 OfflineAudioContext 渲染（peak=0.5 / RMS≈0.354）。
  - 结论/选型：QA 音效断言以 `PokerSFX.debugState` + OfflineAudioContext/Analyser 为准；`--mute-audio` 保留为默认（既静音又不影响 WebAudio 分析），v5 脚本用 `muteAudio:false` 启动以贴近真实播放链路。**无需为音频验证去掉 --mute-audio**。
  - 接口快照（第二次）：`PokerDebug.version=1.5.0`；`timerApi={timerState:true,setTurnTimeLimit:true}`（准备期间由 ui-dev 落地，可在 E2E 里读 `timerState()`/`setTurnTimeLimit()`）；`window.PokerSFX` **未加载**（task-29）；页面 `[data-testid="turn-timer"]` 已存在（布局阶段 `data-total="30"`、`data-state="idle"`、文本「⏱30s」）——仅快照，断言待下一任务按 §13.4 补全。
  - 基础冒烟（可直接运行）：`node tests/e2e/v5-e2e.js --only=8` → **PASS=10 / FAIL=0**；页面加载/PokerDebug 1.5.0/设置弹窗/规则开合/调试开局 layout/新局 `config.turnTimeLimit=30`/console 无异常；截图 `art/qa-v5-smoke-1440x900.png`。

### 13.6 版本断言盘点（接口就绪后统一改，暂不动）

| 文件:行 | 当前断言 | v1.5 目标 | 备注 |
|---|---|---|---|
| `tests/engine.test.js:282` | `E.VERSION === '1.4.0'` | `'1.5.0'` | engine 已 bump |
| `tests/engine.test.js:563` | `state.version === '1.4.0'` | `'1.5.0'` | |
| `tests/ai.test.js:145` | `AI.VERSION === '2.1.0'` | `'2.2.0'` | 待 Lead 改 ai.js |
| `tests/lan.test.js:445` | `/api/info` `version === '1.4.0'` | `'1.5.0'` | 待 Lead 改 server.js |
| `tests/lan.test.js:446` | `engineVersion === H.E.VERSION` | 不变（动态） | |
| `tests/e2e/v3-e2e.js:235` | `PokerDebug.version === '1.4.0'` | `'1.5.0'` | 场景 1 |
| `tests/e2e/v3-e2e.js:760` | `PokerDebug 接口齐全（1.4.0）` 断言 `api.v==='1.4.0'` | `'1.5.0'` | 场景 7 |
| `tests/e2e/v3-lan-e2e.js:235` | `/api/info` version/engineVersion `'1.4.0'` | `'1.5.0'` | LAN 预检 |

- README/docs 中版本号由 Lead 统一更新；QA 不改 docs。
- v1.4 遗留的「AI 不使用 move」断言位置：`tests/ai.test.js:104/237/431/500`、`tests/sim.js:242`、`tests/e2e/v3-e2e.js:1112`（§13.3 已列改写口径）。

### 13.7 改造 / 新增文件清单

**task-33 本轮已做（准备）**
- `tests/e2e/cdp.js`：音频启动参数 + `muteAudio` 选项（默认静音，探测/音效验证可关）。
- `tests/e2e/v5-e2e.js`：新脚本骨架 —— 场景 0 浏览器能力探测（可运行），场景 1–9 为 skip 占位（倒计时 T1–T13、音效 S1–S12、AI move UI 观察、LAN 预留、回归/截图），`--probe-only`/`--strict` 开关。
- `tests/e2e/v3-lan-e2e.js`：预留「v1.5 倒计时/音效」段落（检测 `PokerDebug.timerState`/`PokerSFX` 存在则执行，否则 SKIP，不计失败）。
- 本节 §13 测试计划 + 断言清单。

**接口就绪后（下一个任务）**
- `tests/engine.test.js`：§13.2 引擎用例 + 版本；`tests/lan.test.js`：§13.2 server 用例 + 版本；`tests/ai.test.js`/`tests/sim.js`：§13.3 move 断言改写 + 版本；`tests/helpers.js`：如需 invariant 增加 timer 无关字段（预计不需要）。
- `tests/e2e/v3-e2e.js`：仅版本断言（1.4.0→1.5.0）；timer 相关 DOM 断言放 v5 脚本，避免 v3 脚本膨胀。
- `tests/e2e/v5-e2e.js`：补全 T1–T13、S1–S12 断言与截图 `art/qa-v5-*`；`v3-lan-e2e.js`：补全 LAN 计时/音效段。
- 全量运行：`node tests/run-all.js --games=300`、`node tools/fuzz.js --games=150`、`node tools/lan-smoke.js`、`node tests/e2e/v3-e2e.js`、`node tests/e2e/v3-lan-e2e.js`、`node tests/e2e/v5-e2e.js`；更新 `REPORT.md`（新 §12）、`CHECKLIST.md`（新 §16）、本节回填结果。

### 13.8 风险 / 待 Lead 确认

1. **超时事件语义**：UI 超时走 `end_turn` 管线 → `turn_end.reason` 应为 `'manual'`（沿用 v1.4）；若新增 `reason='timeout'` 或独立事件，Node/UI 断言需同步——请 Lead 在 CONTRACT 明确。
2. **决战 build 阶段是否计时**：task-30 说「仅引擎 battle、turn=本地」→ build 属于 battle 应计时；但 build 阶段可能长时间思考，需确认是否豁免（准备稿按计时断言，若豁免改 T12）。
3. **debugState 响度口径**：目标 -20dBFS 是 `rms` 字段数值还是线性值；`peak` 上限 0.9 是线性幅度（默认按线性幅度）。
4. **sfx 加载方式**：task-29 要求「file:// 可用、不用 fetch」——若素材以 base64 内嵌于 `js/sfx.js` 则静态服务器/gzip 体积增大（18 个短音效预计数百 KB，可接受）；若用 `<audio src>` 需确认 file:// 下允许。
5. **tools/serve.js MIME**：当前 MIME 表无 `.ogg`；若 sfx 通过 http 资源加载（非内嵌），Lead 可能需补 MIME（QA 不改 tools）。
6. **LAN 超时一致性**：端侧计时存在网络/渲染漂移，断言「一端超时后双端状态同步」而非双端同一时刻到期；host/guest 均可能到期，以服务端 action 序列为准。
7. **AI move 与 E2E 稳定性**：AI 主动 move 会改变 v3 E2E 中「AI 回合动作类型」采样断言（如无 move 假设），就绪后重跑 v3 两套以回归（v3-e2e 场景 12 的 `AI 不使用 move` 断言按 §13.3 改）。
8. **准备稿中「45 张旧截图」**：v1.5 最终截图放 `art/qa-v5-*`，v4 保留基线；`v5-e2e` 首轮探测产生 `qa-v5-capability-*.png`。
