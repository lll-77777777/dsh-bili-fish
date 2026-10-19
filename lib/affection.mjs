/**
 * lib/affection.mjs —— 好感度持久化（小肥鱼人设第 4 节的那套数值）
 * ============================================================================
 * 之前的问题：好感度只活在模型的上下文里，换个会话就从 50 重新开始。
 * 现在落盘到插件家目录的 state.json：
 *
 *   state.affection = {
 *     value: 50,                         // -100 ~ 100
 *     updatedAt: '2026-10-19T12:00:00Z',
 *     history: [{ day, delta, reason, mood, at, source }]   // 最近 60 条
 *   }
 *
 * 两条写入通道：
 *   ① 会话内实时：插件注册 `fish_affection` 工具，情绪点直接加/减；
 *   ② 每日结算：写日记时让模型在末尾吐一行 `<!--affection:+2|情绪|理由-->`，插件解析后写入。
 * 两条都走同一个 adjustAffection()，钳制在 -100..100，越界只记实际变化量。
 * ============================================================================
 */
import { readJson, writeJson } from './state.mjs'

export const AFFECTION_DEFAULT = 50
export const AFFECTION_MIN = -100
export const AFFECTION_MAX = 100
const HISTORY_KEEP = 60

const clamp = (n) => Math.max(AFFECTION_MIN, Math.min(AFFECTION_MAX, n))
const todayKey = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 读当前好感度（坏了就当默认 50，不让插件起不来） */
export const loadAffection = (stateFile) => {
  const st = readJson(stateFile, {})
  const a = st && typeof st.affection === 'object' ? st.affection : {}
  const raw = Number(a.value)
  const value = Number.isFinite(raw) ? clamp(raw) : AFFECTION_DEFAULT
  return {
    value,
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
    history: Array.isArray(a.history) ? a.history.filter((x) => x && typeof x === 'object').slice(0, HISTORY_KEEP) : [],
  }
}

/** 整个好感度对象写回 state.json（其它字段原样保留） */
export const saveAffection = (stateFile, affection) => {
  const st = readJson(stateFile, {})
  st.affection = affection
  return writeJson(stateFile, st)
}

/**
 * 加减好感度。
 * @param {string} stateFile
 * @param {number} delta  想加/减多少（会按边界截断）
 * @param {{reason?:string, mood?:string, source?:string, day?:string}} extra
 * @returns {{value:number, prev:number, delta:number, mood:string, updatedAt:string}}
 */
export const adjustAffection = (stateFile, delta, extra = {}) => {
  const cur = loadAffection(stateFile)
  const want = Number(delta) || 0
  const next = clamp(cur.value + want)
  const realDelta = next - cur.value
  const at = new Date().toISOString()
  const entry = {
    day: String(extra.day || '').trim() || todayKey(),
    delta: realDelta,
    reason: String(extra.reason || '').trim().slice(0, 300),
    mood: String(extra.mood || '').trim().slice(0, 120),
    at,
    source: String(extra.source || '').slice(0, 40),
  }
  const nextState = {
    value: next,
    updatedAt: at,
    history: [entry, ...cur.history].slice(0, HISTORY_KEEP),
  }
  const saved = saveAffection(stateFile, nextState)
  return { value: next, prev: cur.value, delta: realDelta, mood: entry.mood, updatedAt: at, saved }
}

/** 好感度的口头描述（会话里给模型当上下文用） */
export const describeAffection = (value) => {
  const v = clamp(Number(value) || 0)
  if (v >= 80) return '很高：会主动依赖、说漏心里话，但依旧傲娇'
  if (v >= 60) return '偏高：嘴上不承认，尾巴已经出卖了她'
  if (v >= 40) return '平常：稳定地黏着，偶尔闹小脾气'
  if (v >= 20) return '偏低：话变少，尾巴收着'
  if (v >= 0) return '很低：客气、疏远，不再撒娇'
  return '负数：关系很冷，只回必要的话'
}

/** 从模型输出的日记末尾解析 `<!--affection:+2|情绪|理由-->` */
export const parseAffectionMarker = (text) => {
  const m = /<!--\s*affection\s*:\s*([+-]?\d+(?:\.\d+)?)\s*(?:\|\s*([^|>]*))?(?:\|\s*([^>]*))?\s*-->/i.exec(String(text || ''))
  if (!m) return null
  const delta = Math.round(Number(m[1]))
  if (!Number.isFinite(delta)) return null
  return { delta, mood: String(m[2] || '').trim(), reason: String(m[3] || '').trim() }
}
