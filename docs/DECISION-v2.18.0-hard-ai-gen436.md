# v2.18.0 决策：启用困难档 AI（2026-10-31 交付模型 H192 gen436）

- 日期：2026-10-31
- 用户指令：**“将其作为困难AI”**（把 2026-10-31 交付包中的最终交付模型作为产品困难档）
- 交付来源：`handoff/handoff_20261031/`（README/manifest/SHA256SUMS 齐全；全部文件 sha256 校验通过）
- 交付模型（按用户指定选型规则 X/Y → 架构内 → H256 vs H192 选出）：
  - `models/selected_by_rule_H192_gen436.params.json`
    - sha256 `1B1A76CD095DF0F870D9DED4BC0E6516C86683D93AE797A9C8CF7462127ED985`
  - `models/selected_by_rule_H192_gen436.bundle.js`
    - sha256 `AAEB8C4512A4A2C8DB193C881322AAC1FFB602ABC1062F63C53917660D9086E9`
    - VERSION `2.7.4-opt-h192-final-20261031-gen436`
- 产品集成文件：`js/ai-pure-hard.js`（由上述 bundle 生成；仅把全局名 `PokerAIPure` 改为 `PokerAIPureHard` 以便与中等档 gen241 的 `PokerAIPure` 共存；参数/前向逻辑未改，`PARAMS_SHA256` 不变）

## 1. 难度档映射（v2.18.0）

| 档位 | 模型 | 文件/全局 | 说明 |
|---|---|---|---|
| 简单 | Phase12 gen60（H96） | `js/ai-pure-simple.js` → `PokerAIPureSimple` | 不变 |
| 中等 | Phase17 联赛 PPO gen241（H128） | `js/ai-pure.js` → `PokerAIPure` | 不变 |
| **困难** | **2026-10-31 交付 PPO H192 gen436（policy-only）** | `js/ai-pure-hard.js` → `PokerAIPureHard` | **新启用**（v2.17 为 disabled） |

- 三档均为纯学习浏览器 bundle（policy-only）：battle/build 纯策略 argmax；layout 仍使用产品阶段基线（`main.js chooseAiLayout` 启发式，与 simple/medium 一致）。
- 产品 `apSpendGuard` 保留（v1.7 战略决战 AP 上限规则的保险）；困难档与其它档共用。
- 失败安全：若 `PokerAIPureHard` 缺失/异常/返回非法动作，`main.js` 回退启发式（现有路径），并在 UI 保持可玩。

## 2. 官方交付指标（交付方口径，仅引用，不重复训练）

- 评估协议：vs 产品 ML **2.3.0**，canon27，`apCapRule=1`，`guard=both`，固定产品 ML 布局，同 seed 换座，n=540×2（n=1080）。
- 最终交付模型 **H192 gen436**：**62.63%**（W/L/D = 667/398/15；Wilson 95% [59.68, 65.48]；0 error/illegal/forfeit）。
- 正式最强模型（非规则冠军）**A H256 gen255**：65.03%（688-370-22；[62.11,67.84]；Node p95 43.26ms 余量小）。
- H192 次优 `best_H192_B_gen252`：63.60%。
- **70% 目标未达到**：最佳正式 65.03%，差 4.97pp；交付模型 62.63%。不得宣称 70%。
- gen241 H2H 独立辅助列：A gen255 55.22%、B gen252 50.66%；gen436 在选型中 H2H 52.74%。该列不可与 vs ML 2.3.0 的 70% 口径合并。
- 选择规则（用户指定）产生的最终模型为 gen436；报告同时如实标注其官方 62.63% 低于正式最强 A gen255 的 65.03%。

## 3. 产品侧独立复验（2026-10-31）

| 检查 | 结果 |
|---|---|
| 交付包 SHA256SUMS | 全部 OK（模型/报告/证据） |
| 官方 seed 2102500 复现（product rule+guard, n=540） | **63.18%**（W/L/D 338/197/5），与交付证据 `B436_vs_ml23_s2102500.json` 完全一致；0 error/illegal/forfeit |
| 独立 fresh seed 9.2M（product rule+guard, n=540） | **63.95%**，Wilson [59.76, 67.93]；0 error/illegal/forfeit |
| gen436 vs gen241（fresh seed 9.21M, n=270, product rule+guard） | 55.56%（W/L/D 145/116/9），Wilson [49.49, 61.46]；0/0/0；CI 跨 50%，不宣称显著 |
| Node bundle 加载/接口 | `PokerAIPureHard.createPolicy` 正常；VERSION/PARAMS_SHA256 与交付一致 |
| 浏览器决策性能（headless Edge，`qa-hard-perf.html`，12 局/293 决策） | p50 4.5ms / **p95 7.6ms** / p99 8.4ms / max 13.6ms；0 非法/0 错误；预算 ≤50ms 通过 |
| 产品 E2E（headless Edge，iframe + PokerDebug，6 局 hard） | 困难按钮 enabled、hint/note 正确；6 局全部 gameover；0 warning/0 pageerror；`apSpendGuard=15`（产品 guard 生效）；局内 `config.aiStrength='hard'` |
| 产品 `node tests/run-all.js --skip-sim` | PASS（52.4s，含 LAN 集成 25/25） |

> 浏览器性能为 headless Edge（桌面）数字；Android WebView/真机未验证。官方 Node p95 26.19ms（训练负载下）与本机浏览器 7.6ms 的差异来自环境/负载；两者均低于 50ms 预算。

## 4. 已知限制与口径

