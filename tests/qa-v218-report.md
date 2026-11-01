# v2.18.0 增量 QA 报告（困难档接入 2026-10-31 交付模型 H192 gen436）

- 日期：2026-10-31
- 产品：`D:\GAME\poker-duel`；本任务改动：`js/ai-pure-hard.js`（新增）、`js/main.js`、`js/ui.js`、`index.html`、`android/build.ps1`、`android/AndroidManifest.xml`、`tools/tmp-v28/package-web.ps1`、`tests/ai-pure-hard.test.js`、`tests/run-all.js`、`android/README.md`、`docs/*`
- 交付来源：`handoff/handoff_20261031/`（SHA256SUMS 全部通过）

## 1. 交付包校验

- `SHA256SUMS`：全部文件 **OK**（3 个模型 bundle/params + reports + evidence）。
- 交付模型：`selected_by_rule_H192_gen436`
  - bundle sha `AAEB8C4512A4A2C8DB193C881322AAC1FFB602ABC1062F63C53917660D9086E9`
  - params sha `1B1A76CD095DF0F870D9DED4BC0E6516C86683D93AE797A9C8CF7462127ED985`
  - VERSION `2.7.4-opt-h192-final-20261031-gen436`
- 集成文件 `js/ai-pure-hard.js`：4,894,270B，sha `EFA9FC68C77042531B0988842DEE92EBDB0F266BD65AE42BD1B469D7358DB798`；仅将全局名改为 `PokerAIPureHard`，参数/前向未改（`PARAMS_SHA256` 与交付一致）。

## 2. 强度独立复验（产品侧）

| 检查 | 结果 |
|---|---|
| 官方 seed 2102500 复现（product rule+guard, n=540） | **63.18%**（W/L/D 338/197/5）；与交付证据 `B436_vs_ml23_s2102500.json` 完全一致；0 error/illegal/forfeit |
| 独立 fresh seed 9.2M（n=540） | **63.95%**，Wilson [59.76, 67.93]；0/0/0 |
| gen436 vs gen241（fresh seed 9.21M, n=270） | 55.56%，Wilson [49.49, 61.46]；0/0/0；CI 跨 50%，不宣称显著 |
| 官方交付口径汇总 | 62.63%（n=1080，667-398-15，Wilson [59.68,65.48]）；**70% 未达到**（正式最强 A H256 gen255=65.03%） |

JSON：`tools/tmp-v28/delivery-20261031/verify436-official-seed2102500-productrule-n540.json`、`verify436-fresh-productrule-n540.json`、`verify436-vs-gen241-productrule-n270.json`。

## 3. 浏览器/产品 QA

| 检查 | 结果 |
|---|---|
| 浏览器决策性能（headless Edge，12 局/293 决策） | p50 4.5ms / **p95 7.6ms** / p99 8.4ms / max 13.6ms；0 非法/0 错误（预算 p95≤50ms） |
| 产品 E2E（headless Edge，iframe + PokerDebug，6 局 hard） | 6 局全部 gameover；0 warning/0 pageerror；`configStrength='hard'`；`apSpendGuard=15`；hard 按钮 enabled、hint/note 正常 |
| file:// 离线页面 | autoplay 对局完成；hard bundle 被加载；未捕获 JS 错误 |
| 设置面板截图 | `tools/tmp-v28/delivery-20261031/evidence/v218-hard-settings-1280x900.png` |

证据：`tools/tmp-v28/delivery-20261031/browser/qa-hard-perf.html`（性能）、`qa-product-hard.html`（E2E）、`qa-hard-settings.html`（截图页）。

## 4. Node 测试

- `node tests/run-all.js --skip-sim`：**PASS 63.3s**（含新增 `tests/ai-pure-hard.test.js`；LAN 25/25）。
- 新增测试：`tests/ai-pure-hard.test.js` 3/3 PASS（接口/版本/参数 sha、三档全局共存、3 局 legality+可完成）。

## 5. 产物

| 产物 | 大小 | sha256 | 校验 |
|---|---:|---|---|
| `dist/poker-duel-web-v2.18.0.zip` | 5,303,119B | `DBDD6C49…F5501B0` | 41 entries、0 反斜杠、含 hard bundle（sha 与工作区一致）+ LAN 文件；staged LAN GET/POST 200 |
| `android/dist/poker-duel-v2.18.0.apk` | 5,327,821B | `3746F31A…A350D` | versionCode 21 / 2.18.0；v1+v2+v3 verified；assets 中 index/main/ui/ai-pure/ai-pure-simple/ai-pure-hard sha 与工作区一致 |
| 旧 v2.17 APK | 3,238,790B | `30CEF749…` | 未变 |

- 发布汇总/验证：`tools/tmp-v28/phase17/eval/release-2.18.0-summary.json`、`release-verify-2.18.0.json`。
- 注：`dist/poker-duel-web-v2.17.0.zip` 在本次发布时已不在 `dist/`（不属本次改动；v2.17 APK 保留）。

## 6. 未验证 / 限制

- **70% 未达到**（交付模型 62.63%；正式最强 65.03%）。
- layout 协议差异：官方数字用固定产品 ML 布局；产品运行时 layout 仍走启发式（与 simple/medium 一致）。
- 真机 Android/WebView、Firefox、低端设备加载/解析未测（模型约 4.9MB）。
- 未集成学习布局（交付方 layout 训练 NO-GO）。
- 未修复交付 bundle 的 move `actionKey` 目标字段缺陷（保持与交付验证一致；见 `docs/04` 历史说明）。

## 7. v2.18.1 补丁（2026-10-31，简化难度文案）

- 设置面板难度描述改为：`简单 = 纯学习 H96，gen60 代`；`中等 = 纯学习 H128，gen241 代`；`困难 = 纯学习 H192，gen436 代`（各附 p95 预算/来源简述）。
- 困难档附加注简化为「困难档模型较大（约 4.9MB），首次加载稍慢。」
- 仅 UI 文案/版本号变更；模型、规则、评测口径不变。
- 产物：Web `dist/poker-duel-web-v2.18.1.zip`（5,302,598B，sha `5E67C93A…2A0C`，41 entries）；APK `android/dist/poker-duel-v2.18.1.apk`（5,327,821B，sha `BA44923A…982E4`，versionCode 22 / 2.18.1，v1+v2+v3）。
- 截图：`tools/tmp-v28/delivery-20261031/evidence/v2181-hard-settings-1280x900.png`；发布记录：`tools/tmp-v28/phase17/eval/release-2.18.1-summary.json`、`release-verify-2.18.1.json`。

## 8. v1.0 版本号统一（2026-10-31）

- 用户要求：版本号改为 **1.0**。产品版本由 2.18.1 统一为 1.0；Android `versionCode 24` / `versionName 1.0`；Web 包名 `poker-duel-web-v1.0.zip`；`README-WEB.txt` Version 1.0。
- 模型/规则/UI 逻辑不变；AI 难度描述去掉日期（只保留 HXX / genN 代与简要说明）；GitHub 入口 README 重写，旧内部记录归档为 `docs/INTERNAL-DESIGN-README.md`。
- 产物（修订重建）：Web `dist/poker-duel-web-v1.0.zip`（5,302,581B，sha `A3F7699D…7204`，41 entries，assets sha 与工作区一致）；APK `android/dist/poker-duel-v1.0.apk`（5,327,821B，sha `8BBC88A3…5BE0`，v1+v2+v3 verified，assets sha 一致）。
- 记录：`tools/tmp-v28/phase17/eval/release-1.0-summary.json`、`release-verify-1.0.json`。
