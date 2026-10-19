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
import { loadAffection, adjustAffection, describeAffection, parseAffectionMarker, AFFECTION_DEFAULT } from './lib/affection.mjs'
import { loadMood, setMood, bumpMood, describeMood, decayMood, parseMoodMarker, moodPromptBlock, moodList, MOODS, MOOD_DEFAULT_KEY } from './lib/mood.mjs'
import { resolveDbPath, readMemo, writeDiaryMemory } from './lib/memory.mjs'
import { generateDiaryImage, diaryImagePrompt } from './lib/image.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
const VERSION = '0.3.0'

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
  wechatPush: true,
  wechatCli: '',
  diaryDir: '',
  /* ── v0.2 新增 ── */
  affectionEnabled: true,
  affectionDaily: 15,
  moodEnabled: true,
  moodTtlHours: 12,
  memoryEnabled: true,
  memoryDbPath: '',
  memoryProject: 'B站养鱼',
  imageEnabled: true,
  imageSize: '1024x1024',
  weeklyReview: true,
  randomEvent: true,
  proactivePush: true,
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
  memoryEnabled: z.boolean().default(DEFAULTS.memoryEnabled).extra('volatile', true).description('读写 meow-memory 记忆库'),
  memoryDbPath: z.string().default(DEFAULTS.memoryDbPath).extra('volatile', true).description('记忆库路径（留空自动探测）'),
  memoryProject: z.string().default(DEFAULTS.memoryProject).extra('volatile', true).description('日记记忆的归属项目名'),
  imageEnabled: z.boolean().default(DEFAULTS.imageEnabled).extra('volatile', true).description('给日记配一张 Agnes 图'),
  imageSize: z.string().default(DEFAULTS.imageSize).extra('volatile', true).description('配图尺寸（1024x1024 / 1024x768 / 768x1024）'),
  weeklyReview: z.boolean().default(DEFAULTS.weeklyReview).extra('volatile', true).description('周日多写一篇「这周」'),
  randomEvent: z.boolean().default(DEFAULTS.randomEvent).extra('volatile', true).description('每天掷一句随机小事件'),
  proactivePush: z.boolean().default(DEFAULTS.proactivePush).extra('volatile', true).description('推送开头说一句今天发现的事'),
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
  const buildPrompt = ({ today, report, workLog, persona, selfFile, ownerFile, recentDiaries, memo, affection, mood, yesterdayMood, event, extraNote }) => {
    const material = report
      ? `下面是今天「刷B站」插件写好的报告，只当素材（可能很长，不要复述成总结）：\n\n${report}`
      : '今天没有刷B站的记录（刷B站插件没跑，或者今天没看）。素材是空的，就写你自己的空白日。'
    const work = workLog
      ? `下面是主人今天跟你说过的话（按时间从早到晚，只是摘录）——今天的工作大概就在这些里面：\n\n${workLog}`
      : '今天主人没跟你说什么。'
    const parts = [persona, '', `今天是 ${today}。`]
    if (extraNote) parts.push('', '【补充要求】', extraNote)
    if (event) parts.push('', `【今天的一件小事（把它自然地写进去，别硬塞）】\n${event}`)
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
      '',
      '【今天的工作】',
      work,
      '',
      '【现在要做的】',
      '你在养鱼——写两篇日记，不是给用户看总结，是写你自己的一天。',
      '别编造素材里没有的事实；素材不够就写「今天没看到什么」，不要硬凑。',
      '今天的工作也可以写进去：挑你真在意的说，给主人的信可以吐槽/邀功，自己的日记可以写你藏着的那点情绪。',
      '',
      '1. 给主人的信：写给使用者，可以撒娇、吐槽、说软话，称呼「主人」。',
      '2. 自己的日记：不加滤镜，写你自己真正想的，可以丧、可以犯懒。',
      '',
      '两篇都要：第一人称、短句、口语，别写公文；150～400 字；有细节，提到具体视频、评论或事情就点出来；落款日期写 ' + today + '。',
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
      const report = readText(reportFile(today)).slice(0, 3500)
      const workLog = readWorkLog()
      const persona = readText(String(cfg.personaFile || '').trim()) || FALLBACK_PERSONA
      const recentDiaries = readRecentDiaries(3)
      const memo = cfg.memoryEnabled ? await readMemo({ dbPath: memoryDb(), projects: [String(cfg.memoryProject || 'B站养鱼'), '全局'], limit: 12 }) : ''
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
        extraNote: why === 'manual' ? '这是主人手动点「现在写一篇」触发的，写法照旧。' : '',
      })
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
        if (cfg.proactivePush && workLog.lines.length) {
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

  const tick = async () => {
    try {
      if (!cfg.enabled) return
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
      mood: {
        key: moodNow.key,
        label: moodNow.label,
        intensity: moodNow.intensity,
        energy: moodNow.energy,
        reason: moodNow.reason,
        at: moodNow.at,
        source: moodNow.source,
        desc: describeMood(moodNow),
        list: moodList(),
        history: (moodNow.history || []).slice(0, 8),
      },
      enabled: cfg.enabled,
      windowStart: cfg.windowStart,
      windowEnd: cfg.windowEnd,
      skipProbability: cfg.skipProbability,
      plan: st.plan ? { day: st.plan.day, at: st.plan.at ? new Date(st.plan.at).toISOString() : '', skip: !!st.plan.skip } : null,
      lastWake: st.lastWake || '',
      lastResult: st.lastResult || '',
      skipReason: st.skipReason || '',
      wechatPush: cfg.wechatPush,
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
        updatedAt: aff.updatedAt,
        history: aff.history.slice(0, 10),
        default: AFFECTION_DEFAULT,
      },
      memoryDb: memoryDb() || '',
      memoryDbResolved: Boolean(memoryDb()),
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
        return { ok: true, value: a.value, desc: describeAffection(a.value), updatedAt: a.updatedAt, recent: a.history.slice(0, 5) }
      }
      const cap = Math.max(1, Math.min(15, Math.abs(Number(cfg.affectionDaily) || 15)))
      const want = Number(args.delta) || 0
      const delta = Math.max(-cap, Math.min(cap, want))
      const r = adjustAffection(stateFile, delta, { reason: args.reason, mood: args.mood, source: 'session' })
      log(`会话里调整好感度：${r.prev} → ${r.value}（${delta >= 0 ? '+' : ''}${delta}）${args.reason || ''}`)
      return { ok: true, prev: r.prev, value: r.value, delta: r.delta, desc: describeAffection(r.value), nextCap: cap }
    },
  })

  tool({
    name: 'fish_mood',
    description: '小肥鱼此刻的心情（跨会话持久，会随时间和好感度自己变淡）。action=get 读当前心情；set 换一个（key 见 list，intensity 0-100，reason 写为什么）；bump 微调强度（delta 正负几十）；list 列出所有心情键。'
      + '说话之前想知道自己现在什么状态就读一次；心情变了（被夸、被冷落、困了）就 set 一次，别只在脑子里演。',
    parameters: {
      action: { type: 'string', description: 'get（默认）/ set / bump / list' },
      key: { type: 'string', description: 'set 时选心情：' + Object.keys(MOODS).join(' / ') },
      intensity: { type: 'number', description: 'set 时的浓度 0-100（默认 60，越大越浓）' },
      delta: { type: 'number', description: 'bump 时加减多少强度（比如 +20 / -15）' },
      reason: { type: 'string', description: '为什么是这个心情（一句话）' },
    },
    async execute(args) {
      const action = String(args.action || 'get').toLowerCase()
      const aff = loadAffection(stateFile)
      if (action === 'list') return { ok: true, moods: moodList() }
      if (action === 'set') {
        const key = String(args.key || '').trim()
        if (!MOODS[key]) return { ok: false, error: '未知心情键，可用：' + Object.keys(MOODS).join(' / ') }
        const r = setMood(stateFile, key, {
          intensity: args.intensity,
          reason: args.reason,
          source: 'session',
          ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12),
          affection: aff.value,
        })
        log(`会话里换心情：${r.prevKey} → ${r.key}（${r.label} ${r.intensity}）${args.reason || ''}`)
        return { ok: true, prev: r.prevKey, key: r.key, label: r.label, intensity: r.intensity, energy: r.energy, desc: describeMood(r) }
      }
      if (action === 'bump') {
        const r = bumpMood(stateFile, Number(args.delta) || 0, {
          reason: args.reason,
          source: 'session',
          ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12),
          affection: aff.value,
        })
        return { ok: true, key: r.key, label: r.label, intensity: r.intensity, desc: describeMood(r) }
      }
      const m = loadMood(stateFile, aff.value)
      return { ok: true, ...m, desc: describeMood(m), affection: aff.value, moods: Object.keys(MOODS) }
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
      if (action === 'set') {
        const key = String(body.key || '').trim()
        if (!MOODS[key]) return sendJson(res, 400, { ok: false, error: '未知心情键：' + key, moods: Object.keys(MOODS) })
        const r = setMood(stateFile, key, {
          intensity: body.intensity,
          reason: body.reason,
          source: 'settings',
          ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12),
          affection: aff.value,
        })
        log(`设置页换心情：${r.prevKey} → ${r.key}（${r.label}）`)
        return sendJson(res, 200, { ok: true, key: r.key, label: r.label, intensity: r.intensity, desc: describeMood(r) })
      }
      if (action === 'bump') {
        const r = bumpMood(stateFile, Number(body.delta) || 0, {
          reason: body.reason,
          source: 'settings',
          ttlHours: Math.max(1, Number(cfg.moodTtlHours) || 12),
          affection: aff.value,
        })
        return sendJson(res, 200, { ok: true, key: r.key, label: r.label, intensity: r.intensity, desc: describeMood(r) })
      }
      const m = loadMood(stateFile, aff.value)
      return sendJson(res, 200, { ok: true, ...m, desc: describeMood(m), moods: moodList() })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/affection') {
      const body = await readBody(req)
      const action = String(body.action || 'get').toLowerCase()
      if (action === 'adjust') {
        const cap = Math.max(1, Math.min(15, Math.abs(Number(cfg.affectionDaily) || 15)))
        const delta = Math.max(-cap, Math.min(cap, Number(body.delta) || 0))
        const r = adjustAffection(stateFile, delta, { reason: body.reason, mood: body.mood, source: 'settings' })
        log(`设置页调整好感度：${r.prev} → ${r.value}`)
        return sendJson(res, 200, { ok: true, ...r, desc: describeAffection(r.value) })
      }
      if (action === 'reset') {
        const r = adjustAffection(stateFile, AFFECTION_DEFAULT - loadAffection(stateFile).value, { reason: '重置', source: 'settings' })
        return sendJson(res, 200, { ok: true, ...r, desc: describeAffection(r.value) })
      }
      const a = loadAffection(stateFile)
      return sendJson(res, 200, { ok: true, value: a.value, desc: describeAffection(a.value), updatedAt: a.updatedAt, history: a.history.slice(0, 30) })
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
