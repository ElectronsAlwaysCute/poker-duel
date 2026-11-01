# 音效素材来源与授权（v1.5）

本目录 19 个 `.ogg` 音效全部来自 **Kenney.nl** 的免费游戏音频包，授权均为 **Creative Commons Zero (CC0 1.0)**：
可个人/商业使用，无需署名（本项目仍在此致谢：Audio by Kenney, https://kenney.nl）。

## 来源包

| 包名 | 页面 | 授权 |
|---|---|---|
| Casino Audio | https://kenney.nl/assets/casino-audio | CC0 1.0 |
| Interface Sounds | https://kenney.nl/assets/interface-sounds | CC0 1.0 |
| Music Jingles | https://kenney.nl/assets/music-jingles | CC0 1.0 |

CC0 全文：https://creativecommons.org/publicdomain/zero/1.0/

## 文件映射

| 项目文件 | 游戏音效名 | 用途 | 原始文件（包内路径） |
|---|---|---|---|
| `ui-click.ogg` | `ui.click` | 按钮/卡片点击 | interface-sounds / Audio/click_001.ogg |
| `ui-confirm.ogg` | `ui.confirm` | 确认、结算确认 | interface-sounds / Audio/confirmation_002.ogg |
| `ui-error.ogg` | `ui.error` | 非法操作/不可用提示 | interface-sounds / Audio/error_004.ogg |
| `card-place.ogg` | `card.place` | 放牌落桌 | casino-audio / Audio/card-place-2.ogg |
| `card-move.ogg` | `card.move` | 移牌滑动 | casino-audio / Audio/card-slide-3.ogg |
| `card-flip.ogg` | `card.flip` | 翻牌 | casino-audio / Audio/cards-pack-take-out-1.ogg |
| `card-draw.ogg` | `card.draw` | 摸牌/补牌 | casino-audio / Audio/card-slide-2.ogg |
| `card-shuffle.ogg` | `card.shuffle` | 布局揭示/洗牌 | casino-audio / Audio/card-shuffle.ogg |
| `settle-go.ogg` | `settle.go` | 区域结算开始 | casino-audio / Audio/card-shove-2.ogg |
| `settle-win.ogg` | `settle.win` | 赢下区域 | casino-audio / Audio/chips-stack-2.ogg |
| `settle-lose.ogg` | `settle.lose` | 输掉区域 | casino-audio / Audio/card-shove-4.ogg |
| `settle-tie.ogg` | `settle.tie` | 区域平局 | casino-audio / Audio/chip-lay-2.ogg |
| `turn-start.ogg` | `turn.start` | 回合开始（轻） | interface-sounds / Audio/switch_002.ogg |
| `turn-warning.ogg` | `turn.warning` | 倒计时 ≤5s 每秒提示 | interface-sounds / Audio/tick_001.ogg |
| `turn-timeout.ogg` | `turn.timeout` | 回合超时 | interface-sounds / Audio/error_002.ogg |
| `endgame-start.ogg` | `endgame.start` | 战略决战触发 | casino-audio / Audio/dice-throw-2.ogg |
| `game-win.ogg` | `game.win` | 对局胜利 | music-jingles / Audio/8-Bit jingles/jingles_NES00.ogg |
| `game-lose.ogg` | `game.lose` | 对局失败 | music-jingles / Audio/Sax jingles/jingles_SAX07.ogg |
| `game-draw.ogg` | `game.draw` | 对局平局 | music-jingles / Audio/Pizzicato jingles/jingles_PIZZI12.ogg |

Jingle 的挑选依据：解码后测量音高走向（上升→胜利、下行→失败）与时长/亮度，非人工试听确认。

## 音量均衡（重要）

素材原始响度差异很大（有效段 RMS 约 -31 ~ -13 dBFS）。为了让所有音效听感一致：

1. 用 headless Edge（Chromium）`decodeAudioData` 解码每个 ogg，按 20ms 帧计算**有效段 RMS**
   （忽略低于 -50dBFS 的静音帧）与**峰值**；
2. 目标响度：**-20 dBFS RMS**，峰值上限 **-1 dBFS**（约 0.891 线性幅度）→ 得到均衡 gain；
3. 再叠加人工 `trimDb` 微调（例如倒计时 tick/点击音更轻、胜负 jingle 保持存在感）；
4. 最终 `gain`（0..1，HTMLAudioElement 音量上限）内嵌在 `js/sfx.js` 的 `MANIFEST` 中，
   运行时只乘主音量（默认 70%），不做二次放大；
5. 短促敲击类音效（card.place、settle.* 等）峰值先到上限，其 RMS 会低于 -20dBFS，
   这是瞬态特性，属预期（`js/sfx.js` 的 `debugState().sounds[name].peakLimited` 会标记）。

测量明细见 `sfx/balance.json`（生成时间、RMS、峰值、gain、均衡后响度）。
所有音效均为 1 声道/立体声 Vorbis，总体积约 231KB。
