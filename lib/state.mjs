/**
 * lib/state.mjs —— 养鱼的落盘小工具（从 dsh-bili-scroll 的 lib/state.mjs 精简而来）
 * ============================================================================
 * 只管三件事：插件家在哪儿、JSON 读写、日期换算。
 * ============================================================================
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** 插件家目录：`<DSH_HOME>/bili-fish`（`ctx.get('dshHomePath')` 可能给函数也可能给字符串） */
export const stateDirOf = (ctx) => {
  let home = ''
  try {
    const p = ctx?.get ? ctx.get('dshHomePath') : null
    if (typeof p === 'function') home = p('bili-fish')
    else if (p) home = join(String(p), 'bili-fish')
  } catch { /* 没有就兜底 */ }
  if (!home) home = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-fish')
  ensureDir(home)
  return home
}

export const ensureDir = (d) => { try { mkdirSync(d, { recursive: true }) } catch { /* 无所谓 */ } }

export const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export const writeJson = (file, value) => {
  try {
    ensureDir(dirname(file))
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch { return false }
}

/** 本地日期键 YYYY-MM-DD */
export const dayKey = (d = new Date()) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天的 [开始, 结束] 毫秒时间戳（窗口跨零点就自动顺延到明天） */
export const windowTimes = (startHM, endHM, now = new Date()) => {
  const parse = (s, dflt) => {
    const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(s || '').trim())
    return m ? { h: Math.min(23, Math.max(0, +m[1])), m: Math.min(59, Math.max(0, +m[2])) } : dflt
  }
  const s = parse(startHM, { h: 21, m: 0 })
  const e = parse(endHM, { h: 23, m: 30 })
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s.h, s.m, 0, 0)
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate(), e.h, e.m, 0, 0)
  if (b.getTime() <= a.getTime()) b.setDate(b.getDate() + 1)
  return { start: a.getTime(), end: b.getTime() }
}

/** 读文件（失败给空串） */
export const readText = (file) => { try { return readFileSync(file, 'utf8') } catch { return '' } }

/** 文件存在且非空 */
export const hasContent = (file) => { try { return existsSync(file) && readFileSync(file, 'utf8').trim().length > 0 } catch { return false } }
