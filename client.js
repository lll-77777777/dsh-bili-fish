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
[data-bf-unread]{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;
  background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);}
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

    /** 文本输入：本地草稿，失焦或回车才提交（避免每敲一个字就发请求、输入被打断） */
    function TextBox({ value, placeholder, width, onCommit, disabled }) {
      const [draft, setDraft] = React.useState(String(value == null ? '' : value))
      const editing = React.useRef(false)
      React.useEffect(() => {
        if (!editing.current) setDraft(String(value == null ? '' : value))
      }, [value])
      const commit = () => {
        editing.current = false
        const next = String(draft == null ? '' : draft)
        const prev = String(value == null ? '' : value)
        if (next !== prev) onCommit(next)
      }
      return h('input', {
        'data-bf-input': '', type: 'text', value: draft,
        placeholder, disabled: disabled || undefined,
        style: { width: width || '240px' },
        onFocus: () => { editing.current = true },
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
      })
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
            h('div', { 'data-bf-note': '', style: { marginTop: '4px', opacity: .7 } },
              a.tier ? ('档位 ' + a.tier.label + '｜怎么叫：' + a.tier.call + '｜干活：' + a.tier.effort) : '−100 到 100，初始 50。换会话也不会重开了。'))),
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

    /** 情绪卡片：主导心情 + 舒服度/躁动度 + 成分 + 事件注入 */
    function MoodBox({ st, busy, onSet, onEvent }) {
      const m = st.mood || { dominant: 'happy', label: '开心', valence: 20, arousal: 50, blend: [], events: [], eventList: [] }
      const v = Math.max(-100, Math.min(100, Number(m.valence) || 0))
      const a = Math.max(0, Math.min(100, Number(m.arousal) || 0))
      const evs = (m.eventList && m.eventList.length) ? m.eventList : [
        { kind: 'praised', label: '被夸' }, { kind: 'cared', label: '被关心' }, { kind: 'workedWell', label: '一起把事办成' },
        { kind: 'fed', label: '喂饱了' }, { kind: 'ignored', label: '被冷落' }, { kind: 'scolded', label: '被凶' },
        { kind: 'questioned', label: '被质疑能力' }, { kind: 'redone', label: '同一处被反复改' },
        { kind: 'lateWork', label: '深夜还在干活' }, { kind: 'hungry', label: '饿' },
        { kind: 'rain', label: '阴雨天' }, { kind: 'calledFat', label: '被叫胖' },
      ]
      const blend = (m.blend || []).filter(Boolean)
      return h('div', { 'data-bf-sec': '' },
        h('div', { 'data-bf-h': '' }, '此刻的情绪'),
        h('div', { 'data-bf-heart': '' },
          h('div', { 'data-bf-num': '', style: { fontSize: '22px' } }, m.label || '开心'),
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-note': '' }, m.desc || ''),
            h('div', { 'data-bf-note': '', style: { marginTop: '6px', opacity: .8 } }, '舒服度 ' + Math.round(v) + '（-100 难受 / +100 很舒服）'),
            h('div', { 'data-bf-bar': '' }, h('i', { style: { left: 'calc(' + Math.round((v + 100) / 2) + '% - 1.5px)' } })),
            h('div', { 'data-bf-note': '', style: { marginTop: '4px', opacity: .8 } },
              '躁动度 ' + Math.round(a) + (m.dailyOffset ? '（日节律 ' + (m.dailyOffset > 0 ? '+' : '') + m.dailyOffset + '）' : '')),
            h('div', { 'data-bf-bar': '' }, h('i', { style: { left: 'calc(' + Math.round(a) + '% - 1.5px)' } })),
            blend.length ? h('div', { 'data-bf-note': '', style: { marginTop: '4px' } },
              '成分：' + blend.map((x) => (x.label || x.key) + ' ' + Math.round((x.weight || 0) * 100) + '%').join(' · ')) : null,
            h('div', { 'data-bf-note': '', style: { marginTop: '4px', opacity: .7 } },
              (m.reason || '') + (m.at ? ' · ' + new Date(m.at).toLocaleString() : '')))),
        h('div', { 'data-bf-note': '', style: { marginTop: '8px' } }, '发生一件事 → 推一下它（按「我的脾气」加权；好感度高时负面扣得少、恢复快）'),
        h('div', { 'data-bf-row': '', style: { flexWrap: 'wrap' } },
          evs.map((x) => h('button', {
            key: 'e' + x.kind, 'data-bf-btn': '', 'data-tiny': '', disabled: busy || undefined,
            onClick: () => onEvent(x.kind),
          }, x.label))),
        h('div', { 'data-bf-note': '', style: { opacity: .7 } }, '小事只记账不换脸；偏离底色超过 12 才真的换表现；会随时间往底色淡回去。'),
        (m.events && m.events.length) ? h('div', { 'data-bf-hist': '' },
          m.events.slice(0, 6).map((x, k) => h('div', { key: 'ev' + k },
            h('b', null, x.label || x.kind),
            '  ' + ((x.dV > 0 ? '+' : '') + (x.dV || 0)) + ' / ' + ((x.dA > 0 ? '+' : '') + (x.dA || 0)),
            (x.note ? ' · ' + x.note : ''),
            h('span', { style: { opacity: .6 } }, '  ' + (x.at ? new Date(x.at).toLocaleTimeString() : ''))))) : null,
      )
    }

    /** 喂食卡片：饱腹度 + 食物按钮 + 最近喂了什么 */
    function FoodBox({ st, busy, onFeed, onToggleWidget }) {
      const f = st.food || { satiety: 60, level: 'ok', levelText: '不饿', foods: [], todayList: [], history: [], streak: 0 }
      const s = Math.max(0, Math.min(100, Number(f.satiety) || 0))
      const foods = (f.foods && f.foods.length) ? f.foods : [
        { key: 'rice', label: '白饭' }, { key: 'fish', label: '小鱼干' }, { key: 'ramen', label: '拉面' },
        { key: 'cake', label: '小蛋糕' }, { key: 'soup', label: '热汤' }, { key: 'soda', label: '气泡水' },
        { key: 'ice', label: '冰淇淋' }, { key: 'coffee', label: '咖啡' },
        { key: 'chili', label: '辣条' }, { key: 'grass', label: '水草' }, { key: 'diet', label: '减肥餐' },
      ]
      const nameOf = (k) => {
        const hit = foods.find((x) => x.key === k)
        return hit ? hit.label : k
      }
      const tone = s >= 50 ? '#3b82f6' : s >= 30 ? '#eab308' : '#ef4444'
      return h('div', { 'data-bf-sec': '' },
        h('div', { 'data-bf-h': '' }, '喂食'),
        h('div', { 'data-bf-heart': '' },
          h('div', { 'data-bf-num': '', style: { color: tone } }, String(s)),
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-note': '' }, '饱腹度 · ' + (f.levelText || '') + (Number(f.streak) > 1 ? ' · 连续投喂 ' + f.streak + ' 天' : '')),
            h('div', { 'data-bf-bar': '' }, h('i', { style: { left: 'calc(' + s + '% - 1.5px)' } })),
            h('div', { 'data-bf-note': '', style: { marginTop: '4px', opacity: .7 } },
              ['full', 'ok', 'peckish'].includes(f.level)
                ? '不饿的时候也吃得下，就是会嫌你啰嗦。'
                : '饿了会真的不高兴（心情事件 hungry），喂一顿就好。'))),
        h('div', { 'data-bf-row': '', style: { flexWrap: 'wrap' } },
          foods.map((x) => h('button', {
            key: 'f' + x.key, 'data-bf-btn': '', 'data-tiny': '', disabled: busy || undefined,
            title: (x.kind === 'bad' || x.kind === 'rage') ? '会出事' : (x.note || ''),
            onClick: () => onFeed(x.key),
          }, x.label))),
        h('div', { 'data-bf-note': '', style: { opacity: .7 } },
          '白饭最顶饿；烫的会先吹两下再吃；辣条、水草、减肥餐会炸。你也可以在聊天里说「喂她一碗白饭」。'),
        onToggleWidget ? h('div', { 'data-bf-row': '' },
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-label': '' }, '同步到右下角的小鲸鱼'),
            h('div', { 'data-bf-note': '' },
              '前提：要先装 dsh-whale-widget（右下角那只小鲸鱼）——它只管显示，不能点着喂，饿了只会自己嘟囔。'
              + (st.widget && st.widget.available ? '（已找到 ' + (st.widget.files || []).length + ' 份配置）' : '（没找到挂件的数据文件，先去插件市场装它）')
              + ' 改完要在浏览器按 F5 才看得到。')),
          h(Switch, { on: st.config.widgetSync === true, disabled: busy, onChange: (v) => onToggleWidget(v) })) : null,
        (f.todayList && f.todayList.length) ? h('div', { 'data-bf-note': '' },
          '今天喂了 ' + f.todayList.length + ' 次：' + f.todayList.slice(-6).map((x) => nameOf(x.key)).join('、')) : null,
        (f.history && f.history.length) ? h('div', { 'data-bf-hist': '' },
          f.history.slice(0, 5).map((x, i) => h('div', { key: 'fh' + i },
            h('b', null, (x.delta > 0 ? '+' : '') + x.delta),
            '  ' + (x.label || nameOf(x.key)),
            h('span', { style: { opacity: .6 } }, '  ' + (x.day || ''))))) : null,
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

      const seenUnread = React.useRef('')
      const load = async () => {
        try {
          const r = await jget('/status')
          if (r && r.ok) {
            setSt(r); setErr('')
            /* 浏览器通知：只有设置里开着、且浏览器给了权限才发；同一条未读只弹一次 */
            const u = r.unread
            if (u && r.notify && r.notify.browser) {
              const key = String(u.at || '') + '|' + String(u.kind || '')
              if (seenUnread.current !== key) {
                seenUnread.current = key
                try {
                  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    new Notification('小肥鱼', { body: u.title || '有新内容写好了', tag: 'bili-fish' })
                  } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                    Notification.requestPermission()
                  }
                } catch { /* 浏览器不让就算了，页面里还有红点 */ }
              }
            }
          } else setErr((r && r.error) || '状态加载失败')
        } catch (e) { setErr(String((e && e.message) || e)) }
      }
      React.useEffect(() => {
        load()
        const t = setInterval(load, 30_000)
        return () => clearInterval(t)
      }, [])

      const srcRow = (label, key, note) => h('div', { 'data-bf-row': '' },
        h('div', { 'data-bf-grow': '' },
          h('div', { 'data-bf-label': '' }, label),
          h('div', { 'data-bf-note': '' }, note)),
        h(Switch, { on: st.config[key] !== false, disabled: busy, onChange: (v) => patch({ [key]: v }, label) }))

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

      const ackUnread = async () => {
        try { await jpost('/unread', { action: 'clear' }); await load() } catch (e) { setErr(String((e && e.message) || e)) }
      }

      const runWeek = async () => {        setBusy(true)
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

        /* 未读提醒：日记写好了但你还不知道的时候，这行先出现 */
        st.unread && st.notify && st.notify.badge ? h('div', { 'data-bf-unread': '' },
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-label': '' }, '🔴 ' + (st.unread.title || '有新内容写好了')),
            h('div', { 'data-bf-note': '' }, (st.unread.day || '') + ' · '
              + (st.unread.kind === 'morning' ? '早安' : st.unread.kind === 'diary' ? '日记' : String(st.unread.kind || '')))),
          h('button', { 'data-bf-btn': '', disabled: busy || undefined, onClick: ackUnread }, '知道了')) : null,

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
              h(TextBox, {
                value: st.diaryDirCfg || '', placeholder: st.diaryDir || '', width: '240px',
                onCommit: (v) => patch({ diaryDir: v }, '日记目录'),
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
          onEvent: async (kind) => {
            setBusy(true)
            try {
              const r = await jpost('/mood', { action: 'event', kind })
              if (!r || !r.ok) setErr((r && r.error) || '注入事件失败')
              await load()
            } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
          },
        }),

        /* ── 喂食 ── */
        h(FoodBox, {
          st, busy,
          onFeed: async (key) => {
            setBusy(true)
            try {
              const r = await jpost('/feed', { food: key })
              if (!r || !r.ok) setErr((r && r.error) || '喂食失败')
              await load()
            } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
          },
          onToggleWidget: (v) => patch({ widgetSync: v }, '挂件同步'),
        }),

        /* ── 早安推送 ── */
        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '早安推送'),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '每天早上第一次醒'),
              h('div', { 'data-bf-note': '' }, '醒来后在窗口内推一条：天气、穿什么、今天要注意的事、前一晚交代的待办，配一张表情包。电脑睡了一夜起来也会补上。')),
            h(Switch, { on: st.config.morningEnabled !== false, disabled: busy, onChange: (v) => patch({ morningEnabled: v }, '早安') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '城市'),
              h('div', { 'data-bf-note': '' }, '天气查这里（中文城市名；小城市可以填中国天气网的 9 位 key）。')),
            h(TextBox, {
              value: st.config.morningCity || '上海', width: '120px',
              onCommit: (v) => patch({ morningCity: v }, '早安城市'),
            })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '早安窗口'),
              h('div', { 'data-bf-note': '' }, '在这段时间里醒就推；过了窗口就不推，等第二天。')),
            h(TextBox, {
              value: st.config.morningWindowStart || '05:30', width: '64px',
              onCommit: (v) => patch({ morningWindowStart: v }, '早安开始'),
            }),
            h('span', { 'data-bf-note': '' }, '~'),
            h(TextBox, {
              value: st.config.morningWindowEnd || '11:30', width: '64px',
              onCommit: (v) => patch({ morningWindowEnd: v }, '早安结束'),
            })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '配表情包'),
              h('div', { 'data-bf-note': '' }, '从表情包目录里挑一张最贴心情的发出去。' + (st.morning && st.morning.memeDir ? '（' + st.morning.memeDir + '）' : '（没找到目录，留空会用 <工作区>/meme）'))),
            h(Switch, { on: st.config.morningImage !== false, disabled: busy, onChange: (v) => patch({ morningImage: v }, '早安配图') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '表情包目录'),
              h('div', { 'data-bf-note': '' }, '放 PNG/JPG 的目录，留空自动找工作区的 meme。')),
            h(TextBox, {
              value: st.config.morningMemeDir || '', placeholder: '自动', width: '240px',
              onCommit: (v) => patch({ morningMemeDir: v }, '表情包目录'),
            })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '每天早上掷一次「睡得怎么样」'),
              h('div', { 'data-bf-note': '' }, '醒来时掷一次身体状态（睡得好/没睡好/一般），心情从这件事上长出来——不再凭空抽一张心情。')),
            h(Switch, { on: st.config.morningRandomMood !== false, disabled: busy, onChange: (v) => patch({ morningRandomMood: v }, '身体状态') })),
          h('div', { 'data-bf-row': '' },
            h('button', {
              'data-bf-btn': '', disabled: busy || undefined,
              onClick: async () => {
                setBusy(true); setErr('')
                try {
                  const r = await jpost('/morning', { action: 'run' })
                  if (!r || !r.ok) setErr((r && r.error) || '推早安失败')
                  await load()
                } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
              },
            }, '现在推一条早安'),
            h('div', { 'data-bf-grow': '' }),
            (st.morning && st.morning.last) ? h('span', { 'data-bf-note': '' }, st.morning.last) : null),
          (st.morning && st.morning.today) ? h('div', { 'data-bf-hist': '' },
            h('div', null,
              h('b', null, st.morning.today.weather || ''),
              st.morning.today.image ? h('span', { style: { opacity: .6 } }, '  🖼 ' + st.morning.today.image) : null),
            st.morning.today.text ? h('div', { 'data-bf-note': '', style: { opacity: .75, marginTop: '4px' } }, st.morning.today.text.slice(0, 220)) : null) : null,
        ),

        /* ── 通知通路 ── */
        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '怎么让我告诉你有新内容'),
          h('div', { 'data-bf-note': '' }, '日记、早安写好了，用下面几种方式让你知道。一个都不开，就等于悄悄写在自己的硬盘里。'),
          srcRow('微信', 'wechatPush', '装了 dsh-wechat-plugin 才有这条；没装会失败，不影响日记本身。'),
          srcRow('页面红点', 'notifyBadge', '打开这一页时，顶上会冒一条「有新内容」，点掉就消。'),
          srcRow('浏览器通知', 'notifyBrowser', '这一页开着的时候，用系统通知弹一下（浏览器要你点一次允许）。'),
          srcRow('下次对话提一句', 'notifyInbox', '把未读留在状态里，下次聊天开头我会先提一句。'),
          srcRow('系统通知（实验）', 'notifySystem', '直接调系统通知。Windows 多半要额外注册，可能不弹；失败只记一句，不影响别的。'),
          st.notify && st.notify.systemPlatform === 'win32'
            ? h('div', { 'data-bf-note': '', style: { opacity: .7 } }, '（Windows 上这条我实测过，多半发不出来，别指望它。）') : null,
        ),

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
              h('div', { 'data-bf-label': '' }, '久不聊天会掉好感'),
              h('div', { 'data-bf-note': '' }, '超过这么多天没说话，之后每天 −1，最低到 20（0 = 关，默认关）。只在你真的很久没出现时才动。')),
            h('input', {
              'data-bf-input': '', type: 'number', min: 0, max: 365, step: 1,
              value: st.config.affectionDecayDays || 0, style: { width: '76px' },
              onChange: (e) => patch({ affectionDecayDays: Number(e.target.value) || 0 }, '闲聊衰减'),
            }), h('span', { 'data-bf-note': '' }, '天')),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '心情系统'),
              h('div', { 'data-bf-note': '' }, '事件驱动 + 人设加权 + 关系滤镜：同一件事按我的脾气放大，好感度高时负面扣得少、恢复快。')),
            h(Switch, { on: st.config.moodEnabled !== false, disabled: busy, onChange: (v) => patch({ moodEnabled: v }, '心情') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '跟着时辰起伏（日节律）'),
              h('div', { 'data-bf-note': '' }, '早上蔫、下午精神、夜里困。只影响显示和语气，不改状态。')),
            h(Switch, { on: st.config.moodDailyRhythm !== false, disabled: busy, onChange: (v) => patch({ moodDailyRhythm: v }, '日节律') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '思考过程也带心情'),
              h('div', { 'data-bf-note': '' }, '心情好时思考跳一点、带点小动作；心情差时句子短、会碎碎念。只改语气，判断和数字不动。'
                + (st.thinkStyle && st.thinkStyle.enabled ? '（现在：' + st.thinkStyle.label + '）' : '（现在：关）'))),
            h(Switch, { on: st.config.thinkMoodEnabled !== false, disabled: busy, onChange: (v) => patch({ thinkMoodEnabled: v }, '思考心情') })),
          h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '写一篇这周（手动）'),
              h('div', { 'data-bf-note': '' }, '不等周日，现在就让ta回顾一下最近七天。')),
            h('button', { 'data-bf-btn': '', disabled: busy || undefined, onClick: runWeek }, '写周回顾')),
        ),

        /* ── 素材来源（v0.7） ── */
        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '日记素材从哪来'),
          h('div', { 'data-bf-note': '', style: { marginBottom: '6px' } },
            '四个都关掉也写得出来——会写成「空日」短文（心情 + 随机小事 + 好感度），不报错。'),
          srcRow('刷B站报告', 'sourceBiliReport', '读刷B站插件当天写的报告。没装刷B站就关掉。'),
          srcRow('工作流水', 'sourceWorkLog', '读当天会话里你说过的话（只摘录，最多 40 条）。'),
          srcRow('记忆库', 'sourceMemory', '读 meow-memory 里你最近提过的事（「接记忆」也要开着）。'),
          srcRow('自己放的素材', 'sourceManual', '读一个目录里的 .md/.txt，优先当天日期开头的文件。'),
          st.config.sourceManual ? h('div', { 'data-bf-row': '' },
            h('div', { 'data-bf-grow': '' },
              h('div', { 'data-bf-label': '' }, '素材目录'),
              h('div', { 'data-bf-note': '' }, '留空 = 日记目录下的「素材」文件夹')),
            h(TextBox, {
              value: st.config.manualSourceDir || '',
              placeholder: '例如 E:\\大肥鱼人设\\素材',
              width: '260px',
              onCommit: (v) => patch({ manualSourceDir: v }, '素材目录'),
            })) : null,
          st.sources ? h('div', { 'data-bf-note': '', style: { marginTop: '6px' } },
            '上次写日记时能用的素材：'
            + (st.sources.biliReport && st.sources.biliReport.has ? '报告✓ ' : '报告✗ ')
            + (st.sources.workLog && st.sources.workLog.lines ? '流水✓(' + st.sources.workLog.lines + ') ' : '流水✗ ')
            + (st.sources.memory && st.sources.memory.has ? '记忆✓ ' : '记忆✗ ')
            + (st.sources.manual && st.sources.manual.has ? '素材✓ ' : '素材✗ ')
            + (st.sources.degraded ? '→ 写了空日短文' : '')) : null,
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

    /* ── 侧边栏的「喂食」小页（v0.11.0，接 dsh-better-sidebar 的 registerTab）── */
    function FeedTab({ visible }) {
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [last, setLast] = React.useState('')

      const load = React.useCallback(async () => {
        try { setSt(await jget('/status')) } catch (e) { setErr(String((e && e.message) || e)) }
      }, [])
      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        if (visible === false) return undefined
        const t = setInterval(load, 60 * 1000)
        return () => clearInterval(t)
      }, [load, visible])

      const feed = async (key) => {
        setBusy(true); setErr('')
        try {
          const r = await jpost('/feed', { food: key })
          if (!r || !r.ok) setErr((r && r.error) || '喂食失败')
          else setLast((r.reaction || '') + (r.delta ? '（饱腹 +' + r.delta + '）' : ''))
          await load()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }

      const f = (st && st.food) || {}
      const s = Math.max(0, Math.min(100, Number(f.satiety) || 0))
      const foods = (f.foods && f.foods.length) ? f.foods : []
      const tone = s >= 50 ? '#3b82f6' : s >= 30 ? '#eab308' : '#ef4444'
      const hungry = f.level === 'hungry' || f.level === 'starving'

      return h('div', { 'data-bf-page': '', style: { padding: '12px 12px 16px', maxWidth: 'none' } },
        h('style', null, CSS),
        h('div', { 'data-bf-heart': '' },
          h('div', { 'data-bf-num': '', style: { color: tone } }, String(s)),
          h('div', { 'data-bf-grow': '' },
            h('div', { 'data-bf-label': '' }, hungry ? '饿了' : (f.levelText || '肚子')),
            h('div', { 'data-bf-note': '' }, f.levelText || ''),
            h('div', { 'data-bf-bar': '', style: { marginTop: '6px' } },
              h('i', { style: { left: 'calc(' + s + '% - 1.5px)' } })))),
        last ? h('div', { 'data-bf-note': '', style: { marginTop: '6px' } }, last) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '10px' } },
          foods.map((x) => h('button', {
            key: 'ft' + x.key, 'data-bf-btn': '', disabled: busy || undefined,
            style: (x.kind === 'bad' || x.kind === 'rage') ? { opacity: .7 } : undefined,
            title: x.note || '',
            onClick: () => feed(x.key),
          }, x.label))),
        h('div', { 'data-bf-note': '', style: { marginTop: '8px' } },
          '白饭最顶饿。喂完这里、设置页、日记那边都是同一份数。'),
        (f.todayList && f.todayList.length)
          ? h('div', { 'data-bf-note': '', style: { marginTop: '6px' } }, '今天喂了 ' + f.todayList.length + ' 次')
          : null,
        err ? h('div', { 'data-bf-err': '', style: { marginTop: '6px' } }, err) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots && slots.inject) {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'bili-fish', order: 31, label: '养鱼' },
            () => h(Panel),
          ))
        }
        /* 侧边栏（装了 dsh-better-sidebar 才有）：右侧多一个 🐟，点开就能喂 */
        let tries = 0
        const registerFeedTab = () => {
          tries += 1
          try {
            const bs = ctx.get('betterSidebar')
            if (bs && typeof bs.registerTab === 'function') {
              bs.registerTab({
                id: 'bili-fish:feed',
                title: '喂食',
                description: '小肥鱼的肚子：饱腹度、今天喂过什么、饿了会说话',
                icon: h('span', { style: { fontSize: '15px', lineHeight: 1 } }, '🐟'),
                order: 90,
                single: true,
                component: (p) => h(FeedTab, { visible: p && p.visible }),
              })
              return true
            }
          } catch (e) {
            try { console.warn('[bili-fish] 侧边栏注册失败', e) } catch (e2) {}
          }
          return false
        }
        if (!registerFeedTab()) {
          const timer = setInterval(() => {
            if (registerFeedTab() || tries >= 6) clearInterval(timer)
          }, 1500)
        }
      },
    }
  },
})
