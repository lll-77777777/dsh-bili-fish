/**
 * lib/memory.mjs —— 和 meow-memory 的记忆库打交道（读写同一个 SQLite）
 * ============================================================================
 * 为什么直接读写 DB 而不是调工具：日记是 headless 子会话写的，headless profile 里
 * 没有挂 meow-memory 插件，模型手里根本没有 memory_* 工具；写完之后主进程也没有
 * 「替模型记一笔」的通道。所以只能直接对 .dsh-meow/memory.db（Node 24 自带 node:sqlite）。
 *
 * 两个方向：
 *   读 readMemo()  —— 取「主人最近提过的事」，塞进日记 prompt，让日记连贯；
 *   写 writeDiaryMemory() —— 把日记摘要落成一条 fact/topic（source_session 标记来路，
 *                            同一天重复写就 UPDATE，不刷屏）。
 *
 * 安全性：DB 是 WAL 模式的共享文件，写的时候带 busy_timeout + 重试；任何一步失败都
 * 静默降级（记忆是加分项，不能因为它让日记写不出来）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

let sqlite = null
const getSqlite = async () => {
  if (sqlite !== null) return sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    sqlite = false
  }
  return sqlite
}

/** 候选 DB 路径：配置优先，其次工作区 .dsh-meow，再其次用户主目录 */
export const resolveDbPath = (preferred, workspaceDir) => {
  const cands = []
  if (preferred) cands.push(preferred)
  if (workspaceDir) cands.push(path.join(workspaceDir, '.dsh-meow', 'memory.db'))
  cands.push(path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh-meow', 'memory.db'))
  for (const p of cands) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {}
  }
  return ''
}

/** 打开 DB（只读/读写），失败返回 null */
const openDb = async (dbPath, readOnly) => {
  const sql = await getSqlite()
  if (!sql || !dbPath) return null
  try {
    const db = new sql.DatabaseSync(dbPath, readOnly ? { readOnly: true } : { readOnly: false })
    if (!readOnly) db.exec('PRAGMA busy_timeout = 4000')
    return db
  } catch {
    return null
  }
}

const closeQuiet = (db) => {
  try {
    db && db.close()
  } catch {}
}

const TABLE_BY_LEVEL = {
  fact: 'fact',
  lesson: 'lesson',
  topic: 'topic',
  project: 'project',
  rules: 'rules',
  soul: 'soul',
  user: 'user',
}

/**
 * 读「最近主人提过的事」。
 * @param {{dbPath:string, projects?:string[], limit?:number}} opts
 * @returns {string} 一段可以直接塞进 prompt 的文本（空串表示没读到）
 */
export const readMemo = async (opts = {}) => {
  const { dbPath, projects = [], limit = 12 } = opts
  const db = await openDb(dbPath, true)
  if (!db) return ''
  try {
    const rows = []
    // 1) B站养鱼 / 全局的项目记忆（overview/decisions/quotes 最有用）
    if (projects.length) {
      const marks = projects.map(() => '?').join(',')
      for (const lv of ['project', 'topic', 'fact']) {
        const tb = TABLE_BY_LEVEL[lv]
        const sql =
          lv === 'project'
            ? `SELECT 'project' AS lv, content, updated_at FROM project WHERE status='active' AND project IN (${marks}) ORDER BY updated_at DESC LIMIT 8`
            : `SELECT '${lv}' AS lv, content, updated_at FROM ${tb} WHERE status='active' AND project IN (${marks}) ORDER BY updated_at DESC LIMIT 8`
        try {
          for (const r of db.prepare(sql).all(...projects)) rows.push(r)
        } catch {}
      }
    }
    // 2) 近期任何层级的活跃记忆（不限项目，给个「最近在想什么」的底）
    for (const lv of ['fact', 'topic', 'lesson']) {
      try {
        const tb = TABLE_BY_LEVEL[lv]
        for (const r of db.prepare(`SELECT '${lv}' AS lv, content, updated_at FROM ${tb} WHERE status='active' ORDER BY updated_at DESC LIMIT 6`).all()) rows.push(r)
      } catch {}
    }
    if (!rows.length) return ''
    // 去重（同内容只留一次），按 updated_at 倒序，截断长度
    const seen = new Set()
    const picked = []
    rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    for (const r of rows) {
      const c = String(r.content || '').trim().replace(/\s+/g, ' ')
      if (!c || seen.has(c)) continue
      seen.add(c)
      picked.push(`- ${c.slice(0, 160)}`)
      if (picked.length >= limit) break
    }
    return picked.join('\n')
  } catch {
    return ''
  } finally {
    closeQuiet(db)
  }
}

