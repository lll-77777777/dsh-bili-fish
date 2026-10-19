/**
 * 早安推送：天气 → 穿衣建议 → 一句早安 → 配一张表情包。
 *
 * 触发是「每天早上第一次醒」：进程/电脑睡了一夜，醒来后第一个 tick 落在
 * morningWindow 里、而且今天还没推过，就推一条。不依赖 Electron 的
 * powerMonitor —— 睡眠期间 tick 本来就不跑，醒来自然就补上了。
 *
 * 天气用 t.weather.itboy.net（国内直连，免 key，中文，15 天预报）。
 * 拿不到天气不阻塞：降级成「今天没查到天气」，照样说早安。
 */

/** 主要城市 → 中国天气网 cityKey（够用就行，其它城市可以在设置里直接填 9 位 key） */
export const CITY_CODES = {
  北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100',
  哈尔滨: '101050101', 长春: '101060101', 沈阳: '101070101', 大连: '101070201',
  呼和浩特: '101080101', 石家庄: '101090101', 太原: '101100101', 西安: '101110101',
  济南: '101120101', 青岛: '101120201', 乌鲁木齐: '101130101', 拉萨: '101140101',
  西宁: '101150101', 兰州: '101160101', 银川: '101170101', 郑州: '101180101',
  南京: '101190101', 苏州: '101190401', 无锡: '101190201', 杭州: '101210101',
  宁波: '101210401', 合肥: '101220101', 福州: '101230101', 厦门: '101230201',
  南昌: '101240101', 长沙: '101250101', 武汉: '101200101', 广州: '101280101',
  深圳: '101280601', 珠海: '101280701', 东莞: '101281601', 南宁: '101300101',
  海口: '101310101', 三亚: '101310201', 成都: '101270101', 贵阳: '101260101',
  昆明: '101290101', 香港: '101320101', 澳门: '101330101', 台北: '101340101',
}

/**
 * 城市名 → cityKey。接受「上海」「上海市」「广州天河区」「广东广州」、也接受直接给的 9 位 key。
 * 匹配顺序：9 位 key → 去掉行政区后缀精确匹配 → 输入里包含的城市名（取最长）。
 * @param {string} input
 * @returns {string} 拿不到就返回空串
 */
export function cityKeyOf(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  if (/^\d{9}$/.test(s)) return s
  const bare = s.replace(/(特别行政区|自治州|地区|新区|市|区|县|省)$/, '')
  if (CITY_CODES[bare]) return CITY_CODES[bare]
  if (CITY_CODES[s]) return CITY_CODES[s]
  /* 「广州天河区」「广东省广州市」：找表里出现在输入中的最长城市名 */
  let best = ''
  for (const name of Object.keys(CITY_CODES)) {
    if (name.length > best.length && s.includes(name)) best = name
  }
  return best ? CITY_CODES[best] : ''
}

