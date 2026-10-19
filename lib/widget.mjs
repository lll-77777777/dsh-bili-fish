/**
 * lib/widget.mjs —— 把「肚子」同步到右下角的挂件（v0.10）
 * ============================================================================
 * 挂件是 dsh-whale-widget，它的随机语句存在数据文件里：
 *   ~/.dsh/.dshw-bubble.json（桌面端）
 *   ~/.dsh/profiles/web/.dshw-bubble.json（dsh web 那端，存在才写）
 *
 * 结构：{ v:1, items:[ { kind:'custom', modules:[ {type:'random', lines:[{t,w,...}]} ] } ] }
 *
 * 本模块只做一件事：把带我们标记的那几句删掉，按当前饱腹档位换上一组。
 * 主人手写的句子一个字都不动，顺序也不动。写完挂件要 F5 才看得到。
 * ============================================================================
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

/** 我们管的那几句（删的时候也按这个表认，防标记丢了认不出来） */
export const WIDGET_TEXTS = {
  starving: ['……饿得不行了', '想吃白饭，就一碗', '尾巴都不想动了'],
  hungry: ['……饿了', '有点想吃白饭', '你那儿有吃的吗'],
  peckish: ['有点空空的'],
  ok: ['吃得好饱', '想趴一会儿'],
  full: ['撑了……不吃了', '想睡'],
}

const ALL_TEXTS = new Set(Object.values(WIDGET_TEXTS).flat())

/** 哪些数据文件存在（桌面端 + web 端） */
export function bubbleFiles(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const cands = [join(home, '.dshw-bubble.json'), join(home, 'profiles', 'web', '.dshw-bubble.json')]
  return cands.filter((f) => { try { return existsSync(f) } catch { return false } })
}

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 找到第一个 random 模块 */
function findRandomModule(json) {
  for (const it of (json && json.items) || []) {
    for (const m of (it && it.modules) || []) {
      if (m && m.type === 'random' && Array.isArray(m.lines)) return m
    }
  }
  return null
}

/** 这个文件里现在挂着我们哪几句（按文本认） */
export function currentTexts(file) {
  const j = readJson(file)
  const m = findRandomModule(j)
  if (!m) return []
  return m.lines.filter((l) => l && ALL_TEXTS.has(String(l.t || ''))).map((l) => String(l.t))
}

/**
 * 把挂件随机语句同步成当前档位。
 * @param {string} level full/ok/peckish/hungry/starving
 * @param {{dshHome?: string, backupDir?: string, sizes?: number[]}} opts
 * @returns {{ok:boolean, level:string, files:string[], added:number, removed:number, error?:string}}
 */
export function syncWidgetLevel(level, opts = {}) {
  const lv = String(level || 'ok')
  const want = WIDGET_TEXTS[lv] || []
  const files = bubbleFiles(opts.dshHome)
  if (!files.length) return { ok: false, level: lv, files: [], added: 0, removed: 0, error: '没找到挂件的数据文件' }

  let added = 0
  let removed = 0
  const wrote = []
  for (const file of files) {
    const j = readJson(file)
    if (!j) continue
    const m = findRandomModule(j)
    if (!m) continue

    /* 第一次动这个文件前留一份底（只留一份，别越攒越多） */
    if (opts.backupDir) {
      try {
        const bak = join(opts.backupDir, '.dshw-bubble.before-fish.json')
        if (!existsSync(bak)) {
          mkdirSync(dirname(bak), { recursive: true })
          copyFileSync(file, bak)
        }
      } catch { /* 备份失败就继续，不值得挡路 */ }
    }

    const kept = m.lines.filter((l) => !(l && ALL_TEXTS.has(String(l.t || ''))))
    removed += m.lines.length - kept.length
    const sizes = Array.isArray(opts.sizes) && opts.sizes.length ? opts.sizes : [22, 18, 15]
    const next = want.map((t, i) => ({ t, w: i === 0 ? 14 : 9, bold: true, size: sizes[i % sizes.length] }))
    m.lines = [...kept, ...next]
    added += next.length

    try {
      writeFileSync(file, JSON.stringify(j, null, 2), 'utf8')
      wrote.push(file)
    } catch { /* 单个文件失败不影响另一个 */ }
  }
  return { ok: wrote.length > 0, level: lv, files: wrote, added, removed }
}

/** 给 status 看的一句话 */
export function widgetStatus(dshHome) {
  const files = bubbleFiles(dshHome)
  return {
    files,
    available: files.length > 0,
    texts: files.length ? currentTexts(files[0]) : [],
  }
}
