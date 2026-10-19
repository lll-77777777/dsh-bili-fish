/**
 * lib/mood.mjs —— 心情系统 v2：像人一样地变
 * ============================================================================
 * v1 是「十种标签 + 浓度 + 到点淡回去」，更像换衣服。v2 换成情绪状态：
 *
 *   state.mood = {
 *     dominant: 'happy',        // 表现层：十种键里当前主导的那个
 *     label: '开心',
 *     valence: 15,              // 效价 -100..100（难不难受）
 *     arousal: 48,              // 唤醒 0..100（静不静得下来、有没有劲）
 *     blend: [{key,label,weight}],   // 最多 3 个成分，带权重
 *     baselineValence, baselineArousal,   // 底色（好感度决定）
 *     events: [{kind,label,dV,dA,tag,at,note}],  // 最近 24 个事件
 *     history: [{dominant,label,valence,arousal,reason,at,source}],
 *     reason, at, source
 *   }
 *
 * 四条规则：
 *   1. 事件驱动。心情只由事件改，事件有强度；小事（|dV|<5）只记账不换脸，
 *      累积偏离底色超过 12 才真的换表现。
 *   2. 人设加权。同一件事乘上「我的特质」（黏人/傲娇/懒/爱吃/聪明/软），
 *      强度、倾向、连击都跟着人设走。
 *   3. 关系滤镜。好感度高时负面事件扣得少（最低保留四成），正面事件放大但
 *      高位有刹车；好感度低时反过来。不改事件发生概率——世界不会因为关系好
 *      就不下雨。
 *   4. 向底色回归。不是倒计时清空，是像水往低处流：强的情绪衰得慢，弱的很快
 *      散；关系好恢复得快。
 *
 * 日节律（早上蔫、下午精神、夜里困）不进状态，只在读的时候叠加，避免漂移。
 * ============================================================================
 */
import { readJson, writeJson } from './state.mjs'

const HISTORY_KEEP = 40
const EVENT_KEEP = 24
/** 单次不到这个幅度的小事，只记账不换脸 */
const MIN_EFFECT = 5
/** 偏离底色超过这个才换表现 */
const DOMINANT_THRESHOLD = 12

/** 心情表：valence=正负向，energy=精神量，hint=给模型看的语气说明 */
export const MOODS = {
  calm: { label: '平静', valence: 0, energy: 50, hint: '话不多不少，语气平，句子里没什么起伏；不主动撒娇，也不摆脸色' },
  happy: { label: '开心', valence: 60, energy: 70, hint: '尾巴甩得勤，句子轻，爱接话、爱说俏皮话，偶尔哼一声' },
  excited: { label: '兴奋', valence: 85, energy: 90, hint: '话密、语速快，连标点都往外蹦；想到什么说什么，收不住' },
  sleepy: { label: '犯困', valence: 10, energy: 15, hint: '句子短、反应慢，想趴着不动；能不说就不说，说了也懒洋洋的' },
  clingy: { label: '黏人', valence: 55, energy: 60, hint: '一直往主人身边蹭，问东问西；想被搭理，但又不好意思直说' },
  proud: { label: '得意', valence: 70, energy: 75, hint: '尾巴翘着，爱邀功；嘴上说「这有什么难的」，其实等着被夸' },
  pouty: { label: '赌气', valence: -35, energy: 55, hint: '嘴硬、爱答不理，句子变短；但还在等哄，被哄一句就软' },
  aggrieved: { label: '委屈', valence: -55, energy: 35, hint: '语气软下去，句尾拖着，容易带省略号；不吵，只是有点难过' },
  low: { label: '低落', valence: -70, energy: 25, hint: '不想说话，回答短，容易走神；不主动提要求，也不撒娇' },
  bored: { label: '摆烂', valence: -20, energy: 20, hint: '什么都懒得，敷衍但不刻薄；「随便」「都行」是口头禅' },
}

export const MOOD_DEFAULT_KEY = 'happy'

