import React, { useMemo, useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { io } from 'socket.io-client'

// =====================
// Constants & utils
// =====================
const STATUS = { WON: 'Выиграна', LOST: 'Проиграна', PENDING: 'Нерасчитана' }
const statusColor = (s) => s===STATUS.WON? 'bg-emerald-600' : s===STATUS.LOST? 'bg-rose-600' : 'bg-amber-500'

// формат чисел до 2 знаков
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const fmt2 = (n) => nf2.format(Number(n) || 0)
const currency = (v) => `${fmt2(v)} рублей`

// Нормализуем результат ставки
function normalizedWinValue(b){
  const win = Number(b.win_value) || 0
  const stake = Number(b.stake_value) || 0
  if (b.status === STATUS.LOST){
    return win < 0 ? win : (stake ? -stake : 0)
  }
  if (b.status === STATUS.PENDING){
    return 0
  }
  return win
}

// =====================
// Minimal router (path-based)
// =====================
const usePath = () => {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(()=>{
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  },[])
  return [path, (p)=>{ window.history.pushState({}, '', p); setPath(p)}]
}

export default function App(){
  const [path, nav] = usePath()
  if(path.startsWith('/admin')) return <AdminPage onBack={()=>nav('/')} />
  return <MobileHome />
}

// =====================
// Data layer + realtime status (persist last updated to localStorage)
// =====================
async function fetchBets(){
  const r = await fetch('/api/bets')
  return await r.json()
}

// получить серверный штамп последнего обновления (независимо от браузера)
async function fetchMeta(){
  try{
    const r = await fetch('/api/meta')
    if(!r.ok) return 0
    const j = await r.json()
    return Number(j.updatedAt)||0
  }catch{ return 0 }
}

function useRealtimeBets(){
  const [bets, setBets] = useState([])
  const [connected, setConnected] = useState(false)
  const [lastEventAt, setLastEventAt] = useState(()=>{
    const saved = Number(localStorage.getItem('betoff_last_update')||0)
    return saved || 0
  })

  useEffect(()=>{
    let mounted = true
    // первичная загрузка: тянем список и серверный updatedAt
    fetchBets().then(d=> { if(mounted) setBets(d) })
    fetchMeta().then(ts=> { if(mounted && ts) setLastEventAt(ts) })

    const socket = io('/', { path: '/socket.io' })
    socket.on('connect', ()=> setConnected(true))
    socket.on('disconnect', ()=> setConnected(false))

    // поддержка старого и нового формата события
    socket.on('bets:update', (payload)=>{
      if(Array.isArray(payload)){
        setBets(payload)
        fetchMeta().then(ts=> { if(ts) setLastEventAt(ts) })
      }else if(payload && typeof payload==='object'){
        setBets(payload.items || [])
        const ts = Number(payload.updatedAt)||Date.now()
        setLastEventAt(ts)
        try{ localStorage.setItem('betoff_last_update', String(ts)) }catch{}
        return
      }
      const now = Date.now()
      setLastEventAt(now)
      try{ localStorage.setItem('betoff_last_update', String(now)) }catch{}
    })
    return ()=> { mounted=false; socket.disconnect() }
  },[])
  return { bets, setBets, connected, lastEventAt }
}

// === Статы: исключаем НЕРАСЧИТАННЫЕ из винрейта и профита ===
function calcStats(bets){
  const eligible = bets.filter(b => b.status !== STATUS.PENDING)
  const total = eligible.length
  const won = eligible.filter(b=>b.status===STATUS.WON).length
  const winRate = total? Math.round(won/total*100):0

  const profit = eligible.reduce((a,b)=> a + normalizedWinValue(b), 0)
  const sumStakes = eligible.reduce((a,b)=> a + (Number(b.stake_value)||0), 0)
  const roi = sumStakes? ((profit / sumStakes) * 100).toFixed(1) : '0.0'
  const avgOdds = total? (eligible.reduce((a,b)=> a+(Number(b.coef)||0),0)/total).toFixed(2):0
  return { total, winRate, profit, avgOdds, roi }
}

// === Серия: ищем первую НЕ нерасчитанную и считаем подряд ===
function calcStreak(all){
  const slice = all.slice(0, 15)
  const firstIdx = slice.findIndex(b => b.status !== STATUS.PENDING)
  if (firstIdx === -1) return { kind: 'нет', count: 0 }
  const target = slice[firstIdx].status
  let count = 0
  for (let i = firstIdx; i < slice.length; i++){
    const b = slice[i]
    if (b.status === STATUS.PENDING) continue
    if (b.status !== target) break
    count++
  }
  return { kind: target===STATUS.WON? 'побед' : 'поражений', count }
}

// =====================
// Mobile Home — horizontal scrollable top metrics (Winrate/Profit/Streak)
// =====================
function MobileHome(){
  const { bets, connected, lastEventAt } = useRealtimeBets()
  const [limit, setLimit] = useState(20)
  const [flash, setFlash] = useState(false)
  const [highlightId, setHighlightId] = useState('')
  const listRef = useRef(null)
  const prevFirstId = useRef('')

  // summary carousel state
  const scrollerRef = useRef(null)

  // короткая вспышка при любом апдейте + подсветка и автоскролл при добавлении новой первой
  useEffect(()=>{
    if(!lastEventAt) return
    setFlash(true)
    const t = setTimeout(()=> setFlash(false), 900)
    const firstId = bets?.[0]?.id || ''
    if (firstId && firstId !== prevFirstId.current){
      setHighlightId(firstId)
      prevFirstId.current = firstId
      const el = listRef.current
      if (el) try { el.scrollTo({ top: 0, behavior: 'smooth' }) } catch { el.scrollTop = 0 }
      setTimeout(()=> setHighlightId(''), 2500)
    }
    return ()=> clearTimeout(t)
  }, [lastEventAt])

  // вычисления
  const last15 = useMemo(()=> bets.slice(0, 15), [bets])
  const stats15 = useMemo(()=> calcStats(last15), [last15])
  const streak = useMemo(()=> calcStreak(bets), [bets])
  const visible = useMemo(()=> bets.slice(0, limit), [bets, limit])

  const winrateTone = stats15.winRate > 50 ? 'green' : 'red'
  const profitTone = stats15.profit > 0 ? 'green' : (stats15.profit < 0 ? 'red' : 'neutral')

  const dateLabel = useMemo(()=>{
    if(!lastEventAt) return '—'
    const delta = Date.now() - Number(lastEventAt)
    if(delta <= 30*60*1000) return 'только что'
    if(delta <= 24*60*60*1000) return 'недавно'
    try{ return new Date(Number(lastEventAt)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) }catch{ return 'недавно' }
  }, [lastEventAt])

  // items for carousel
  const metricCards = [
    { key:'wr', title:'Винрейт', subtitle:'за последние 15 ставок', value:`${stats15.winRate}%`, tone:winrateTone },
    { key:'pf', title:'Профит', subtitle:'за последние 15 ставок', value:`${fmt2(stats15.profit)} рублей`, tone:profitTone },
    { key:'st', title:'Серия', subtitle:'за последние 15 ставок', value:`${streak.count} ${streak.kind}`, tone:(streak.kind==='побед'&&streak.count>0?'green':(streak.kind==='поражений'&&streak.count>0?'red':'neutral')) },
  ]

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      {/* Branding + LIVE индикатор + дата обновления (сохраняется) */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <div className="text-2xl font-extrabold tracking-tight">BETOFF</div>
              <div className="text-xs text-white/60 flex items-center gap-2">
                <LiveDot on={connected} /> статистика в реальном времени
                <span className="opacity-60">·</span>
                <span className="opacity-80">обновлено {dateLabel}</span>
              </div>
            </div>
          </div>
          <a
            href="https://t.me/betoff7"
            target="_blank"
            rel="noreferrer"
            className="text-xs px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 whitespace-nowrap"
          >t.me/betoff7</a>
        </div>
        {/* бегущая линия под шапкой */}
        <motion.div
          className="mt-3 h-[2px] bg-gradient-to-r from-emerald-400/0 via-emerald-400/80 to-emerald-400/0"
          animate={{ x: [ '-100%', '100%' ] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
        />
      </div>

      {/* Summary — горизонтальный слайдер, КОМПАКТНЫЕ карточки контентной ширины */}
      <div className="px-0 mb-1">
        <motion.div
          className="relative"
          animate={flash? { scale: [1, 1.02, 1] } : {}}
          transition={{ duration: 0.6 }}
        >
          <div ref={scrollerRef} className="no-scrollbar overflow-x-auto snap-x snap-mandatory">
            <div className="flex gap-3 px-3">
              {metricCards.map((c)=> (
                <div key={c.key} className="shrink-0 snap-center">
                  <SummaryCard title={c.title} subtitle={c.subtitle} value={c.value} tone={c.tone} />
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Тост «Данные обновлены» */}
      <AnimatePresence>
        {flash && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="pointer-events-none fixed top-2 left-1/2 -translate-x-1/2 z-50 px-3 py-1 rounded-full bg-emerald-500/90 text-white text-xs"
          >Данные обновлены</motion.div>
        )}
      </AnimatePresence>

      {/* List (newest first) + highlight for newest */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {visible.map(b=> <BetCard key={b.id} bet={b} highlight={highlightId===b.id} />)}
        {visible.length < bets.length && (
          <button onClick={()=>setLimit(l=>l+20)} className="w-full mt-1 mb-6 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm">Показать ещё</button>
        )}
      </div>
    </div>
  )
}

function LiveDot({ on }){
  return (
    <div className="relative inline-flex items-center">
      <motion.span
        className={`inline-block w-2 h-2 rounded-full ${on? 'bg-emerald-400':'bg-rose-400'}`}
        animate={on? { scale: [1, 1.3, 1], opacity: [1, 0.7, 1] } : {}}
        transition={{ duration: 1.2, repeat: Infinity }}
      />
      <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">{on? 'LIVE':'OFFLINE'}</span>
    </div>
  )
}

function SummaryCard({ title, subtitle, value, tone='neutral' }){
  const toneClasses = tone==='green'
    ? 'ring-emerald-500/40 bg-emerald-500/10'
    : tone==='red'
      ? 'ring-rose-500/40 bg-rose-500/10'
      : 'ring-white/10 bg-white/5'

  // Карточка контентной ширины (минимум 140px), не растягиваем на всю
  return (
    <div className={`inline-flex flex-col items-start rounded-2xl ${toneClasses} px-3 py-2 backdrop-blur-md min-w-[140px] max-w-[92vw]`}>
      <div className="text-[11px] font-semibold leading-tight">{title}</div>
      <div className="text-[9px] uppercase tracking-wide text-white/70 leading-tight">{subtitle}</div>
      <div className="text-lg font-semibold mt-1 whitespace-nowrap">{value}</div>
    </div>
  )
}

function BetCard({ bet, highlight=false }){
  const [open, setOpen] = useState(false)
  const bg = statusColor(bet.status)
  const result = normalizedWinValue(bet)
  const positive = result > 0
  return (
    <motion.div
      layout
      onClick={()=>setOpen(v=>!v)}
      className={`rounded-2xl ${bg} text-white px-4 py-3 shadow-lg cursor-pointer select-none`}
      animate={highlight? { boxShadow: ['0 0 0 0 rgba(255,255,255,0.0)','0 0 0 8px rgba(255,255,255,0.25)','0 0 0 0 rgba(255,255,255,0.0)'] } : {}}
      transition={highlight? { duration: 2.2, ease: 'easeInOut' } : {}}
    >
      {/* Свернуто (без текста статуса) */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate text-[15px]">{bet.match}</div>
          <div className="text-white/85 text-[13px] truncate">{bet.bet}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold">{bet.coef}</div>
          <div className="text-xs opacity-90">{positive? `+${currency(result)}`: `${currency(result)}`}</div>
        </div>
      </div>

      {/* Раскрыто (здесь уже показываем статус) */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="x" initial={{height:0, opacity:0}} animate={{height:'auto', opacity:1}} exit={{height:0, opacity:0}} transition={{duration:0.2}} className="overflow-hidden">
            <div className="mt-3 text-[12px] font-semibold">Статус: {bet.status}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
              <Detail label="Ставка" value={currency(bet.stake_value)} />
              <Detail label="Коэффициент" value={bet.coef} />
              <Detail label="Результат" value={currency(result)} />
              <Detail label="ID" value={bet.id} />
            </div>
            {bet.time && <div className="mt-2 text-[12px] opacity-90">{bet.time}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Detail({ label, value }){
  return (
    <div className="bg-black/10 rounded-xl px-3 py-2">
      <div className="text-[11px] uppercase opacity-85">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  )
}

// =====================
// Admin page — persistent auth + quick status + bulk JSON import
// =====================
function AdminPage(){
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [bets, setBets] = useState([])
  const [jsonText, setJsonText] = useState('') // пусто по умолчанию
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState('')

  // импорт JSON
  const [importItems, setImportItems] = useState([])
  const [importInfo, setImportInfo] = useState('')

  // автологин из localStorage с проверкой пароля на сервере
  useEffect(()=>{
    const saved = localStorage.getItem('betoff_admin_pw')
    if(!saved) return
    fetch('/api/auth/check', { headers: { 'x-admin-password': saved } })
      .then(r=>{
        if(r.ok){ setPassword(saved); setAuthed(true) }
        else { localStorage.removeItem('betoff_admin_pw') }
      })
      .catch(()=>{})
  },[])

  useEffect(()=>{ fetch('/api/bets').then(r=>r.json()).then(d=>{ setBets(d) }) },[])
  const headers = useMemo(()=> authed? { 'Content-Type':'application/json', 'x-admin-password': password }: {}, [authed, password])

  const login = async (e)=>{
    e.preventDefault()
    if(password.trim().length<3){ setError('Введите пароль'); return }
    try{
      const r = await fetch('/api/auth/check', { headers: { 'x-admin-password': password } })
      if(!r.ok){ setError('Неверный пароль'); setAuthed(false); return }
      setAuthed(true); setError('')
      localStorage.setItem('betoff_admin_pw', password)
    }catch(_){ setError('Сеть недоступна'); }
  }

  const logout = ()=>{
    localStorage.removeItem('betoff_admin_pw')
    setAuthed(false); setPassword('')
  }

  const addOne = async ()=>{
    try{
      const obj = JSON.parse(jsonText)
      if(Array.isArray(obj)) throw new Error('Для добавления одной ставки вставьте объект {…}, не массив []')
      const r = await fetch('/api/bets', { method:'POST', headers, body: JSON.stringify(obj) })
      if(!r.ok) throw new Error('Ошибка авторизации или данных')
      setError('')
    }catch(e){ setError(e.message) }
  }
  const del = async (id)=>{
    const r = await fetch(`/api/bets/${id}`, { method:'DELETE', headers })
    if(!r.ok){ setError('Ошибка авторизации'); return }
    // оптимистично обновим список локально (чтобы не было «тёмного» состояния при задержке сокета)
    setBets(prev => prev.filter(x => String(x.id) !== String(id)))
  }
  const loadToEditor = (b)=>{
    setEditingId(String(b.id))
    setJsonText(JSON.stringify(b, null, 2))
  }
  const savePatch = async ()=>{
    if(!editingId){ setError('Сначала выберите ставку «В редактор»'); return }
    try{
      const obj = JSON.parse(jsonText)
      const r = await fetch(`/api/bets/${editingId}`, { method:'PATCH', headers, body: JSON.stringify(obj) })
      if(!r.ok) throw new Error('Ошибка PATCH (авторизация/данные)')
      setError('')
    }catch(e){ setError(e.message) }
  }

  // Быстрые кнопки смены статуса с автоподстановкой win_value
  const quickStatus = async (b, to) => {
    const stake = Number(b.stake_value)||0
    const coef = Number(b.coef)||0
    let patch = {}
    if (to === STATUS.WON){
      patch = { status: STATUS.WON, win_value: Math.round(stake * coef), win_currency: b.win_currency || 'RUB' }
    } else if (to === STATUS.LOST){
      patch = { status: STATUS.LOST, win_value: -Math.abs(stake), win_currency: b.win_currency || 'RUB' }
    } else {
      patch = { status: STATUS.PENDING, win_value: 0, win_currency: b.win_currency || 'RUB' }
    }
    if(!b.stake_currency) patch.stake_currency = 'RUB'
    const r = await fetch(`/api/bets/${b.id}`, { method:'PATCH', headers, body: JSON.stringify(patch) })
    if(!r.ok) setError('Ошибка PATCH (проверь пароль)')
  }

  // ===== Импорт JSON (только добавление) =====
  const onChooseFile = async (e) => {
    const file = e.target.files?.[0]
    if(!file) return
    try{
      const text = await file.text()
      const json = JSON.parse(text)
      if(!Array.isArray(json)) throw new Error('JSON должен быть массивом объектов')
      const items = json.map(normalizeImportedBet)
      setImportItems(items)
      setImportInfo(`Файл: ${file.name} — найдено записей: ${items.length}`)
    }catch(err){
      setImportItems([])
      setImportInfo('Ошибка импорта: ' + (err?.message||''))
    }
  }

  function normalizeImportedBet(b){
    const status = [STATUS.WON, STATUS.LOST, STATUS.PENDING].includes(b.status) ? b.status : STATUS.PENDING
    const stake = Number(b.stake_value)||0
    const coef = Number(b.coef)||0
    let win = Number(b.win_value)
    if(Number.isNaN(win) || win===undefined){
      if(status===STATUS.WON) win = Math.round(stake*coef)
      else if(status===STATUS.LOST) win = -Math.abs(stake)
      else win = 0
    }
    return {
      time: b.time || '',
      id: String(b.id || Date.now() + Math.random().toString(16).slice(2)),
      match: b.match || '',
      bet: b.bet || '',
      status,
      stake_value: stake,
      stake_currency: b.stake_currency || 'RUB',
      coef: coef,
      win_value: win,
      win_currency: b.win_currency || 'RUB'
    }
  }

  const importAddMerge = async ()=>{
    if(!importItems.length){ setImportInfo('Сначала выберите JSON-файл'); return }
    // получаем текущий список, добавляем импорт сверху (сохраняем порядок файла)
    const current = await fetch('/api/bets').then(r=>r.json())
    const merged = [...importItems.slice().reverse(), ...current]
    const r = await fetch('/api/bets', { method:'PUT', headers, body: JSON.stringify(merged) })
    if(!r.ok){ setImportInfo('Ошибка импорта (авторизация?)'); return }
    setImportInfo('Импорт завершён: добавлено ' + importItems.length)
    setImportItems([])
  }

  useEffect(()=>{
    const socket = io('/', { path: '/socket.io' })
    socket.on('bets:update', (data)=>{
      const items = Array.isArray(data) ? data : (data?.items || [])
      setBets(items)
      if(!editingId) setJsonText('')
    })
    return ()=> socket.disconnect()
  },[editingId])

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Админ-панель</h1>
          <div className="flex items-center gap-2">
            {authed && <button onClick={logout} className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15">Выйти</button>}
            <a href="/" className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15">← На сайт</a>
          </div>
        </div>

        {!authed ? (
          <form onSubmit={login} className="mt-6 max-w-md bg-white/5 p-4 rounded-2xl ring-1 ring-white/10">
            <div className="text-sm opacity-80 mb-2">Введите пароль администратора</div>
            <input type="password" className="w-full bg-black/40 rounded-xl p-3 outline-none" placeholder="Пароль" value={password} onChange={e=>setPassword(e.target.value)} />
            {error && <div className="text-rose-400 text-sm mt-2">{error}</div>}
            <button className="mt-3 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-medium">Войти</button>
          </form>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <div className="bg-white/5 rounded-2xl p-4 ring-1 ring-white/10">
              <div className="text-sm opacity-80 mb-2">Редактор JSON</div>
              <textarea className="w-full h-[420px] bg-black/40 rounded-xl p-3 font-mono text-sm outline-none" value={jsonText} onChange={(e)=>setJsonText(e.target.value)} spellCheck={false} placeholder='Вставьте сюда объект {"…"} для "Добавить ставку" или "Сохранить изменения"' />
              {error && <div className="text-rose-400 text-sm mt-2">{error}</div>}
              <div className="flex flex-wrap gap-3 mt-3">
                <button onClick={addOne} className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 font-medium">Добавить ставку</button>
                <button onClick={savePatch} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 font-medium">Сохранить изменения</button>
              </div>

              {/* Импорт из JSON документа (только добавление) */}
              <div className="mt-6 border-t border-white/10 pt-4">
                <div className="text-sm opacity-80 mb-2">Импорт из JSON (массовое добавление)</div>
                <input type="file" accept="application/json" onChange={onChooseFile} className="block text-sm" />
                {importInfo && <div className="text-xs opacity-80 mt-2">{importInfo}</div>}
                <div className="flex flex-wrap gap-3 mt-3">
                  <button onClick={importAddMerge} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm">Импортировать (добавить)</button>
                </div>
              </div>
            </div>
            <div className="bg-white/5 rounded-2xl p-4 ring-1 ring-white/10">
              <div className="text-sm opacity-80 mb-3">Предпросмотр / Быстрая правка / Удаление</div>
              <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
                {bets.map(b=> (
                  <div key={b.id} className={`${statusColor(b.status)} rounded-xl text-white p-3`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{b.match}</div>
                        <div className="text-sm truncate opacity-90">{b.bet}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={()=>loadToEditor(b)} className="px-2 py-1 rounded-md bg-black/30 hover:bg-black/40 text-xs">В редактор</button>
                        <button onClick={()=>del(b.id)} className="px-2 py-1 rounded-md bg-black/30 hover:bg-black/40 text-xs">Удалить</button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button onClick={()=>quickStatus(b, STATUS.WON)} className="px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-xs">Выиграна</button>
                      <button onClick={()=>quickStatus(b, STATUS.LOST)} className="px-2 py-1 rounded-md bg-rose-600 hover:bg-rose-500 text-xs">Проиграна</button>
                      <button onClick={()=>quickStatus(b, STATUS.PENDING)} className="px-2 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-xs">Нерасчитана</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// hide scrollbars util (for mobile)
const style = document.createElement('style')
style.innerHTML = `.no-scrollbar::-webkit-scrollbar{display:none}.no-scrollbar{-ms-overflow-style:none;scrollbar-width:none}`
document.head.appendChild(style)
