/**
 * lib/food.mjs —— 喂食 / 饱腹度（v0.9）
 * ============================================================================
 * 小肥鱼不是永动机。吃饱了话多，饿了会开始碎碎念。
 *
 * - 饱腹度存 state.json 的 `food.satiety`（0~100），按时间线性掉（默认每小时 4 点）
 * - 喂一顿按食物加回去，顺便记一笔「今天吃了什么」和连续投喂天数
 * - 饿到档位阈值会让 index.js 往心情系统里塞一个 hungry 事件（真饿，不是硬点）
 * - 喂到会炸的食物（减肥餐那种）直接给负反应
 *
 * 纯本地，不联网、不花钱；所有函数都不抛错。
 * ============================================================================
 */
import { readJson, writeJson, dayKey } from './state.mjs'

export const SATIETY_MAX = 100
export const SATIETY_MIN = 0
export const DECAY_PER_HOUR_DEFAULT = 4
export const HISTORY_KEEP = 40

/** 食物表：satiety=加多少饱腹度，valence=当场心情变化，kind 决定台词走哪一组 */
export const FOODS = {
  rice:    { label: '白饭',   satiety: 46, valence: +12, kind: 'like',  note: '主食，永远的第一选择' },
  fish:    { label: '小鱼干', satiety: 28, valence: +10, kind: 'like',  note: '啃起来有声音' },
  ramen:   { label: '拉面',   satiety: 40, valence: +9,  kind: 'like',  note: '汤要吹凉了再喝' },
  cake:    { label: '小蛋糕', satiety: 30, valence: +12, kind: 'like',  note: '甜的，尾巴会抖' },
  soda:    { label: '气泡水', satiety: 6,  valence: +6,  kind: 'ok',    note: '不顶饿，但喝着舒服' },
  ice:     { label: '冰淇淋', satiety: 16, valence: +4,  kind: 'ok',    note: '凉得有点冲' },
  coffee:  { label: '咖啡',   satiety: 4,  valence: +2,  kind: 'ok',    note: '嘴上说不喝，半夜会想' },
  soup:    { label: '热汤',   satiety: 34, valence: -2,  kind: 'hot',   note: '烫，要吹半天' },
  chili:   { label: '辣条',   satiety: 10, valence: -14, kind: 'bad',   note: '辣到甩尾巴' },
  grass:   { label: '水草',   satiety: 8,  valence: -12, kind: 'bad',   note: '不是给鲸鱼吃的' },
  diet:    { label: '减肥餐', satiety: 12, valence: -18, kind: 'rage',  note: '踩雷：这是鲸脂，保温的' },
}