1. **70% 未达成**：交付模型官方 62.63%；正式最强 65.03%；均低于 70%。本决策只启用交付模型，不改变该事实。
2. **layout 协议**：官方数字使用固定产品 ML 2.3.0 布局；产品运行时 layout 由 `main.js chooseAiLayout`（启发式）完成，与 simple/medium 相同。两者分布不同，玩家实际体感强度可能与官方数字有偏差。
3. **模型体积**：困难 bundle 约 4.9MB，页面加载/低端 Android WebView 解析时间增加；未测真机。
4. **既有 bundle 的 move 编码缺陷**：交付 bundle 的 `actionKey` 不含 `toRegionId`（与历史 H128/H96 bundle 同源）；由于 move 动作特征也未编码目标区域，learned 在同 key move 间本就并列，argmax 取首个，实际行为与修复 key 时一致；未在 v2.18 修复（避免偏离交付模型已验证行为）。
5. **Firefox/真机**：交付方 Firefox 未测 gen436；产品侧仅测 headless Edge（桌面）。真机/多浏览器仍为未验证项。
6. **学习布局**：交付方 layout 训练为预注册 NO-GO，未集成；产品保留固定布局 fallback。
7. v2.18.0 仅新增困难档模型与 UI/版本更新；引擎仍为 **1.7.0**，规则/联机协议不变。

## 5. 产物（已构建并自检）

- Web：`dist/poker-duel-web-v2.18.0.zip`（5,303,119B，sha256 `DBDD6C49B9C7B5E6CFCDF5B7865DFC65629B9E1E2B04B5FA450F4D4C0F5501B0`，41 entries，0 反斜杠，含 `js/ai-pure-hard.js` 与联机文件；staged LAN GET/POST 200）
- Android：`android/dist/poker-duel-v2.18.0.apk`（5,327,821B，sha256 `3746F31A2360640125293813860E24267DDF74E899F8AFF4C245A41E9F2A350D`，versionCode 21 / versionName 2.18.0，v1+v2+v3 verified；APK assets 与工作区 sha 一致）
- 旧版本 v2.17.0 APK 保留（3,238,790B，sha `30CEF749…` 未变）；v2.17 web zip 在本次发布时已不在 `dist/`（不属本次改动）。
- 发布汇总：`tools/tmp-v28/phase17/eval/release-2.18.0-summary.json`
- 验证：`tools/tmp-v28/phase17/eval/release-verify-2.18.0.json`（PASS；70% 单独标 NOT_REACHED）
- 回归测试：`tests/ai-pure-hard.test.js`（3/3 PASS），已纳入 `node tests/run-all.js --skip-sim`（PASS 63.3s）
- 浏览器/产品 QA 证据：`tools/tmp-v28/delivery-20261031/`（perf/E2E harness、复验脚本与 JSON）

## 6. 引用

- 交付包：`handoff/handoff_20261031/README.md`、`reports/ppo_layout_final_20261031.md`
- v2.17 规则/映射：`docs/DECISION-v2.17.0-engine-rule-ai-mapping.md`
- 评测协议：v2.17 包内 `docs/07-EVALUATION-PROTOCOL.md`（handoff/deep-cfr-v1）
- 本次复验脚本/产物：`tools/tmp-v28/delivery-20261031/`

## 7. v2.18.1 补丁：简化难度文案（2026-10-31）

- 用户要求：AI 难度描述简化为“HXX，genN 代（简要说明即可）”。
- 设置面板文案改为：
  - 简单：`纯学习 H96，gen60 代（Phase12 PPO；保守回退档；p95 ≤25ms）`
  - 中等：`纯学习 H128，gen241 代（Phase17 联赛 PPO；默认档；p95 ≤35ms）`
  - 困难：`纯学习 H192，gen436 代（2026-10-31 交付 PPO；p95 ≤50ms）`
  - 困难附加注：`困难档模型较大（约 4.9MB），首次加载稍慢。`
- 仅 UI 文案/版本号变更，模型、规则、评测口径不变。
- 产物：Web `dist/poker-duel-web-v2.18.1.zip`（5,302,598B，sha `5E67C93A…2A0C`）；APK `android/dist/poker-duel-v2.18.1.apk`（5,327,821B，sha `BA44923A…982E4`，versionCode 22 / 2.18.1，v1+v2+v3 verified）。
- 截图：`tools/tmp-v28/delivery-20261031/evidence/v2181-hard-settings-1280x900.png`。

## 8. v1.0 版本号统一（2026-10-31）

- 用户要求：将版本号改为 **1.0**。
- 变更：产品版本号由 `2.18.1` 统一为 **`1.0`**；Android `versionCode` 递增为 **24** / `versionName` **`1.0`**；Web 包名改为 `poker-duel-web-v1.0.zip`；`README-WEB.txt` Version 1.0。
- 模型/规则/UI 文案不变（困难档仍 H192 gen436；简单 H96/gen60、中等 H128/gen241）；AI 难度描述不再包含日期（只用 HXX / genN 代）。
- 产物（修订重建）：Web `dist/poker-duel-web-v1.0.zip`（5,302,581B，sha `A3F7699D…7204`，41 entries）；APK `android/dist/poker-duel-v1.0.apk`（5,327,821B，sha `8BBC88A3…5BE0`，versionCode 24 / versionName 1.0，v1+v2+v3 verified）。
- GitHub 入口 README 已重写为产品介绍（旧版内部开发记录归档到 `docs/INTERNAL-DESIGN-README.md`）。
- 记录：`tools/tmp-v28/phase17/eval/release-1.0-summary.json`、`release-verify-1.0.json`；v2.18.1/v2.18.0/v2.17 APK 保留可回退。
