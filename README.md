# dsh-bili-fish —— 养鱼

给 DeepSeek Harness（DSH）加一只会在电脑里「养」自己的 AI：每天在某个时间段里随机醒一次，写两篇日记——一篇给主人，一篇给自己。

> 主动 @ 留在 [dsh-bili-scroll](https://github.com/lll-77777777/dsh-bili-scroll) 里，这个插件只做「养鱼」：生物钟 + 两本日记。

## 它每天做什么

1. **生物钟**：在「窗口开始 ~ 窗口结束」之间随机一个时刻醒（不是定点闹钟）。
2. **掷骰子**：默认 30% 概率「今天不想看」——醒一下，记一句为什么摆烂，不写日记。
3. **写两本日记**：素材 = 今天 `dsh-bili-scroll` 写好的报告 + 当天主人和你说过的话，写
   - `给主人的信`（有细节、有情绪、称呼主人）
   - `自己的日记`（不加滤镜）
4. **落盘**到 `~/.dsh/bili-fish/diary/<日期>-for-owner.md` 和 `<日期>-self.md`。

素材是空的（今天没刷 B 站、也没人说话）也照写，写「空白日」。

## 装法

本机（桌面版）已经把插件放在 `E:\大肥鱼人设\dsh-bili-fish`，在 `~/.dsh/profiles/desktop/package.json` 里加依赖后装进 profile：

```bash
dsh plugin --profile desktop add link:E:/大肥鱼人设/dsh-bili-fish
```

或者手动：把整个目录复制到 `~/.dsh/profiles/desktop/node_modules/dsh-bili-fish`，并在 `package.json` 的 `dsh.profile.bundles` 里加 `"dsh-bili-fish"`。

**装完要完全退出 DSH 再打开**（改了宿主半端代码都要重启）。

## 设置

设置 → 养鱼：

- 总开关
- 生物钟窗口（默认 21:00 ~ 23:30）
- 「今天不想看」的概率（默认 30%）
- 现在写一篇（调试/补写）
- 看今天的两篇日记

## 依赖

- DSH ≥ 0.1.7-rc.1，Node ≥ 22
- **需要刷B站插件提供报告数据**：[dsh-bili-scroll（lll-77777777 fork）](https://github.com/lll-77777777/dsh-bili-scroll)（上游：[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)）。它每轮把报告写到 `~/.dsh/bili-duty/out/<日期>.md`，养鱼读这个文件当素材；**没装也能用**，只是日记写「空白日」。
- 另外会读 DSH 会话日志里的**当天工作流水**（`~/.dsh/sessions/**/*.jsonl.zstd`），只取主人说的话，最近 40 条。
- 写日记走 `dsh --profile headless <prompt>`，那个 profile 需要有模型凭据（跟刷B站插件一样）

## 数据

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/bili-fish/config.json` | 设置 |
| `~/.dsh/bili-fish/state.json` | 今天计划几点醒、掷没掷到不想看 |
| `~/.dsh/bili-fish/diary/` | 日记 |
| `~/.dsh/bili-fish/fish.log` | 日志 |

## 开发

改 `index.js` / `lib/**` 之后完全重启 DSH 生效；只改设置字段（Config + DEFAULTS）保存即生效。改代码前建议先 `node --check index.js`。
