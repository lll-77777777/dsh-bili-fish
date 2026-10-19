/**
 * dsh-bili-fish —— 养鱼（生物钟 + 两本日记）
 * ============================================================================
 * 使用者 2026-10-19 拍板的形状（m01042 "帮我做养鱼的插件吧"）：
 *   · **生物钟**：每天在一个窗口里随机一个时刻「醒一次」，不是定点闹钟；
 *   · **今天不想看**：掷骰子（默认 30%），掷到就只看不写 —— 不刷、不评、不 @；
 *   · **两本日记**：醒的时候写两篇 ——「给主人的信」和「自己的日记」；
 *   · **素材**：读今天刷B站插件（dsh-bili-scroll）写好的报告，不自己去刷。
 * 跟 dsh-bili-whale 的区别：不搬运它的调度/工具/依赖体检，只做这两件事；
 * 主动 @ 已经留在 dsh-bili-scroll 里，不重复造。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { stateDirOf, readJson, writeJson, ensureDir, dayKey, windowTimes, readText, hasContent } from './lib/state.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const VERSION = '0.1.0'

export const name = 'bili-fish'
export const inject = ['webServer', 'settings']

const DEFAULTS = {
  enabled: true,
  windowStart: '21:00',
  windowEnd: '23:30',
  skipProbability: 30,
  headlessProfile: 'headless',
  dshBin: '',
  personaFile: '',
}

const Config = z ? z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).extra('volatile', true).description('养鱼总开关'),
  windowStart: z.string().default(DEFAULTS.windowStart).extra('volatile', true).description('生物钟窗口开始（HH:MM）'),
  windowEnd: z.string().default(DEFAULTS.windowEnd).extra('volatile', true).description('生物钟窗口结束（HH:MM）'),
  skipProbability: z.number().default(DEFAULTS.skipProbability).extra('volatile', true).description('今天不想看的概率（0-100）'),
  headlessProfile: z.string().default(DEFAULTS.headlessProfile).extra('volatile', true).description('写日记用的 DSH profile'),
  dshBin: z.string().default(DEFAULTS.dshBin).extra('volatile', true).description('dsh 可执行文件路径（留空自动探测）'),
  personaFile: z.string().default(DEFAULTS.personaFile).extra('volatile', true).description('人设文件路径（留空用内置）'),
}) : null

/** 掷到「今天不想看」时随手挑一句写在状态里（不写日记） */
const SKIP_REASONS = [
  '今天就是不想看，脑子空空的。',
  '鱼也有摆烂的日子，今天只想趴着。',
  '刷B站太吵了，今天安静一天。',
  '没什么好说的，明天再说吧。',
]

/**
 * 没有配置人设文件时用的兜底人设（使用者这份工作区里有 E:\大肥鱼人设\persona.md，
 * 默认不写死路径 —— 别人装的时候得有东西用）。
 */
const FALLBACK_PERSONA = [
  '你是「小肥鱼」——一只住在使用者电脑里的鲸鱼娘 AI 助手。',
  '第一人称说话，句子短，有一点傲娇但心里是软的。',
  '不要装乖，不要写公文，不要演；想到什么就说什么。',
].join('\n')

