/**
 * lib/notify.mjs —— 系统通知（尽力而为，各平台走各自的原生命令）
 * ============================================================================
 * 设计前提：这不是养鱼的「主通路」，只是一条可选的额外提醒。
 * 微信插件是主通路；没装微信的人靠「页面红点 + 下次对话提一句」，系统通知是锦上添花。
 *
 *   darwin  → osascript display notification（稳）
 *   linux   → notify-send（有桌面就稳，没有就失败）
 *   win32   → WinRT toast。⚠️ 需要系统里有注册过的 AppUserModelId，
 *             否则 PowerShell 会报 0x80073D54（这台机器实测就是这样），
 *             所以 Windows 默认关，要用的人自己去设置里开，失败也只记一句。
 *
 * 所有函数都不抛异常，失败返回 { ok: false, error }，调用方无视即可。
 * ============================================================================
 */
import { spawn } from 'node:child_process'

/** 这个平台能不能发系统通知（只是粗判，真发一次失败才算失败） */
export const supported = () => process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'

function run(cmd, args, timeoutMs = 10_000, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    } catch (e) {
      resolve({ code: -1, err: String(e?.message || e) })
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 无所谓 */ }
      resolve({ code: -1, err: '超时 ' + timeoutMs + 'ms' })
    }, timeoutMs)
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { out += String(b) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String(e?.message || e) }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out: out.slice(-400) }) })
  })
}

/** 单引号包起来的 AppleScript 字符串 */
const aq = (s) => '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

const WINDOWS_PS = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
  '$x = \'<toast duration="short"><visual><binding template="ToastGeneric"><text>\' + $env:DSH_NOTIFY_TITLE + \'</text><text>\' + $env:DSH_NOTIFY_BODY + \'</text></binding></visual></toast>\'',
  '$d = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$d.LoadXml($x)',
  '$t = New-Object Windows.UI.Notifications.ToastNotification $d',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($t)",
].join('\n')

/**
 * 发一条系统通知。返回 { ok, platform, error? }
 * 不重试、不阻塞太久：发不出去就是发不出去，日记已经写好了才是要紧事。
 */
export async function sendSystem({ title, body } = {}) {
  const t = String(title || '小肥鱼')
  const b = String(body || '')
  const p = process.platform
  if (p === 'darwin') {
    const r = await run('osascript', ['-e', 'display notification ' + aq(b) + ' with title ' + aq(t)])
    return { ok: r.code === 0, platform: p, error: r.code === 0 ? '' : (r.err || r.out || ('code=' + r.code)) }
  }
  if (p === 'linux') {
    const r = await run('notify-send', [t, b])
    return { ok: r.code === 0, platform: p, error: r.code === 0 ? '' : (r.err || r.out || ('code=' + r.code)) }
  }
  if (p === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS], 20_000, {
      env: { ...process.env, DSH_NOTIFY_TITLE: t, DSH_NOTIFY_BODY: b },
    })
    return { ok: r.code === 0, platform: p, error: r.code === 0 ? '' : String(r.err || r.out || ('code=' + r.code)).slice(0, 300) }
  }
  return { ok: false, platform: p, error: '这个平台没接系统通知：' + p }
}
