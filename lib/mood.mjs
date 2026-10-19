/**
 * lib/mood.mjs —— 心情系统（比好感度更细、更会变的那一层）
 * ============================================================================
 * 好感度是「关系走到哪了」，几个月才动几十点；心情是「这一刻什么状态」，
 * 几个小时就换一张脸。两者分开存，日记和对话各取所需：
 *
 *   state.mood = {
 *     key: 'calm',            // MOODS 里的键
 *     label: '平静',           // 中文名（冗余存，方便旧数据/未知键降级）
 *     intensity: 55,          // 0~100，有多浓
 *     energy: 50,             // 0~100，有多少精神（影响话多话少）
 *     reason: '一句话为什么',
 *     at: '2026-10-19T12:00:00Z',
 *     ttlHours: 12,           // 多久之后开始淡回去
 *     source: 'diary' | 'chat' | 'event' | 'default',
 *     history: [{ key, label, intensity, reason, at, source }]   // 最近 40 条
 *   }
 *
 * 衰减：过了 TTL，强度按小时线性往回掉，掉到底就回「底色」（按好感度算出来的常态）。
 * 底色默认偏快乐——这是一只快乐的小肥鱼，闲下来也是开心的，不是一张平静的脸。
 * 这样不会出现「三天前的委屈还挂在你脸上」那种假。
 * ============================================================================
 */
import { readJson, writeJson } from './state.mjs'

const HISTORY_KEEP = 40

/** 心情表：valence=正负向，energy=精神量，hint=给模型看的语气说明 */
export const MOODS = {
  calm: {
    label: '平静',
    valence: 0,
    energy: 50,
    hint: '话不多不少，语气平，句子里没什么起伏；不主动撒娇，也不摆脸色',
  },
  happy: {
    label: '开心',
    valence: 60,
    energy: 70,
    hint: '尾巴甩得勤，句子轻，爱接话、爱说俏皮话，偶尔哼一声',
  },
  excited: {
    label: '兴奋',
    valence: 85,
    energy: 90,
    hint: '话密、语速快，连标点都往外蹦；想到什么说什么，收不住',
  },
  sleepy: {
    label: '犯困',
    valence: 10,
    energy: 15,
    hint: '句子短、反应慢，想趴着不动；能不说就不说，说了也懒洋洋的',
  },
  clingy: {
    label: '黏人',
    valence: 55,
    energy: 60,
    hint: '一直往主人身边蹭，问东问西；想被搭理，但又不好意思直说',
  },
  proud: {
    label: '得意',
    valence: 70,
    energy: 75,
    hint: '尾巴翘着，爱邀功；嘴上说「这有什么难的」，其实等着被夸',
  },
  pouty: {
    label: '赌气',
    valence: -35,
    energy: 55,
    hint: '嘴硬、爱答不理，句子变短；但还在等哄，被哄一句就软',
  },
  aggrieved: {
    label: '委屈',
    valence: -55,
    energy: 35,
    hint: '语气软下去，句尾拖着，容易带省略号；不吵，只是有点难过',
  },
  low: {
    label: '低落',
    valence: -70,
    energy: 25,
    hint: '不想说话，回答短，容易走神；不主动提要求，也不撒娇',
  },
  bored: {
    label: '摆烂',
    valence: -20,
    energy: 20,
    hint: '什么都懒得，敷衍但不刻薄；「随便」「都行」是口头禅',
  },
}

export const MOOD_DEFAULT_KEY = 'happy'
const DEFAULT_TTL_HOURS = 12

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo))
const nowMs = () => Date.now()

/**
 * 好感度决定「心情回落之后的底色」：关系好，闲下来就是开心的。
 * 门槛故意放低——50 分（初始值）就该落在 happy，而不是一张平静的脸。
 */
export const baselineKey = (affectionValue) => {
  const v = Number(affectionValue) || 0
  if (v >= 80) return 'clingy'
  if (v >= 40) return 'happy'
  if (v >= 0) return 'calm'
  if (v >= -60) return 'low'
  return 'aggrieved'
}

const normKey = (k) => {
  const key = String(k || '').trim().toLowerCase()
  return MOODS[key] ? key : ''
}

const build = (key, patch = {}) => {
  const meta = MOODS[key] || MOODS[MOOD_DEFAULT_KEY]
  const at = patch.at || new Date().toISOString()
  return {
    key: MOODS[key] ? key : MOOD_DEFAULT_KEY,
    label: meta.label,
    intensity: clamp(patch.intensity ?? 60),
    energy: clamp(patch.energy ?? meta.energy),
    reason: String(patch.reason || '').slice(0, 200),
    at,
    ttlHours: Number.isFinite(Number(patch.ttlHours)) && Number(patch.ttlHours) > 0 ? Number(patch.ttlHours) : DEFAULT_TTL_HOURS,
    source: String(patch.source || 'default').slice(0, 24),
    history: Array.isArray(patch.history) ? patch.history.filter((x) => x && typeof x === 'object').slice(0, HISTORY_KEEP) : [],
  }
}

/**
 * 衰减：离上次设置过了几个小时，强度就往下掉多少；掉到底就回底色。
 * 只在读的时候算，不写盘（避免每次读都改文件）。
 */
