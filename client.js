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
 * v0.2 这一页加了三块：
 *   · 好感度：数字 + 一句描述 + 进度条 + 最近结算记录 + 手动 ±；
 *   · 新功能开关：记忆 / 配图 / 周回顾 / 随机小事 / 醒的时候找主人；
 *   · 日记：今天那两篇 + 历史列表（点哪天看哪天，顺带看配图）。
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
[data-bf-btn][data-tiny]{padding:3px 8px;font-size:11px;border-radius:6px;}
[data-bf-card]{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:10px;padding:10px 12px;
  font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;}
[data-bf-pill]{font-size:11px;padding:1px 8px;border-radius:9px;background:rgba(128,128,128,.16);}
[data-bf-err]{font-size:12px;color:#ef4444;}
[data-bf-heart]{display:flex;align-items:center;gap:12px;}
[data-bf-num]{font-size:30px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;}
[data-bf-bar]{position:relative;height:8px;border-radius:4px;overflow:hidden;
  background:linear-gradient(90deg,rgba(239,68,68,.35),rgba(128,128,128,.25) 50%,rgba(59,130,246,.45));}
[data-bf-bar] i{position:absolute;top:-2px;width:3px;height:12px;background:#fff;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.25);}
[data-bf-hist]{display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bf-hist] b{font-weight:600;}
[data-bf-days]{display:flex;flex-wrap:wrap;gap:6px;}
[data-bf-img]{max-width:100%;border-radius:10px;display:block;}
`

    function Switch({ on, disabled, onChange }) {
      return h('button', {
        'data-bf-sw': '', 'data-on': on ? '' : undefined, disabled: disabled || undefined,
        onClick: () => { if (!disabled) onChange(!on) },
        title: on ? '已打开' : '已关闭',
      }, h('i'))
    }

    /** 好感度卡片：数字 / 描述 / 进度条 / 手动 ± / 最近记录 */
    function AffectionBox({ st, busy, onAdjust, onReset }) {
      const a = st.affection || { value: 50, desc: '', history: [] }
      const v = Number(a.value) || 0
      const pct = Math.max(0, Math.min(100, ((v + 100) / 200) * 100))
      const sign = v > 0 ? '+' : ''
      const btns = [-5, -1, 1, 5].map((d) => h('button', {
        key: 'a' + d, 'data-bf-btn': '', 'data-tiny': '', disabled: busy || undefined,
        onClick: () => onAdjust(d),
      }, (d > 0 ? '+' : '') + d))
      return h('div', { 'data-bf-sec': '' },
        h('div', { 'data-bf-h': '' }, '好感度'),
        h('div', { 'data-bf-heart': '' },
          h('div', { 'data-bf-num': '', style: { color: v < 0 ? '#ef4444' : (v >= 60 ? '#3b82f6' : 'inherit') } }, sign + v),
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-note': '' }, a.desc || '平常'),
            h('div', { 'data-bf-bar': '', style: { marginTop: '6px' } }, h('i', { style: { left: 'calc(' + pct + '% - 1.5px)' } })),
            h('div', { 'data-bf-note': '', style: { marginTop: '4px', opacity: .7 } }, '−100 到 100，初始 50。换会话也不会重开了。'))),
        h('div', { 'data-bf-row': '', style: { flexWrap: 'wrap' } },
          btns,
          h('button', { 'data-bf-btn': '', 'data-tiny': '', disabled: busy || undefined, onClick: onReset }, '重置为 50'),
          h('div', { 'data-bf-grow': '' }),
          a.updatedAt ? h('span', { 'data-bf-note': '' }, '上次结算 ' + new Date(a.updatedAt).toLocaleString()) : null),
        (a.history && a.history.length) ? h('div', { 'data-bf-hist': '' },
          a.history.slice(0, 5).map((x, i) => h('div', { key: 'h' + i },
            h('b', null, (x.delta > 0 ? '+' : '') + x.delta),
            '  ' + (x.mood || '') + (x.reason ? ' · ' + x.reason : ''),
            h('span', { style: { opacity: .6 } }, '  ' + (x.day || ''))))) : null,
      )
    }

    /** 心情卡片：现在什么心情 / 浓度 / 一键换 / 微调 */
    function MoodBox({ st, busy, onSet, onBump }) {
      const m = st.mood || { key: 'happy', label: '开心', intensity: 65, desc: '', list: [] }
      const list = (m.list && m.list.length) ? m.list : [
        { key: 'happy', label: '开心' }, { key: 'excited', label: '兴奋' }, { key: 'clingy', label: '黏人' },
        { key: 'proud', label: '得意' }, { key: 'calm', label: '平静' }, { key: 'sleepy', label: '犯困' },
        { key: 'bored', label: '摆烂' }, { key: 'pouty', label: '赌气' }, { key: 'aggrieved', label: '委屈' },
        { key: 'low', label: '低落' },
      ]
      const i = Math.max(0, Math.min(100, Number(m.intensity) || 0))
      return h('div', { 'data-bf-sec': '' },
        h('div', { 'data-bf-h': '' }, '此刻的心情'),
        h('div', { 'data-bf-heart': '' },
          h('div', { 'data-bf-num': '', style: { fontSize: '22px' } }, m.label || '开心'),
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-note': '' }, m.desc || ''),
            h('div', { 'data-bf-bar': '', style: { marginTop: '6px' } }, h('i', { style: { left: 'calc(' + i + '% - 1.5px)' } })),
            h('div', { 'data-bf-note': '', style: { marginTop: '4px', opacity: .7 } },
              '浓度 ' + i + (m.reason ? ' · ' + m.reason : '') + (m.at ? ' · ' + new Date(m.at).toLocaleString() : '')))),
        h('div', { 'data-bf-row': '', style: { flexWrap: 'wrap' } },
          list.map((x) => h('button', {
            key: x.key, 'data-bf-btn': '', 'data-tiny': '', disabled: busy || undefined,
            style: x.key === m.key ? { outline: '2px solid #3b82f6' } : null,
            onClick: () => onSet(x.key),
          }, x.label))),
        h('div', { 'data-bf-row': '', style: { flexWrap: 'wrap' } },
          [-20, -10, 10, 20].map((d) => h('button', {
            key: 'm' + d, 'data-bf-btn': '', 'data-tiny': '', disabled: busy || undefined,
            onClick: () => onBump(d),
          }, '浓度 ' + (d > 0 ? '+' : '') + d)),
          h('div', { 'data-bf-note': '', style: { opacity: .7, alignSelf: 'center' } }, '心情会随时间自己淡回「开心」，好感度越低也越容易沉下去。')),
        (m.history && m.history.length) ? h('div', { 'data-bf-hist': '' },
          m.history.slice(0, 5).map((x, k) => h('div', { key: 'mh' + k },
            h('b', null, x.label || x.key),
            '  ' + (x.intensity || 0) + (x.reason ? ' · ' + x.reason : ''),
            h('span', { style: { opacity: .6 } }, '  ' + (x.at ? new Date(x.at).toLocaleString() : ''))))) : null,
      )
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [diary, setDiary] = React.useState(null)
      const [showDiary, setShowDiary] = React.useState(false)
      const [days, setDays] = React.useState([])
      const [day, setDay] = React.useState('')
      const [showHist, setShowHist] = React.useState(false)

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
          if (showDiary) await loadDiary(day || undefined)
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
      }

      const runWeek = async () => {
        setBusy(true)
        try {
          const r = await jpost('/week')
          if (!r.ok) setErr(r.error || '周回顾失败（看日志）')
          await load()
          if (showDiary) await loadDiary(day || undefined)
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
      }

      const loadDiary = async (d) => {
        try {
          const r = await jget('/diary' + (d ? '?day=' + encodeURIComponent(d) : ''))
          if (r && r.ok) setDiary(r)
        } catch (e) { setErr(String((e && e.message) || e)) }
      }

      const loadDays = async () => {
        try {
          const r = await jget('/diaries')
          if (r && r.ok) setDays(r.list || [])
        } catch (e) { setErr(String((e && e.message) || e)) }
      }

      const toggleDiary = async () => {
        const next = !showDiary
        setShowDiary(next)
        if (next) await loadDiary(day || undefined)
      }

      const adjust = async (delta) => {
        setBusy(true)
        try {
          const r = await jpost('/affection', { action: 'adjust', delta, reason: '设置页手动调', source: 'settings' })
          if (!r.ok) setErr(r.error || '调整失败')
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
        load()
      }
      const resetAff = async () => {
        setBusy(true)
        try {
          const r = await jpost('/affection', { action: 'reset' })
          if (!r.ok) setErr(r.error || '重置失败')
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
        load()
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

      const openDay = async (d) => {
        setShowDiary(true)
        await loadDiary(d)
      }

      const toggleHist = async () => {
        const next = !showHist
        setShowHist(next)
        if (next) await loadDays()
      }

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
                h('div', { 'data-bf-note': '' }, '日记写好后通过微信插件发一条过来（两篇合成一条，有配图一起带上）；不想收就关掉。')),
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

        /* ── 好感度 ── */
        h(AffectionBox, { st, busy, onAdjust: adjust, onReset: resetAff }),

        /* ── 心情 ── */
        h(MoodBox, {
          st, busy,
          onSet: async (key) => {
            setBusy(true)
            try {
              const r = await jpost('/mood', { action: 'set', key, reason: '设置页手动换' })
              if (!r || !r.ok) setErr((r && r.error) || '换心情失败')
              await load()
            } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
          },
          onBump: async (delta) => {
            setBusy(true)
            try {
              const r = await jpost('/mood', { action: 'bump', delta, reason: '设置页微调' })
              if (!r || !r.ok) setErr((r && r.error) || '调心情失败')
              await load()
            } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
          },
        }),

        /* ── 新功能开关 ── */
        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '日子怎么过'),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '接记忆'),
              h('div', { 'data-bf-note': '' }, '写日记前查一下你最近提过的事（meow-memory），日记摘要也回写进记忆库。' + (st.memoryDbResolved ? '' : '（还没找到记忆库）'))),
            h(Switch, { on: st.config.memoryEnabled !== false, disabled: busy, onChange: (v) => patch({ memoryEnabled: v }, '记忆') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '给日记配一张图'),
              h('div', { 'data-bf-note': '' }, '用 agnes-image 的 key 画一张（1024x1024），存在日记目录，推送时一起发。慢一点，失败就算了。')),
            h(Switch, { on: st.config.imageEnabled !== false, disabled: busy, onChange: (v) => patch({ imageEnabled: v }, '配图') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '周日写「这周」'),
              h('div', { 'data-bf-note': '' }, '每周日多写一篇回顾，读这七天的日记。')),
            h(Switch, { on: st.config.weeklyReview !== false, disabled: busy, onChange: (v) => patch({ weeklyReview: v }, '周回顾') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '随机小事件'),
              h('div', { 'data-bf-note': '' }, '每天掷一句环境小事（下雨、风扇响、网卡了），免得日子写成一个模子。')),
            h(Switch, { on: st.config.randomEvent !== false, disabled: busy, onChange: (v) => patch({ randomEvent: v }, '随机小事') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '醒的时候找主人'),
              h('div', { 'data-bf-note': '' }, '推送开头说一句它今天看到你在忙什么（不泄漏日记全文）。只在开微信推送时生效。')),
            h(Switch, { on: st.config.proactivePush !== false, disabled: busy, onChange: (v) => patch({ proactivePush: v }, '主动说话') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '每天好感度最多动'),
              h('div', { 'data-bf-note': '' }, '写日记时它自己结算一次，幅度限制在这里（persona 里是 ±15）。')),
            h('input', {
              'data-bf-input': '', type: 'number', min: 1, max: 15, step: 1,
              value: st.config.affectionDaily, style: { width: '76px' },
              onChange: (e) => patch({ affectionDaily: Number(e.target.value) }, '好感度幅度'),
            }), h('span', { 'data-bf-note': '' }, '±')),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '心情系统'),
              h('div', { 'data-bf-note': '' }, '日记结算心情、对话里也按心情来（人设 4.4），心情会随时间自己淡回去。')),
            h(Switch, { on: st.config.moodEnabled !== false, disabled: busy, onChange: (v) => patch({ moodEnabled: v }, '心情') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '心情多久开始淡回去'),
              h('div', { 'data-bf-note': '' }, '小时数。过了这个时间的半衰期，心情慢慢变回底色（默认开心）。')),
            h('input', {
              'data-bf-input': '', type: 'number', min: 1, max: 72, step: 1,
              value: st.config.moodTtlHours, style: { width: '76px' },
              onChange: (e) => patch({ moodTtlHours: Number(e.target.value) }, '心情时长'),
            }), h('span', { 'data-bf-note': '' }, '小时')),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '写一篇这周（手动）'),
              h('div', { 'data-bf-note': '' }, '不等周日，现在就让ta回顾一下最近七天。')),
            h('button', { 'data-bf-btn': '', disabled: busy || undefined, onClick: runWeek }, '写周回顾')),
        ),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '状态'),
          h('div', { 'data-bf-row': '' },
            h('span', { 'data-bf-pill': '' }, st.enabled ? '养着' : '停着'),
            h('span', { 'data-bf-note': '' }, planLine)),
          h('div', { 'data-bf-note': '' }, todayLine),
          st.lastResult ? h('div', { 'data-bf-note': '' }, '上次：' + st.lastResult + (st.lastWake ? '（' + new Date(st.lastWake).toLocaleString() + '）' : '')) : null,
          st.wechatResult ? h('div', { 'data-bf-note': '' }, '微信：' + st.wechatResult) : null,
          st.memoryResult ? h('div', { 'data-bf-note': '' }, '记忆：' + st.memoryResult) : null,
          st.imageResult ? h('div', { 'data-bf-note': '' }, '配图：' + st.imageResult) : null,
          st.weekResult ? h('div', { 'data-bf-note': '' }, '周回顾：' + st.weekResult) : null),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' }, h('div', { 'data-bf-h': '' }, '今天的日记')),
            h('button', { 'data-bf-btn': '', onClick: () => loadDiary(undefined) }, '刷新'),
            h('button', { 'data-bf-btn': '', onClick: toggleDiary }, showDiary ? '收起来' : '看看')),
          showDiary && diary ? h('div', { 'data-bf-sec': '' },
            h('div', { 'data-bf-note': '' }, diary.day === st.today ? '今天' : diary.day),
            h('div', { 'data-bf-h': '' }, '给主人的信'),
            h('div', { 'data-bf-card': '' }, diary.owner || '（还没写）'),
            h('div', { 'data-bf-h': '' }, '自己的日记'),
            h('div', { 'data-bf-card': '' }, diary.self || '（还没写）'),
            diary.week ? h('div', { 'data-bf-sec': '' },
              h('div', { 'data-bf-h': '' }, '这周'),
              h('div', { 'data-bf-card': '' }, diary.week)) : null) : null),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' }, h('div', { 'data-bf-h': '' }, '历史')),
            h('button', { 'data-bf-btn': '', onClick: toggleHist }, showHist ? '收起来' : '看看往天')),
          showHist ? h('div', { 'data-bf-days': '' },
            days.length ? days.map((d) => h('button', {
              key: d.day, 'data-bf-btn': '', 'data-tiny': '',
              onClick: () => openDay(d.day),
            }, d.day + (d.hasSelf && d.hasOwner ? '' : ' ⚠'))) : h('div', { 'data-bf-note': '' }, '还没有历史日记。')) : null),

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