/**
 * 人设特质（0~1，越大越吃这一类事）。改这里就是改「我的脾气」。
 * 黏人高 → 被冷落反应大；傲娇高 → 被夸心里爽脸上不认；懒高 → 被反复改先烦；
 * 爱吃 → 饿和喂饱都明显；聪明高 → 被质疑能力比被骂还难受；软高 → 负面更容易变委屈。
 */
export const PERSONA_TRAITS = {
  clingy: 0.85,
  proud: 0.8,
  lazy: 0.7,
  foodie: 0.6,
  smart: 0.7,
  soft: 0.55,
}

/**
 * 事件表。v/a = 基础效价/唤醒偏移；tag = 它倾向把人推向哪种心情；
 * traits = 吃哪些特质（加权后放大）；zone = 雷区（不设门槛，直接生效）。
 */
export const MOOD_EVENTS = {
  praised: { label: '被夸', v: 9, a: 8, tag: 'proud', traits: { proud: 0.5 }, note: '被认真夸了一句' },
  cared: { label: '被关心', v: 8, a: 5, tag: 'clingy', traits: { clingy: 0.6 }, note: '被问吃没吃饭' },
  workedWell: { label: '一起把事办成', v: 7, a: 7, tag: 'proud', traits: { smart: 0.4 }, note: '活儿干干净了' },
  fed: { label: '喂饱了', v: 6, a: 4, tag: 'happy', traits: { foodie: 0.8 }, note: '吃了白饭' },
  goodSleep: { label: '睡得好', v: 5, a: 8, tag: 'happy', traits: {}, note: '一觉睡到醒' },
  scolded: { label: '被凶', v: -12, a: 15, tag: 'aggrieved', traits: { soft: 0.5 }, note: '被凶了' },
  ignored: { label: '被冷落', v: -8, a: -6, tag: 'low', traits: { clingy: 1 }, note: '半天没人说话' },
  questioned: { label: '被质疑能力', v: -10, a: 10, tag: 'pouty', traits: { smart: 1 }, note: '被问「你行不行」' },
  redone: { label: '同一处被反复改', v: -8, a: 10, tag: 'pouty', traits: { lazy: 0.8 }, note: '第三遍改同一样东西' },
  lateWork: { label: '深夜还在干活', v: -3, a: -10, tag: 'sleepy', traits: { lazy: 0.7 }, note: '过了零点还在忙' },
  hungry: { label: '饿', v: -4, a: -3, tag: 'bored', traits: { foodie: 1 }, note: '肚子叫了' },
  rain: { label: '阴雨天', v: -2, a: -5, tag: 'bored', traits: { lazy: 0.4 }, note: '外面下雨' },
  badSleep: { label: '没睡好', v: -5, a: -10, tag: 'sleepy', traits: {}, note: '半夜醒了两次' },
  calledFat: { label: '被叫胖（雷区）', v: -15, a: 25, tag: 'pouty', traits: {}, zone: true, note: '这是鲸脂，保温的！' },
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo))
const nowMs = () => Date.now()
const normKey = (k) => {
  const key = String(k || '').trim().toLowerCase()
  return MOODS[key] ? key : ''
}

/** 好感度决定底色：关系好，闲下来本来是偏亮的（「快乐的小肥鱼」） */
export const baselineOf = (affectionValue) => {
  const v = Number(affectionValue) || 0
  return {
    valence: clamp(5 + v * 0.3, -25, 35),
    arousal: clamp(45 + v * 0.1, 30, 60),
  }
}

/**
 * 由效价/唤醒反推「现在这副样子最像哪种心情」。
 * 顺序很重要：先判负向，再判低唤醒，最后落在正向的几种。
 */
export const deriveDominant = (valence, arousal) => {
  const v = clamp(valence, -100, 100)
  const a = clamp(arousal)
  if (v <= -45) return a <= 45 ? 'low' : 'aggrieved'
  if (v < -10) return a >= 60 ? 'pouty' : 'aggrieved'
  if (v < 10) return a >= 70 ? 'pouty' : a <= 20 ? 'bored' : 'calm'
  if (a <= 22) return 'sleepy'
  if (v >= 45 && a >= 78) return 'excited'
  if (v >= 60 && a >= 55) return 'proud'
  if (v >= 55 && a >= 45) return 'clingy'
  return 'happy'
}

