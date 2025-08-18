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

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

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

let cache = readBets()

// ===== middleware
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ===== health
app.get('/api/health', (req,res)=> res.json('ok'))

// ===== meta — серверный штамп последнего обновления
app.get('/api/meta', (req,res)=> res.json({ updatedAt: getUpdatedAt() }))

// ===== auth check
app.get('/api/auth/check', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) === String(ADMIN_PASSWORD)) return res.status(200).end()
  return res.status(401).end()
})

// ===== read
app.get('/api/bets', (req,res)=> res.json(cache))

// ===== replace all (PUT)
app.put('/api/bets', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const body = req.body
  if(!Array.isArray(body)) return res.status(400).json({ error: 'array required' })
  cache = body
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
  cache = [obj, ...cache]
  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  return res.json({ ok: true, id: obj.id })
})

// ===== patch one
app.patch('/api/bets/:id', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const id = String(req.params.id)
  const idx = cache.findIndex(x=> String(x.id) === id)
  if(idx === -1) return res.status(404).json({ error: 'not found' })
  const patch = req.body || {}
  cache[idx] = { ...cache[idx], ...patch }
  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  return res.json({ ok: true })
})

// ===== delete one
app.delete('/api/bets/:id', (req,res)=>{
  const pw = req.headers['x-admin-password'] || ''
  if(String(pw) !== String(ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' })
  const id = String(req.params.id)
  const before = cache.length
  cache = cache.filter(x=> String(x.id) !== id)
  if(cache.length === before) return res.status(404).json({ error: 'not found' })
  writeBets(cache, true)
  io.emit('bets:update', { items: cache, updatedAt: Date.now() })
  return res.json({ ok: true })
})

// ===== static client
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist')
app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }))

// ===== SPA fallback (но не для /api и /socket.io)
app.get(/^(?!\/api\/|\/socket\.io\/).*/, (req,res)=>{
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

// ===== sockets
io.on('connection', (socket)=>{
  // можно слать текущее состояние по подключению, если нужно
  // socket.emit('bets:update', { items: cache, updatedAt: getUpdatedAt() })
})

// ===== start
server.listen(PORT, '0.0.0.0', ()=>{
  console.log(`BETOFF listening on http://0.0.0.0:${PORT}`)
})
