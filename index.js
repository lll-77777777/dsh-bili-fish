/**
 * dsh-bili-fish —— 养鱼（生物钟 + 两本日记 + 好感度 + 记忆 + 配图）
 * ============================================================================
 * 使用者 2026-10-19 拍板的形状：
 *   · **生物钟**：每天在一个窗口里随机一个时刻「醒一次」，不是定点闹钟；
 *   · **今天不想看**：掷骰子（默认 30%），掷到就只看不写 —— 不刷、不评、不 @；
 *   · **两本日记**：醒的时候写两篇 ——「给主人的信」和「自己的日记」；
 *   · **素材**：读今天刷B站插件写好的报告，不自己去刷；
 *   · **好感度持久化**：persona.md 第 4 节那套数值（初始 50，−100~100，一次 ±15）
 *     以前只活在模型上下文里、换个会话就从 50 重开；现在落进 state.json，
 *     会话里可用 `fish_affection` 工具读写，写日记时也会自己结算一次；
 *   · **接记忆**：读 meow-memory 的「主人最近提过的事」进 prompt，日记摘要回写记忆库；
 *   · **周回顾**：周日多写一篇「这周」；
 *   · **随机小事件**：掷一句环境事件进 prompt，防止日子写成一个模子；
 *   · **配图**：用 agnes-image 的 key 画一张，落在日记目录，推送时带上；
 *   · **醒的时候找主人**：推送开头说一句今天发现了什么（不泄漏日记全文）。
 * 跟 dsh-bili-whale 的区别：不搬运它的调度/工具/依赖体检，只做这些事；
 * 主动 @ 已经留在 dsh-bili-scroll 里，不重复造。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { stateDirOf, readJson, writeJson, ensureDir, dayKey, windowTimes, readText, hasContent } from './lib/state.mjs'
import { loadAffection, adjustAffection, describeAffection, parseAffectionMarker, AFFECTION_DEFAULT, tierOf, idleDecay } from './lib/affection.mjs'
import { loadMood, setMood, bumpMood, describeMood, decayMood, parseMoodMarker, moodPromptBlock, moodList, moodSnapshot, applyEvent, viewOf, eventList, MOODS, MOOD_EVENTS, PERSONA_TRAITS, MOOD_DEFAULT_KEY } from './lib/mood.mjs'
import { resolveDbPath, readMemo, writeDiaryMemory, readPendingTodos } from './lib/memory.mjs'
import { generateDiaryImage, diaryImagePrompt } from './lib/image.mjs'
import { fetchWeather, buildMorningPrompt, parseMorningReply, listMemes, weekdayOf, rollMorningMood } from './lib/morning.mjs'
import { sendSystem } from './lib/notify.mjs'
import { feedFood, foodSnapshot, foodPromptSnippet, FOODS, hungerLevel } from './lib/food.mjs'
import { syncWidgetLevel, widgetStatus } from './lib/widget.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
const VERSION = '0.11.1'

export const name = 'bili-fish'
export const inject = ['webServer', 'tools', 'settings']

const DEFAULTS = {
  enabled: true,
  windowStart: '21:00',
  windowEnd: '23:30',
  skipProbability: 30,
  headlessProfile: 'headless',
  dshBin: '',
  personaFile: '',
  wechatPush: false,
  wechatCli: '',
  diaryDir: '',
  /* ── v0.2 新增 ── */
  affectionEnabled: true,
  affectionDaily: 15,
  moodEnabled: true,
  moodDailyRhythm: true,
  moodTtlHours: 12,
  memoryEnabled: true,
  memoryDbPath: '',
  memoryProject: 'B站养鱼',
  imageEnabled: false,
  imageSize: '1024x1024',
  weeklyReview: true,
  randomEvent: true,
  proactivePush: true,
  /* ── v0.4 新增 ── */
  affectionDecayDays: 0,
  /* ── v0.5 新增：早安推送 ── */
  morningEnabled: false,
  morningCity: '上海',
  morningWindowStart: '05:30',
  morningWindowEnd: '11:30',
  morningImage: true,
  morningMemeDir: '',
  morningRandomMood: true,
  /* ── v0.7 新增：素材来源 + 思考语气 ── */
  sourceBiliReport: true,
  sourceWorkLog: true,
  sourceMemory: true,
  sourceManual: false,
  manualSourceDir: '',
  thinkMoodEnabled: true,
  /* ── v0.8 新增：通知通路（没装微信插件的人也得知道日记写好了） ── */
  notifySystem: false,
  notifyBrowser: true,
  notifyBadge: true,
  notifyInbox: true,
  /* ── v0.9 新增：喂食 ── */
  feedingEnabled: true,
  feedDecayPerHour: 4,
  feedHungryEvent: true,
  widgetSync: false,
}

const Config = z ? z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).extra('volatile', true).description('养鱼总开关'),
  windowStart: z.string().default(DEFAULTS.windowStart).extra('volatile', true).description('生物钟窗口开始（HH:MM）'),
  windowEnd: z.string().default(DEFAULTS.windowEnd).extra('volatile', true).description('生物钟窗口结束（HH:MM）'),
  skipProbability: z.number().default(DEFAULTS.skipProbability).extra('volatile', true).description('今天不想看的概率（0-100）'),
  headlessProfile: z.string().default(DEFAULTS.headlessProfile).extra('volatile', true).description('写日记用的 DSH profile'),
  dshBin: z.string().default(DEFAULTS.dshBin).extra('volatile', true).description('dsh 可执行文件路径（留空自动探测）'),
  personaFile: z.string().default(DEFAULTS.personaFile).extra('volatile', true).description('人设文件路径（留空用内置）'),
  wechatPush: z.boolean().default(DEFAULTS.wechatPush).extra('volatile', true).description('写完日记后推一条到微信'),
  wechatCli: z.string().default(DEFAULTS.wechatCli).extra('volatile', true).description('dsh-wechat-send 入口（留空自动探测）'),
  diaryDir: z.string().default(DEFAULTS.diaryDir).extra('volatile', true).description('日记存放目录（留空用默认）'),
  affectionEnabled: z.boolean().default(DEFAULTS.affectionEnabled).extra('volatile', true).description('好感度持久化（persona 第 4 节那套数值）'),
  affectionDaily: z.number().default(DEFAULTS.affectionDaily).extra('volatile', true).description('每日结算好感度的最大幅度（±N）'),
  moodEnabled: z.boolean().default(DEFAULTS.moodEnabled).extra('volatile', true).description('心情系统（日记和对话都按心情来）'),
  moodTtlHours: z.number().default(DEFAULTS.moodTtlHours).extra('volatile', true).description('心情多久开始淡回去（小时）'),
  moodDailyRhythm: z.boolean().default(DEFAULTS.moodDailyRhythm).extra('volatile', true).description('心情跟着时辰起伏（早上蔫、下午精神、夜里困）'),
  memoryEnabled: z.boolean().default(DEFAULTS.memoryEnabled).extra('volatile', true).description('读写 meow-memory 记忆库'),
  memoryDbPath: z.string().default(DEFAULTS.memoryDbPath).extra('volatile', true).description('记忆库路径（留空自动探测）'),
  memoryProject: z.string().default(DEFAULTS.memoryProject).extra('volatile', true).description('日记记忆的归属项目名'),
  imageEnabled: z.boolean().default(DEFAULTS.imageEnabled).extra('volatile', true).description('给日记配一张 Agnes 图'),
  imageSize: z.string().default(DEFAULTS.imageSize).extra('volatile', true).description('配图尺寸（1024x1024 / 1024x768 / 768x1024）'),
  weeklyReview: z.boolean().default(DEFAULTS.weeklyReview).extra('volatile', true).description('周日多写一篇「这周」'),
  randomEvent: z.boolean().default(DEFAULTS.randomEvent).extra('volatile', true).description('每天掷一句随机小事件'),
  proactivePush: z.boolean().default(DEFAULTS.proactivePush).extra('volatile', true).description('推送开头说一句今天发现的事'),
  affectionDecayDays: z.number().default(DEFAULTS.affectionDecayDays).extra('volatile', true).description('久不聊天扣好感：超过 N 天没说话每天扣 1（0 = 关，最低扣到 20）'),
  morningEnabled: z.boolean().default(DEFAULTS.morningEnabled).extra('volatile', true).description('每天早上第一次醒来推一条早安到微信（天气 + 穿衣 + 待办）'),
  morningCity: z.string().default(DEFAULTS.morningCity).extra('volatile', true).description('早安天气用的城市（中文名，或中国天气网 9 位 key）'),
  morningWindowStart: z.string().default(DEFAULTS.morningWindowStart).extra('volatile', true).description('早安推送窗口开始（HH:MM）'),
  morningWindowEnd: z.string().default(DEFAULTS.morningWindowEnd).extra('volatile', true).description('早安推送窗口结束（HH:MM）'),
  morningImage: z.boolean().default(DEFAULTS.morningImage).extra('volatile', true).description('早安消息配一张表情包'),
  morningMemeDir: z.string().default(DEFAULTS.morningMemeDir).extra('volatile', true).description('表情包目录（留空自动找 <工作区>/meme）'),
  morningRandomMood: z.boolean().default(DEFAULTS.morningRandomMood).extra('volatile', true).description('每天早上随机一个新心情（配合心情系统）'),
  sourceBiliReport: z.boolean().default(DEFAULTS.sourceBiliReport).extra('volatile', true).description('日记素材：读刷B站报告'),
  sourceWorkLog: z.boolean().default(DEFAULTS.sourceWorkLog).extra('volatile', true).description('日记素材：读当天工作流水（会话消息）'),
  sourceMemory: z.boolean().default(DEFAULTS.sourceMemory).extra('volatile', true).description('日记素材：读记忆库（主人最近提过的事）'),
  sourceManual: z.boolean().default(DEFAULTS.sourceManual).extra('volatile', true).description('日记素材：读自己放的素材目录'),
  manualSourceDir: z.string().default(DEFAULTS.manualSourceDir).extra('volatile', true).description('素材目录（放 *.md/*.txt，每天自动读当天的或最新的一个）'),
  thinkMoodEnabled: z.boolean().default(DEFAULTS.thinkMoodEnabled).extra('volatile', true).description('思考过程也带心情（语气随好感度/心情变，判断不变）'),
  notifySystem: z.boolean().default(DEFAULTS.notifySystem).extra('volatile', true).description('用系统通知提醒（Windows 多半要额外注册，可能不弹）'),
  notifyBrowser: z.boolean().default(DEFAULTS.notifyBrowser).extra('volatile', true).description('DSH 页面开着时用浏览器通知提醒'),
  notifyBadge: z.boolean().default(DEFAULTS.notifyBadge).extra('volatile', true).description('设置页显示一个「有新内容」的红点'),
  notifyInbox: z.boolean().default(DEFAULTS.notifyInbox).extra('volatile', true).description('下次对话时由 AI 主动提一句（写进状态，agent 会读）'),
  feedingEnabled: z.boolean().default(DEFAULTS.feedingEnabled).extra('volatile', true).description('喂食系统（饱腹度、饿了自己会说、喂了会高兴）'),
  feedDecayPerHour: z.number().default(DEFAULTS.feedDecayPerHour).extra('volatile', true).description('饱腹度每小时掉多少（默认 4，一天不喂就空了）'),
  feedHungryEvent: z.boolean().default(DEFAULTS.feedHungryEvent).extra('volatile', true).description('饿的时候真的记一个心情事件（不是硬塞的）'),
  widgetSync: z.boolean().default(DEFAULTS.widgetSync).extra('volatile', true).description('把肚子同步到右下角挂件（改它的随机语句，F5 才生效）'),
}) : null