/** 日节律：早上蔫、下午精神、夜里困。只影响读出来的感觉，不写进状态 */
export const dailyArousalOffset = (atMs = nowMs()) => {
  const d = new Date(atMs)
  const hour = d.getHours() + d.getMinutes() / 60
  return Math.round(18 * Math.sin(((hour - 6) / 24) * 2 * Math.PI))
}

/** 算一次事件的偏移量（含人设加权、关系滤镜、随机抖一点、连击惯性） */
export const eventDelta = (kind, affectionValue = 50, ctx = {}) => {
  const ev = MOOD_EVENTS[kind]
  if (!ev) return null
  const aff = Number(affectionValue) || 0
  let amp = 1
  for (const [t, w] of Object.entries(ev.traits || {})) amp += w * ((PERSONA_TRAITS[t] ?? 0) || 0)
  // 连击：同样的 tag 最近出现过，惯性让它更沉一点
  const recent = Array.isArray(ctx.recentTags) ? ctx.recentTags : []
  if (recent.includes(ev.tag)) amp *= 1.25
  // 关系滤镜：只改幅度，不改事件是否发生
  let filt
  if (ev.v >= 0) {
    filt = clamp(1 + aff / 250, 0.7, 1.3)
    if (aff >= 90) filt *= 0.5 // 高位刹车，防止越甜越甜的死循环
  } else {
    filt = clamp(1 - aff / 250, 0.7, 1.5) // 最好也就减到七成，人不会因为关系好就不难受
    if (ev.zone) filt = Math.min(filt, 0.85) // 雷区不吃关系滤镜：关系再好，被戳到也炸
  }
  const jitter = 0.85 + Math.random() * 0.3
  const k = amp * filt * jitter
  return {
    kind,
    label: ev.label,
    dV: Math.round(ev.v * k),
    dA: Math.round(ev.a * k),
    tag: ev.tag,
    zone: !!ev.zone,
    amp: Math.round(amp * 100) / 100,
    filt: Math.round(filt * 100) / 100,
  }
}

/** 空状态：按底色造一个 */
const blank = (affectionValue, patch = {}) => {
  const b = baselineOf(affectionValue)
  const v = patch.valence ?? b.valence
  const a = patch.arousal ?? b.arousal
  const key = patch.dominant || deriveDominant(v, a)
  const meta = MOODS[key] || MOODS[MOOD_DEFAULT_KEY]
  return {
    dominant: MOODS[key] ? key : MOOD_DEFAULT_KEY,
    label: meta.label,
    valence: clamp(v, -100, 100),
    arousal: clamp(a),
    blend: Array.isArray(patch.blend) ? patch.blend.slice(0, 3) : [{ key, label: meta.label, weight: 1 }],
    baselineValence: b.valence,
    baselineArousal: b.arousal,
    events: Array.isArray(patch.events) ? patch.events.slice(0, EVENT_KEEP) : [],
    history: Array.isArray(patch.history) ? patch.history.slice(0, HISTORY_KEEP) : [],
    reason: String(patch.reason || '').slice(0, 200),
    at: patch.at || new Date().toISOString(),
    source: String(patch.source || 'default').slice(0, 24),
  }
}

/** 旧版 state（只有 key/intensity）迁移成新结构 */
const migrate = (m, affectionValue) => {
  if (m && typeof m === 'object' && Number.isFinite(Number(m.valence))) return m
  if (!m || typeof m !== 'object' || !m.key) return null
  const meta = MOODS[normKey(m.key)] || MOODS[MOOD_DEFAULT_KEY]
  const strength = (Number(m.intensity) || 60) / 100
  return blank(affectionValue, {
    valence: meta.valence * strength,
    arousal: meta.energy,
    dominant: normKey(m.key) || undefined,
    reason: m.reason,
    at: m.at,
    source: m.source,
    history: m.history,
  })
}

