/**
 * lib/image.mjs —— 给日记配一张图（复用 agnes-image 插件的 key 和接口）
 * ============================================================================
 * 不自己发明一套配置：直接读 agnes-image 插件家目录的 config.json
 *   ~/.dsh/agnes-image/config.json → { apiKey, provider, endpoint, compatModel, model }
 * 这样主人在那边换 key / 换模型，这里自动跟着变。
 *
 * 官方：POST https://api.agnes-ai.cn/v1/images/generations
 *   body { model, prompt, size, extra_body: { response_format: 'b64_json' } }
 * 自定义（provider === 'compat'）：POST 到 cfg.endpoint，OpenAI 兼容体
 *
 * 任何失败都返回 { ok:false }——配图是点缀，不能拖垮写日记。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const AGNES_CFG = () => path.join(dshHome(), 'agnes-image', 'config.json')
const AGNES_ENDPOINT = 'https://api.agnes-ai.cn/v1/images/generations'
const AGNES_MODELS = ['agnes-image-2.1-flash', 'agnes-image-2.5-flash']

/** 读 agnes 插件配置（坏了当空） */
export const readAgnesConfig = () => {
  try {
    const j = JSON.parse(fs.readFileSync(AGNES_CFG(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

const sniffExt = (buf) => {
  if (!buf || buf.length < 12) return 'png'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.toString('ascii', 0, 4) === 'RIFF') return 'webp'
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'png'
}

/**
 * 组装一次请求计划；provider 配置不全就返回 null。
 * 注意：主人的 agnes 插件可能只填了「自定义接口」的 endpoint/model 却没把 provider 存成 compat，
 * 这种情况 key 往往是自定义接口的，打官方会 401 —— 所以下面会自动互相回退。
 */
const buildPlan = (provider, cfg, apiKey, prompt, size) => {
  if (provider === 'compat') {
    const endpoint = String(cfg.endpoint || '').trim()
    const model = String(cfg.compatModel || '').trim()
    if (!endpoint || !model) return null
    return { provider, endpoint, model, apiKey, body: { model, prompt, size, n: 1 } }
  }
  const model = AGNES_MODELS.includes(String(cfg.model || '').trim())
    ? String(cfg.model).trim()
    : AGNES_MODELS[0]
  return {
    provider,
    endpoint: AGNES_ENDPOINT,
    model,
    apiKey,
    body: { model, prompt, size, extra_body: { response_format: 'b64_json' } },
  }
}

/** 打一次接口，成功返回图片字节，失败抛错（带可读原因） */
const callOnce = async (plan) => {
  const res = await fetch(plan.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${plan.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(plan.body),
    signal: AbortSignal.timeout(240_000),
  })
  const raw = await res.text()
  let json = null
  try {
    json = JSON.parse(raw)
  } catch {}
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || raw.slice(0, 300)
    throw new Error(`[${plan.provider}] HTTP ${res.status}：${detail}`)
  }
  const item = json?.data?.[0] ?? json?.images?.[0] ?? null
  if (!item) throw new Error(`[${plan.provider}] 返回空结果：${raw.slice(0, 300)}`)
  let bytes = null
  const b64 = item.b64_json ?? item.b64 ?? (typeof item === 'string' ? item : null)
  if (b64) bytes = Buffer.from(String(b64), 'base64')
  else if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(120_000) })
    if (!img.ok) throw new Error(`[${plan.provider}] 图片 URL 下载失败 HTTP ${img.status}`)
    bytes = Buffer.from(await img.arrayBuffer())
  }
  if (!bytes || !bytes.length) throw new Error(`[${plan.provider}] 图片数据为空`)
  return bytes
}

/**
 * 生一张图并落盘。
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.size]   1024x1024 / 1024x768 / 768x1024
 * @param {string} opts.outDir   落盘目录
 * @param {string} opts.basename 文件名（不含扩展名）
 * @param {number} [opts.retry]  每个接口来源的失败重试次数
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, model?:string, provider?:string, error?:string}>}
 */
export const generateDiaryImage = async (opts = {}) => {
  const { prompt, size = '1024x1024', outDir, basename = 'cover', retry = 1 } = opts
  const cfg = readAgnesConfig()
  const apiKey = String(cfg.apiKey || process.env.AGNES_API_KEY || '').trim()
  if (!apiKey) return { ok: false, error: 'agnes-image 没配置 apiKey' }

  const primary = cfg.provider === 'compat' ? 'compat' : 'agnes'
  const order = [primary, primary === 'agnes' ? 'compat' : 'agnes']
  const plans = []
  for (const p of order) {
    const plan = buildPlan(p, cfg, apiKey, prompt, size)
    if (plan) plans.push(plan)
  }
  if (!plans.length) return { ok: false, error: 'agnes-image 里既没有官方模型也没有可用的自定义接口' }

  let lastErr = ''
  for (const plan of plans) {
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      try {
        const bytes = await callOnce(plan)
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.join(outDir, `${basename}.${sniffExt(bytes)}`)
        fs.writeFileSync(file, bytes)
        return { ok: true, path: file, bytes: bytes.length, model: plan.model, provider: plan.provider }
      } catch (e) {
        lastErr = String(e && e.message ? e.message : e)
      }
    }
  }
  return { ok: false, error: lastErr || '未知错误' }
}

/** 给「日记配图」用的画面提示词（固定画风，别让模型每次自由发挥） */
export const diaryImagePrompt = (scene) => {
  const s = String(scene || '').trim().slice(0, 400)
  return [
    '一个手绘绘本风格的温馨小场景：一位鲸鱼娘（拟人化，银蓝色长发、发梢像湿透的浅海、深海蓝的眼睛、粗壮圆润的鲸鱼尾巴、小小的鳍状耳朵），Q 版可爱但不幼态。',
    s ? `画面内容：${s}。` : '画面内容：安静的水下小屋，暖色调。',
    '风格：日系绘本、柔光、低饱和暖色、纸纹质感、构图简洁、留白多；不要文字，不要水印。',
  ].join('')
}