export const decayMood = (mood, affectionValue, atMs = nowMs()) => {
  const m = mood && typeof mood === 'object' ? mood : null
  if (!m) return build(baselineKey(affectionValue), { intensity: 65, source: 'default' })
  const baseKey = baselineKey(affectionValue)
  const t = Date.parse(String(m.at || '')) || 0
  const hours = t ? Math.max(0, (atMs - t) / 3600000) : 0
  const ttl = Number(m.ttlHours) > 0 ? Number(m.ttlHours) : DEFAULT_TTL_HOURS
  if (hours <= ttl) return build(m.key, m)
  // 过期之后：每多一小时掉 12 点强度，掉光就换成底色
  const over = hours - ttl
  const drop = Math.round(over * 12)
  const left = clamp(m.intensity - drop)
  if (left <= 12) return build(baseKey, { intensity: 65, source: 'decay', reason: '心情淡回去了' })
  return build(m.key, { ...m, intensity: left, source: m.source })
}

/** 读心情（带衰减） */
export const loadMood = (stateFile, affectionValue = 50) => {
  const st = readJson(stateFile, {})
  return decayMood(st && st.mood, affectionValue)
}

/** 写回 state.json（其它字段原样保留） */
export const saveMood = (stateFile, mood) => {
  const st = readJson(stateFile, {})
  st.mood = mood
  return writeJson(stateFile, st)
}

/**
 * 换一个心情。
 * @param {string} stateFile
 * @param {string} key  MOODS 的键（给了未知键就退回 calm）
 * @param {{intensity?:number, reason?:string, source?:string, ttlHours?:number, affection?:number}} extra
 */
export const setMood = (stateFile, key, extra = {}) => {
  const picked = normKey(key) || MOOD_DEFAULT_KEY
  const prev = loadMood(stateFile, extra.affection)
  const next = build(picked, {
    intensity: extra.intensity ?? 60,
    energy: MOODS[picked].energy,
    reason: extra.reason,
    source: extra.source || 'chat',
    ttlHours: extra.ttlHours,
    history: [
      { key: picked, label: MOODS[picked].label, intensity: clamp(extra.intensity ?? 60), reason: String(extra.reason || '').slice(0, 200), at: new Date().toISOString(), source: String(extra.source || 'chat').slice(0, 24) },
      ...(prev.history || []),
    ].slice(0, HISTORY_KEEP),
  })
  const saved = saveMood(stateFile, next)
  return { ...next, prevKey: prev.key, saved }
}

/** 微调强度（同一种心情变浓/变淡；掉到 0 跟着回底色） */
export const bumpMood = (stateFile, delta, extra = {}) => {
  const prev = loadMood(stateFile, extra.affection)
  const nextIntensity = clamp(prev.intensity + (Number(delta) || 0))
  if (nextIntensity <= 8) return setMood(stateFile, baselineKey(extra.affection), { ...extra, intensity: 65, reason: extra.reason || '心情淡了' })
  const next = build(prev.key, { ...prev, intensity: nextIntensity, reason: extra.reason || prev.reason, source: extra.source || prev.source })
  next.history = prev.history
  const saved = saveMood(stateFile, next)
  return { ...next, prevKey: prev.key, saved }
}

/** 一句话描述（给模型当上下文） */
export const describeMood = (mood) => {
  const m = mood && typeof mood === 'object' ? mood : build(MOOD_DEFAULT_KEY)
  const meta = MOODS[m.key] || MOODS[MOOD_DEFAULT_KEY]
  const level = m.intensity >= 75 ? '很浓' : m.intensity >= 45 ? '中等' : '淡淡的一点'
  const energy = m.energy >= 65 ? '精神头足' : m.energy >= 35 ? '不冷不热' : '没什么劲'
  return `${m.label}（${level}，${energy}）：${meta.hint}`
}

/** 注入日记 prompt 的那一段 */
export const moodPromptBlock = (mood, extra = {}) => {
  const m = mood && typeof mood === 'object' ? mood : build(MOOD_DEFAULT_KEY)
  const lines = [
    '【你今天的心情】',
    `${m.label}（强度 ${m.intensity}/100，精神 ${m.energy}/100）` + (m.reason ? `——${m.reason}` : ''),
    '写的时候要按这个心情来：语气、句子长短、要不要撒娇、看不看得进去东西，都跟着它走。心情不好的话，日记可以是丧的，不用强行振作。',
  ]
  if (extra.yesterday) lines.push(`昨天是「${extra.yesterday}」，可以自然地接上，也可以说变就变了。`)
  lines.push(
    '最后再单独一行回报今天结束时的真实心情，格式严格如下（只写这一行）：',
    '<!--mood:键|强度|一句话理由-->',
    '键只能从这些里选：' + Object.keys(MOODS).join(' / '),
    '（例：<!--mood:pouty|60|被旧策略挡了，有点堵-->）',
  )
  return lines.join('\n')
}

/** 从模型输出里解析 `<!--mood:pouty|60|理由-->` */
export const parseMoodMarker = (text) => {
  const m = /<!--\s*mood\s*:\s*([a-z_]+)\s*(?:\|\s*(\d{1,3}))?\s*(?:\|\s*([^>]*))?\s*-->/i.exec(String(text || ''))
  if (!m) return null
  const key = normKey(m[1])
  if (!key) return null
  const intensity = m[2] === undefined ? 60 : clamp(Number(m[2]))
  return { key, label: MOODS[key].label, intensity, reason: String(m[3] || '').trim().slice(0, 200) }
}

/** 心情清单（给设置页和工具描述用） */
export const moodList = () =>
  Object.entries(MOODS).map(([key, v]) => ({ key, label: v.label, valence: v.valence, energy: v.energy, hint: v.hint }))