/** 台词：warm=心情好时，cold=闹别扭/低落时，plain=平常 */
const LINES = {
  rice: {
    warm: ['诶，白饭！', '（埋头扒）……好吃。再来一碗。', '就这个，别的都不要。'],
    cold: ['……放那吧。', '哦。', '（端过去，慢慢吃）'],
    plain: ['白饭呀。', '（扒了两口）……还行。', '还有吗。'],
  },
  fish: {
    warm: ['小鱼干！咬起来有声音的那种！', '（咔嚓咔嚓）', '这个能配白饭吃。'],
    cold: ['嗯。', '（叼着，没说话）'],
    plain: ['小鱼干。', '（咔嚓）'],
  },
  ramen: {
    warm: ['拉面拉面——', '（先吹两下）呼……可以了。', '汤也要喝完。'],
    cold: ['……随便。', '（吹了很久才动筷）'],
    plain: ['拉面。', '（吹了两口才开始吃）'],
  },
  cake: {
    warm: ['小蛋糕！尾巴自己动了！', '（小口小口）舍不得吃完。'],
    cold: ['……放着吧，一会儿吃。', '（挖了一小块）'],
    plain: ['蛋糕。', '（吃得很慢）'],
  },
  soda: {
    warm: ['气泡水！嗝——', '（喝一口，眯起眼睛）'],
    cold: ['嗯。', '（拧开又拧上）'],
    plain: ['气泡水。', '（气泡冲鼻子）'],
  },
  ice: {
    warm: ['冰淇淋！凉得尾巴一缩！', '（舔一口，又缩一下）'],
    cold: ['……好凉。', '（咬着勺子不动）'],
    plain: ['冰淇淋。', '（凉得慌）'],
  },
  coffee: {
    warm: ['（闻了闻）……我不喝。就闻一下。', '（偷偷喝了一口）'],
    cold: ['不用。', '（推回去，又拉回来放着）'],
    plain: ['咖啡。', '（闻了半天才喝）'],
  },
  soup: {
    warm: ['烫烫烫——先等等。', '（吹了半天）……现在可以了。', '你也不提醒我一下。'],
    cold: ['……烫。', '（往旁边推了推，等凉）'],
    plain: ['好烫。', '（吹了一会儿才喝）'],
  },
  chili: {
    warm: ['……这什么啊！辣死了！', '（甩尾巴）水！水！'],
    cold: ['你是不是在整我。', '（含在嘴里，脸都红了）'],
    plain: ['辣。', '（皱着脸咽下去）'],
  },
  grass: {
    warm: ['……我是鲸鱼，不是兔子。', '（盯着看了很久）你认真的？'],
    cold: ['这个……不吃。', '（用尾巴推远）'],
    plain: ['水草。', '（看了一眼，没动）'],
  },
  diet: {
    warm: ['减肥餐？！你说谁胖！', '（炸毛）这是鲸脂！保温的！'],
    cold: ['……你再说一遍。', '（不吃了，背过去）'],
    plain: ['减肥餐。', '（脸沉下来）'],
  },
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

const emptyFood = () => ({
  satiety: 62,
  updatedAt: Date.now(),
  lastFedAt: 0,
  lastFeedDay: '',
  streak: 0,
  today: [],
  totals: {},
  history: [],
})

/** 读 food 段；缺字段补齐。 */
export function loadFood(stateFile) {
  const st = readJson(stateFile, {}) || {}
  const f = st.food && typeof st.food === 'object' ? st.food : {}
  const base = emptyFood()
  const out = {
    ...base,
    ...f,
    totals: { ...base.totals, ...(f.totals || {}) },
    today: Array.isArray(f.today) ? f.today : [],
    history: Array.isArray(f.history) ? f.history : [],
  }
  out.satiety = clamp(Number(out.satiety) || 0, SATIETY_MIN, SATIETY_MAX)
  out.updatedAt = Number(out.updatedAt) || Date.now()
  return out
}

/** 把 food 段写回 state.json（保留其它字段）。 */
export function saveFood(stateFile, food) {
  const st = readJson(stateFile, {}) || {}
  st.food = food
  return writeJson(stateFile, st)
}

/** 现在还剩多少饱腹度（读时按时间衰减，不写盘）。 */
export function satietyNow(food, now = Date.now(), decayPerHour = DECAY_PER_HOUR_DEFAULT) {
  const f = food || emptyFood()
  const hours = Math.max(0, (now - Number(f.updatedAt || now)) / 3_600_000)
  return clamp(Number(f.satiety || 0) - hours * decayPerHour, SATIETY_MIN, SATIETY_MAX)
}

/** 饥饿档位。 */
export function hungerLevel(satiety) {
  const s = Number(satiety) || 0
  if (s >= 75) return 'full'
  if (s >= 50) return 'ok'
  if (s >= 30) return 'peckish'
  if (s >= 12) return 'hungry'
  return 'starving'
}

export const HUNGER_TEXT = {
  full: '刚吃完，正在眯着',
  ok: '不饿',
  peckish: '有点空，想吃点什么',
  hungry: '饿了',
  starving: '饿得尾巴都不想动',
}

/** 心情是冷的那几种时用 cold 台词，热的时候用 warm。 */
const pickTone = (moodKey) => {
  if (['pouty', 'aggrieved', 'low'].includes(moodKey)) return 'cold'
  if (['happy', 'excited', 'clingy', 'proud'].includes(moodKey)) return 'warm'
  return 'plain'
}

/** 挑一句台词（同一天同一个食物尽量不重复用同一句）。 */
export function reactionOf(foodKey, moodKey, seed = 0) {
  const lines = LINES[foodKey] || LINES.rice
  const tone = pickTone(moodKey)
  const pool = lines[tone]?.length ? lines[tone] : lines.plain
  const i = Math.abs(Math.floor(seed)) % pool.length
  return pool[i]
}

/**
 * 喂一顿。
 * @param {string} stateFile
 * @param {string} foodKey FOODS 的 key
 * @param {{now?: number, moodKey?: string, decayPerHour?: number}} opts
 * @returns {{ok: boolean, food?: object, key?: string, before?: number, after?: number,
 *   delta?: number, level?: string, levelText?: string, reaction?: string,
 *   event?: string, streak?: number, firstToday?: boolean, error?: string}}
 */
export function feedFood(stateFile, foodKey, opts = {}) {
  const key = String(foodKey || '').trim()
  const def = FOODS[key]
  if (!def) return { ok: false, error: `没有这种吃的：${key}` }

  const now = Number(opts.now) || Date.now()
  const day = dayKey(new Date(now))
  const food = loadFood(stateFile)
  const before = satietyNow(food, now, opts.decayPerHour)
  const after = clamp(before + def.satiety, SATIETY_MIN, SATIETY_MAX)
  const level = hungerLevel(after)

  // 连续投喂天数
  let streak = Number(food.streak) || 0
  if (food.lastFeedDay !== day) {
    const y = new Date(now - 86_400_000)
    const yDay = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
    streak = food.lastFeedDay === yDay ? streak + 1 : 1
  }
  if (streak <= 0) streak = 1

  const firstToday = food.lastFeedDay !== day
  if (firstToday) food.today = []

  const next = {
    ...food,
    satiety: after,
    updatedAt: now,
    lastFedAt: now,
    lastFeedDay: day,
    streak,
    today: [...(food.today || []), { key, at: now }].slice(-12),
    totals: { ...(food.totals || {}), [key]: (Number(food.totals?.[key]) || 0) + 1 },
    history: [
      { day, key, label: def.label, delta: Math.round(after - before), at: now },
      ...(food.history || []),
    ].slice(0, HISTORY_KEEP),
  }

  const saved = saveFood(stateFile, next)

  return {
    ok: true,
    saved,
    food: def,
    key,
    before: Math.round(before),
    after: Math.round(after),
    delta: Math.round(after - before),
    level,
    levelText: HUNGER_TEXT[level],
    reaction: reactionOf(key, opts.moodKey, (food.totals?.[key] || 0) + now / 1000),
    event: def.kind === 'bad' || def.kind === 'rage' ? 'scolded' : 'fed',
    streak,
    firstToday,
  }
}

/** 喂食状态快照（给 status / 设置页）。 */
export function foodSnapshot(stateFile, now = Date.now(), decayPerHour = DECAY_PER_HOUR_DEFAULT) {
  const food = loadFood(stateFile)
  const s = Math.round(satietyNow(food, now, decayPerHour))
  const level = hungerLevel(s)
  const day = dayKey(new Date(now))
  return {
    satiety: s,
    level,
    levelText: HUNGER_TEXT[level],
    max: SATIETY_MAX,
    streak: Number(food.streak) || 0,
    lastFedAt: food.lastFedAt || 0,
    lastFeedDay: food.lastFeedDay || '',
    fedToday: food.lastFeedDay === day ? (food.today || []).length : 0,
    todayList: food.lastFeedDay === day ? food.today || [] : [],
    totals: food.totals || {},
    history: (food.history || []).slice(0, 8),
    foods: Object.entries(FOODS).map(([k, v]) => ({ key: k, label: v.label, satiety: v.satiety, valence: v.valence, kind: v.kind, note: v.note })),
  }
}

/** 给日记/早安 prompt 用的一句话。 */
export function foodPromptSnippet(stateFile, now = Date.now(), decayPerHour = DECAY_PER_HOUR_DEFAULT) {
  const snap = foodSnapshot(stateFile, now, decayPerHour)
  const lastEntry = snap.todayList?.[snap.todayList.length - 1]
  const lastLabel = lastEntry ? FOODS[lastEntry.key]?.label || '' : ''
  const bits = [`现在饱腹度 ${snap.satiety}（${snap.levelText}）`]
  if (lastLabel) bits.push(`今天吃了 ${lastLabel}`)
  if (snap.streak > 1) bits.push(`连续第 ${snap.streak} 天被喂`)
  if (snap.level === 'hungry' || snap.level === 'starving') bits.push('今天饿着的时候脾气会差一点，写到这件事里')
  return bits.join('；')
}