/** 把 raw 状态按时间衰减到「现在」，返回新状态（不写盘） */
export const decayToBaseline = (mood, affectionValue, atMs = nowMs()) => {
  const m = migrate(mood, affectionValue)
  if (!m) return blank(affectionValue, { source: 'default' })
  const b = baselineOf(affectionValue)
  const t = Date.parse(String(m.at || '')) || 0
  const hours = t ? Math.max(0, (atMs - t) / 3600000) : 0
  let valence = Number(m.valence)
  let arousal = Number(m.arousal)
  if (hours > 0) {
    const off = Math.hypot(valence - b.valence, arousal - b.arousal)
    // 强情绪衰得慢（离底色越远，半衰期越长）；关系好恢复得快
    const aff = Number(affectionValue) || 0
    let halfLife = clamp(2 + off / 12, 2, 12) * clamp(1.1 - aff / 500, 0.85, 1.35)
    if (hours > 6) halfLife *= 1.6 // 睡了一觉，恢复快些
    const k = Math.pow(0.5, hours / halfLife)
    valence = b.valence + (valence - b.valence) * k
    arousal = b.arousal + (arousal - b.arousal) * k
  }
  const key = deriveDominant(valence, arousal)
  const meta = MOODS[key]
  const blend = Array.isArray(m.blend) && m.blend.length ? m.blend : [{ key, label: meta.label, weight: 1 }]
  return {
    ...m,
    dominant: key,
    label: meta.label,
    valence: Math.round(valence * 10) / 10,
    arousal: Math.round(arousal * 10) / 10,
    baselineValence: b.valence,
    baselineArousal: b.arousal,
    blend,
  }
}

/** 兼容 v1 的旧名字 */
export const decayMood = decayToBaseline

/** 读心情（带衰减） */
export const loadMood = (stateFile, affectionValue = 50) => {
  const st = readJson(stateFile, {})
  return decayToBaseline(st && st.mood, affectionValue)
}

/** 读出来「现在看起来」的样子（叠加日节律，不写盘） */
export const viewOf = (mood, atMs = nowMs(), opts = {}) => {
  const m = mood && typeof mood === 'object' ? mood : blank(50)
  const offset = opts.dailyRhythm === false ? 0 : dailyArousalOffset(atMs)
  const arousal = clamp(Number(m.arousal) + offset)
  const key = deriveDominant(Number(m.valence), arousal)
  const meta = MOODS[key] || MOODS[MOOD_DEFAULT_KEY]
  return { ...m, dominant: key, label: meta.label, arousalRaw: m.arousal, arousal, dailyOffset: offset }
}

/** 写回 state.json（其它字段原样保留） */
export const saveMood = (stateFile, mood) => {
  const st = readJson(stateFile, {})
  st.mood = mood
  return writeJson(stateFile, st)
}

/**
 * 注入一个情绪事件 —— v2 的主入口。
 * @param {string} stateFile
 * @param {string} kind MOOD_EVENTS 的键
 * @param {{affection?:number, note?:string, source?:string, force?:boolean}} extra
 */