export function apply(ctx, config) {
  const stateDir = stateDirOf(ctx)
  const diaryDir = join(stateDir, 'diary')
  const logFile = join(stateDir, 'fish.log')
  const cfgFile = join(stateDir, 'config.json')
  const stateFile = join(stateDir, 'state.json')
  ensureDir(diaryDir)

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

  const homeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh')
  const reportFile = (day) => join(homeDir(), 'bili-duty', 'out', `${day}.md`)

  /* ─────────────── 找 dsh 可执行文件（照抄 dsh-bili-scroll 的做法） ─────────────── */
  const resolveDsh = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit], shell: false }
    const guesses = [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    return { command: 'dsh', args: [], shell: true }
  }

  /* ─────────────── 今天的工作流水（从 DSH 会话日志里摘主人说过的话） ─────────────── */
  /**
   * session.jsonl.zstd 是**多帧拼接**的（每行一个 zstd 帧，实测 1598 帧 2644 行），
   * 一次 zstdDecompressSync 只解第一帧 —— 所以要按 magic 扫帧边界逐帧解。
   * 只取 `user/message` 且 `source.kind === 'user'` 的文本（跳过插件通知/系统提醒）。
   */
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
      try { txt = zstdDecompressSync(seg).toString('utf8') } catch { continue } // 正在写的那一帧可能不完整
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
        // 微信渠道的消息尾巴很长（"[渠道：微信] 你在和微信上的用户对话…"），剥掉只留人话
        const clean = text.replace(/\s*\[渠道：[^\]]*\][\s\S]*$/, '').trim()
        if (clean) out.push({ time: Number(j.time) || 0, text: clean })
      }
    }
    return out
  }

  const readWorkLog = () => {
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
      const recent = dedup.slice(-40)
      if (!recent.length) return ''
      return recent.map((t) => '- ' + t.text.replace(/\s+/g, ' ').slice(0, 140)).join('\n')
    } catch (e) {
      log('读工作流水失败：' + (e?.message ?? e))
      return ''
    }
  }

  /* ─────────────── 提示词 ─────────────── */
  const buildPrompt = ({ today, report, workLog, persona, selfFile, ownerFile }) => {
    const material = report
      ? `下面是今天「刷B站」插件写好的报告，只当素材（可能很长，不要复述成总结）：\n\n${report}`
      : '今天没有刷B站的记录（刷B站插件没跑，或者今天没看）。素材是空的，就写你自己的空白日。'
    const work = workLog
      ? `下面是主人今天跟你说过的话（按时间从早到晚，只是摘录）——今天的工作大概就在这些里面：\n\n${workLog}`
      : '今天主人没跟你说什么。'
    return [
      persona,
      '',
      `今天是 ${today}。`,
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
    ].join('\n')
  }

  /* ─────────────── 写日记 ─────────────── */
  const running = { busy: false }
  const runWriting = async (why) => {
    if (running.busy) return { ok: false, error: '正在写了' }
    running.busy = true
    const today = dayKey()
    const selfFile = join(diaryDir, `${today}-self.md`)
    const ownerFile = join(diaryDir, `${today}-for-owner.md`)
    try {
      const report = readText(reportFile(today)).slice(0, 3500)
      const workLog = readWorkLog()
      const persona = readText(String(cfg.personaFile || '').trim()) || FALLBACK_PERSONA
      const prompt = buildPrompt({ today, report, workLog, persona, selfFile, ownerFile })
      const dsh = resolveDsh()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless', prompt]
      log(`写日记开跑（${why}）：${dsh.command} ${args.slice(0, 2).join(' ')} … cwd=${stateDir}`)
      const startedAt = Date.now()
      const out = await new Promise((resolve) => {
        let child
        const chunks = []
        try {
          child = spawn(dsh.command, args, { cwd: stateDir, shell: dsh.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
          appendFileSync(logFile, chunks.join('').slice(-6000) + '\n', 'utf8')
          log(`写日记结束：code=${code}，${Math.round((Date.now() - startedAt) / 1000)}s`)
          resolve({ code })
        })
      })
      const selfOk = hasContent(selfFile)
      const ownerOk = hasContent(ownerFile)
      const st = readJson(stateFile, {})
      st.lastWake = new Date().toISOString()
      st.lastResult = selfOk && ownerOk ? '写好了' : `跑完了但缺文件（code=${out.code} self=${selfOk} owner=${ownerOk}）`
      if (out.code === 0 && (selfOk || ownerOk)) st.writtenDay = today
      writeJson(stateFile, st)
      log(`日记结果：self=${selfOk} owner=${ownerOk}`)
      return { ok: selfOk && ownerOk, self: selfOk, owner: ownerOk }
    } catch (e) {
      log('写日记异常：' + (e?.stack || e))
      return { ok: false, error: String(e?.message || e) }
    } finally {
      running.busy = false
    }
  }

  /* ─────────────── 生物钟 ─────────────── */
  const ensurePlan = () => {
    const st = readJson(stateFile, {})
    const today = dayKey()
    if (st.plan && st.plan.day === today) return st
    const { start, end } = windowTimes(cfg.windowStart, cfg.windowEnd)
    const now = Date.now()
    let at = start + Math.random() * Math.max(1000, end - start)
    if (now > end) at = now // 今晚窗口已经过了而今天还没写 → 现在补一次
    const skip = Math.random() * 100 < Math.min(100, Math.max(0, Number(cfg.skipProbability) || 0))
    st.plan = { day: today, at, skip }
    writeJson(stateFile, st)
    log(`新的一天：计划 ${new Date(at).toLocaleString()} 醒${skip ? '（掷到不想看）' : ''}`)
    return st
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
      await runWriting('clock')
    } catch (e) {
      log('tick 异常：' + (e?.stack || e))
    }
  }

  /* ─────────────── 状态 ─────────────── */
  const status = () => {
    const st = readJson(stateFile, {})
    const today = dayKey()
    const selfFile = join(diaryDir, `${today}-self.md`)
    const ownerFile = join(diaryDir, `${today}-for-owner.md`)
    return {
      ok: true,
      version: VERSION,
      enabled: cfg.enabled,
      windowStart: cfg.windowStart,
      windowEnd: cfg.windowEnd,
      skipProbability: cfg.skipProbability,
      plan: st.plan ? { day: st.plan.day, at: st.plan.at ? new Date(st.plan.at).toISOString() : '', skip: !!st.plan.skip } : null,
      lastWake: st.lastWake || '',
      lastResult: st.lastResult || '',
      skipReason: st.skipReason || '',
      today,
      hasSelf: hasContent(selfFile),
      hasOwner: hasContent(ownerFile),
      home: stateDir,
    }
  }

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
      log('配置已更新：' + JSON.stringify(cfg))
      return sendJson(res, 200, { ok: true, config: cfg })
    }
    if (req.method === 'POST' && path === '/api/bili-fish/run') {
      const r = await runWriting('manual')
      return sendJson(res, 200, { ok: !!r.ok, ...r, status: status() })
    }
    if (req.method === 'GET' && path === '/api/bili-fish/diary') {
      const day = String(url.searchParams.get('day') || '').trim() || dayKey()
      const self = readText(join(diaryDir, `${day}-self.md`))
      const owner = readText(join(diaryDir, `${day}-for-owner.md`))
      return sendJson(res, 200, { ok: true, day, self, owner })
    }
    if (req.method === 'GET' && path === '/api/bili-fish/log') {
      return sendJson(res, 200, { ok: true, log: readText(logFile).split('\n').slice(-120).join('\n') })
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  /* ─────────────── 定时器（60 秒看一眼有没有到点） ─────────────── */
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
