/**
 * dsh-bili-fish —— 浏览器半端（「设置」里的一页：养鱼）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本（跟 dsh-bili-scroll 同一套约定）：
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-bili-fish',              // 必须等于 package.json 的 name
 *     factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *   })
 *
 * 这一页的形状（使用者 m01042 拍板的）：
 *   · 总开关 → 打开后展开：生物钟窗口 / 今天不想看的概率 / 现在写一篇
 *   · 状态行：今天计划几点醒、上次结果
 *   · 日记：今天的「给主人的信」和「自己的日记」直接看
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-fish',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-fish'
    const jget = async (p) => (await fetch(API + p, { credentials: 'same-origin' })).json()
    const jpost = async (p, body) => (await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).json()

    const CSS = `
[data-bf-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-bf-sec]{display:flex;flex-direction:column;gap:8px;}
[data-bf-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bf-row]{display:flex;align-items:center;gap:10px;}
[data-bf-grow]{flex:1;min-width:0;}
[data-bf-label]{font-size:13px;}
[data-bf-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bf-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bf-sw][data-on]{background:#3b82f6;}
[data-bf-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bf-sw][data-on] i{left:19px;}
[data-bf-sw][disabled]{opacity:.45;cursor:default;}
[data-bf-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-bf-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  background:var(--dsw-alias-bg-l2,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));
  color:inherit;outline:none;}
[data-bf-btn]{appearance:none;border:0;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;
  background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.14));color:inherit;}
[data-bf-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22));}
[data-bf-btn][data-primary]{background:#3b82f6;color:#fff;}
[data-bf-btn][disabled]{opacity:.5;cursor:default;}
[data-bf-card]{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:10px;padding:10px 12px;
  font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;}
[data-bf-pill]{font-size:11px;padding:1px 8px;border-radius:9px;background:rgba(128,128,128,.16);}
[data-bf-err]{font-size:12px;color:#ef4444;}
`

    function Switch({ on, disabled, onChange }) {
      return h('button', {
        'data-bf-sw': '', 'data-on': on ? '' : undefined, disabled: disabled || undefined,
        onClick: () => { if (!disabled) onChange(!on) },
        title: on ? '已打开' : '已关闭',
      }, h('i'))
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [diary, setDiary] = React.useState(null)
      const [showDiary, setShowDiary] = React.useState(false)

      const load = async () => {
        try {
          const r = await jget('/status')
          if (r && r.ok) { setSt(r); setErr('') } else setErr((r && r.error) || '状态加载失败')
        } catch (e) { setErr(String((e && e.message) || e)) }
      }
      React.useEffect(() => {
        load()
        const t = setInterval(load, 30_000)
        return () => clearInterval(t)
      }, [])

      const patch = async (p, label) => {
        setBusy(true)
        try {
          const r = await jpost('/config', p)
          if (!r.ok) setErr(r.error || (label + ' 失败'))
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
        load()
      }

      const runNow = async () => {
        setBusy(true)
        try {
          const r = await jpost('/run')
          if (!r.ok) setErr(r.error || '写日记失败（看日志）')
          await load()
          if (showDiary) await loadDiary()
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
      }

      const loadDiary = async () => {
        try {
          const r = await jget('/diary')
          if (r && r.ok) setDiary(r)
        } catch (e) { setErr(String((e && e.message) || e)) }
      }

      const toggleDiary = async () => {
        const next = !showDiary
        setShowDiary(next)
        if (next) await loadDiary()
      }

      if (!st) {
        return h('div', { 'data-bf-page': '' },
          h('div', { 'data-bf-note': '' }, '养鱼：加载中…'),
          err ? h('div', { 'data-bf-err': '' }, err) : null)
      }

      const planLine = st.plan && st.plan.day === st.today
        ? (st.plan.skip ? '今天掷到了「不想看」，会醒一下但不写日记。' : ('今天计划 ' + (st.plan.at ? new Date(st.plan.at).toLocaleString() : '') + ' 醒。'))
        : '今天还没有计划（还没到窗口）。'
      const todayLine = st.hasOwner && st.hasSelf ? '今天的日记已经写好了。' : '今天的日记还没写。'

      return h('div', { 'data-bf-page': '' },
        h('style', null, CSS),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '养鱼'),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '让它自己养着'),
              h('div', { 'data-bf-note': '' }, '每天在一个窗口里随机醒一次，写两篇日记：给你的信、它自己的日记。素材读「刷B站」写好的报告。')),
            h(Switch, { on: st.enabled, disabled: busy, onChange: (v) => patch({ enabled: v }, '总开关') })),
          st.enabled ? h('div', { 'data-bf-sub': '' },
            h('div', { 'data-bf-row': '' },
              h('div', { 'data-bf-grow': '' },
                h('div', { 'data-bf-label': '' }, '生物钟窗口'),
                h('div', { 'data-bf-note': '' }, '在这个时间段里随机一个时刻醒；窗口过了而今天没写，会现在补一次。')),
              h('input', {
                'data-bf-input': '', type: 'time', value: st.windowStart, style: { width: '92px' },
                onChange: (e) => patch({ windowStart: e.target.value }, '开始时间'),
              }),
              h('span', { 'data-bf-note': '' }, '→'),
              h('input', {
                'data-bf-input': '', type: 'time', value: st.windowEnd, style: { width: '92px' },
                onChange: (e) => patch({ windowEnd: e.target.value }, '结束时间'),
              })),
            h('div', { 'data-bf-row': '' },
              h('div', { 'data-bf-grow': '' },
                h('div', { 'data-bf-label': '' }, '今天不想看的概率'),
                h('div', { 'data-bf-note': '' }, '掷到就只看不写（默认 30%，别调太低——它也需要摆烂）。')),
              h('input', {
                'data-bf-input': '', type: 'number', min: 0, max: 100, step: 5,
                value: st.skipProbability, style: { width: '76px' },
                onChange: (e) => patch({ skipProbability: Number(e.target.value) }, '概率'),
              }), h('span', { 'data-bf-note': '' }, '%')),
            h('div', { 'data-bf-row': '' },
              h('div', { 'data-bf-grow': '' },
                h('div', { 'data-bf-label': '' }, '写完推送到微信'),
                h('div', { 'data-bf-note': '' }, '日记写好后通过微信插件发一条过来（两篇合成一条）；不想收就关掉。')),
              h(Switch, { on: st.wechatPush !== false, disabled: busy, onChange: (v) => patch({ wechatPush: v }, '微信推送') })),
            h('div', { 'data-bf-row': '' },
              h('div', { 'data-bf-grow': '' },
                h('div', { 'data-bf-label': '' }, '日记存到哪'),
                h('div', { 'data-bf-note': '' }, '现在写到这里：' + (st.diaryDir || '') + '（留空就用这个默认目录；填别的盘也行）')),
              h('input', {
                'data-bf-input': '', type: 'text', value: st.diaryDirCfg || '', placeholder: st.diaryDir || '',
                style: { width: '240px' },
                onChange: (e) => patch({ diaryDir: e.target.value }, '日记目录'),
              })),
            h('div', { 'data-bf-row': '' },
              h('div', { 'data-bf-grow': '' },
                h('div', { 'data-bf-label': '' }, '现在就写一篇'),
                h('div', { 'data-bf-note': '' }, '不等生物钟，立刻写今天的；调试或补写用。')),
              h('button', {
                'data-bf-btn': '', 'data-primary': busy ? undefined : '', disabled: busy || undefined,
                onClick: runNow,
              }, busy ? '正在写…' : '写一篇')),
          ) : null),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '状态'),
          h('div', { 'data-bf-row': '' },
            h('span', { 'data-bf-pill': '' }, st.enabled ? '养着' : '停着'),
            h('span', { 'data-bf-note': '' }, planLine)),
          h('div', { 'data-bf-note': '' }, todayLine),
          st.lastResult ? h('div', { 'data-bf-note': '' }, '上次：' + st.lastResult + (st.lastWake ? '（' + new Date(st.lastWake).toLocaleString() + '）' : '')) : null,
          st.wechatResult ? h('div', { 'data-bf-note': '' }, '微信：' + st.wechatResult) : null),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' }, h('div', { 'data-bf-h': '' }, '今天的日记')),
            h('button', { 'data-bf-btn': '', onClick: toggleDiary }, showDiary ? '收起来' : '看看')),
          showDiary && diary ? h('div', { 'data-bf-sec': '' },
            h('div', { 'data-bf-h': '' }, '给主人的信'),
            h('div', { 'data-bf-card': '' }, diary.owner || '（还没写）'),
            h('div', { 'data-bf-h': '' }, '自己的日记'),
            h('div', { 'data-bf-card': '' }, diary.self || '（还没写）')) : null),

        err ? h('div', { 'data-bf-err': '' }, err) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-fish', order: 31, label: '养鱼' },
          () => h(Panel),
        ))
      },
    }
  },
})