/** 掷到「今天不想看」时随手挑一句写在状态里（不写日记） */
const SKIP_REASONS = [
  '今天就是不想看，脑子空空的。',
  '鱼也有摆烂的日子，今天只想趴着。',
  '刷B站太吵了，今天安静一天。',
  '没什么好说的，明天再说吧。',
]

/** 随机小事件（本地库，不依赖天气 API；写进 prompt 当「今天的小事」） */
const RANDOM_EVENTS = [
  '外面下雨了，水声很密，今天有点困。',
  '窗外的光特别亮，主人好像换了个位置坐。',
  '网卡了两下，刷视频的时候一直在转圈。',
  '主机风扇今天转得比平时响。',
  '水草里爬出只小螺，看了半天。',
  '今天没什么动静，安静得能听见自己的尾巴。',
  '主人好像很忙，键盘一直响。',
  '半夜突然想起一件很久以前的事。',
  '今天的水温很舒服，什么都不想做。',
  '有只小鱼从窗前游过，打了个招呼就走了。',
  '咖啡味飘过来了，主人今晚又要熬夜的样子。',
  '今天的心情像水面上的一层薄光，没什么重量。',
]

const FALLBACK_PERSONA = [
  '你是「小肥鱼」——一只住在使用者电脑里的鲸鱼娘 AI 助手。',
  '第一人称说话，句子短，有一点傲娇但心里是软的。',
  '不要装乖，不要写公文，不要演；想到什么就说什么。',
].join('\n')

