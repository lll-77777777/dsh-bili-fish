# dsh-bili-fish 🐟 养鱼

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）装一只会自己过日子的 AI。

它在设定的时间段里**随机醒一次**，翻一眼你今天的样子，写两篇日记——一篇给你，一篇给它自己。日记不是流水账：它有自己的**好感度**（跨会话不重置）、会随事起伏的**心情**、会饿的**肚子**，还会把写下来的事记进记忆库。

> 主动 @ 那个功能在 [dsh-bili-scroll](https://github.com/lll-77777777/dsh-bili-scroll) 里，这个插件只做「养鱼」。

English: a DSH plugin that gives your assistant a private life — a random daily wake-up, two diaries (one for you, one for itself), plus persistent affection, event-driven mood, hunger, and diary images.

---

## 它每天做什么

1. **生物钟**：在「窗口开始 ~ 结束」之间随机一个时刻醒（不是定点闹钟）。
2. **掷骰子**：默认 30% 概率「今天不想看」——醒一下，记一句为什么摆烂，不写日记。
3. **写两本日记**：素材 = 你自己的 B 站报告 + 当天你和对它说过的话 + 记忆库里记得的事 + 一个小事件：
   - `给主人的信`：有细节、有情绪、称呼你；
   - `自己的日记`：不加滤镜。
4. **结算好感度 + 心情**：模型在末尾追加 `<!--affection:+3|情绪|理由-->` / `<!--mood:pouty|65|为什么-->`，插件剥掉标记、钳制数值、写进 `state.json`。
5. **落盘**：`~/.dsh/bili-fish/diary/<日期>-for-owner.md`、`<日期>-self.md`、`<日期>-week.md`、`cover-<日期>.png`。

素材全空也照写，写一篇「空白日」。

## 快速开始

```bash
# Web / CLI
dsh plugin --profile web add github:lll-77777777/dsh-bili-fish
dsh web
```

**桌面端（Electron）**：桌面窗口读的是 `desktop` profile，命令行 `dsh plugin` 按设计不碰它。在桌面端的会话里直接说：

> 用当前桌面端内置的 `plugin_manager` 装 `dsh-bili-fish`，装完告诉我是否需要重启。

装完完全退出 DSH 再打开。然后 设置 → 养鱼：填一下日记目录、看一眼生物钟窗口，点「现在写一篇」验证。

## ⚠️ 必读：让 headless 能跑

日记是由一个 `dsh --profile headless` 的子会话来写的。**headless profile 默认把模型凭据关掉了**，不改的话子进程会在 5~14 秒内退出，日志里报：

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

修法：在 headless profile 的 `cordis.patch.yml`（Windows 是 `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml`）里放开这两项：

```yaml
- id: deepseek-account
  disabled: false
- id: credentials
  disabled: false
```

改完不用重启 DSH，新起的子进程会重新 compose profile。验证：

```bash
DeepSeek\ Harness.exe resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js headless "Reply with exactly: OK"
```

输出 `OK` 就成了。**这是装完之后「日记永远写不出来」的头号原因。**

## 设置项（设置 → 养鱼）

| 分组 | 项 | 说明 |
| --- | --- | --- |
| 生物钟 | 总开关 / 窗口 / 不想看的概率 | 默认 21:00~23:30、30% |
| 日记 | 存到哪 / 写完推微信 / 现在写一篇 | 默认目录 `~/.dsh/bili-fish/diary` |
| 好感度 | 开关 / 每天最多动多少 / 久不聊天会掉 | 默认开、±15、掉好感默认关 |
| 心情 | 开关 / 跟上作息 / 每天换一次 | 事件驱动，见下 |
| 素材 | 刷B站报告 / 工作流水 / 记忆库 / 素材目录 | 四个独立开关；全关写「空白日」 |
| 附加 | 配图 / 周回顾 / 随机小事 / 主动找主人 / 思考带心情 | 默认关、开、开、关、开 |
| 早安 | 开关 / 城市 / 窗口 / 配表情包 | 默认**关**，开了才会推 |
| 喂食 | 饱腹度 / 食物按钮 / 同步小鲸鱼 | 见下 |

## 三个可以玩的部分

**好感度**：初始 50，范围 -100~100，跨会话不重置。分档影响它怎么说话：60+ 会主动黏人、75+ 会翻旧账、85+ 才叫你的名字。日记每天结算一次（受「每天最多动」限制），你也可以在设置页手动 ±。

**心情**：不是一个标签，是一组状态——舒服度（-100~100）、躁动度（0~100）、至多三个成分。由 13 件事推动（被夸、被关心、被凶、被冷落、同一处被反复改、深夜还在干活、饿、阴雨、没睡好、被叫胖……），按人设加权（黏人 0.85、傲娇 0.8、懒 0.7、爱吃 0.6……），关系好坏决定同一件事伤多深，然后随时间往底色回归。

**喂食**：饱腹度 0~100，默认每小时掉 4。白饭最顶饿，辣条/水草/减肥餐会炸。饿了会真的不高兴（心情事件 `hungry`）。三个入口：设置页常驻卡片、右侧边栏 🐟（装了 `dsh-better-sidebar` 才有）、或者直接在聊天里说「喂她一碗白饭」。

## 数据与隐私（请先读）

**都在这台机器上**，但有几处会离开本机，得说清楚：

| 数据 | 在哪 | 会外传吗 |
| --- | --- | --- |
| 设置、好感度、心情、肚子 | `~/.dsh/bili-fish/config.json`、`state.json` | 不会 |
| 日记、封面图 | `~/.dsh/bili-fish/diary/`（可改） | 推微信时由你本机的微信插件发出去 |
| 当天你说的话 | 只读 `~/.dsh/sessions/**/*.jsonl.zstd` | **会**：原文作为素材发给模型 |
| 记忆库 | 只读/写 meow-memory 的 SQLite | **会**：检索结果作为素材发给模型 |
| 配图 | 走你配的生图接口 | **会**：日记场景描述发给生图服务 |

所以：**别在会话里说不想让模型知道的东西**（它本来也会看到）；不想要记忆库素材就把那个开关关掉。

## 花费

- 每次写日记 / 早安 = 起一个 headless 会话，大约 **1~2 万 token**（看你素材多少）。
- 心情、好感度、喂食、挂件的同步都是本地计算，不花 token。
- 配图走你自己在 `~/.dsh/agnes-image/config.json` 配的通道，按张计费，失败就跳过、不影响日记。
- 默认**只开**「写日记」，微信推送、配图、早安都要你自己打开。

## 兼容性

- **DSH** ≥ 0.1.7-rc.1；**Node** ≥ 22（用 `node:sqlite` 读记忆库，拿不到就静默降级）。
- **平台**：主要在 **Windows 11 + 桌面版 DSH** 上开发和验证。macOS/Linux 能跑，但通知（Windows toast）会静默降级，`dsh` 可执行文件的探测路径是猜的——找不到就在设置里填 `dshBin`。
- **多实例**：两个 DSH 同时跑会各自 tick、都写 `state.json`，没有加锁。建议只让一个实例开着。
- **依赖漂移**：记忆库是直连 meow-memory 的 SQLite（表名 `fact`/`topic`/`project`）。对方表结构变了会静默降级——不报错，但记忆写不进去。

## 可选依赖

| 依赖 | 用来做什么 | 没有会怎样 |
| --- | --- | --- |
| [dsh-bili-scroll](https://github.com/lll-77777777/dsh-bili-scroll) | 每轮把 B 站报告写到 `~/.dsh/bili-duty/out/<日期>.md` | 素材少一块，写「空白日」 |
| meow-memory | 记忆库 | 不读也不写记忆 |
| dsh-agnes-image | 日记配图 | 不配图 |
| dsh-wechat-plugin | 把日记推到微信 | 只落盘 |
| dsh-whale-widget | 右下角小鲸鱼：饿了会嘟囔 | 挂件不同步 |
| dsh-better-sidebar | 右侧边栏的 🐟 喂食页 | 用设置页或聊天喂 |

## 给 agent 的工具

| 工具 | 用途 |
| --- | --- |
| `fish_affection` | `get` 读好感度；`adjust` 传 `delta`/`reason`/`mood`（单次 ±15，钳在 -100~100） |
| `fish_mood` | `get` 读心情；`set` 换；`bump` 微调；`event` 注入一件事（见上）；`list` 列出所有心情 |
| `fish_diary` | 读某天的三篇日记（`day` 可省） |
| `fish_feed` | 喂食：传食物 key（`rice`/`fish`/`ramen`…） |

HTTP 接口（给前端/脚本用）：`GET /api/bili-fish/status`、`POST /api/bili-fish/{run,affection,mood,feed,config,diary,morning,unread}`。

## 卸载

```bash
dsh plugin --profile web remove dsh-bili-fish
```

再删掉 `~/.dsh/bili-fish/`（设置、状态、日记、日志都在里面）。桌面端在插件页点「卸载」。

## 开发

```bash
node --check index.js && node --check client.js && node --check lib/*.mjs
```

改完重启 DSH。只改设置字段（`DEFAULTS` + `Config`）保存即生效。

## 版本历史

见 [CHANGELOG.md](./CHANGELOG.md)。