/** 中文/英文关键词粗切（给写入的记忆当检索词，够用即可） */
export const roughKeywords = (text, extra = []) => {
  const s = String(text || '')
  const words = new Set()
  for (const w of s.match(/[A-Za-z][A-Za-z0-9_+-]{2,}/g) || []) words.add(w.toLowerCase())
  // 中文：连续汉字串取 2-gram（限制总量，避免关键词暴涨）
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const run of cjk.slice(0, 40)) {
    for (let i = 0; i + 2 <= run.length && words.size < 40; i += 1) words.add(run.slice(i, i + 2))
  }
  for (const e of extra) if (e) words.add(String(e))
  return [...words].slice(0, 13)
}

const newId = () => {
  const t = Date.now().toString(36)
  const r = Math.random().toString(16).slice(2, 10)
  return `${t}${r}`
}

/**
 * 把一天的日记摘要写进记忆库（幂等：source_session = bili-fish:<day>）。
 * @returns {Promise<{ok:boolean, action?:string, error?:string}>}
 */
export const writeDiaryMemory = async (opts = {}) => {
  const { dbPath, day, title, content, project = 'B站养鱼', importance = 2, level = 'fact' } = opts
  const db = await openDb(dbPath, false)
  if (!db) return { ok: false, error: '记忆库打不开（meow-memory 未安装或路径不对）' }
  const tb = TABLE_BY_LEVEL[level] || 'fact'
  const source = `bili-fish:${day}`
  const body = String(content || '').trim().slice(0, 800)
  if (!body) {
    closeQuiet(db)
    return { ok: false, error: '内容为空' }
  }
  const now = Date.now()
  try {
    const exist = db.prepare(`SELECT id FROM ${tb} WHERE source_session = ? LIMIT 1`).get(source)
    if (exist) {
      db.prepare(`UPDATE ${tb} SET title = ?, content = ?, keywords = ?, importance = ?, updated_at = ? WHERE id = ?`).run(
        String(title || '').slice(0, 80),
        body,
        JSON.stringify(roughKeywords(body, [day, '日记', project])),
        importance,
        now,
        exist.id,
      )
      return { ok: true, action: 'updated', id: exist.id }
    }
    const id = newId()
    db.prepare(
      `INSERT INTO ${tb} (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
    ).run(id, String(title || '').slice(0, 80), body, importance, JSON.stringify(roughKeywords(body, [day, '日记', project])), source, now, now)
    return { ok: true, action: 'inserted', id }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  } finally {
    closeQuiet(db)
  }
}

/** 读一条记忆的完整内容（给设置页/状态展示用） */
export const readMemoBySource = async (dbPath, source) => {
  const db = await openDb(dbPath, true)
  if (!db) return null
  try {
    for (const tb of ['fact', 'topic', 'project', 'lesson']) {
      try {
        const r = db.prepare(`SELECT id, title, content, updated_at FROM ${tb} WHERE source_session = ? LIMIT 1`).get(source)
        if (r) return { ...r, level: tb }
      } catch {}
    }
    return null
  } catch {
    return null
  } finally {
    closeQuiet(db)
  }
}
