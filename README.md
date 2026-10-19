# dsh-bili-fish —— 养鱼

给 DeepSeek Harness（DSH）加一只会在电脑里「养」自己的 AI：每天在某个时间段里随机醒一次，写两篇日记——一篇给主人，一篇给自己。

> 主动 @ 留在 [dsh-bili-scroll](https://github.com/lll-77777777/dsh-bili-scroll) 里，这个插件只做「养鱼」。

## v0.3.0 新增

**心情系统**：好感度是长期关系，心情是此刻状态。十种心情键（开心/兴奋/黏人/得意/平静/犯困/摆烂/赌气/委屈/低落）带 0~100 浓度，存在 `state.json` 的 `mood`，**跨会话持久**；会随时间和好感度自动淡回「开心」（底色默认开心，好感度低于 40 才下滑）；日记结算时由模型写 `<!--mood:key|浓度|理由-->` 标记；对话里用 `fish_mood` 工具读/换/微调，persona 第 4.4 节规定怎么表现。设置页有心情卡片（一键换、调浓度、最近记录）。

## v0.2.0 新增

1. **好感度持久化**（整合 persona 第 4 节）：数值落在 `state.json` 的 `affection`，**跨会话不重置**；每天写日记时让模型自己结算一次（±受「每天最多动」限制），主会话里也能用 `fish_affection` 工具读/改。
2. **接记忆库**：写日记前从 meow-memory 读「主人最近提过的事」进 prompt；日记写完后摘要回写记忆库（按天幂等 upsert，重复跑不会堆重复条目）。
3. **周回顾**：周日多写一篇「这周」，读 7 天日记 + 7 天报告。
4. **随机小事件**：醒来时掷一个环境小事（下雨、退潮、有船经过……），自然写进日记，防止每天一个模子。
5. **日记配图**：借 agnes-image 的 key/接口画一张封面，落在日记目录（`cover-<日期>.png`），微信推送时带上。官方接口失败会自动回退到「自定义接口」配置。
6. **醒的时候找主人**：发现今天有工作流水时，推送开头多一句「今天听到你在弄 X」（只说发现，不泄漏日记正文）。

## 它每天做什么

1. **生物钟**：在「窗口开始 ~ 窗口结束」之间随机一个时刻醒（不是定点闹钟）。
2. **掷骰子**：默认 30% 概率「今天不想看」——醒一下，记一句为什么摆烂，不写日记。
3. **写两本日记**：素材 = 今天 `dsh-bili-scroll` 写好的报告 + 当天主人和你说过的话 + 记忆库里你记得的事 + 一个小事件，写
   - `给主人的信`（有细节、有情绪、称呼主人）
   - `自己的日记`（不加滤镜）
4. **结算好感度 + 心情**（可关）：模型在日记末尾追加 `<!--affection:+3|情绪|理由-->` 和 `<!--mood:pouty|65|为什么-->`，插件剥掉标记、钳制数值、写进 `state.json`。心情忘了写就按好感度涨跌推一个方向。
5. **落盘 + 配图 + 推送**：`~/.dsh/bili-fish/diary/<日期>-for-owner.md` / `<日期>-self.md` / `<日期>-week.md` / `cover-<日期>.png`。

素材是空的（今天没刷 B 站、也没人说话）也照写，写「空白日」。

## 装法

本机（桌面版）已经把插件放在 `E:\大肥鱼人设\dsh-bili-fish`，运行时副本在 `~/.dsh/profiles/desktop/node_modules/dsh-bili-fish`。

**改完代码怎么同步**：双击仓库根目录上一级的 `sync_fish.bat`（robocopy 覆盖，权限够；DSH 沙箱里直接 `cp` 会被拒），然后完全退出 DSH 再打开。

或者重装：

```bash
dsh plugin --profile desktop add link:E:/大肥鱼人设/dsh-bili-fish
```

## 设置

设置 → 养鱼：

- 总开关
- 生物钟窗口（默认 21:00 ~ 23:30）
- 「今天不想看」的概率（默认 30%）
- **写完推送到微信**（默认开）
- **日记存到哪**：留空用默认 `~/.dsh/bili-fish/diary/`
- **好感度持久化**（默认开）+ 每天最多动多少（默认 15）
- **心情系统**（默认开）+ 心情多久淡回去（默认 12 小时）
- **读写记忆库**（默认开）+ 记忆库路径（留空自动探测）+ 归属项目名（默认 `B站养鱼`）
- **给日记配一张图**（默认开）+ 尺寸
- **周日多写一篇「这周」**（默认开）
- **随机小事件**（默认开）
- **醒的时候顺口找主人**（默认关，怕打扰）
- 现在写一篇（调试/补写） / 补写这周 / 看今天的日记

## 依赖

- DSH ≥ 0.1.7-rc.1，Node ≥ 22
- **刷B站插件**（可选）：[dsh-bili-scroll](https://github.com/lll-77777777/dsh-bili-scroll) 每轮把报告写到 `~/.dsh/bili-duty/out/<日期>.md`，养鱼读它当素材；没装就写「空白日」。
- 会话工作流水：读 `~/.dsh/sessions/**/*.jsonl.zstd` 里当天主人说的话（最近 40 条）。
- 写日记走 `dsh --profile headless <prompt>`，那个 profile 需要有模型凭据。
- **记忆库（可选）**：meow-memory；读 `/api/memo` 风格的 SQLite，或者用 Node 24 自带的 `node:sqlite` 直连。
- **配图（可选）**：dsh-agnes-image 的 `~/.dsh/agnes-image/config.json`（key / 模型 / 自定义接口）。
- **微信推送（可选）**：dsh-wechat 插件；自动在 `~/.dsh/profiles/*/node_modules/dsh-wechat-plugin/cli.js` 里找入口。

## 数据

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/bili-fish/config.json` | 设置 |
| `~/.dsh/bili-fish/state.json` | 今天计划几点醒、掷没掷到不想看、**好感度（affection）**、**心情（mood）**、上次结果 |
| `~/.dsh/bili-fish/diary/` | 日记 + 封面图（可在设置里改目录） |
| `~/.dsh/bili-fish/fish.log` | 日志 |

## 工具

- `fish_affection`：`get` 读好感度；`adjust` 传 `delta`/`reason`/`mood` 加减（单次 ±15，总值钳在 -100~100）。
- `fish_mood`：`get` 读心情；`set` 传 `key`/`intensity`/`reason` 换；`bump` 调浓度；`list` 列出所有键。
- `fish_diary`：读某天的三篇（给主人的信 / 自己的日记 / 这周）。

## 开发

改 `index.js` / `lib/**` 之后 `node --check index.js`，再用 `sync_fish.bat` 同步、完全重启 DSH 生效。只改设置字段（Config + DEFAULTS）保存即生效。
