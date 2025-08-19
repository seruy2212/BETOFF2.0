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

// Валютные хелперы
const DEFAULT_RUB_RATE = 80.78
const fmtAmount = (v, unit='USDT') => `${fmt2(v)} ${unit}`
const betUnit = (b) => (b.stake_currency || b.win_currency || 'USDT')
const round2 = (n) => Math.round((Number(n)||0) * 100) / 100

// Нормализуем результат ставки (чистый профит)
function normalizedWinValue(b){
  const win = Number(b.win_value) || 0
  const stake = Number(b.stake_value) || 0

  if (b.status === STATUS.LOST){
    return win < 0 ? win : (stake ? -stake : 0)
  }
  if (b.status === STATUS.PENDING){
    return 0
  }
  return (win - stake)
}

// Перевод суммы результата в USDT исходя из валюты ставки
const toUSDT = (amount, b, rubRate) => {
  const unit = betUnit(b)
  if (unit === 'RUB') return amount / (Number(rubRate) || DEFAULT_RUB_RATE)
  return amount
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

async function fetchMeta(){
  try{
    const r = await fetch('/api/meta')
    if(!r.ok) return 0
    const j = await r.json()
    return Number(j.updatedAt)||0
  }catch{ return 0 }
}

async function fetchRate(){
  try{
    const r = await fetch('/api/rate')
    if(!r.ok) return DEFAULT_RUB_RATE
    const j = await r.json()
    const val = Number(j?.rubPerUsdt)
    return Number.isFinite(val) && val>0 ? val : DEFAULT_RUB_RATE
  }catch{ return DEFAULT_RUB_RATE }
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
    fetchBets().then(d=> { if(mounted) setBets(d) })
    fetchMeta().then(ts=> { if(mounted && ts) setLastEventAt(ts) })

    const socket = io('/', { path: '/socket.io' })
    socket.on('connect', ()=> setConnected(true))
    socket.on('disconnect', ()=> setConnected(false))

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

// === Диапазон метрик: используем только added_date (ДД/ММ/ГГГГ) ===
function pad2(n){ return String(n).padStart(2,'0') }
function todayDMY(){
  const now = new Date()
  return `${pad2(now.getDate())}/${pad2(now.getMonth()+1)}/${now.getFullYear()}`
}
function parseDMYtoMs(dmy){
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dmy||'').trim())
  if(!m) return NaN
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3])
  const dt = new Date(y, mo-1, d)
  if (dt.getFullYear()!==y || (dt.getMonth()+1)!==mo || dt.getDate()!==d) return NaN
  return dt.getTime()
}
function startOfDayMs(ms){
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function filterBetsByAddedDate(bets, period){
  const todayStr = todayDMY()
  if (period === 'DAY'){
    return bets.filter(b => (b.added_date||'').trim() === todayStr)
  }
  const todayMs = startOfDayMs(Date.now())

  if (period === 'WEEK'){
    const startMs = todayMs - 6*24*60*60*1000
    const endMs = todayMs + 24*60*60*1000 - 1
    return bets.filter(b => {
      const t = parseDMYtoMs(b.added_date)
      return Number.isFinite(t) && t >= startMs && t <= endMs
    })
  }

  // MONTH: текущий календарный месяц
  const now = new Date()
  const startMonthMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const startNextMonthMs = new Date(now.getFullYear(), now.getMonth()+1, 1).getTime()
  return bets.filter(b => {
    const t = parseDMYtoMs(b.added_date)
    return Number.isFinite(t) && t >= startMonthMs && t < startNextMonthMs
  })
}

// === Статы (в USDT)
function calcStats(bets, rubRate){
  const eligible = bets.filter(b => b.status !== STATUS.PENDING)
  const total = eligible.length
  const won = eligible.filter(b=>b.status===STATUS.WON).length
  const winRate = total? Math.round(won/total*100):0

  const profitUSDT = eligible.reduce((a,b)=> a + toUSDT(normalizedWinValue(b), b, rubRate), 0)
  const sumStakesUSDT = eligible.reduce((a,b)=> a + toUSDT(Number(b.stake_value)||0, b, rubRate), 0)

  const roi = sumStakesUSDT? ((profitUSDT / sumStakesUSDT) * 100).toFixed(1) : '0.0'
  const avgOdds = total? (eligible.reduce((a,b)=> a+(Number(b.coef)||0),0)/total).toFixed(2):0
  return { total, winRate, profitUSDT, avgOdds, roi }
}

// === Серия (в рамках выбранного периода)
function calcStreak(list){
  if (!list.length) return { kind: 'нет', count: 0 }
  const firstIdx = list.findIndex(b => b.status !== STATUS.PENDING)
  if (firstIdx === -1) return { kind: 'нет', count: 0 }
  const target = list[firstIdx].status
  let count = 0
  for (let i = firstIdx; i < list.length; i++){
    const b = list[i]
    if (b.status === STATUS.PENDING) continue
    if (b.status !== target) break
    count++
  }
  return { kind: target===STATUS.WON? 'побед' : 'поражений', count }
}

// =====================
// Segmented control — компактный, чёрный, подчёркивание с glow под текстом
// =====================
function SegmentedPeriod({ value, onChange }){
  const opts = [
    { key: 'DAY', label: 'День' },
    { key: 'WEEK', label: 'Неделя' },
    { key: 'MONTH', label: 'Месяц' },
  ]
  const containerRef = useRef(null)
  const labelRefs = useRef({})
  const [underline, setUnderline] = useState({ left: 0, width: 28 })
  const spring = { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }

  const updateUnderline = () => {
    const c = containerRef.current
    const span = labelRefs.current[value]
    if (!c || !span) return
    const cr = c.getBoundingClientRect()
    const tr = span.getBoundingClientRect()
    const w = Math.max(22, Math.min(48, Math.round(tr.width * 0.6)))
    const left = Math.round((tr.left - cr.left) + (tr.width - w) / 2)
    setUnderline({ left, width: w })
  }

  useEffect(()=>{
    const rAF = requestAnimationFrame(updateUnderline)
    return () => cancelAnimationFrame(rAF)
  }, [value])

  useEffect(()=>{
    const onResize = () => updateUnderline()
    window.addEventListener('resize', onResize)
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(updateUnderline).catch(()=>{})
    }
    const t = setTimeout(updateUnderline, 0)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(t)
    }
  }, [])

  return (
    <div className="sticky top-0 z-20 px-3 pt-1 pb-2 bg-gradient-to-b from-black/85 via-black/55 to-transparent backdrop-blur-md">
      <div className="mx-auto max-w-[520px]">
        <div
          ref={containerRef}
          className="relative rounded-3xl ring-1 ring-black/40 bg-black/65 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] px-2 py-1 overflow-visible"
        >
          {/* Glow подчеркивания */}
          <motion.div
            className="absolute bottom-[5px] h-[7px] rounded-full bg-emerald-400/70 blur-md"
            style={{ left: 0, width: 0 }}
            animate={{ left: underline.left, width: underline.width }}
            transition={spring}
          />
          {/* Чёткая полоска */}
          <motion.div
            className="absolute bottom-[6px] h-[3px] rounded-full bg-emerald-400 shadow-[0_0_0_2px_rgba(16,185,129,0.1),0_0_14px_rgba(16,185,129,0.35)]"
            style={{ left: 0, width: 0 }}
            animate={{ left: underline.left, width: underline.width }}
            transition={spring}
          />
          <div className="grid grid-cols-3 gap-1">
            {opts.map((o)=> {
              const active = value === o.key
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={()=>onChange(o.key)}
                  className={`relative h-10 rounded-2xl flex items-center justify-center select-none transition-colors duration-150
                    ${active ? 'text-white' : 'text-white/75 hover:text-white/90'}`}
                >
                  <span
                    ref={el => { if (el) labelRefs.current[o.key] = el }}
                    className="text-[15px] font-semibold tracking-tight"
                  >
                    {o.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// =====================
// Mobile Home — metrics and list
// =====================
function MobileHome(){
  const { bets, connected, lastEventAt } = useRealtimeBets()
  const [limit, setLimit] = useState(20)
  const [flash, setFlash] = useState(false)
  const [highlightId, setHighlightId] = useState('')
  const listRef = useRef(null)
  const prevFirstId = useRef('')

  // курс и валюта отображения профита
  const [rubRate, setRubRate] = useState(DEFAULT_RUB_RATE)
  const [profitCurrency, setProfitCurrency] = useState('USDT') // 'USDT' | 'RUB'

  // период метрик и списка
  const [period, setPeriod] = useState(()=>{
    const s = localStorage.getItem('betoff_period')
    return s === 'WEEK' || s === 'MONTH' ? s : 'DAY'
  })
  useEffect(()=>{
    try{ localStorage.setItem('betoff_period', period) }catch{}
  }, [period])

  // сокет для курса
  useEffect(()=>{
    let mounted = true
    fetchRate().then(v => { if(mounted) setRubRate(v) })
    const socket = io('/', { path: '/socket.io' })
    socket.on('rate:update', (data)=>{
      const val = Number(data?.rubPerUsdt)
      if(Number.isFinite(val) && val>0) setRubRate(val)
    })
    return ()=> socket.disconnect()
  },[])

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

  // вычисления по added_date
  const filtered = useMemo(()=> filterBetsByAddedDate(bets, period), [bets, period])
  const stats = useMemo(()=> calcStats(filtered, rubRate), [filtered, rubRate])
  const streak = useMemo(()=> calcStreak(filtered), [filtered])

  // постраничность списка — по отфильтрованным данным
  const visible = useMemo(()=> filtered.slice(0, limit), [filtered, limit])

  const winrateTone = stats.winRate > 50 ? 'green' : 'red'
  const profitTone = stats.profitUSDT > 0 ? 'green' : (stats.profitUSDT < 0 ? 'red' : 'neutral')

  const dateLabel = useMemo(()=>{
    if(!lastEventAt) return '—'
    const delta = Date.now() - Number(lastEventAt)
    if(delta <= 30*60*1000) return 'только что'
    if(delta <= 24*60*60*1000) return 'недавно'
    try{ return new Date(Number(lastEventAt)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) }catch{ return 'недавно' }
  }, [lastEventAt])

  // Профит для отображения
  const profitDisplay = profitCurrency === 'USDT'
    ? stats.profitUSDT
    : stats.profitUSDT * (Number(rubRate)||DEFAULT_RUB_RATE)

  const onToggleProfitCurrency = () => {
    setProfitCurrency(c => c === 'USDT' ? 'RUB' : 'USDT')
  }

  // items for carousel — новые заголовки и оформление
  const metricCards = [
    { key:'wr', title:'ВИНРЕЙТ', value:`${stats.winRate}%`, tone:winrateTone },
    { key:'pf', title:'ПРИБЫЛЬ', value:`${fmt2(profitDisplay)} ${profitCurrency}`, tone:profitTone, onClick:onToggleProfitCurrency },
    { key:'st', title:'СЕРИЯ', value:`${streak.count} ${streak.kind}`, tone:(streak.kind==='побед'&&streak.count>0?'green':(streak.kind==='поражений'&&streak.count>0?'red':'neutral')) },
  ]

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      {/* Branding */}
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
        <motion.div
          className="mt-3 h-[2px] bg-gradient-to-r from-emerald-400/0 via-emerald-400/80 to-emerald-400/0"
          animate={{ x: [ '-100%', '100%' ] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
        />
      </div>

      {/* Summary — горизонтальный слайдер */}
      <div className="px-0 mb-1">
        <motion.div
          className="relative"
          animate={flash? { scale: [1, 1.02, 1] } : {}}
          transition={{ duration: 0.6 }}
        >
          <div className="no-scrollbar overflow-x-auto snap-x snap-mandatory">
            <div className="flex gap-3 px-3">
              {metricCards.map((c)=> (
                <div key={c.key} className="shrink-0 snap-center">
                  <SummaryCard title={c.title} value={c.value} tone={c.tone} onClick={c.onClick} />
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Segmented control (липкий под метриками) */}
      <SegmentedPeriod value={period} onChange={setPeriod} />

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

      {/* List (filtered, newest first by current order) */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {visible.map(b=> <BetCard key={b.id} bet={b} highlight={highlightId===b.id} />)}
        {visible.length < filtered.length && (
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

// =====================
// Summary card — центровка, большие верхние заголовки и броские значения
// =====================
function SummaryCard({ title, value, tone='neutral', onClick }){
  const toneClasses = tone==='green'
    ? 'ring-emerald-500/40 bg-emerald-500/10'
    : tone==='red'
      ? 'ring-rose-500/40 bg-rose-500/10'
      : 'ring-white/10 bg-white/5'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex flex-col items-center justify-center rounded-2xl ${toneClasses} px-4 py-3 backdrop-blur-md min-w-[150px] max-w-[92vw] text-center ${onClick? 'cursor-pointer':'cursor-default'}`}
    >
      <div className="text-[13px] font-extrabold leading-none uppercase tracking-wide">{title}</div>
      <div className="mt-1 text-2xl font-extrabold leading-none text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.25)]">
        {value}
      </div>
    </button>
  )
}

function BetCard({ bet, highlight=false }){
  const [open, setOpen] = useState(false)
  const bg = statusColor(bet.status)
  const result = normalizedWinValue(bet)
  const positive = result > 0
  const unit = betUnit(bet)

  return (
    <motion.div
      layout
      onClick={()=>setOpen(v=>!v)}
      className={`rounded-2xl ${bg} text-white px-4 py-3 shadow-lg cursor-pointer select-none`}
      animate={highlight? { boxShadow: ['0 0 0 0 rgba(255,255,255,0.0)','0 0 0 8px rgba(255,255,255,0.25)','0 0 0 0 rgba(255,255,255,0.0)'] } : {}}
      transition={highlight? { duration: 2.2, ease: 'easeInOut' } : {}}
    >
      {/* Свернуто */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate text-[15px]">{bet.match}</div>
          <div className="text-white/85 text-[13px] truncate">{bet.bet}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold">{bet.coef}</div>
          <div className="text-xs opacity-90">{positive? `+${fmtAmount(result, unit)}`: `${fmtAmount(result, unit)}`}</div>
        </div>
      </div>

      {/* Раскрыто */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="x" initial={{height:0, opacity:0}} animate={{height:'auto', opacity:1}} exit={{height:0, opacity:0}} transition={{duration:0.2}} className="overflow-hidden">
            <div className="mt-3 text-[12px] font-semibold">Статус: {bet.status}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
              <Detail label="Ставка" value={fmtAmount(bet.stake_value, unit)} />
              <Detail label="Коэффициент" value={bet.coef} />
              <Detail label="Результат" value={fmtAmount(result, unit)} />
              <Detail label="ID" value={bet.id} />
            </div>
            {bet.time !== undefined && (
              <div className="mt-2 text-[12px] opacity-90">{String(bet.time)}</div>
            )}
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
// Admin page — как в предыдущей версии
// =====================
function AdminPage(){
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [bets, setBets] = useState([])
  const [jsonText, setJsonText] = useState('')
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState('')

  // импорт JSON
  const [importItems, setImportItems] = useState([])
  const [importInfo, setImportInfo] = useState('')

  // rate editor
  const [rubRateInput, setRubRateInput] = useState('')
  const [rateInfo, setRateInfo] = useState('')

  // client clock
  const [clientTime, setClientTime] = useState(()=> new Date())
  useEffect(()=>{
    const t = setInterval(()=> setClientTime(new Date()), 1000)
    return ()=> clearInterval(t)
  },[])
  const clientTimeLabel = useMemo(()=>{
    try{
      return clientTime.toLocaleString('ru-RU', { hour12: false })
    }catch{ return String(clientTime) }
  }, [clientTime])

  // edit added_date
  const [editDateId, setEditDateId] = useState('')
  const [editDateVal, setEditDateVal] = useState('')

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

  // загрузка ставок и курса
  useEffect(()=>{
    fetch('/api/bets').then(r=>r.json()).then(d=>{ setBets(d) })
    fetchRate().then(v => setRubRateInput(String(v)))
  },[])
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
      setJsonText('')
    }catch(e){ setError(e.message) }
  }

  const del = async (id)=>{
    const r = await fetch(`/api/bets/${id}`, { method:'DELETE', headers })
    if(!r.ok){ setError('Ошибка авторизации'); return }
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

  const quickStatus = async (b, to) => {
    const stake = Number(b.stake_value)||0
    const coef = Number(b.coef)||0
    let patch = {}
    const currency = b.win_currency || b.stake_currency || 'USDT'
    if (to === STATUS.WON){
      patch = { status: STATUS.WON, win_value: round2(stake * coef), win_currency: currency }
    } else if (to === STATUS.LOST){
      patch = { status: STATUS.LOST, win_value: -Math.abs(stake), win_currency: currency }
    } else {
      patch = { status: STATUS.PENDING, win_value: 0, win_currency: currency }
    }
    if(!b.stake_currency) patch.stake_currency = 'USDT'
    const r = await fetch(`/api/bets/${b.id}`, { method:'PATCH', headers, body: JSON.stringify(patch) })
    if(!r.ok) setError('Ошибка PATCH (проверь пароль)')
  }

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
      if(status===STATUS.WON) win = round2(stake*coef)
      else if(status===STATUS.LOST) win = -Math.abs(stake)
      else win = 0
    }
    const stake_currency = b.stake_currency || 'USDT'
    const win_currency = b.win_currency || stake_currency
    return {
      time: b.time,
      id: String(b.id || Date.now() + Math.random().toString(16).slice(2)),
      match: b.match || '',
      bet: b.bet || '',
      status,
      stake_value: stake,
      stake_currency,
      coef: coef,
      win_value: win,
      win_currency
    }
  }

  const importAddMerge = async ()=>{
    if(!importItems.length){ setImportInfo('Сначала выберите JSON-файл'); return }
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

  const saveRubRate = async ()=>{
    const val = Number(rubRateInput)
    if(!isFinite(val) || val <= 0){
      setRateInfo('Введите корректный курс (> 0)')
      return
    }
    try{
      const r = await fetch('/api/rate', { method:'PUT', headers, body: JSON.stringify({ rubPerUsdt: val }) })
      if(!r.ok){
        setRateInfo('Ошибка сохранения курса (проверь пароль)')
        return
      }
      setRateInfo('Курс сохранён')
      setTimeout(()=> setRateInfo(''), 1500)
    }catch{
      setRateInfo('Сеть недоступна')
    }
  }

  const startEditDate = (b)=>{
    setEditDateId(String(b.id))
    setEditDateVal(b.added_date || '')
  }
  const cancelEditDate = ()=>{
    setEditDateId('')
    setEditDateVal('')
  }
  const saveEditDate = async ()=>{
    if(!editDateId) return
    try{
      const patch = { added_date: editDateVal }
      const r = await fetch(`/api/bets/${editDateId}`, { method:'PATCH', headers, body: JSON.stringify(patch) })
      if(!r.ok){ setError('Ошибка сохранения даты добавления'); return }
      cancelEditDate()
    }catch{
      setError('Сеть недоступна')
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Админ-панель</h1>
            <div className="text-xs text-white/70 mt-1">Время клиента: {clientTimeLabel}</div>
          </div>
          <div className="flex items-center gap-2">
            {authed && <button onClick={logout} className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15">Выйти</button>}
            <a href="/" className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15">← На сайт</a>
          </div>
        </div>

        {authed && (
          <div className="mt-4">
            <div className="bg-white/5 rounded-2xl p-4 ring-1 ring-white/10 max-w-sm">
              <div className="text-sm font-semibold">Курс RUB/USDT</div>
              <div className="text-xs opacity-80 mt-1">Используется для конвертации профита RUB → USDT и для отображения профита в RUB</div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-sm whitespace-nowrap">1 USDT =</span>
                <input
                  type="number"
                  step="0.01"
                  className="w-28 bg-black/40 rounded-lg p-2 outline-none"
                  value={rubRateInput}
                  onChange={(e)=>setRubRateInput(e.target.value)}
                />
                <span className="text-sm">RUB</span>
              </div>
              {rateInfo && <div className="text-xs mt-2 opacity-85">{rateInfo}</div>}
              <div className="mt-3">
                <button onClick={saveRubRate} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm">Сохранить курс</button>
              </div>
            </div>
          </div>
        )}

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
              <textarea className="w-full h=[420px] bg-black/40 rounded-xl p-3 font-mono text-sm outline-none" value={jsonText} onChange={(e)=>setJsonText(e.target.value)} spellCheck={false} />
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

                    {/* Дата добавления (только админка) */}
                    <div className="mt-2 text-xs flex items-center gap-2 flex-wrap">
                      <span className="opacity-90">Добавлено:</span>
                      {editDateId === String(b.id) ? (
                        <>
                          <input
                            type="text"
                            placeholder="ДД/ММ/ГГГГ"
                            className="px-2 py-1 rounded-md bg-black/30 outline-none"
                            value={editDateVal}
                            onChange={e=>setEditDateVal(e.target.value)}
                          />
                          <button onClick={saveEditDate} className="px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-xs">Сохранить</button>
                          <button onClick={cancelEditDate} className="px-2 py-1 rounded-md bg-black/30 hover:bg-black/40 text-xs">Отмена</button>
                        </>
                      ) : (
                        <>
                          <span className="px-2 py-1 rounded-md bg-black/20">{b.added_date || '—'}</span>
                          <button onClick={()=>startEditDate(b)} className="px-2 py-1 rounded-md bg-black/30 hover:bg-black/40 text-xs">Изм. дату</button>
                        </>
                      )}
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