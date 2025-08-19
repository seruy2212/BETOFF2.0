require('dotenv').config()
const express = require('express')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }
})

const PORT = process.env.PORT || 3001
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'betoff07'

const DATA_DIR = __dirname
const BETS_FILE = path.join(DATA_DIR, 'bets.json')
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const RATE_FILE = path.join(DATA_DIR, 'rate.json')
const DEFAULT_RUB_RATE = 80.78

// Путь к собранному фронтенду
const CLIENT_DIST = path.resolve(__dirname, '..', 'client', 'dist')

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

// ===== helpers: common
function pad2(n){ return String(n).padStart(2,'0') }
function formatDMY(d = new Date()){
  const dd = pad2(d.getDate())
  const mm = pad2(d.getMonth()+1)
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// ===== helpers: bets
function readBets(){
  try{
    const text = fs.readFileSync(BETS_FILE, 'utf8')
    const json = JSON.parse(text)
    return Array.isArray(json) ? json : []
  }catch{ return [] }
}
function writeBets(list, doBackup=false){
  const text = JSON.stringify(list, null, 2)
  fs.writeFileSync(BETS_FILE, text, 'utf8')
  if (doBackup){
    const stamp = new Date().toISOString().replace(/[:.]/g,'-')
    const bname = path.join(BACKUP_DIR, `bets-${stamp}.json`)
    fs.writeFileSync(bname, text, 'utf8')
  }
}
function getUpdatedAt(){
  try{
    const st = fs.statSync(BETS_FILE)
    return Math.floor(st.mtimeMs)
  }catch{ return 0 }
}

// ===== helpers: rate
function readRate(){
  try{
    const text = fs.readFileSync(RATE_FILE, 'utf8')
    const json = JSON.parse(text)
    const v = Number(json?.rubPerUsdt)
    if(Number.isFinite(v) && v > 0) return { rubPerUsdt: v }
  }catch{}
  return { rubPerUsdt: DEFAULT_RUB_RATE }
}
function writeRate(val){
  const v = Number(val)
  const obj = { rubPerUsdt: (Number.isFinite(v) && v > 0) ? v : DEFAULT_RUB_RATE, updatedAt: Date.now() }
  fs.writeFileSync(RATE_FILE, JSON.stringify(obj, null, 2), 'utf8')
  return obj
}

let cache = readBets()
let rateCache = readRate()

// ===== middleware
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ===== health
app.get('/api/health', (req,res)=> res.json('ok'))

// ===== meta — серверный штамп последнего обновления ставок
app.get('/api/meta', (req,res)=> res.json({ updatedAt: getUpdatedAt() }))

// ===== auth check
app.get('/api/auth/check', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) === String(ADMIN_PASSWORD)) return res.status(200).end()
  return res.status(401).end()
})

// ===== rate API
app.get('/api/rate', (req,res)=>{
  rateCache = readRate()
  res.json({ rubPerUsdt: rateCache.rubPerUsdt })
})
app.put('/api/rate', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const body = req.body || {}
  const val = Number(body.rubPerUsdt)
  if(!Number.isFinite(val) || val <= 0) return res.status(400).json({ error: 'invalid rate' })
  rateCache = writeRate(val)
  io.emit('rate:update', { rubPerUsdt: rateCache.rubPerUsdt })
  res.json({ ok: true, rubPerUsdt: rateCache.rubPerUsdt })
})

// ===== bets read
app.get('/api/bets', (req,res)=> res.json(cache))

// ===== ensure added_date helper
function ensureAddedDateOnArray(arr){
  const today = formatDMY(new Date())
  return arr.map(item => {
    if (item && typeof item === 'object' && !item.added_date){
      return { ...item, added_date: today }
    }
    return item
  })
}

// ===== replace all (PUT)
app.put('/api/bets', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const body = req.body
  if(!Array.isArray(body)) return res.status(400).json({ error: 'array required' })

  // Назначаем added_date для тех, у кого его нет
  cache = ensureAddedDateOnArray(body)
  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  return res.json({ ok: true })
})

// ===== add one (POST)
app.post('/api/bets', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const obj = req.body || {}
  if(!obj.id) obj.id = String(Date.now())

  // Назначаем added_date, если отсутствует
  if(!obj.added_date) obj.added_date = formatDMY(new Date())

  // ВАЖНО: поле time НЕ трогаем — остаётся как пришло
  cache = [obj, ...cache]
  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  res.json({ ok: true, id: obj.id })
})

// ===== patch one (PATCH)
app.patch('/api/bets/:id', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const id = String(req.params.id || '')
  const idx = cache.findIndex(x => String(x.id) === id)
  if(idx === -1) return res.status(404).json({ error: 'not found' })

  const patch = req.body || {}

  // Если приходит added_date — сохраняем как есть (строка)
  // Поле time не модифицируем специально
  cache[idx] = { ...cache[idx], ...patch }
  // Гарантируем, что added_date есть всегда
  if(!cache[idx].added_date) cache[idx].added_date = formatDMY(new Date())

  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  res.json({ ok: true })
})

// ===== delete one (DELETE)
app.delete('/api/bets/:id', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const id = String(req.params.id || '')
  const lenBefore = cache.length
  cache = cache.filter(x => String(x.id) !== id)
  if (cache.length === lenBefore) return res.status(404).json({ error: 'not found' })
  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  res.json({ ok: true })
})

// ===== Static frontend (production)
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next()
    res.sendFile(path.join(CLIENT_DIST, 'index.html'))
  })
}

// ===== start
server.listen(PORT, ()=> {
  if (!fs.existsSync(RATE_FILE)) {
    const obj = { rubPerUsdt: DEFAULT_RUB_RATE, updatedAt: 0 }
    fs.writeFileSync(RATE_FILE, JSON.stringify(obj, null, 2), 'utf8')
  }
  console.log('BETOFF server on', PORT)
})