/** @param {string} s '高温 25℃' → 25；拿不到 → NaN */
export function parseTemp(s) {
  const m = String(s || '').match(/(-?\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : NaN
}

/**
 * 拿一份天气。永不抛错。
 * @param {string} cityInput 城市名或 cityKey
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, city?: string, key?: string, temp?: number, quality?: string,
 *   today?: {ymd: string, low: number, high: number, type: string, notice: string, wind: string},
 *   tomorrow?: {ymd: string, low: number, high: number, type: string, notice: string}, error?: string}>}
 */
export async function fetchWeather(cityInput, timeoutMs = 15_000) {
  const input = String(cityInput || '').trim()
  const key = cityKeyOf(input) || (input ? '' : CITY_CODES.上海)
  if (!key) return { ok: false, error: `不认识这个城市：${input}（可以填中国天气网的 9 位 key）` }
  try {
    const r = await fetch(`http://t.weather.itboy.net/api/weather/city/${key}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return { ok: false, key, error: `HTTP ${r.status}` }
    const j = await r.json()
    if (j?.status !== 200 || !j?.data) return { ok: false, key, error: '接口返回异常' }
    const f = j.data.forecast || []
    const d0 = f[0] || {}
    const d1 = f[1] || {}
    return {
      ok: true,
      key,
      city: j.cityInfo?.city || '',
      temp: Number(j.data.wendu),
      quality: j.data.quality || '',
      ganmao: j.data.ganmao || '',
      today: {
        ymd: d0.ymd || '', low: parseTemp(d0.low), high: parseTemp(d0.high),
        type: d0.type || '', notice: d0.notice || '', wind: ((d0.fx || '') + (d0.fl || '')).trim(),
      },
      tomorrow: {
        ymd: d1.ymd || '', low: parseTemp(d1.low), high: parseTemp(d1.high),
        type: d1.type || '', notice: d1.notice || '',
      },
    }
  } catch (e) {
    return { ok: false, key, error: String(e?.message || e) }
  }
}

/**
 * 温度 + 天象 → 穿衣建议（不靠模型也能独立给出，模型只负责润色）。
 * @param {number} low 最低温
 * @param {number} high 最高温
 * @param {string} type 天气现象，如「小雨」
 * @returns {string}
 */
export function clothingAdvice(low, high, type = '') {
  const t = Number.isFinite(high) ? high : low
  let wear = ''
  if (!Number.isFinite(t)) wear = ''
  else if (t >= 30) wear = '短袖短裤、透气一点，别贪凉把空调开太低'
  else if (t >= 26) wear = '短袖或薄衬衫就够'
  else if (t >= 22) wear = '长袖加一件薄外套，中午可能热'
  else if (t >= 18) wear = '卫衣或薄外套，正合适'
  else if (t >= 14) wear = '厚一点的外套或者风衣'
  else if (t >= 10) wear = '毛衣加外套，别只穿一件'
  else if (t >= 5) wear = '厚外套或薄羽绒'
  else if (Number.isFinite(t)) wear = '羽绒服，别硬扛'
  const tips = []
  if (Number.isFinite(low) && Number.isFinite(high) && high - low >= 8) tips.push('早晚温差快' + Math.round(high - low) + '度，出门带件能脱的')
  if (/雨/.test(type)) tips.push('有雨，伞别忘了')
  if (/雪/.test(type)) tips.push('下雪，路滑慢点走')
  if (/风/.test(type)) tips.push('风大，围巾或者帽子')
  if (/霾|雾/.test(type)) tips.push('空气不好，口罩带上')
  return [wear, ...tips].filter(Boolean).join('；') || '出门前自己看一眼窗外吧'
}

/**
 * 扫表情包目录里能发的图。
 * @param {string} dir
 * @param {Function} readdir 注入 fs.readdirSync，避免本模块自己依赖 fs
 * @returns {Array<{file: string, name: string, path: string}>}
 */
export function listMemes(dir, readdir) {
  if (!dir) return []
  try {
    const names = readdir(dir) || []
    return names
      .filter((n) => /\.(png|jpe?g|webp|gif)$/i.test(n))
      .slice(0, 40)
      .map((n) => ({ file: n, name: n.replace(/\.[^.]+$/, ''), path: dir.replace(/[\\/]+$/, '') + '\\' + n }))
  } catch {
    return []
  }
}

/**
 * 拼早安 prompt。模型只写「话」，天气数字和建议都给它了，不让它编。
 * @param {object} p
 * @param {ReturnType<typeof fetchWeather>} p.weather
 * @param {{key: string, label: string, intensity: number, desc?: string}} p.mood
 * @param {number} p.affection 好感度数值
 * @param {{label: string, call: string}} p.tier
 * @param {string[]} p.pending 主人之前交代过、还没做完的事
 * @param {Array<{file: string, name: string}>} p.memes
 * @param {string} p.weekday 星期几
 * @returns {string}
 */
export function buildMorningPrompt({ weather, mood, affection, tier, pending, memes, weekday }) {
  const w = weather?.ok ? weather : null
  const t = w?.today || {}
  const lines = []
  lines.push('现在是早上，你刚醒。给主人发一条早安消息（微信），不是写日记。')
  lines.push('')
  lines.push('【今天】' + weekday + '，' + new Date().toLocaleDateString('zh-CN'))
  if (w) {
    lines.push('【天气】' + w.city + '：现在 ' + w.temp + '℃，' + t.type + '，' + Math.round(t.low) + '~' + Math.round(t.high) + '℃'
      + (w.quality ? '，空气 ' + w.quality : '') + (t.wind ? '，' + t.wind : ''))
    lines.push('【穿衣建议（已算好，照这个说）】' + clothingAdvice(t.low, t.high, t.type))
    if (w.tomorrow && w.tomorrow.type) {
      lines.push('【明天】' + w.tomorrow.type + '，' + Math.round(w.tomorrow.low) + '~' + Math.round(w.tomorrow.high) + '℃')
    }
  } else {
    lines.push('【天气】没查到（接口不通）。明说一句「今天没查到天气」，不要编数字。')
  }
  lines.push('【此刻的你】心情：' + mood.label + '（浓度 ' + mood.intensity + '）。好感度 ' + affection + '（档位 ' + tier.label + '，这个档位怎么称呼主人：' + tier.call + '）。')
  if (pending && pending.length) {
    lines.push('【主人之前交代过的事（还没做完的）】')
    for (const p of pending.slice(0, 5)) lines.push('- ' + p)
    lines.push('挑 1~2 件提醒他，别把清单全念一遍。')
  } else {
    lines.push('【主人交代过的事】没有待办，不用硬提。')
  }
  if (memes && memes.length) {
    lines.push('【可以配的表情包】' + memes.map((m) => m.file).join(' / '))
    lines.push('最后单独一行写 IMAGE: <文件名>，从上面选一张最贴今天心情的；都不想用就写 IMAGE: NONE。')
  }
  lines.push('')
  lines.push('要求：')
  lines.push('1. 120~220 字，一段，别分点、别用 markdown 标题。')
  lines.push('2. 像刚醒的人说话：先打个招呼，再说天气和穿什么，再给 1 条具体的建议（带伞/早点出门/别熬夜这种，要跟今天的天气或主人的事有关）。')
  lines.push('3. 语气按你的心情和好感度档位来，不用每次一样；高兴就轻快，犯困就蔫一点。')
  lines.push('4. 不要写「作为 AI」「希望对你有帮助」这类话，也不要重复报城市和温度两遍。')
  lines.push('5. 最后一行只能是 IMAGE: 标记，正文里不要出现文件名。')
  return lines.join('\n')
}

/**
 * 拆出正文和图片标记。
 * @param {string} text
 * @returns {{body: string, image: string}}
 */
export function parseMorningReply(text) {
  const raw = String(text || '')
  const m = raw.match(/IMAGE\s*:\s*([^\s\n]+)/i)
  const image = m ? (String(m[1]).trim().toLowerCase() === 'none' ? '' : String(m[1]).trim()) : ''
  const body = raw
    .replace(/IMAGE\s*:\s*[^\s\n]+/gi, '')
    .replace(/^\s*```[\s\S]*?```\s*$/g, '')
    .trim()
  return { body, image }
}

/** 星期几（中文） */
export function weekdayOf(d = new Date()) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

/**
 * 今天该随机成什么心情。早上掷一次，一天都算这个底色。
 * @param {Array<{key: string}>} moodList 可选的心情键
 * @param {number} rand 0~1
 * @returns {{key: string, intensity: number}}
 */
export function rollMorningMood(moodList, rand = Math.random()) {
  const list = (moodList || []).filter((m) => m && m.key)
  if (!list.length) return { key: 'happy', intensity: 60 }
  const idx = Math.min(list.length - 1, Math.floor(rand * list.length))
  const intensity = 45 + Math.floor(rand * 35) // 45~79
  return { key: list[idx].key, intensity }
}