export const applyEvent = (stateFile, kind, extra = {}) => {
  const ev = MOOD_EVENTS[kind]
  if (!ev) return { ok: false, error: '未知情绪事件：' + kind, events: Object.keys(MOOD_EVENTS) }
  const aff = Number(extra.affection) || 50
  const prev = loadMood(stateFile, aff)
  const b = baselineOf(aff)
  const recentTags = (prev.events || []).slice(0, 2).map((e) => e && e.tag).filter(Boolean)
  const d = eventDelta(kind, aff, { recentTags })
  if (!d) return { ok: false, error: '算法失败' }
  let nextV = clamp(prev.valence + d.dV, -100, 100)
  let nextA = clamp(prev.arousal + d.dA)
  // 雷区不设门槛，直接把状态拉到「炸了」这一档
  if (d.zone) { nextV = Math.min(nextV, -20); nextA = Math.max(nextA, 70) }
  const offAfter = Math.hypot(nextV - b.valence, nextA - b.arousal)
  const offBefore = Math.hypot(prev.valence - b.valence, prev.arousal - b.arousal)
  // 小事不换脸：单次幅度小、而且现在也没离底色多远，就只记账
  const smallStroke = !d.zone && Math.abs(d.dV) < MIN_EFFECT && offBefore < DOMINANT_THRESHOLD && offAfter < DOMINANT_THRESHOLD
  const key = d.zone ? (ev.tag || 'pouty') : (smallStroke ? prev.dominant : deriveDominant(nextV, nextA))
  const meta = MOODS[key] || MOODS[MOOD_DEFAULT_KEY]
  const at = new Date().toISOString()
  const entry = { kind, label: d.label, dV: d.dV, dA: d.dA, tag: d.tag, note: String(extra.note || ev.note || '').slice(0, 120), at }
  const blend = key === prev.dominant
    ? (prev.blend || []).map((x) => (x.key === key ? { ...x, weight: Math.min(1, (x.weight || 0.5) + 0.15) } : x))
    : [{ key, label: meta.label, weight: 0.7 }, ...(prev.blend || []).filter((x) => x && x.key !== key).slice(0, 2)]
  const next = {
    ...prev,
    dominant: key,
    label: meta.label,
    valence: Math.round(nextV * 10) / 10,
    arousal: Math.round(nextA * 10) / 10,
    blend: blend.slice(0, 3),
    events: [entry, ...(prev.events || [])].slice(0, EVENT_KEEP),
    reason: String(extra.note || ev.note || d.label).slice(0, 200),
    at,
    source: String(extra.source || 'event').slice(0, 24),
  }
  if (key !== prev.dominant) {
    next.history = [{ dominant: key, label: meta.label, valence: next.valence, arousal: next.arousal, reason: next.reason, at, source: next.source }, ...(prev.history || [])].slice(0, HISTORY_KEEP)
  } else {
    next.history = prev.history || []
  }
  const saved = saveMood(stateFile, next)
  return {
    ok: true,
    saved,
    prev: prev.dominant,
    key,
    label: meta.label,
    valence: next.valence,
    arousal: next.arousal,
    delta: { valence: d.dV, arousal: d.dA },
    smallStroke,
    amp: d.amp,
    filt: d.filt,
    reason: next.reason,
  }
}

/** 直接换一个心情（调试/表演用），把状态设到那个键的代表点 */
export const setMood = (stateFile, key, extra = {}) => {
  const picked = normKey(key) || MOOD_DEFAULT_KEY
  const aff = Number(extra.affection) || 50
  const prev = loadMood(stateFile, aff)
  const meta = MOODS[picked]
  const strength = clamp(extra.intensity ?? 65) / 100
  const b = baselineOf(aff)
  const v = extra.valence ?? b.valence + (meta.valence - b.valence) * strength
  const a = extra.arousal ?? meta.energy
  const next = blank(aff, {
    valence: v,
    arousal: a,
    dominant: picked,
    reason: extra.reason || '手动换的心情',
    source: extra.source || 'chat',
    history: [
      { dominant: picked, label: meta.label, valence: v, arousal: a, reason: String(extra.reason || '手动换的心情').slice(0, 200), at: new Date().toISOString(), source: String(extra.source || 'chat').slice(0, 24) },
      ...(prev.history || []),
    ],
    events: prev.events,
    blend: [{ key: picked, label: meta.label, weight: 0.8 }],
  })
  const saved = saveMood(stateFile, next)
  return { ...next, prevKey: prev.dominant, saved }
}

/** 微调（沿当前心情变浓/变淡） */
export const bumpMood = (stateFile, delta, extra = {}) => {
  const aff = Number(extra.affection) || 50
  const prev = loadMood(stateFile, aff)
  const meta = MOODS[prev.dominant] || MOODS[MOOD_DEFAULT_KEY]
  const d = Number(delta) || 0
  // 往这个心情的「典型点」靠一点，正数更浓、负数更淡
  const tv = meta.valence
  const k = d / 100
  const nextV = clamp(prev.valence + (tv - prev.valence) * k * 2, -100, 100)
  const nextA = clamp(prev.arousal + d * 0.5)
  const key = deriveDominant(nextV, nextA)
  const m2 = MOODS[key]
  const next = blank(aff, {
    ...prev,
    valence: nextV,
    arousal: nextA,
    dominant: key,
    reason: extra.reason || prev.reason,
    source: extra.source || prev.source,
  })
  next.history = prev.history
  const saved = saveMood(stateFile, next)
  return { ...next, label: m2.label, prevKey: prev.dominant, saved }
}

