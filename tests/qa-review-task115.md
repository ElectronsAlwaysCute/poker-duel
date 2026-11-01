# task-115 独立复核报告（qa-v6）

- 复核对象：`tools/tmp-v28/medium/REPORT.md` + `cand-medium-pure-v1.js`（sha256_16 `5034BA18147DB304`，92,766B）+ 变体/审计证据
- 方法：独立读代码 + 独立重跑 A/B + 自写独立配对 harness + 行为/确定性/公平性/性能探针；产品未改动。
- 证据（QA 侧）：`tests/qa-review-*.json`、`tests/qa-review-candidate-probe.json`、`tests/qa-review-independent-ab-cand-vs-base.json`

## 1. 通过项（与报告一致）

| 项 | 复核结果 |
|---|---|
| self-control（A=B=base-ai3 hard，n=600 对/1200 局） | **aOnly/bOnly/tie = 0/0/600，paired Δ=0，0 illegal/0 forfeit**（与报告一致） |
| cand vs 产品 ai hard（n=1200 对/2400 局） | **52.41% CI[50.38,54.44]，paired +4.67，0 illegal/0 forfeit**（复跑一致）；自写独立 harness（n=1200 局，100 对/config）得 52.18%、paired +4.25，方向一致 |
| pure-safe-v1 vs 产品 hard（n=1200 对） | **52.48% [50.45,54.50]，paired +4.83，0/0**（复跑一致） |
| cand vs 父本 pure-safe-v1（n=1200 对） | **50.71% [48.68,52.73]，paired +1.38，0/0**（复跑一致） |
| 反事实（去平/paired） | no-placeheavy 47.13% / paired −5.58；no-earlypass 49.23% / −1.50；no-heavytempo 49.83% / −0.33；no-turnopening、no-forcedflip 均 50.00% / 0（与仓库内存档 JSON 完全一致） |
| 死代码结论 | 独立静态核对：`chooseEndgameHard/chooseEndgameMedium/mediumActionScore` 无生产调用点；`chooseTurnOpening/chooseForcedFlip` 仅被上述 dead 函数调用；`chooseEndgamePlaceHeavy` 是 hard/medium 唯一生产 endgame 路由（active）；0 影响变体与 instrument 计数一致 |
| 审计分类（CEM/非 CEM） | `tools/train-ai.js` SPECS hard 25 / medium 19 / easy 6，与 `audit-params.json` 一致；medium notCem 含旧 mediumActionScore 死参数，分类合理 |
| 行为/安全 | 候选 20 局探针 0 illegal/0 forfeit/0 unfinished；同 seed 序列+结果确定性一致；隐藏信息置换 40 状态 0 不一致；stall/productive 护栏保留 |

## 2. 需修正/注意（WARN）

1. **n 语义不明确**：`ab-medium.js --games=600` 实际生成 **600 对 / 1200 局**（`perConfigGames=GAMES/6` × 2 局）；报告写 n=600 但 W/L/D 与 CI 按 1200 局统计，易误读。CI 按单局计算而非按 pair 计算，且 seeds 在 6 个 config 间复用（每个 config 100/200 个 seed），建议报告明确「n=对数/局数」并说明 seed 复用。
2. **「所有 A/B 0 forfeit」不成立**：`no-tactics-all` 变体存档 `ab-no-tactics-all.json` 为 **57 forfeit**（qa 重跑当前文件 5 次）；报告未列该变体却给全称结论。建议改为「核心对照表各变体 0 forfeit；`no-tactics-all` 出现 forfeit，需排除/修复后再用」。
3. **候选未证明优于父本**：candidate vs parent 50.71% CI 含 50（+1.38 paired），而 parent pure-safe vs 产品为 52.48%；**candidate 点估计低于父本**。若目标是「去硬编码+纯自对弈」，pure-safe-v1 已是当前最强证据，candidate 的 CEM 参数化在本轮 n=1200 无显著增益；建议不要以 candidate 作为「提升」集成，最多作为「参数化实验」。
4. **配置异质性**：candidate 3 区三配置 47.7/48.5/50.9%（2 个 <50），5 区 54.2–58.5%；parent 3 区 47.4/51.8/50.0。整体 +2.4pt 主要由 5 区贡献；需 n≥2400 + 按配置报告（尤其 R3N1D1 有退化风险）。
5. **「纯学习」范围**：candidate = pure-safe-v1 + CEM 参数注入（数值只改 TRAINED.hard），仍保留 `chooseEndgamePlaceHeavy` 投影 beam、hard 战斗 top5/follow8 搜索与手写估值公式；仅去掉 earlyPass/heavyTempo/medium 行为参数等 4 类 shaping。报告 §5 已承认启发式结构，但标题/§3「无硬编码战术」易被误读为无手写搜索结构。
6. **p95 指标口径**：报告的 p50/p95≈80–84ms 是「每局总时长」且共享负载，不是每决策耗时。独立探针（共享负载）：candidate 每决策 p50 0.44ms/p95 2.04ms vs base 0.40/1.88ms（p95 +8.6%，绝对值仍极低，无实质性能退化）；每局 p95 candidate 103.8ms vs base 101.0ms。若报告要论证性能，应标注 metric 并在空闲机复测每局 p95。
7. **证据目录有旧版本混淆**：`ab-hard-pure-v1-vs-base-n1200.json` 显示 A=41.47%、paired−16.63，与最终 candidate（52.41）不是同一文件；建议清理/重命名，避免误用旧候选结果。
8. **place-heavy 术语**：pure-safe 的 firstPool 只在 productive>0 时改为全合法行动参与；productive=0 仍 hand>0→places（安全/推进约束）。报告 §2「place 优先池」结论没问题，但 §3 描述应明确这一区别；`chooseEndgamePlaceHeavy` 本身未被移除。

## 3. 结论/建议

- **方法学**：配对 bug 修复可信；self-control 与独立重跑一致；候选 A/B 数字可复现。
- **集成建议**：暂不集成 `cand-medium-pure-v1`；若要验证「替换 hard」应先验证 **pure-safe-v1（父本）**（当前 +2.48pt 唯一证据）在 n≥2400 空闲机 + 按配置分层；candidate 与父本差异不显著，且 R3 有退化信号。
- **报告修正**：明确 n（对数/局数）、排除 `no-tactics-all` 的 forfeit 例外、标 p95 口径、修正 candidate 相对父本/整体提升措辞；否则容易导致 Lead 误判 CEM 参数化收益。