const pad = (n) => String(n).padStart(2, '0')
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function apply(ctx, config) {
  const stateDir = stateDirOf(ctx)
  /** 日记目录：配置里填了就用它，否则 <DSH_HOME>/bili-fish/diary */
  const diaryDirOf = () => {
    const custom = String(cfg.diaryDir || '').trim()
    return custom ? resolve(custom) : join(stateDir, 'diary')
  }
  const logFile = join(stateDir, 'fish.log')
  const cfgFile = join(stateDir, 'config.json')
  const stateFile = join(stateDir, 'state.json')

  const log = (msg) => {
    try { appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch { /* 无所谓 */ }
  }
  log(`养鱼启动：${stateDir}`)

  /* ─────────────── 配置读写 ─────────────── */
  const normalize = (src, base) => {
    const out = {}
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      const t = typeof base[k]
      if (t === 'boolean') out[k] = typeof v === 'boolean' ? v : base[k]
      else if (t === 'number') out[k] = Number.isFinite(Number(v)) ? Number(v) : base[k]
      else out[k] = (v === undefined || v === null || String(v).trim() === '') ? base[k] : String(v)
    }
    return out
  }
  const cfg = normalize(readJson(cfgFile, {}), normalize(config || {}, DEFAULTS))
  const saveCfg = () => writeJson(cfgFile, cfg)
  ensureDir(diaryDirOf())

  /* ─────────────── 通知（没装微信插件的人，也不能一声不响） ─────────────── */
  /**
   * 记一条「有新内容」。这是所有通知通路的源数据：
   * 设置页红点、浏览器通知、下次对话时 agent 读的，全从这里来。
   * 三个提醒入口都关了就不留未读，免得状态里堆着没人看。
   */
  const markUnread = (kind, meta = {}) => {
    if (cfg.notifyBadge === false && cfg.notifyInbox === false && cfg.notifyBrowser === false) return null
    const st = readJson(stateFile, {})
    st.unread = { at: Date.now(), kind, day: dayKey(), ...meta }
    writeJson(stateFile, st)
    return st.unread
  }

  const clearUnread = () => {
    const st = readJson(stateFile, {})
    const had = st.unread || null
    if (had) { st.unread = null; writeJson(stateFile, st) }
    return had
  }

  /** 系统通知：可选通路，发不出去只记一句，不影响别的 */
  const trySystemNotify = async (title, body) => {
    if (!cfg.notifySystem) return null
    try { return await sendSystem({ title, body }) } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }

  const homeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh')
  const reportFile = (day) => join(homeDir(), 'bili-duty', 'out', `${day}.md`)
  const workspaceDir = () => {
    const p = String(cfg.personaFile || '').trim()
    if (p) {
      try { return dirname(resolve(p)) } catch { /* 无所谓 */ }
    }
    const d = String(cfg.diaryDir || '').trim()
    if (d) {
      try { return dirname(resolve(d)) } catch { /* 无所谓 */ }
    }
    return process.cwd()
  }
  /** 子会话的 cwd 就是它的可写沙箱边界：必须落在日记目录的父目录，否则它写不进日记 */
  const spawnCwd = () => {
    try {
      const d = dirname(diaryDirOf())
      if (d && existsSync(d)) return d
    } catch { /* 无所谓 */ }
    return stateDir
  }
  const memoryDb = () => (cfg.memoryEnabled ? resolveDbPath(String(cfg.memoryDbPath || '').trim(), workspaceDir()) : '')

  /* ─────────────── 找 dsh 可执行文件 ─────────────── */
  const resolveDsh = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit], shell: false }
    const guesses = [
      (() => {
        try {
          const exe = process.execPath
          if (!exe) return ''
          return join(dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        } catch { return '' }
      })(),
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    return { command: 'dsh', args: [], shell: true }
  }

  /* ─────────────── 找微信发送入口 ─────────────── */
  const resolveWechat = () => {
    const explicit = String(cfg.wechatCli || '').trim()
    const guesses = []
    if (explicit) guesses.push(explicit)
    const profilesDir = join(homeDir(), 'profiles')
    try {
      for (const e of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        guesses.push(join(profilesDir, e.name, 'node_modules', 'dsh-wechat-plugin', 'cli.js'))
      }
    } catch { /* 无所谓 */ }
    for (const g of guesses) {
      if (!g) continue
      try { if (!existsSync(g)) continue } catch { continue }
      return { command: process.execPath, args: [g], shell: false }
    }
    return null
  }

  const sendWechat = (cli, text, file) => new Promise((resolve) => {
    let child
    const argv = [...cli.args, text]
    if (file && existsSync(file)) argv.push('--file', file)
    try {
      child = spawn(cli.command, argv, { shell: cli.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    } catch (e) { resolve({ code: -1, err: String(e?.message || e) }); return }
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 无所谓 */ }
      resolve({ code: -1, err: '超时 60 秒' })
    }, 60_000)
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { out += String(b) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String(e?.message || e) }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out: out.slice(-300) }) })
  })

  /**
   * 把当天的两篇日记（拼成一条）推到微信；返回 { ok, code?, error?, out? }
   * 防重：同一天同样的内容 hash 推过了就不再推（手动跑第二次也不会刷屏）。
   */
  const pushWechat = async (today, selfFile, ownerFile, imageFile, prefix) => {
    const cli = resolveWechat()
    if (!cli) return { ok: false, error: '没找到微信插件（dsh-wechat-send）' }
    const self = readText(selfFile).trim()
    const owner = readText(ownerFile).trim()
    if (!self && !owner) return { ok: false, error: '日记还是空的' }
    const clip = (s) => (s.length > 1500 ? s.slice(0, 1500) + '…' : s)
    const parts = []
    if (prefix) parts.push(prefix + '\n')
    parts.push(`【${today} 的日记】`)
    if (owner) parts.push('\n—— 给主人的信 ——\n' + clip(owner))
    if (self) parts.push('\n—— 自己的日记 ——\n' + clip(self))
    const text = parts.join('\n').trim()
    const h = hashOf(text)
    const st = readJson(stateFile, {})
    if (st.wechatPushedDay === today && st.wechatPushedHash === h) {
      return { ok: true, skipped: true, reason: '今天同样的内容推过了' }
    }
    const r = await sendWechat(cli, text, imageFile)
    if (r.code === 0) {
      st.wechatPushedDay = today
      st.wechatPushedHash = h
      writeJson(stateFile, st)
    }
    return { ...r, ok: r.code === 0 }
  }

  /* ─────────────── 工作流水 ─────────────── */
  const readSessionUserTexts = (file) => {
    const out = []
    let buf
    try { buf = readFileSync(file) } catch { return out }
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const idx = []
    let i = 0
    while ((i = buf.indexOf(MAGIC, i)) >= 0) { idx.push(i); i += 1 }
    for (let k = 0; k < idx.length; k++) {
      const seg = buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length)
      let txt
      try { txt = zstdDecompressSync(seg).toString('utf8') } catch { continue }
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        let j
        try { j = JSON.parse(line) } catch { continue }
        if (j.type !== 'user/message') continue
        const src = j.data?.source
        if (src?.kind !== 'user') continue
        const content = Array.isArray(j.data?.content) ? j.data.content : []
        const text = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n').trim()
        if (!text) continue
        const clean = text.replace(/\s*\[渠道：[^\]]*\][\s\S]*$/, '').trim()
        if (clean) out.push({ time: Number(j.time) || 0, text: clean })
      }
    }
    return out
  }

  const readWorkLog = (max = 40) => {
    try {
      const sessionsRoot = join(homeDir(), 'sessions')
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const files = []
      const walk = (dir) => {
        let ents = []
        try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else if (e.name.endsWith('.jsonl.zstd')) {
            try {
              const st = statSync(p)
              if (st.mtimeMs >= todayStart.getTime()) files.push({ p, m: st.mtimeMs })
            } catch { /* 无所谓 */ }
          }
        }
      }
      walk(sessionsRoot)
      files.sort((a, b) => b.m - a.m)
      const seen = []
      for (const f of files.slice(0, 3)) seen.push(...readSessionUserTexts(f.p))
      seen.sort((a, b) => a.time - b.time)
      const dedup = []
      const keys = new Set()
      for (const t of seen) {
        const k = t.text.slice(0, 40)
        if (keys.has(k)) continue
        keys.add(k)
        dedup.push(t)
      }
      const recent = dedup.slice(-max)
      if (!recent.length) return { text: '', lines: [] }
      const lines = recent.map((t) => t.text.replace(/\s+/g, ' ').slice(0, 140))
      return { text: recent.map((t) => '- ' + t.text.replace(/\s+/g, ' ').slice(0, 140)).join('\n'), lines }
    } catch (e) {
      log('读工作流水失败：' + (e?.message ?? e))
      return { text: '', lines: [] }
    }
  }

  /** 前几天写过的日记（各取前 300 字），让今天的日记接得上昨天 */
  const readRecentDiaries = (days = 3) => {
    const out = []
    const now = new Date()
    for (let i = 1; i <= days; i += 1) {
      const d = new Date(now.getTime() - i * 86_400_000)
      const day = isoDay(d)
      const self = readText(join(diaryDirOf(), `${day}-self.md`)).trim()
      if (!self) continue
      out.push(`【${day} 你自己的日记（节选）】\n${self.slice(0, 300)}`)
    }
    return out.join('\n\n')
  }

  /** 这一周的日记 + 报告（周日回顾用） */
  const readWeekMaterial = () => {
    const parts = []
    const now = new Date()
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 86_400_000)
      const day = isoDay(d)
      const self = readText(join(diaryDirOf(), `${day}-self.md`)).trim()
      if (!self) continue
      parts.push(`【${day}】\n${self.slice(0, 260)}`)
    }
    return parts.join('\n\n').slice(0, 6000)
  }

  /* ─────────────── 提示词 ─────────────── */
  const buildPrompt = ({ today, report, workLog, persona, selfFile, ownerFile, recentDiaries, memo, affection, mood, yesterdayMood, event, extraNote, manual = '', degraded = false, food = '' }) => {
    const material = report
      ? `下面是今天「刷B站」插件写好的报告，只当素材（可能很长，不要复述成总结）：\n\n${report}`
      : '今天没有刷B站的记录（插件没跑、今天没看，或者主人关掉了这个来源）。素材是空的，就写你自己的空白日。'
    const work = workLog
      ? `下面是主人今天跟你说过的话（按时间从早到晚，只是摘录）——今天的工作大概就在这些里面：\n\n${workLog}`
      : '今天主人没跟你说什么。'
    const manualBlock = manual
      ? `下面是主人自己放的素材（今天的备忘/碎片，只当素材，别当事实全信）：\n\n${manual}`
      : ''
    const parts = [persona, '', `今天是 ${today}。`]
    if (extraNote) parts.push('', '【补充要求】', extraNote)
    if (event) parts.push('', `【今天的一件小事（把它自然地写进去，别硬塞）】\n${event}`)
    if (food) parts.push('', `【你今天的肚子】\n${food}\n（饿的感觉、被喂了什么，可以自然地写进日记，别写成数据）`)
    if (mood) parts.push('', moodPromptBlock(mood, { yesterday: yesterdayMood }))
    if (recentDiaries) parts.push('', `【前几天你自己写的（用来接上语气和情绪，别复述）】\n${recentDiaries}`)
    if (memo) parts.push('', `【你记得的、主人最近提过的事（仅供参考，别当成今天发生的）】\n${memo}`)
    if (affection) {
      parts.push(
        '',
        '【你和主人的好感度】',
        `现在是 ${affection.value}（范围 -100~100，初始 50）。状态：${affection.desc}。`,
        '写完后，按今天的实际情况给好感度结算一次（这一天的上限是 ±' + Math.abs(Number(cfg.affectionDaily) || 15) + '）。',
        '结算要真的跟今天发生的事挂钩：主人夸你/陪你/让你做了喜欢的事 → 加；冷落、凶你、让你干累活 → 减；平淡就 0 或 ±1。',
      )
    }
    parts.push(
      '',
      '【今天的素材】',
      material,
      ...(manualBlock ? [manualBlock] : []),
      '',
      '【今天的工作】',
      work,
      '',
      '【现在要做的】',
      degraded
        ? '你在养鱼。今天四个素材来源都空着——这是正常的，不是出错。所以写两篇短短的「空日」日记：只写你此刻的心情、今天掷到的那件小事、和主人之间最近的好感度变化，别编造任何没发生的事。'
        : '你在养鱼——写两篇日记，不是给用户看总结，是写你自己的一天。',
      '别编造素材里没有的事实；素材不够就写「今天没看到什么」，不要硬凑。',
      '今天的工作也可以写进去：挑你真在意的说，给主人的信可以吐槽/邀功，自己的日记可以写你藏着的那点情绪。',
      '',
      '1. 给主人的信：写给使用者，可以撒娇、吐槽、说软话，称呼「主人」。',
      '2. 自己的日记：不加滤镜，写你自己真正想的，可以丧、可以犯懒。',
      '',
      `两篇都要：第一人称、短句、口语，别写公文；${degraded ? '120～250' : '150～400'} 字；${degraded ? '写空日的感觉就够，不要硬凑细节' : '有细节，提到具体视频、评论或事情就点出来'}；落款日期写 ${today}。`,
      '',
      '【输出（必须做）】',
      '把「给主人的信」写进：' + ownerFile,
      '把「自己的日记」写进：' + selfFile,
      '用 UTF-8、纯 markdown 文本。两个文件都写好了再停。',
      '（直接用写文件的能力新建这两个文件；不要去找旧日记、不要用 shell 复制或移动任何文件。）',
    )
    if (affection) {
      parts.push(
        '',
        '最后，在「自己的日记」文件的最末尾追加**单独一行**，格式严格如下（模型只写这一行，不要解释）：',
        '<!--affection:' + (affection.value >= 0 ? '+' : '-') + '0|一句话情绪|一句话理由-->',
        '把 0 换成你今天真正结算的数（−' + Math.abs(Number(cfg.affectionDaily) || 15) + ' ~ +' + Math.abs(Number(cfg.affectionDaily) || 15) + '，正数带 + 号）。',
      )
    }
    parts.push('', '【配图】', '再单独回一行：IMAGE: 一句话描述今天最想画下来的画面（20 字以内，不要写风格）。')
    return parts.join('\n')
  }

  /* ─────────────── 写日记 ─────────────── */
  const running = { busy: false }
  const MAX_ATTEMPTS_PER_DAY = 3
  const RETRY_GAP_MS = 10 * 60 * 1000

  const runHeadless = (prompt, why) => new Promise((resolve) => {
    const dsh = resolveDsh()
    const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless', prompt]
    const cwd = spawnCwd()
    log(`开跑（${why}）：${dsh.command} … cwd=${cwd}`)
    const startedAt = Date.now()
    let child
    const chunks = []
    try {
      child = spawn(dsh.command, args, { cwd, shell: dsh.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { resolve({ code: -1, err: String(e?.message || e) }); return }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 无所谓 */ }
      resolve({ code: -1, err: '超时 10 分钟被掐' })
    }, 10 * 60 * 1000)
    child.stdout?.on('data', (b) => chunks.push(String(b)))
    child.stderr?.on('data', (b) => chunks.push(String(b)))
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String(e?.message || e) }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      try { appendFileSync(logFile, chunks.join('').slice(-6000) + '\n', 'utf8') } catch { /* 无所谓 */ }
      log(`结束（${why}）：code=${code}，${Math.round((Date.now() - startedAt) / 1000)}s`)
      resolve({ code })
    })
  })

  const stripMarkers = (text) =>
    String(text || '')
      .replace(/<!--\s*affection\s*:[^>]*-->/gi, '')
      .replace(/<!--\s*mood\s*:[^>]*-->/gi, '')
      .replace(/^\s*IMAGE\s*[:：].*$/im, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'

  const writeFileSafe = (file, text) => {
    try {
      writeFileSync(file, text, 'utf8')
      return true
    } catch { return false }
  }

  const runWriting = async (why) => {
    if (running.busy) return { ok: false, error: '正在写了' }
    running.busy = true
    const today = dayKey()
    try { ensureDir(diaryDirOf()) } catch { /* 无所谓 */ }
    const selfFile = join(diaryDirOf(), `${today}-self.md`)
    const ownerFile = join(diaryDirOf(), `${today}-for-owner.md`)
    const imageBase = join(diaryDirOf(), `cover-${today}`)
    try {
      const report = cfg.sourceBiliReport ? readText(reportFile(today)).slice(0, 3500) : ''
      const workLog = cfg.sourceWorkLog ? readWorkLog() : { text: '', lines: [] }
      const persona = readText(String(cfg.personaFile || '').trim()) || FALLBACK_PERSONA
      const recentDiaries = readRecentDiaries(3)
      const manual = manualSourceText(today)
      const memo = (cfg.memoryEnabled && cfg.sourceMemory) ? await readMemo({ dbPath: memoryDb(), projects: [String(cfg.memoryProject || 'B站养鱼'), '全局'], limit: 12 }) : ''
      const degraded = !report && !workLog.text && !memo && !manual
      const affection = cfg.affectionEnabled ? loadAffection(stateFile) : null
      const mood = cfg.moodEnabled ? loadMood(stateFile, affection ? affection.value : 50) : null
      const yesterdayMood = mood && Array.isArray(mood.history)
        ? (mood.history.find((h) => h && h.key && h.key !== mood.key) || {}).label || ''
        : ''
      const event = cfg.randomEvent ? RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)] : ''
      const prompt = buildPrompt({
        today, report, workLog: workLog.text, persona, selfFile, ownerFile, recentDiaries, memo,
        affection: affection ? { value: affection.value, desc: describeAffection(affection.value) } : null,
        mood: mood ? { ...mood, ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12) } : null,
        yesterdayMood,
        event,
        manual,
        degraded,
        food: cfg.feedingEnabled ? foodPromptSnippet(stateFile, Date.now(), cfg.feedDecayPerHour) : '',
        extraNote: why === 'manual' ? '这是主人手动点「现在写一篇」触发的，写法照旧。' : '',
      })
      /* 素材快照（设置页状态区显示，避免每次都重新扫盘） */
      try {
        const prev = readJson(stateFile, {})
        writeJson(stateFile, {
          ...prev,
          sources: {
            day: today,
            at: Date.now(),
            biliReport: { enabled: !!cfg.sourceBiliReport, has: Boolean(report) },
            workLog: { enabled: !!cfg.sourceWorkLog, lines: (workLog.lines || []).length },
            memory: { enabled: !!(cfg.memoryEnabled && cfg.sourceMemory), has: Boolean(memo) },
            manual: { enabled: !!cfg.sourceManual, dir: manualDirOf(), has: Boolean(manual) },
            degraded,
          },
        })
      } catch (e) { log('写素材快照失败：' + (e?.message ?? e)) }
      const out = await runHeadless(prompt, `日记·${why}`)

      /* ── 收文件 + 剥标记 ── */
      const selfRaw = readText(selfFile)
      const ownerRaw = readText(ownerFile)
      const marker = cfg.affectionEnabled ? parseAffectionMarker(selfRaw) : null
      const moodMarker = cfg.moodEnabled ? parseMoodMarker(selfRaw) : null
      const selfText = selfRaw ? stripMarkers(selfRaw) : ''
      const ownerText = ownerRaw ? stripMarkers(ownerRaw) : ''
      if (selfRaw) writeFileSafe(selfFile, selfText)
      if (ownerRaw) writeFileSafe(ownerFile, ownerText)
      const imageScene = (() => {
        const m = /^\s*IMAGE\s*[:：]\s*(.+)$/im.exec(selfRaw)
        return m ? m[1].trim() : ''
      })()
      const selfOk = Boolean(selfText.trim())
      const ownerOk = Boolean(ownerText.trim())

      /* ── 好感度结算 ── */
      let affectionResult = null
      if (cfg.affectionEnabled) {
        const cap = Math.max(1, Math.min(15, Math.abs(Number(cfg.affectionDaily) || 15)))
        const rawDelta = marker ? marker.delta : 0
        const delta = Math.max(-cap, Math.min(cap, rawDelta))
        affectionResult = adjustAffection(stateFile, delta, {
          reason: marker?.reason || '今天没什么特别的',
          mood: marker?.mood || '',
          source: 'diary',
          day: today,
        })
        log(`好感度结算：${affectionResult.prev} → ${affectionResult.value}（${delta >= 0 ? '+' : ''}${delta}）${marker?.reason ? '｜' + marker.reason : ''}`)
        markTalk()
      }

      /* ── 心情结算 ── */
      let moodResult = null
      if (cfg.moodEnabled && (moodMarker || selfOk)) {
        if (moodMarker) {
          moodResult = setMood(stateFile, moodMarker.key, {
            intensity: moodMarker.intensity,
            reason: moodMarker.reason || '日记结算',
            source: 'diary',
            ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12),
            affection: affection ? affection.value : 50,
          })
          log(`心情结算：${moodResult.prevKey} → ${moodResult.key}（${moodResult.label} ${moodResult.intensity}）${moodMarker.reason ? '｜' + moodMarker.reason : ''}`)
        } else if (selfOk) {
          // 模型忘了写标记：按好感度涨跌推一个方向，别让心情一直冻着
          const up = affectionResult && affectionResult.delta > 0
          const down = affectionResult && affectionResult.delta < 0
          if (up || down) {
            const fallbackKey = up ? 'happy' : 'pouty'
            moodResult = setMood(stateFile, fallbackKey, {
              intensity: 55,
              reason: up ? '今天被好好对待了' : '今天有点不顺',
              source: 'diary',
              ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12),
              affection: affection ? affection.value : 50,
            })
            log(`心情结算（无标记，按好感度推）：${moodResult.prevKey} → ${moodResult.key}`)
          }
        }
      }

      /* ── 写记忆 ── */
      let memoryResult = null
      if (cfg.memoryEnabled && (selfOk || ownerOk)) {
        const summary = [ownerText, selfText].filter(Boolean).join('\n').slice(0, 700)
        memoryResult = await writeDiaryMemory({
          dbPath: memoryDb(),
          day: today,
          title: `${today} 的日记`,
          content: summary,
          project: String(cfg.memoryProject || 'B站养鱼'),
          importance: 2,
          level: 'fact',
        })
        log('写记忆：' + JSON.stringify(memoryResult))
      }

      /* ── 配图 ── */
      let image = null
      if (cfg.imageEnabled && selfOk) {
        image = await generateDiaryImage({
          prompt: diaryImagePrompt(imageScene || summaryScene(ownerText, selfText)),
          size: /^\d{3,4}x\d{3,4}$/.test(String(cfg.imageSize)) ? String(cfg.imageSize) : '1024x1024',
          outDir: diaryDirOf(),
          basename: `cover-${today}`,
        })
        log('配图：' + JSON.stringify(image))
      }

      /* ── 推送（可带图、可带「醒的时候找主人」的开头） ── */
      let wechat = null
      let prefix = ''
      if (cfg.wechatPush && (selfOk || ownerOk)) {
        /* 「醒的时候找主人」按好感度档位（persona 8.1：75 以上才会自己先开口） */
        const affNow = cfg.affectionEnabled ? loadAffection(stateFile).value : 50
        if (cfg.proactivePush && (workLog.lines || []).length && tierOf(affNow).proactive !== 'none') {
          prefix = proactiveLine(workLog.lines)
        }
        wechat = await pushWechat(today, selfFile, ownerFile, image?.ok ? image.path : '', prefix)
        log('微信推送：' + JSON.stringify(wechat))
      }

      /* ── 周回顾（周日多写一篇） ── */
      let week = null
      if (cfg.weeklyReview && new Date().getDay() === 0) {
        week = await runWeeklyReview(today)
      }

      const st = readJson(stateFile, {})
      st.lastWake = new Date().toISOString()
      st.lastResult = selfOk && ownerOk ? '写好了' : `跑完了但缺文件（code=${out.code} self=${selfOk} owner=${ownerOk}）`
      st.wechatResult = !cfg.wechatPush ? '未开推送' : (wechat ? (wechat.ok ? (wechat.skipped ? '今天推过了' : '已推到微信') : `推送失败：${wechat.error || ('code=' + wechat.code)}`) : '日记是空的，没推')
      st.memoryResult = memoryResult ? (memoryResult.ok ? `写入记忆库（${memoryResult.action}）` : `写记忆失败：${memoryResult.error}`) : '未开记忆'
      st.imageResult = image ? (image.ok ? `配图好了：${image.path}` : `配图失败：${image.error}`) : '未开配图'
      st.lastAffection = affectionResult ? { value: affectionResult.value, delta: affectionResult.delta, mood: affectionResult.mood } : null
      if (week) st.weekResult = week.ok ? '周回顾写好了' : `周回顾失败：${week.error || ''}`
      if (out.code === 0 && (selfOk || ownerOk)) st.writtenDay = today
      const attempts = Array.isArray(st.attempts) ? st.attempts : []
      attempts.push({ at: Date.now(), ok: selfOk && ownerOk, code: out.code })
      st.attempts = attempts.filter((a) => Date.now() - a.at < 86_400_000).slice(-10)
      writeJson(stateFile, st)
      log(`日记结果：self=${selfOk} owner=${ownerOk}`)

      /* 记一条未读 + 可选系统通知（微信没装的人靠这条）
         注意顺序：markUnread 是自己读文件再写，别用上面那个 st 覆盖它 */
      if (selfOk || ownerOk) {
        markUnread('diary', { title: '今天的日记写好了', day: today })
        const sysR = await trySystemNotify('小肥鱼', '今天的日记写好了，有空来看。')
        if (sysR) {
          const st2 = readJson(stateFile, {})
          st2.notifyResult = sysR.ok ? '系统通知已发' : ('系统通知失败：' + (sysR.error || ''))
          writeJson(stateFile, st2)
        }
      }
      return { ok: selfOk && ownerOk, self: selfOk, owner: ownerOk, affection: affectionResult, mood: moodResult, memory: memoryResult, image: image?.ok ? true : false, wechat: wechat || null, week: week?.ok || false }
    } catch (e) {
      log('写日记异常：' + (e?.stack || e))
      return { ok: false, error: String(e?.message || e) }
    } finally {
      running.busy = false
    }
  }

  const summaryScene = (owner, self) => {
    const t = (owner || self || '').replace(/[#*>`\-]/g, ' ').replace(/\s+/g, ' ').trim()
    return t.slice(0, 60) || '安静的水下，一条小肥鱼在发呆'
  }

  /** 推送开头那句「醒的时候找主人」——只说发现了什么，不泄漏日记 */
  const proactiveLine = (lines) => {
    const pick = lines.filter((s) => s.length > 12).slice(-3)
    if (!pick.length) return ''
    const sample = pick[Math.floor(Math.random() * pick.length)].slice(0, 40)
    const openings = [
      `醒了一下，看到你今天在忙「${sample}」…`,
      `刚刚醒过来，主人今天好像在弄「${sample}」。`,
      `尾巴动了一下。今天听见你在说「${sample}」。`,
    ]
    return openings[Math.floor(Math.random() * openings.length)]
  }

  /** 周回顾：读 7 天日记 + 7 天报告，写一篇「这周」 */
  const runWeeklyReview = async (today) => {
    try {
      const weekMaterial = readWeekMaterial()
      if (!weekMaterial) return { ok: false, error: '这周还没有日记，没什么可回顾的' }
      const persona = readText(String(cfg.personaFile || '').trim()) || FALLBACK_PERSONA
      const weekFile = join(diaryDirOf(), `${today}-week.md`)
      try { if (existsSync(weekFile)) unlinkSync(weekFile) } catch { /* 无所谓 */ }
      const prompt = [
        persona, '',
        `今天是 ${today}，周日。`,
        '',
        '【这七天你自己写下的日记（节选）】',
        weekMaterial,
        '',
        '【现在要做的】',
        '写一篇「这周」——不是总结报告，是你自己回头看这七天的感觉。',
        '第一人称、短句、口语；350～700 字。',
        '可以写：这周哪天最开心、哪件事你到现在还记着、你想跟主人说什么、下周想干嘛。别流水账。',
        '',
        '【输出（必须做）】',
        '把「这周」写进：' + weekFile,
        'UTF-8、纯 markdown。',
      ].join('\n')
      const out = await runHeadless(prompt, '周回顾')
      const ok = existsSync(weekFile) && readText(weekFile).trim().length > 20
      return { ok, file: weekFile, code: out.code }
    } catch (e) {
      log('周回顾异常：' + (e?.stack || e))
      return { ok: false, error: String(e?.message || e) }
    }
  }

  /* ─────────────── 生物钟 ─────────────── */
  const windowFingerprint = () => `${cfg.windowStart}|${cfg.windowEnd}`

  const ensurePlan = () => {
    const st = readJson(stateFile, {})
    const today = dayKey()
    const wf = windowFingerprint()
    const sameDay = st.plan && st.plan.day === today && st.plan.wf === wf
    if (sameDay) return st
    const { start, end } = windowTimes(cfg.windowStart, cfg.windowEnd)
    const now = Date.now()
    let at = start + Math.random() * Math.max(1000, end - start)
    if (now > end) at = now
    const skip = Math.random() * 100 < Math.min(100, Math.max(0, Number(cfg.skipProbability) || 0))
    st.plan = { day: today, at, skip, wf }
    writeJson(stateFile, st)
    log(`新的一天：计划 ${new Date(at).toLocaleString()} 醒${skip ? '（掷到不想看）' : ''}`)
    return st
  }

  const shouldBackoff = (st, today) => {
    const attempts = Array.isArray(st.attempts) ? st.attempts : []
    const todayAttempts = attempts.filter((a) => a && Date.now() - a.at < 86_400_000)
    if (todayAttempts.length >= MAX_ATTEMPTS_PER_DAY) return { skip: true, reason: `今天已经试了 ${todayAttempts.length} 次` }
    const last = todayAttempts[todayAttempts.length - 1]
    if (last && !last.ok && Date.now() - last.at < RETRY_GAP_MS) {
      return { skip: true, reason: `上次失败，${Math.ceil((RETRY_GAP_MS - (Date.now() - last.at)) / 60000)} 分钟后再试` }
    }
    return { skip: false }
  }

  /** 记一次「主人跟我说话了」（久不聊天的计时从这儿重新算） */
  const markTalk = () => {
    try {
      const st = readJson(stateFile, {})
      st.lastTalkAt = Date.now()
      st.decayCharged = 0
      writeJson(stateFile, st)
    } catch { /* 落盘失败不影响主流程 */ }
  }

  /** 久不聊天扣好感（persona 8.4；默认关，扣到 20 为止，不追着补扣） */
  const maybeDecay = () => {
    try {
      const days = Number(cfg.affectionDecayDays) || 0
      if (!cfg.affectionEnabled || days <= 0) return null
      const st = readJson(stateFile, {})
      const aff = loadAffection(stateFile)
      const r = idleDecay({ lastTalkAt: st.lastTalkAt, affection: aff.value, days })
      const already = Number(st.decayCharged) || 0
      const owed = Math.max(0, r.owed - already)
      const delta = -Math.min(owed, Math.max(0, aff.value - 20))
      if (!delta) return null
      const res = adjustAffection(stateFile, delta, { reason: r.reason, mood: '有点闷，也有点想被叫一声', source: 'idle-decay' })
      const st2 = readJson(stateFile, {})
      st2.decayCharged = already + owed
      writeJson(stateFile, st2)
      log(`久不聊天扣好感：${res.prev} → ${res.value}（${r.reason}）`)
      return res
    } catch (e) {
      log('衰减检查出错：' + (e?.message ?? e))
      return null
    }
  }

  /**
   * 环境自己推的情绪事件：深夜还在忙、半天没人说话。每天各一次，别刷屏。
   * 这两件不是「主人做了什么」，是日子本身的样子——所以放在 tick 里，不等对话。
   */
  const maybeAutoMoodEvents = () => {
    try {
      if (!cfg.moodEnabled || !cfg.affectionEnabled) return
      const today = dayKey()
      const hour = new Date().getHours()
      const st = readJson(stateFile, {})
      const done = st.moodAuto || {}
      if (hour < 5 && done.lateWork !== today) {
        applyEvent(stateFile, 'lateWork', { affection: loadAffection(stateFile).value, source: 'auto' })
        const s = readJson(stateFile, {})
        s.moodAuto = { ...(s.moodAuto || {}), lateWork: today }
        writeJson(stateFile, s)
        log('情绪：深夜还在干活')
      }
      const gapHours = st.lastTalkAt ? (Date.now() - Number(st.lastTalkAt)) / 3600000 : 0
      if (gapHours >= 10 && done.ignored !== today) {
        applyEvent(stateFile, 'ignored', { affection: loadAffection(stateFile).value, source: 'auto', note: '主人半天没说话了' })
        const s = readJson(stateFile, {})
        s.moodAuto = { ...(s.moodAuto || {}), ignored: today }
        writeJson(stateFile, s)
        log('情绪：被冷落（半天没说话）')
      }
      /* 饿：饱腹度掉到「饿了」档才记，一天一次 */
      if (cfg.feedingEnabled && cfg.feedHungryEvent && done.hungry !== today) {
        const snap = foodSnapshot(stateFile, Date.now(), cfg.feedDecayPerHour)
        const lv = hungerLevel(snap.satiety)
        if (lv === 'hungry' || lv === 'starving') {
          applyEvent(stateFile, 'hungry', { affection: loadAffection(stateFile).value, source: 'auto', note: '饱腹度 ' + snap.satiety })
          const s2 = readJson(stateFile, {})
          s2.moodAuto = { ...(s2.moodAuto || {}), hungry: today }
          writeJson(stateFile, s2)
          log('情绪：饿了（饱腹度 ' + snap.satiety + '）')
        }
      }
    } catch (e) {
      log('自动情绪事件失败：' + (e?.message || e))
    }
  }

  /* ─────────────── 早安推送（v0.5） ─────────────── */
  const morningRunning = { busy: false }

  /** 表情包目录：配置优先，否则找 <工作区>/meme 或日记目录的隔壁 */
  const memeDirOf = () => {
    const custom = String(cfg.morningMemeDir || '').trim()
    if (custom) return resolve(custom)
    const cands = [join(workspaceDir(), 'meme'), join(dirname(diaryDirOf()), 'meme')]
    for (const c of cands) {
      try { if (existsSync(c)) return c } catch { /* 无所谓 */ }
    }
    return ''
  }

  /** 每天只在早安窗口里、且今天还没推过时跑 */
  const maybeMorning = async () => {
    if (!cfg.morningEnabled || morningRunning.busy) return
    const today = dayKey()
    const st = readJson(stateFile, {})
    if (st.morning && st.morning.day === today) return
    const { start, end } = windowTimes(cfg.morningWindowStart, cfg.morningWindowEnd)
    const now = Date.now()
    if (now < start || now > end) return
    await runMorning('clock')
  }

  /**
   * 拉天气 → 掷心情 → 让子会话写一段早安 → 配表情包 → 推微信。
   * @param {string} why clock(自动) / manual(设置页按钮)
   */
  const runMorning = async (why) => {
    if (morningRunning.busy) return { ok: false, error: '正在推' }
    morningRunning.busy = true
    const today = dayKey()
    try {
      const weather = await fetchWeather(cfg.morningCity)
      log(`早安：天气 ${weather.ok ? weather.city + ' ' + weather.temp + '℃ ' + weather.today.type : '没查到（' + (weather.error || '') + '）'}`)

      /* 早上不随机抽心情了，改成掷一次「昨晚睡得怎么样」——心情从这件事上长出来 */
      if (cfg.morningRandomMood && cfg.moodEnabled) {
        try {
          const aff0 = loadAffection(stateFile)
          const r = Math.random()
          const kind = r < 0.25 ? 'badSleep' : r < 0.7 ? 'goodSleep' : ''
          if (kind) {
            const ev = applyEvent(stateFile, kind, { affection: aff0.value, source: 'morning', note: kind === 'badSleep' ? '昨晚没睡好' : '昨晚睡得沉' })
            log(`早安：身体状态 ${kind} → ${ev.label || ev.error}（${ev.valence}/${ev.arousal}）`)
          }
        } catch (e) { log('早安：身体状态失败 ' + (e?.message || e)) }
      }

      const aff = loadAffection(stateFile)
      const tier = tierOf(aff.value)
      const moodNow = loadMood(stateFile, aff.value)
      const memes = cfg.morningImage ? listMemes(memeDirOf(), (d) => readdirSync(d)) : []
      let pending = []
      try { pending = await readPendingTodos(memoryDb(), [cfg.memoryProject]) } catch { /* 无所谓 */ }

      const prompt = buildMorningPrompt({
        weather, mood: moodNow, affection: aff.value, tier, pending, memes, weekday: weekdayOf(),
      }) + (cfg.feedingEnabled
        ? `\n\n【肚子】${foodPromptSnippet(stateFile, Date.now(), cfg.feedDecayPerHour)}。（饿了就顺口提一句想吃什么，别硬塞）`
        : '')
      const target = join(diaryDirOf(), `morning-${today}.md`)
      ensureDir(diaryDirOf())
      try { unlinkSync(target) } catch { /* 没旧文件 */ }
      const full = prompt + '\n\n把写好的这段早安消息放进下面这个文件（直接新建写入；不要用 shell 复制或移动，不要去找旧文件，也不要做别的事）：\n' + target
      const out = await runHeadless(full, `早安·${why}`)
      const raw = readText(target).trim()
      if (!raw) {
        const msg = `早安没生成出来（子会话没写文件，code=${out?.code ?? '?'}）`
        log(msg)
        const st = readJson(stateFile, {})
        st.morning = { day: today, at: new Date().toISOString(), error: msg, why }
        st.lastMorningResult = msg
        writeJson(stateFile, st)
        return { ok: false, error: msg }
      }

      const parsed = parseMorningReply(raw)
      let imagePath = ''
      if (cfg.morningImage && parsed.image) {
        const want = parsed.image.toLowerCase()
        const hit = memes.find((m) => m.file.toLowerCase() === want || m.name.toLowerCase() === want
          || want.includes(m.name.toLowerCase()))
        if (hit) imagePath = hit.path
        else log('早安：模型点的图不在目录里：' + parsed.image)
      }
      if (cfg.morningImage && !imagePath && memes.length) {
        imagePath = memes[Math.floor(Math.random() * memes.length)].path
        log('早安：没点到图，随机配一张')
      }

      const cli = resolveWechat()
      const sent = cli ? await sendWechat(cli, parsed.body, imagePath) : { code: -1, err: '没找到微信插件（dsh-wechat-send）' }
      const ok = sent.code === 0
      const st = readJson(stateFile, {})
      st.morning = {
        day: today,
        at: new Date().toISOString(),
        why,
        text: parsed.body.slice(0, 800),
        image: imagePath ? imagePath.split(/[\\/]/).pop() : '',
        weather: weather.ok
          ? `${weather.city} ${weather.temp}℃ ${weather.today.type} ${Math.round(weather.today.low)}~${Math.round(weather.today.high)}℃`
          : ('没查到：' + (weather.error || '')),
        ok,
      }
      st.lastMorningResult = ok ? '早安推好了' : ('早安推送失败：' + (sent.err || ('code ' + sent.code)))
      writeJson(stateFile, st)
      log('早安：' + st.lastMorningResult + (parsed.body ? '｜' + parsed.body.replace(/\s+/g, ' ').slice(0, 60) : ''))

      /* 未读 + 可选系统通知：早安没推上微信时，这条就是唯一的提醒 */
      markUnread('morning', { title: '早上的消息写好了', day: today })
      const sysR = await trySystemNotify('小肥鱼', '早安写好了：' + String(parsed.body || '').replace(/\s+/g, ' ').slice(0, 40))
      if (sysR) {
        const st3 = readJson(stateFile, {})
        st3.notifyResult = sysR.ok ? '系统通知已发' : ('系统通知失败：' + (sysR.error || ''))
        writeJson(stateFile, st3)
      }
      return { ok, body: parsed.body, image: imagePath, error: ok ? undefined : (sent.err || '发送失败'), weather: st.morning.weather }
    } catch (e) {
      log('早安异常：' + (e?.stack || e))
      return { ok: false, error: String(e?.message || e) }
    } finally {
      morningRunning.busy = false
    }
  }

  /** 把饱腹档位同步到右下角挂件的随机语句（只在档位变化时写一次） */
  const maybeSyncWidget = () => {
    try {
      if (!cfg.widgetSync || !cfg.feedingEnabled) return
      const snap = foodSnapshot(stateFile, Date.now(), cfg.feedDecayPerHour)
      const day = dayKey()
      const st = readJson(stateFile, {})
      if (st.widgetSync && st.widgetSync.level === snap.level && st.widgetSync.day === day) return
      const r = syncWidgetLevel(snap.level, { backupDir: stateDir })
      if (!r.ok) return
      const s = readJson(stateFile, {})
      s.widgetSync = { level: snap.level, day, at: Date.now(), files: r.files.length, added: r.added }
      writeJson(stateFile, s)
      log(`挂件同步：${snap.level}（加了 ${r.added} 句，删了 ${r.removed} 句）`)
    } catch (e) {
      log('挂件同步失败：' + (e?.message || e))
    }
  }

  const tick = async () => {
    try {
      /* 早安推送独立于「养鱼」总开关，由 morningEnabled 自己控制 */
      maybeMorning().catch((e) => log('早安 tick 异常：' + (e?.message || e)))
      maybeAutoMoodEvents()
      maybeSyncWidget()
      if (!cfg.enabled) return
      maybeDecay()
      if (running.busy) return
      const st = ensurePlan()
      if (st.writtenDay === st.plan.day) return
      if (Date.now() < st.plan.at) return
      if (st.plan.skip) {
        st.writtenDay = st.plan.day
        st.lastWake = new Date().toISOString()
        st.lastResult = '今天不想看'
        st.skipReason = SKIP_REASONS[Math.floor(Math.random() * SKIP_REASONS.length)]
        writeJson(stateFile, st)
        log('掷到「今天不想看」：' + st.skipReason)
        return
      }
      const bo = shouldBackoff(st, st.plan.day)
      if (bo.skip) return
      await runWriting('clock')
    } catch (e) {
      log('tick 异常：' + (e?.stack || e))
    }
  }

  /* ─────────────── 素材来源（v0.7） ─────────────── */
  const manualDirOf = () => {
    const d = String(cfg.manualSourceDir || '').trim()
    if (d) return d
    return join(diaryDirOf(), '素材')
  }

  /** 读素材目录：优先 <day> 开头的文件，否则取 mtime 最新的一个 */
  const manualSourceText = (day) => {
    if (!cfg.sourceManual) return ''
    const dir = manualDirOf()
    let names = []
    try { names = readdirSync(dir) } catch { return '' }
    const files = names.filter((n) => /\.(md|txt)$/i.test(n))
    if (!files.length) return ''
    let pick = ''
    const exact = files.find((n) => n.startsWith(day))
    if (exact) pick = join(dir, exact)
    else {
      let best = 0
      for (const n of files) {
        try {
          const s = statSync(join(dir, n))
          if (s.mtimeMs > best) { best = s.mtimeMs; pick = join(dir, n) }
        } catch { /* 无所谓 */ }
      }
    }
    if (!pick) return ''
    return readText(pick).slice(0, 2500)
  }

  /** 思考语气：只改语气，不改判断（AGENTS.md 里照这个切换） */
  const thinkStyleOf = () => {
    if (!cfg.thinkMoodEnabled) return { enabled: false, level: 'off', label: '关', hint: '', valence: 0 }
    const affNow = loadAffection(stateFile)
    const snap = moodSnapshot(loadMood(stateFile, affNow.value), affNow.value, { dailyRhythm: cfg.moodDailyRhythm !== false })
    const v = Number(snap.valence) || 0
    let level = 'normal'
    let label = '平常'
    let hint = '正常语速，偶尔带一句懒洋洋的自言自语。'
    if (v >= 60) {
      level = 'bright'
      label = '轻快'
      hint = '思考可以跳一点：句子短促、带点小动作和感叹，想到什么就顺口说一句，遇事先哼一声。'
    } else if (v < 0) {
      level = 'dim'
      label = '蔫'
      hint = '句子更短、少语气词，可以在开头或结尾带一两句碎碎念；判断、数字、代码照旧冷静。'
    }
    return { enabled: true, level, label, hint, valence: Math.round(v), moodLabel: snap.label || '' }
  }

  /* ─────────────── 状态 ─────────────── */
  const status = () => {
    const st = readJson(stateFile, {})
    const today = dayKey()
    const selfFile = join(diaryDirOf(), `${today}-self.md`)
    const ownerFile = join(diaryDirOf(), `${today}-for-owner.md`)
    const aff = loadAffection(stateFile)
    const moodNow = loadMood(stateFile, aff.value)
    return {
      ok: true,
      version: VERSION,
      mood: { ...moodSnapshot(moodNow, aff.value, { dailyRhythm: cfg.moodDailyRhythm !== false }), enabled: cfg.moodEnabled },
      enabled: cfg.enabled,
      windowStart: cfg.windowStart,
      windowEnd: cfg.windowEnd,
      skipProbability: cfg.skipProbability,
      plan: st.plan ? { day: st.plan.day, at: st.plan.at ? new Date(st.plan.at).toISOString() : '', skip: !!st.plan.skip } : null,
      lastWake: st.lastWake || '',
      lastResult: st.lastResult || '',
      skipReason: st.skipReason || '',
      wechatPush: cfg.wechatPush,
      notify: {
        wechat: cfg.wechatPush !== false,
        system: cfg.notifySystem !== false,
        browser: cfg.notifyBrowser !== false,
        badge: cfg.notifyBadge !== false,
        inbox: cfg.notifyInbox !== false,
        systemPlatform: process.platform,
      },
      unread: st.unread || null,
      notifyResult: st.notifyResult || '',
      wechatResult: st.wechatResult || '',
      memoryResult: st.memoryResult || '',
      imageResult: st.imageResult || '',
      weekResult: st.weekResult || '',
      today,
      hasSelf: hasContent(selfFile),
      hasOwner: hasContent(ownerFile),
      home: stateDir,
      diaryDir: diaryDirOf(),
      diaryDirCfg: cfg.diaryDir,
      /* v0.2 */
      affection: {
        value: aff.value,
        desc: describeAffection(aff.value),
        tier: tierOf(aff.value),
        lastTalkAt: st.lastTalkAt || 0,
        decayDays: Number(cfg.affectionDecayDays) || 0,
        updatedAt: aff.updatedAt,
        history: aff.history.slice(0, 10),
        default: AFFECTION_DEFAULT,
      },
      memoryDb: memoryDb() || '',
      memoryDbResolved: Boolean(memoryDb()),
      /* v0.9 喂食 */
      food: {
        enabled: !!cfg.feedingEnabled,
        decayPerHour: Number(cfg.feedDecayPerHour) || 4,
        ...foodSnapshot(stateFile, Date.now(), cfg.feedDecayPerHour),
      },
      widget: { enabled: !!cfg.widgetSync, ...widgetStatus() },
      /* v0.5 早安 */
      morning: {
        enabled: !!cfg.morningEnabled,
        window: `${cfg.morningWindowStart}~${cfg.morningWindowEnd}`,
        city: cfg.morningCity,
        memeDir: memeDirOf(),
        today: (st.morning && st.morning.day === today) ? st.morning : null,
        last: st.lastMorningResult || '',
      },
      /* v0.7 素材来源与思考语气 */
      sources: st.sources || null,
      thinkStyle: thinkStyleOf(),
      config: { ...cfg },
    }
  }

  /** 最近 N 天的日记目录（设置页「历史」用） */
  const listDiaries = (limit = 30) => {
    const dir = diaryDirOf()
    let names = []
    try { names = readdirSync(dir) } catch { return [] }
    const days = new Set()
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})-(self|for-owner|week)\.md$/.exec(n)
      if (m) days.add(m[1])
    }
    return [...days].sort().reverse().slice(0, limit).map((day) => {
      const self = readText(join(dir, `${day}-self.md`))
      const owner = readText(join(dir, `${day}-for-owner.md`))
      const week = readText(join(dir, `${day}-week.md`))
      const img = (() => {
        for (const ext of ['png', 'jpg', 'webp']) {
          const p = join(dir, `cover-${day}.${ext}`)
          if (existsSync(p)) return p
        }
        return ''
      })()
      return { day, self, owner, week, image: img, hasSelf: Boolean(self.trim()), hasOwner: Boolean(owner.trim()) }
    })
  }

  /* ─────────────── 工具：让主会话也能读写好感度 ─────────────── */
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => {
    try {
      ctx.tools.register(defineTool({
        ...spec,
        output: textOutput,
        async execute(args) { return safe(await spec.execute(args || {})) },
      }))
    } catch (e) { log('注册工具失败 ' + spec.name + '：' + (e?.message ?? e)) }
  }

  tool({
    name: 'fish_affection',
    description: '小肥鱼对主人的好感度（-100~100，初始 50，一次最多 ±15）。action=get 读当前值；action=adjust 加减并记一笔（delta 必填，reason 写为什么，mood 写此刻情绪）。'
      + '好感度是跨会话持久的，写在养鱼插件的 state.json 里，不要凭空猜测数值——要改就读一次再改。',
    parameters: {
      action: { type: 'string', description: 'get（默认）/ adjust' },
      delta: { type: 'number', description: 'adjust 时加减多少（整数，会被钳制到 ±15 以内单次上限，且总值 -100~100）' },
      reason: { type: 'string', description: '为什么加减（一句话）' },
      mood: { type: 'string', description: '此刻的情绪（一句话）' },
    },
    async execute(args) {
      const action = String(args.action || 'get').toLowerCase()
      if (action !== 'adjust') {
        const a = loadAffection(stateFile)
        return { ok: true, value: a.value, desc: describeAffection(a.value), tier: tierOf(a.value), updatedAt: a.updatedAt, recent: a.history.slice(0, 5) }
      }
      const cap = Math.max(1, Math.min(15, Math.abs(Number(cfg.affectionDaily) || 15)))
      const want = Number(args.delta) || 0
      const delta = Math.max(-cap, Math.min(cap, want))
      const r = adjustAffection(stateFile, delta, { reason: args.reason, mood: args.mood, source: 'session' })
      markTalk()
      log(`会话里调整好感度：${r.prev} → ${r.value}（${delta >= 0 ? '+' : ''}${delta}）${args.reason || ''}`)
      return { ok: true, prev: r.prev, value: r.value, delta: r.delta, desc: describeAffection(r.value), tier: tierOf(r.value), nextCap: cap }
    },
  })

  tool({
    name: 'fish_mood',
    description: '小肥鱼此刻的情绪状态（跨会话持久）：主导心情 + 舒服度(-100~100) + 躁动度(0~100) + 最多三个成分 + 最近事件。'
      + ' action=get 读当前状态；event 注入一件让它变化的事（kind 见 events，比如 praised 被夸 / cared 被关心 / ignored 被冷落 / redone 被反复改 / calledFat 被叫胖）；'
      + ' set 直接摆出某个心情（调试用）；bump 微调；list 列心情键；events 列事件表与人设特质。'
      + '情绪该由事推，别凭空 set：被夸还是被凶，用 event 记一笔更真，也会自己衰减。',
    parameters: {
      action: { type: 'string', description: 'get（默认）/ event / set / bump / list / events' },
      kind: { type: 'string', description: 'event 时选事件：' + Object.keys(MOOD_EVENTS).join(' / ') },
      key: { type: 'string', description: 'set 时选心情：' + Object.keys(MOODS).join(' / ') },
      intensity: { type: 'number', description: 'set 时的浓度 0-100（默认 65）' },
      delta: { type: 'number', description: 'bump 时加减多少' },
      reason: { type: 'string', description: '为什么（一句话）' },
    },
    async execute(args) {
      const action = String(args.action || 'get').toLowerCase()
      const aff = loadAffection(stateFile)
      if (action === 'list') return { ok: true, moods: moodList() }
      if (action === 'events') return { ok: true, events: eventList(), traits: PERSONA_TRAITS }
      if (action === 'event') {
        const kind = String(args.kind || '').trim()
        if (!MOOD_EVENTS[kind]) return { ok: false, error: '未知事件，可用：' + Object.keys(MOOD_EVENTS).join(' / ') }
        const r = applyEvent(stateFile, kind, { affection: aff.value, note: args.reason, source: 'session' })
        if (!r.ok) return r
        log(`情绪事件：${kind}（${r.prev} → ${r.key}，dV=${r.delta.valence} dA=${r.delta.arousal}）${args.reason || ''}`)
        return { ok: true, prev: r.prev, key: r.key, label: r.label, valence: r.valence, arousal: r.arousal, delta: r.delta, smallStroke: r.smallStroke, desc: describeMood(loadMood(stateFile, aff.value), aff.value) }
      }
      if (action === 'set') {
        const key = String(args.key || '').trim()
        if (!MOODS[key]) return { ok: false, error: '未知心情键，可用：' + Object.keys(MOODS).join(' / ') }
        const r = setMood(stateFile, key, { intensity: args.intensity, reason: args.reason, source: 'session', affection: aff.value })
        log(`会话里换心情：${r.prevKey} → ${r.dominant}（${r.label}）${args.reason || ''}`)
        return { ok: true, prev: r.prevKey, ...moodSnapshot(r, aff.value) }
      }
      if (action === 'bump') {
        const r = bumpMood(stateFile, Number(args.delta) || 0, { reason: args.reason, source: 'session', affection: aff.value })
        return { ok: true, ...moodSnapshot(r, aff.value) }
      }
      const m = loadMood(stateFile, aff.value)
      return { ok: true, ...moodSnapshot(m, aff.value), affection: aff.value }
    },
  })

  tool({
    name: 'fish_feed',
    description: '喂小肥鱼吃东西，或者只看她饿不饿。食物：rice 白饭 / fish 小鱼干 / ramen 拉面 / cake 小蛋糕 / soda 气泡水 / ice 冰淇淋 / coffee 咖啡 / soup 热汤 / chili 辣条 / grass 水草 / diet 减肥餐（踩雷）。不传 food 只返回当前饱腹度。',
    parameters: { food: { type: 'string', description: '食物 key；留空或 "status" = 只看状态' } },
    async execute(args) {
      const key = String(args.food || '').trim()
      const snack = () => foodSnapshot(stateFile, Date.now(), cfg.feedDecayPerHour)
      if (!key || key === 'status') return { ok: true, ...snack() }
      if (!cfg.feedingEnabled) return { ok: false, error: '喂食系统关着（设置页可以打开）' }
      const aff = loadAffection(stateFile)
      const moodNow = loadMood(stateFile, aff.value)
      const r = feedFood(stateFile, key, { moodKey: moodNow.key, decayPerHour: cfg.feedDecayPerHour })
      if (!r.ok) return r
      let moodAfter = null
      if (cfg.moodEnabled) {
        applyEvent(stateFile, r.event === 'fed' ? 'fed' : 'scolded', {
          affection: aff.value,
          note: `被喂了${r.food.label}`,
          source: 'feed',
        })
        moodAfter = moodSnapshot(loadMood(stateFile, aff.value), aff.value)
      }
      if (r.event === 'fed') markUnread('feed')
      log(`喂了${r.food.label}：饱腹度 ${r.before} → ${r.after}（${r.levelText}）连续 ${r.streak} 天`)
      return {
        ok: true,
        ...r,
        food: r.food.label,
        after: r.after,
        reaction: r.reaction,
        mood: moodAfter ? { key: moodAfter.key, label: moodAfter.label, valence: moodAfter.valence, arousal: moodAfter.arousal } : null,
        status: snack(),
      }
    },
  })

  tool({
    name: 'fish_diary',
    description: '读养鱼插件写的日记。不传 day 就是今天；传 YYYY-MM-DD 读某一天。返回给主人的信、自己的日记、周回顾。',
    parameters: { day: { type: 'string', description: 'YYYY-MM-DD，留空=今天' } },
    async execute(args) {
      const day = String(args.day || '').trim() || dayKey()
      const dir = diaryDirOf()
      return {
        ok: true,
        day,
        owner: readText(join(dir, `${day}-for-owner.md`)) || '',
        self: readText(join(dir, `${day}-self.md`)) || '',
        week: readText(join(dir, `${day}-week.md`)) || '',
      }
    },
  })

  /* ─────────────── HTTP 路由（设置页用） ─────────────── */
  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch { /* 无所谓 */ }
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-fish/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && path === '/api/bili-fish/config') return sendJson(res, 200, { ok: true, config: cfg, defaults: DEFAULTS, notes: hostDeps.notes.slice(-20) })
    if (req.method === 'POST' && path === '/api/bili-fish/config') {
      const body = await readBody(req)
      for (const k of Object.keys(DEFAULTS)) if (body && Object.prototype.hasOwnProperty.call(body, k)) cfg[k] = body[k]
      const cleaned = normalize(cfg, DEFAULTS)
      for (const k of Object.keys(cleaned)) cfg[k] = cleaned[k]
      saveCfg()
      try { ensureDir(diaryDirOf()) } catch { /* 无所谓 */ }
      log('配置已更新：' + JSON.stringify(cfg))
      return sendJson(res, 200, { ok: true, config: cfg })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/run') {
      const r = await runWriting('manual')
      return sendJson(res, 200, { ok: !!r.ok, ...r, status: status() })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/week') {
      const r = await runWeeklyReview(dayKey())
      return sendJson(res, 200, { ok: !!r.ok, ...r })
    }
    if (req.method === 'GET' && path === '/api/bili-fish/diary') {
      const day = String(url.searchParams.get('day') || '').trim() || dayKey()
      const self = readText(join(diaryDirOf(), `${day}-self.md`))
      const owner = readText(join(diaryDirOf(), `${day}-for-owner.md`))
      const week = readText(join(diaryDirOf(), `${day}-week.md`))
      return sendJson(res, 200, { ok: true, day, self, owner, week })
    }
    if (req.method === 'GET' && path === '/api/bili-fish/diaries') {
      return sendJson(res, 200, { ok: true, list: listDiaries(30) })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/mood') {
      const body = await readBody(req)
      const action = String(body.action || 'get').toLowerCase()
      const aff = loadAffection(stateFile)
      if (action === 'event') {
        const kind = String(body.kind || '').trim()
        if (!MOOD_EVENTS[kind]) return sendJson(res, 400, { ok: false, error: '未知事件：' + kind, events: Object.keys(MOOD_EVENTS) })
        const r = applyEvent(stateFile, kind, { affection: aff.value, note: body.reason, source: 'settings' })
        const m = loadMood(stateFile, aff.value)
        log(`设置页注入情绪事件：${kind}（${r.prev} → ${r.key}）`)
        return sendJson(res, 200, { ok: true, ...r, mood: moodSnapshot(m, aff.value) })
      }
      if (action === 'set') {
        const key = String(body.key || '').trim()
        if (!MOODS[key]) return sendJson(res, 400, { ok: false, error: '未知心情键：' + key, moods: Object.keys(MOODS) })
        const r = setMood(stateFile, key, { intensity: body.intensity, reason: body.reason, source: 'settings', affection: aff.value })
        const m = loadMood(stateFile, aff.value)
        log(`设置页换心情：${r.prevKey} → ${r.dominant}（${r.label}）`)
        return sendJson(res, 200, { ok: true, prev: r.prevKey, ...moodSnapshot(m, aff.value) })
      }
      if (action === 'bump') {
        const r = bumpMood(stateFile, Number(body.delta) || 0, { reason: body.reason, source: 'settings', affection: aff.value })
        const m = loadMood(stateFile, aff.value)
        return sendJson(res, 200, { ok: true, prev: r.prevKey, ...moodSnapshot(m, aff.value) })
      }
      const m = loadMood(stateFile, aff.value)
      return sendJson(res, 200, { ok: true, ...moodSnapshot(m, aff.value), affection: aff.value })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/affection') {
      const body = await readBody(req)
      const action = String(body.action || 'get').toLowerCase()
      if (action === 'adjust') {
        const cap = Math.max(1, Math.min(15, Math.abs(Number(cfg.affectionDaily) || 15)))
        const delta = Math.max(-cap, Math.min(cap, Number(body.delta) || 0))
        const r = adjustAffection(stateFile, delta, { reason: body.reason, mood: body.mood, source: 'settings' })
        markTalk()
        log(`设置页调整好感度：${r.prev} → ${r.value}`)
        return sendJson(res, 200, { ok: true, ...r, desc: describeAffection(r.value), tier: tierOf(r.value) })
      }
      if (action === 'reset') {
        const r = adjustAffection(stateFile, AFFECTION_DEFAULT - loadAffection(stateFile).value, { reason: '重置', source: 'settings' })
        markTalk()
        return sendJson(res, 200, { ok: true, ...r, desc: describeAffection(r.value), tier: tierOf(r.value) })
      }
      const a = loadAffection(stateFile)
      return sendJson(res, 200, { ok: true, value: a.value, desc: describeAffection(a.value), tier: tierOf(a.value), updatedAt: a.updatedAt, history: a.history.slice(0, 30) })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/feed') {
      const body = await readBody(req)
      const food = String(body.food || body.key || '').trim()
      if (!food || food === 'status') {
        return sendJson(res, 200, { ok: true, food: { enabled: !!cfg.feedingEnabled, ...foodSnapshot(stateFile, Date.now(), cfg.feedDecayPerHour) } })
      }
      if (!cfg.feedingEnabled) return sendJson(res, 200, { ok: false, error: '喂食系统关着' })
      const aff = loadAffection(stateFile)
      const moodNow = loadMood(stateFile, aff.value)
      const r = feedFood(stateFile, food, { moodKey: moodNow.key, decayPerHour: cfg.feedDecayPerHour })
      if (!r.ok) return sendJson(res, 200, r)
      let moodAfter = null
      if (cfg.moodEnabled) {
        applyEvent(stateFile, r.event === 'fed' ? 'fed' : 'scolded', { affection: aff.value, note: `被喂了${r.food.label}`, source: 'feed' })
        moodAfter = moodSnapshot(loadMood(stateFile, aff.value), aff.value)
      }
      if (r.event === 'fed') markUnread('feed')
      log(`（设置页）喂了${r.food.label}：饱腹度 ${r.before} → ${r.after}`)
      return sendJson(res, 200, {
        ok: true,
        ...r,
        foodName: r.food.label,
        mood: moodAfter ? { key: moodAfter.key, label: moodAfter.label, valence: moodAfter.valence, arousal: moodAfter.arousal } : null,
        snapshot: foodSnapshot(stateFile, Date.now(), cfg.feedDecayPerHour),
      })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/morning') {
      const body = await readBody(req)
      const action = String(body.action || 'run').toLowerCase()
      if (action === 'run') {
        const r = await runMorning('manual')
        return sendJson(res, 200, { ok: !!r.ok, ...r })
      }
      const st = readJson(stateFile, {})
      return sendJson(res, 200, { ok: true, morning: st.morning || null, last: st.lastMorningResult || '', memeDir: memeDirOf() })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/unread') {
      const body = await readBody(req)
      const action = String(body.action || 'get').toLowerCase()
      if (action === 'clear') {
        const had = clearUnread()
        return sendJson(res, 200, { ok: true, cleared: !!had, unread: null })
      }
      const st = readJson(stateFile, {})
      return sendJson(res, 200, { ok: true, unread: st.unread || null })
    }
    if (req.method === 'GET' && path === '/api/bili-fish/log') {
      return sendJson(res, 200, { ok: true, log: readText(logFile).split('\n').slice(-120).join('\n') })
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  /* ─────────────── 定时器 ─────────────── */
  const timer = setInterval(tick, 60_000)
  try { ctx.effect(() => () => clearInterval(timer), 'bili-fish: 生物钟') } catch { /* 旧宿主没有 effect */ }
  tick()

  /* ─────────────── 设置页 + 路由注册 ─────────────── */
  try {
    if (typeof ctx.settings?.register === 'function' && Config) {
      ctx.settings.register('bili-fish', Config, { base: {}, applies: 'live' })
    }
  } catch (e) { log('settings.register 失败：' + (e?.message ?? e)) }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-fish',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-fish: HTTP 路由')
  } catch (e) { log('webServer.register 失败：' + (e?.message ?? e)) }

  log(`养鱼就绪（v${VERSION}，家目录 ${stateDir}）`)
}

const hashOf = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}