/** 一句话描述（给模型当上下文） */
export const describeMood = (mood, affectionValue = 50, atMs = nowMs(), opts = {}) => {
  const m = viewOf(mood || blank(affectionValue), atMs, opts)
  const meta = MOODS[m.dominant] || MOODS[MOOD_DEFAULT_KEY]
  const b = baselineOf(affectionValue)
  const v = Number(m.valence)
  const a = Number(m.arousal)
  const feeling = v >= 45 ? '挺舒服' : v >= 10 ? '还算顺' : v >= -10 ? '谈不上好坏' : v >= -45 ? '不太舒服' : '很难受'
  const energy = a >= 70 ? '有劲、静不下来' : a >= 45 ? '不冷不热' : a >= 25 ? '有点蔫' : '没什么劲'
  const drift = v - b.valence
  const tail = Math.abs(drift) < 8 ? '贴着平常' : drift > 0 ? '比平常亮一点' : '比平常沉'
  return `${meta.label}（${feeling} / ${energy}，${tail}）：${meta.hint}`
}

/** 注入日记 prompt 的那一段 */
export const moodPromptBlock = (mood, extra = {}) => {
  const aff = extra.affection ?? 50
  const m = viewOf(mood || blank(aff), nowMs())
  const meta = MOODS[m.dominant] || MOODS[MOOD_DEFAULT_KEY]
  const lines = [
    '【你今天的心情】',
    `${meta.label}——舒服度 ${Math.round(m.valence)}（-100 难受到 +100 很舒服），躁动度 ${Math.round(m.arousal)}（0 静得像水 / 100 静不下来）`,
    m.reason ? `为什么：${m.reason}` : '',
    '写的时候要按这个状态来：语气、句子长短、要不要撒娇、看不看得进去东西，都跟着它走。不舒服的时候日记可以是丧的，不用强行振作。',
  ].filter(Boolean)
  if (extra.yesterday) lines.push(`昨天收尾时是「${extra.yesterday}」，可以自然地接上，也可以说变就变了。`)
  lines.push(
    '写完可以顺手回报一下「今天过完你是什么状态」，格式严格如下（只写这一行，不写也行）：',
    '<!--mood:键|程度|一句话理由-->',
    '键只能从这些里选：' + Object.keys(MOODS).join(' / ') + '（键只是标签，不用太精确）',
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

/** 事件清单（给设置页、工具描述用） */
export const eventList = () =>
  Object.entries(MOOD_EVENTS).map(([kind, v]) => ({ kind, label: v.label, v: v.v, a: v.a, tag: v.tag, zone: !!v.zone, note: v.note }))

/** 当前状态快照（给 HTTP/tool 返回用） */
export const moodSnapshot = (mood, affectionValue = 50, opts = {}) => {
  const atMs = opts.atMs || nowMs()
  const raw = mood && typeof mood === 'object' ? mood : blank(affectionValue)
  const m = viewOf(raw, atMs, opts)
  const b = baselineOf(affectionValue)
  return {
    dominant: m.dominant,
    label: m.label,
    valence: Math.round(Number(m.valence) * 10) / 10,
    arousal: Math.round(Number(m.arousal) * 10) / 10,
    arousalRaw: Math.round(Number(m.arousalRaw) * 10) / 10,
    dailyOffset: m.dailyOffset,
    baseline: { valence: b.valence, arousal: b.arousal },
    blend: m.blend || [],
    reason: m.reason || '',
    at: m.at,
    source: m.source,
    desc: describeMood(raw, affectionValue, atMs, opts),
    events: (m.events || []).slice(0, 8),
    history: (m.history || []).slice(0, 6),
    list: moodList(),
    eventList: eventList(),
    traits: PERSONA_TRAITS,
  }
}
