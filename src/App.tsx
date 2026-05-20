// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'

// ── CONFIGURACIÓN ─────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '33863186131-3rgcbifmp7sjkacuhqinr41nkbca7v09.apps.googleusercontent.com'
const AI_PROVIDER = 'groq'
const AI_MODEL = 'llama-3.3-70b-versatile'
const AI_API_KEY = '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'

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ')

const SESSION_KEY = 'dentaiq_session_v3'

// ── COLORES ───────────────────────────────────────────────────────
const C = {
  bg:'#F8F7F4', card:'#FFFFFF', border:'rgba(0,0,0,0.08)',
  teal:'#007A6B', tealL:'#E6F4F2', tealD:'#005549',
  gold:'#D97706', goldL:'#FEF3C7',
  red:'#DC2626', redL:'#FEE2E2',
  blue:'#1D4ED8', blueL:'#DBEAFE',
  text:'#111827', sub:'#6B7280', light:'#9CA3AF',
  green:'#059669', greenL:'#D1FAE5',
  white:'#FFFFFF', shadow:'rgba(0,0,0,0.06)',
  purple:'#7C3AED', purpleL:'#EDE9FE',
}

const clp = (n) => {
  if (isNaN(n) || n === null || n === undefined) return '$0'
  const v = Number(n)
  if (Math.abs(v) >= 1e6) return `$${(v/1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `$${Math.round(v/1e3).toLocaleString('es-CL')}K`
  return `$${Math.round(v).toLocaleString('es-CL')}`
}

// ── SESIÓN PERSISTENTE ────────────────────────────────────────────
function saveSession(user) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, savedAt: Date.now() }))
  } catch {}
}

function loadSession() {
  try {
    const data = JSON.parse(localStorage.getItem(SESSION_KEY))
    if (!data) return null
    const ageMin = (Date.now() - data.savedAt) / 60000
    if (ageMin < 50) return { user: data.user, expired: false }
    return { user: data.user, expired: true } // token expirado pero sabemos quién es
  } catch { return null }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch {}
}

// ── GOOGLE OAUTH ──────────────────────────────────────────────────
function loadGIS() {
  return new Promise(r => {
    if (window.google?.accounts) { r(); return }
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => r()
    document.head.appendChild(s)
  })
}

async function signIn(emailHint, silent = false) {
  await loadGIS()
  return new Promise((resolve, reject) => {
    const timeout = silent ? setTimeout(() => reject(new Error('timeout')), 8000) : null
    const c = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      hint: emailHint || '',
      prompt: silent ? '' : undefined,
      callback: async (r) => {
        if (timeout) clearTimeout(timeout)
        if (!r.access_token) { reject(new Error('Sin token')); return }
        try {
          const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${r.access_token}` }
          }).then(x => x.json())
          resolve({ email: u.email, name: u.name || u.email, picture: u.picture || '', token: r.access_token })
        } catch(e) { reject(e) }
      },
      error_callback: (e) => {
        if (timeout) clearTimeout(timeout)
        reject(new Error(e.type === 'popup_closed' ? 'Cerraste la ventana' : 'Error de autenticación'))
      }
    })
    c.requestAccessToken()
  })
}

// ── GOOGLE DRIVE API ──────────────────────────────────────────────
async function driveFind(t, q) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=10`,
    { headers: { Authorization: `Bearer ${t}` } }
  )
  return (await r.json()).files || []
}

async function driveCreate(t, body) {
  return fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json())
}

async function driveListFiles(t, parentId) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`,
    { headers: { Authorization: `Bearer ${t}` } }
  )
  return (await r.json()).files || []
}

async function driveReadContent(t, file) {
  let url
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet')
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`
  else if (file.mimeType === 'application/vnd.google-apps.document')
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`
  else
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } })
  return (await r.text()).slice(0, 10000)
}

async function getOrCreate(t, name, parentId) {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`
  const ex = await driveFind(t, q)
  if (ex.length) return ex[0].id
  const body = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]
  return (await driveCreate(t, body)).id
}

async function createSheetIfNotExists(t, name, parentId, rows) {
  const ex = await driveFind(t, `name='${name}' and '${parentId}' in parents and trashed=false`)
  if (ex.length) return ex[0].id
  const file = await driveCreate(t, { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [parentId] })
  if (!file.id) return null
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/A1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows, majorDimension: 'ROWS' })
    })
  } catch {}
  return file.id
}

// ── AGREGAR FILA A PLANILLA DRIVE ─────────────────────────────────
async function appendRowToSheet(token, fileId, values) {
  try {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [values], majorDimension: 'ROWS' })
      }
    )
    return true
  } catch { return false }
}

async function findCurrentMonthSheet(token, folderId, tipo) {
  const now = new Date()
  const mes = now.toLocaleDateString('es-CL', { month: 'long' })
  const año = now.getFullYear()
  const name = `${tipo} ${mes} ${año}`
  const ex = await driveFind(token, `name='${name}' and '${folderId}' in parents and trashed=false`)
  if (ex.length) return ex[0].id
  const headers = tipo === 'Ingresos'
    ? ['Fecha', 'Nombre Paciente', 'Servicio Realizado', 'Monto (CLP)', 'Método de Pago', 'Notas']
    : ['Fecha', 'Descripción del Gasto', 'Categoría', 'Monto (CLP)', 'Proveedor / Empresa', 'Notas']
  return await createSheetIfNotExists(token, name, folderId, [headers])
}

const FOLDERS = [
  { name:'Ingresos', emoji:'💰' },
  { name:'Gastos', emoji:'💳' },
]

async function setupDrive(t) {
  const rootId = await getOrCreate(t, 'DentaIQ')
  const folders = []
  const now = new Date()
  const año = now.getFullYear()
  const mes = now.toLocaleDateString('es-CL', { month: 'long' })
  const hoy = now.toLocaleDateString('es-CL')

  for (const { name, emoji } of FOLDERS) {
    const id = await getOrCreate(t, name, rootId)
    if (name === 'Ingresos') {
      await createSheetIfNotExists(t, `Ingresos ${mes} ${año}`, id, [
        ['📌 Agrega un ingreso por fila. Borra los ejemplos.','','','','',''],
        ['Fecha','Nombre Paciente','Servicio Realizado','Monto (CLP)','Método de Pago','Notas'],
        [hoy,'María González','Ortodoncia cuota','120000','Transferencia','Ejemplo - borra'],
        [hoy,'Carlos Pérez','Implante dental','850000','Tarjeta','Ejemplo - borra'],
        [hoy,'Ana Martínez','Limpieza dental','65000','Efectivo','Ejemplo - borra'],
      ])
      await createSheetIfNotExists(t, `Ingresos ${año-1} (año anterior)`, id, [
        ['Fecha','Nombre Paciente','Servicio Realizado','Monto (CLP)','Método de Pago','Notas'],
      ])
    }
    if (name === 'Gastos') {
      await createSheetIfNotExists(t, `Gastos ${mes} ${año}`, id, [
        ['📌 Agrega un gasto por fila. Borra los ejemplos.','','','','',''],
        ['Fecha','Descripción del Gasto','Categoría','Monto (CLP)','Proveedor / Empresa','Notas'],
        [hoy,'Insumos dentales','Insumos y materiales','245000','3M Chile','Ejemplo - borra'],
        [hoy,'Arriendo clínica','Arriendo','450000','Inmobiliaria','Ejemplo - borra'],
        [hoy,'Sueldo asistente','Personal','580000','','Ejemplo - borra'],
      ])
      await createSheetIfNotExists(t, `Gastos ${año-1} (año anterior)`, id, [
        ['Fecha','Descripción del Gasto','Categoría','Monto (CLP)','Proveedor / Empresa','Notas'],
      ])
    }
    const files = await driveListFiles(t, id)
    folders.push({ id, name, emoji, files })
  }
  return { folders, rootId }
}

// ── PARSEAR CSV DE PROVEEDORES (estructura real del archivo) ───────
// Columnas reales: 0=código, 1=empresa, 2=dirección, 3=país, 4=RUT,
// 5=contacto, 6=descripción, 7=frecuencia, 8=términos, 9=email,
// 10=teléfono, 11=factura, 12=fecha, 13..N-5=artículo, N-4=precio, N-3=IVA, N-2=estado, N-1=total
function parseProveedorRow(line) {
  const cols = line.split(',').map(c => c.trim())
  if (cols.length < 14) return null

  // Parse from right: total, estado, IVA, precio, cantidad
  const total = cols[cols.length - 1]
  const estado = cols[cols.length - 2]
  const iva = cols[cols.length - 3]
  const precio = cols[cols.length - 4]
  const cantidad = cols[cols.length - 5]

  // Middle columns (13 onwards until before cantidad) = artículo
  const articuloCols = cols.slice(13, cols.length - 5)
  const articulo = articuloCols.join(' ').trim()

  // Fixed left columns
  const empresa = cols[1] || ''
  const direccion = cols[2] || ''
  const rut = cols[4] || ''
  const contacto = cols[5] || ''
  const telefono = cols[10] || ''
  const factura = cols[11] || ''
  const fecha = cols[12] || ''

  if (!articulo && !empresa) return null

  return { empresa, direccion, rut, contacto, telefono, factura, fecha, articulo, cantidad, precio, iva, estado, total }
}

function parseProveedoresCSV(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(l => l)
  const rows = []
  let startIdx = 0

  // Skip instruction row and header row
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].toLowerCase().includes('empresa') || lines[i].toLowerCase().includes('factura') || lines[i].toLowerCase().includes('articulo')) {
      startIdx = i + 1; break
    }
    if (lines[i].startsWith('📌') || lines[i].startsWith('Código')) {
      startIdx = i + 1
    }
  }

  for (let i = startIdx; i < lines.length; i++) {
    const row = parseProveedorRow(lines[i])
    if (row && row.articulo) rows.push(row)
  }
  return rows
}

// ── IA ────────────────────────────────────────────────────────────
async function askAI(msgs, system) {
  if (!AI_API_KEY || AI_API_KEY.includes('REEMPLAZA')) {
    return '⚙️ Necesitas configurar tu API key de Groq. Ve a console.groq.com → API Keys → Create API Key → y reemplaza la línea 8 en el código (AI_API_KEY).'
  }
  const url = AI_PROVIDER === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role:'system', content:system }, ...msgs] })
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error.message)
  return d.choices?.[0]?.message?.content || ''
}

// ── RECONNECT SCREEN ──────────────────────────────────────────────
function Reconnecting({ savedUser, onLogin, onLogout }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const reconnect = async () => {
    setLoading(true); setError('')
    try {
      const u = await signIn(savedUser.email, false)
      onLogin(u)
    } catch(e) {
      setError(e.message)
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' }}>
      <div style={{ background:C.white, borderRadius:20, padding:'40px', maxWidth:380, width:'100%', textAlign:'center', border:`1px solid ${C.border}`, boxShadow:`0 4px 20px ${C.shadow}` }}>
        <div style={{ fontSize:48, marginBottom:16 }}>🦷</div>
        <h2 style={{ margin:'0 0 8px', fontSize:20, fontWeight:800, color:C.text }}>Bienvenido de vuelta</h2>
        <p style={{ fontSize:14, color:C.sub, marginBottom:24 }}>Tu sesión expiró. Reconéctate para continuar.</p>

        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:C.bg, borderRadius:10, marginBottom:20, border:`1px solid ${C.border}` }}>
          {savedUser.picture
            ? <img src={savedUser.picture} style={{ width:32, height:32, borderRadius:'50%' }}/>
            : <div style={{ width:32, height:32, borderRadius:'50%', background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:700 }}>{savedUser.name[0]}</div>
          }
          <div style={{ textAlign:'left' }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{savedUser.name}</div>
            <div style={{ fontSize:11, color:C.sub }}>{savedUser.email}</div>
          </div>
        </div>

        <button onClick={reconnect} disabled={loading} style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:10, background:C.teal, color:'#fff', border:'none', borderRadius:12, padding:'14px', fontSize:15, fontWeight:700, cursor:'pointer', marginBottom:12, opacity:loading?0.7:1 }}>
          {loading ? '⏳ Reconectando...' : '🔄 Reconectar con Google'}
        </button>

        {error && <div style={{ padding:'8px 12px', background:C.redL, borderRadius:8, fontSize:13, color:C.red, marginBottom:12 }}>{error}</div>}

        <button onClick={onLogout} style={{ background:'none', border:'none', color:C.sub, fontSize:12, cursor:'pointer' }}>
          Cerrar sesión e ingresar con otra cuenta
        </button>
      </div>
    </div>
  )
}

// ── WELCOME ───────────────────────────────────────────────────────
function Welcome({ onLogin }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loginDemo = () => {
    onLogin({ email:'demo@dentaiq.cl', name:'Dr. Demo', picture:'', token:'demo' }, false)
  }

  const login = async () => {
    setLoading(true); setError('')
    try {
      const u = await signIn()
      onLogin(u, true)
    } catch(e) { setError(e.message) }
    setLoading(false)
  }

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'24px', fontFamily:'inherit' }}>
      <div style={{ marginBottom:40, textAlign:'center' }}>
        <div style={{ width:64, height:64, borderRadius:20, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32, margin:'0 auto 16px', boxShadow:'0 4px 20px rgba(0,122,107,0.3)' }}>🦷</div>
        <h1 style={{ margin:'0 0 6px', fontSize:32, fontWeight:800, color:C.text }}>DentaIQ</h1>
        <p style={{ margin:0, fontSize:16, color:C.sub }}>Tu gerente financiero inteligente</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:40, maxWidth:680, width:'100%' }}>
        {[
          ['📊','Finanzas en tiempo real','Conecta Drive y la IA analiza tus ingresos y gastos automáticamente.'],
          ['🔍','Buscador de insumos','Encuentra proveedores, precios y compara quién vende más barato.'],
          ['🔄','Sincronización Drive','Agrega datos en DentaIQ y se guardan automáticamente en tu planilla.'],
        ].map(([icon,title,desc]) => (
          <div key={title} style={{ background:C.white, borderRadius:16, padding:'20px', border:`1px solid ${C.border}`, boxShadow:`0 1px 4px ${C.shadow}` }}>
            <div style={{ fontSize:28, marginBottom:10 }}>{icon}</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:6 }}>{title}</div>
            <div style={{ fontSize:13, color:C.sub, lineHeight:1.5 }}>{desc}</div>
          </div>
        ))}
      </div>

      <div style={{ background:C.white, borderRadius:20, padding:'32px 36px', border:`1px solid ${C.border}`, boxShadow:`0 2px 12px ${C.shadow}`, width:'100%', maxWidth:380, textAlign:'center' }}>
        <div style={{ fontSize:15, fontWeight:700, color:C.text, marginBottom:4 }}>Empieza gratis hoy</div>
        <div style={{ fontSize:13, color:C.sub, marginBottom:20 }}>Tu sesión se recordará automáticamente</div>

        <button onClick={login} disabled={loading} style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:12, background:C.white, color:'#3c4043', border:'1.5px solid #dadce0', borderRadius:12, padding:'13px 20px', fontSize:15, fontWeight:500, cursor:'pointer', marginBottom:10, boxShadow:'0 1px 3px rgba(0,0,0,0.08)', opacity:loading?0.7:1 }}>
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {loading ? 'Conectando...' : 'Continuar con Google'}
        </button>

        <button onClick={loginDemo} style={{ width:'100%', background:C.teal, color:'#fff', border:'none', borderRadius:12, padding:'13px', fontSize:15, fontWeight:700, cursor:'pointer', marginBottom:14 }}>
          🚀 Ver demo
        </button>

        {error && <div style={{ padding:'10px', background:C.redL, borderRadius:8, fontSize:13, color:C.red, marginBottom:10 }}>{error}</div>}
        <p style={{ margin:0, fontSize:11, color:C.light }}>Sesión recordada por 50 minutos · Sin contraseña adicional</p>
      </div>
    </div>
  )
}

// ── ONBOARDING ────────────────────────────────────────────────────
function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0)
  const steps = [
    { icon:'👋', title:`Hola ${user.name.split(' ')[0]}`, desc:'DentaIQ creó tus carpetas en Drive. Tu sesión se recordará automáticamente — no necesitas volver a ingresar credenciales.' },
    { icon:'🔄', title:'Todo se sincroniza', desc:'Agrega ingresos o gastos en DentaIQ y automáticamente se guardan en tu planilla de Drive. O edita la planilla directamente — ambas formas funcionan.' },
    { icon:'🔍', title:'Buscador de proveedores', desc:'En la sección Buscador puedes ver todos tus proveedores e insumos, filtrar por nombre y comparar precios entre proveedores.' },
    { icon:'🤖', title:'La IA lee todo', desc:'El Consejero IA lee tus planillas automáticamente y te dice cómo va tu clínica en lenguaje simple.' },
  ]
  const s = steps[step]
  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ background:C.white, borderRadius:24, padding:'48px 40px', maxWidth:480, width:'100%', textAlign:'center', border:`1px solid ${C.border}`, boxShadow:`0 4px 24px ${C.shadow}` }}>
        <div style={{ fontSize:56, marginBottom:20 }}>{s.icon}</div>
        <h2 style={{ margin:'0 0 12px', fontSize:24, fontWeight:800, color:C.text }}>{s.title}</h2>
        <p style={{ margin:'0 0 32px', fontSize:15, color:C.sub, lineHeight:1.7 }}>{s.desc}</p>
        <div style={{ display:'flex', justifyContent:'center', gap:8, marginBottom:28 }}>
          {steps.map((_,i) => <div key={i} style={{ width:i===step?24:8, height:8, borderRadius:4, background:i===step?C.teal:C.border, transition:'all 0.2s' }}/>)}
        </div>
        <button onClick={() => step < steps.length-1 ? setStep(s=>s+1) : onDone()} style={{ width:'100%', background:C.teal, color:'#fff', border:'none', borderRadius:12, padding:'14px', fontSize:15, fontWeight:700, cursor:'pointer' }}>
          {step < steps.length-1 ? 'Siguiente →' : '¡Empezar!'}
        </button>
        {step > 0 && <button onClick={() => setStep(s=>s-1)} style={{ marginTop:10, background:'none', border:'none', color:C.sub, fontSize:13, cursor:'pointer' }}>← Volver</button>}
      </div>
    </div>
  )
}

// ── DASHBOARD ─────────────────────────────────────────────────────
function Dashboard({ user, txs, folders, aiSummary, loadingAI }) {
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const margen = ing - gas
  const pct = ing > 0 ? (margen/ing)*100 : 0
  const totalFiles = folders.reduce((s,f)=>s+f.files.length,0)

  return (
    <div style={{ padding:'32px', maxWidth:960 }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ margin:0, fontSize:26, fontWeight:800, color:C.text }}>Hola, {user.name.split(' ')[0]} 👋</h1>
        <p style={{ margin:'4px 0 0', fontSize:14, color:C.sub }}>{new Date().toLocaleDateString('es-CL',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
      </div>

      <div style={{ background:margen>=0?C.tealL:C.redL, borderRadius:20, padding:'20px 24px', marginBottom:20, border:`1px solid ${margen>=0?C.teal+'33':C.red+'33'}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <span style={{ fontSize:30 }}>{margen>=0?'✅':'⚠️'}</span>
          <div>
            <div style={{ fontSize:17, fontWeight:800, color:margen>=0?C.tealD:C.red }}>
              {txs.length===0?'Sube tus planillas en Drive para ver tu situación':'Tu clínica está '+(margen>=0?'ganando dinero':'en pérdida este mes')}
            </div>
            {txs.length>0&&<div style={{ fontSize:13, color:margen>=0?C.teal:C.red }}>Margen: {pct.toFixed(1)}%</div>}
          </div>
        </div>
      </div>

      {txs.length>0&&(
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14, marginBottom:20 }}>
          {[
            { label:'Lo que entró', value:clp(ing), icon:'📈', color:C.green, bg:C.greenL },
            { label:'Lo que salió', value:clp(gas), icon:'📉', color:C.red, bg:C.redL },
            { label:'Lo que queda', value:clp(margen), icon:margen>=0?'💰':'🚨', color:margen>=0?C.teal:C.red, bg:margen>=0?C.tealL:C.redL },
          ].map(k=>(
            <div key={k.label} style={{ background:k.bg, borderRadius:14, padding:'18px 20px', border:`1px solid ${k.color}33` }}>
              <div style={{ fontSize:26, marginBottom:6 }}>{k.icon}</div>
              <div style={{ fontSize:12, color:C.sub, marginBottom:3 }}>{k.label}</div>
              <div style={{ fontSize:26, fontWeight:800, color:k.color }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ background:C.white, borderRadius:18, padding:'20px 24px', marginBottom:20, border:`1px solid ${C.border}`, boxShadow:`0 1px 6px ${C.shadow}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
          <div style={{ width:34, height:34, borderRadius:10, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>🤖</div>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:C.text }}>Consejero IA</div>
            <div style={{ fontSize:11, color:C.sub }}>Análisis basado en tus planillas</div>
          </div>
          {loadingAI&&<div style={{ marginLeft:'auto', fontSize:11, color:C.sub }}>Analizando...</div>}
        </div>
        {aiSummary
          ?<p style={{ margin:0, fontSize:14, color:C.text, lineHeight:1.7, whiteSpace:'pre-wrap' }}>{aiSummary}</p>
          :<p style={{ margin:0, fontSize:13, color:C.sub, fontStyle:'italic' }}>{totalFiles===0?'Sube tus planillas en Drive para análisis automático.':'Abre Consejero IA para analizar tus datos.'}</p>
        }
      </div>

      <div style={{ background:C.white, borderRadius:18, padding:'18px 22px', border:`1px solid ${C.border}`, boxShadow:`0 1px 6px ${C.shadow}` }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:12 }}>☁️ Carpetas en Drive</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:10 }}>
          {folders.map(f=>(
            <div key={f.id} style={{ textAlign:'center', padding:'14px', background:C.bg, borderRadius:12, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:24, marginBottom:4 }}>{f.emoji}</div>
              <div style={{ fontSize:13, color:C.text, fontWeight:600, marginBottom:2 }}>{f.name}</div>
              <div style={{ fontSize:11, color:f.files.length>0?C.teal:C.light }}>{f.files.length>0?`${f.files.length} archivos`:'Vacía'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── MIS NÚMEROS (con sync a Drive) ────────────────────────────────
function MisNumeros({ txs, setTxs, user, folderIds }) {
  const [form, setForm] = useState({ tipo:'I', desc:'', cat:'Servicios dentales', monto:'', metodo:'Transferencia' })
  const [open, setOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)

  const CATS_I = ['Servicios dentales','Ortodoncia','Implantes','Blanqueamiento','Convenios','Otros ingresos']
  const CATS_G = ['Insumos y materiales','Personal','Arriendo','Equipos','Servicios básicos','Publicidad','Contabilidad','Otros gastos']
  const METODOS = ['Transferencia','Efectivo','Tarjeta débito','Tarjeta crédito','Cheque']

  const inp = { width:'100%', background:C.bg, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:'10px 12px', fontSize:14, fontFamily:'inherit', outline:'none' }

  // Dashboard de categorías
  const catGastos = CATS_G.map(cat => ({ cat, total: txs.filter(t=>t.tipo==='G'&&t.cat===cat).reduce((s,t)=>s+t.monto,0) })).filter(c=>c.total>0).sort((a,b)=>b.total-a.total)
  const catIngresos = CATS_I.map(cat => ({ cat, total: txs.filter(t=>t.tipo==='I'&&t.cat===cat).reduce((s,t)=>s+t.monto,0) })).filter(c=>c.total>0).sort((a,b)=>b.total-a.total)
  const maxGasto = catGastos[0]?.total || 1
  const maxIngreso = catIngresos[0]?.total || 1

  const guardar = async () => {
    if (!form.desc.trim() || !form.monto) return
    const fecha = new Date().toLocaleDateString('es-CL')
    const tx = { id:Date.now(), tipo:form.tipo, desc:form.desc, cat:form.cat, monto:parseInt(form.monto), fecha, fuente:'manual', metodo:form.metodo }
    setTxs(p => [tx, ...p])
    setForm({ tipo:'I', desc:'', cat:'Servicios dentales', monto:'', metodo:'Transferencia' })
    setOpen(false)

    // Sync a Drive
    if (user.token !== 'demo' && folderIds) {
      setSyncing(true)
      try {
        const folderId = form.tipo === 'I' ? folderIds.ingresos : folderIds.gastos
        if (folderId) {
          const sheetId = await findCurrentMonthSheet(user.token, folderId, form.tipo === 'I' ? 'Ingresos' : 'Gastos')
          if (sheetId) {
            const values = form.tipo === 'I'
              ? [fecha, form.desc, form.cat, parseInt(form.monto), form.metodo, 'Desde DentaIQ']
              : [fecha, form.desc, form.cat, parseInt(form.monto), '', 'Desde DentaIQ']
            await appendRowToSheet(user.token, sheetId, values)
            setSyncMsg('✅ Guardado en Drive')
          }
        }
      } catch { setSyncMsg('⚠️ Guardado localmente (Drive no disponible)') }
      setSyncing(false)
      setTimeout(() => setSyncMsg(''), 3000)
    }
  }

  return (
    <div style={{ padding:'32px', maxWidth:900 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0, fontSize:24, fontWeight:800, color:C.text }}>Mis Números</h1>
          <p style={{ margin:'4px 0 0', fontSize:13, color:C.sub }}>Los datos se sincronizan automáticamente con Google Drive</p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {syncMsg && <span style={{ fontSize:12, color:syncMsg.includes('✅')?C.green:C.gold, fontWeight:600 }}>{syncMsg}</span>}
          {syncing && <span style={{ fontSize:12, color:C.sub }}>Sincronizando...</span>}
          <button onClick={()=>setOpen(!open)} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:10, padding:'10px 18px', fontSize:14, fontWeight:700, cursor:'pointer' }}>+ Agregar</button>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:20 }}>
        {[['Lo que entró',ing,C.green,C.greenL,'📈'],['Lo que salió',gas,C.red,C.redL,'📉'],['Balance',ing-gas,ing-gas>=0?C.teal:C.red,ing-gas>=0?C.tealL:C.redL,ing-gas>=0?'✅':'⚠️']].map(([l,v,c,bg,ico])=>(
          <div key={l} style={{ background:bg, borderRadius:14, padding:'16px 18px', border:`1px solid ${c}33` }}>
            <div style={{ fontSize:20, marginBottom:6 }}>{ico}</div>
            <div style={{ fontSize:12, color:C.sub, marginBottom:3 }}>{l}</div>
            <div style={{ fontSize:22, fontWeight:800, color:c }}>{clp(v)}</div>
          </div>
        ))}
      </div>

      {/* Dashboard categorías */}
      {txs.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:20 }}>
          <div style={{ background:C.white, borderRadius:14, padding:'18px', border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:12 }}>📉 Gastos por categoría</div>
            {catGastos.length===0 ? <div style={{ fontSize:13, color:C.sub }}>Sin gastos</div> : catGastos.map(({cat,total})=>(
              <div key={cat} style={{ marginBottom:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                  <span style={{ fontSize:12, color:C.text }}>{cat}</span>
                  <span style={{ fontSize:12, fontWeight:700, color:C.red }}>{clp(total)}</span>
                </div>
                <div style={{ height:5, background:C.bg, borderRadius:3 }}>
                  <div style={{ height:'100%', width:`${(total/maxGasto)*100}%`, background:C.red, borderRadius:3 }}/>
                </div>
              </div>
            ))}
          </div>
          <div style={{ background:C.white, borderRadius:14, padding:'18px', border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:12 }}>📈 Ingresos por categoría</div>
            {catIngresos.length===0 ? <div style={{ fontSize:13, color:C.sub }}>Sin ingresos</div> : catIngresos.map(({cat,total})=>(
              <div key={cat} style={{ marginBottom:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                  <span style={{ fontSize:12, color:C.text }}>{cat}</span>
                  <span style={{ fontSize:12, fontWeight:700, color:C.green }}>{clp(total)}</span>
                </div>
                <div style={{ height:5, background:C.bg, borderRadius:3 }}>
                  <div style={{ height:'100%', width:`${(total/maxIngreso)*100}%`, background:C.green, borderRadius:3 }}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Formulario */}
      {open && (
        <div style={{ background:C.white, borderRadius:16, padding:22, marginBottom:14, border:`1px solid ${C.border}`, boxShadow:`0 2px 8px ${C.shadow}` }}>
          <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:14 }}>¿Qué quieres registrar?</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 }}>
            <div>
              <label style={{ fontSize:11, color:C.sub, display:'block', marginBottom:5, fontWeight:600 }}>TIPO</label>
              <div style={{ display:'flex', gap:6 }}>
                {[['I','💰 Entró'],['G','💳 Salió']].map(([v,l])=>(
                  <button key={v} onClick={()=>setForm({...form,tipo:v,cat:v==='I'?CATS_I[0]:CATS_G[0]})} style={{ flex:1, padding:'8px 4px', borderRadius:7, border:`2px solid ${form.tipo===v?C.teal:C.border}`, background:form.tipo===v?C.tealL:'transparent', color:form.tipo===v?C.tealD:C.sub, fontSize:12, fontWeight:form.tipo===v?700:400, cursor:'pointer' }}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize:11, color:C.sub, display:'block', marginBottom:5, fontWeight:600 }}>CATEGORÍA</label>
              <select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})} style={inp}>
                {(form.tipo==='I'?CATS_I:CATS_G).map(o=><option key={o}>{o}</option>)}
              </select>
            </div>
            {form.tipo==='I' && (
              <div>
                <label style={{ fontSize:11, color:C.sub, display:'block', marginBottom:5, fontWeight:600 }}>MÉTODO DE PAGO</label>
                <select value={form.metodo} onChange={e=>setForm({...form,metodo:e.target.value})} style={inp}>
                  {METODOS.map(o=><option key={o}>{o}</option>)}
                </select>
              </div>
            )}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr auto', gap:12, alignItems:'flex-end' }}>
            <div>
              <label style={{ fontSize:11, color:C.sub, display:'block', marginBottom:5, fontWeight:600 }}>DESCRIPCIÓN</label>
              <input value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder={form.tipo==='I'?'Ej: Ortodoncia Ana García':'Ej: Insumos Septodont'} style={inp}/>
            </div>
            <div>
              <label style={{ fontSize:11, color:C.sub, display:'block', marginBottom:5, fontWeight:600 }}>MONTO (CLP)</label>
              <input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="150000" style={inp}/>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={guardar} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:8, padding:'10px 18px', fontSize:14, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
                {user.token!=='demo'?'💾 Guardar + Drive':'💾 Guardar'}
              </button>
              <button onClick={()=>setOpen(false)} style={{ background:C.bg, color:C.sub, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 14px', fontSize:14, cursor:'pointer' }}>✕</button>
            </div>
          </div>
          {user.token!=='demo'&&<p style={{ margin:'10px 0 0', fontSize:11, color:C.sub }}>💡 Se guardará automáticamente en tu planilla de Drive</p>}
        </div>
      )}

      {txs.length===0
        ?<div style={{ background:C.white, borderRadius:14, padding:'36px', textAlign:'center', border:`2px dashed ${C.border}` }}>
          <div style={{ fontSize:36, marginBottom:10 }}>📋</div>
          <div style={{ fontSize:14, fontWeight:600, color:C.text, marginBottom:6 }}>Nada registrado aún</div>
          <div style={{ fontSize:13, color:C.sub }}>Agrega un ingreso o gasto — se sincronizará con Drive automáticamente</div>
        </div>
        :<div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden', boxShadow:`0 1px 6px ${C.shadow}` }}>
          <div style={{ padding:'12px 18px', borderBottom:`1px solid ${C.border}`, fontSize:13, fontWeight:700, color:C.text }}>Últimas transacciones</div>
          {txs.slice(0,20).map((tx,i)=>(
            <div key={tx.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 18px', borderBottom:i<Math.min(txs.length,20)-1?`1px solid ${C.border}`:'none' }}>
              <div style={{ width:38, height:38, borderRadius:9, background:tx.tipo==='I'?C.greenL:C.redL, display:'flex', alignItems:'center', justifyContent:'center', fontSize:17, flexShrink:0 }}>{tx.tipo==='I'?'📈':'📉'}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, color:C.text, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tx.desc}</div>
                <div style={{ fontSize:11, color:C.sub, marginTop:1 }}>{tx.cat} · {tx.fecha}{tx.fuente==='drive'?<span style={{ color:C.teal }}> · ☁️</span>:null}</div>
              </div>
              <div style={{ fontSize:15, fontWeight:800, color:tx.tipo==='I'?C.green:C.red, flexShrink:0 }}>{tx.tipo==='I'?'+':'−'}{clp(tx.monto)}</div>
            </div>
          ))}
        </div>
      }
    </div>
  )
}

// ── CONSEJERO IA ──────────────────────────────────────────────────
function Consejero({ user, txs, folders }) {
  const CHAT_KEY = `dentaiq_chat_${user.email}`
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const [driveContext, setDriveContext] = useState('')
  const [loadingDrive, setLoadingDrive] = useState(false)
  const [msgs, setMsgs] = useState(() => {
    try { const s = localStorage.getItem(CHAT_KEY); return s ? JSON.parse(s) : [{ role:'assistant', content:`Hola ${user.name.split(' ')[0]} 👋 Leyendo tus planillas...` }] }
    catch { return [{ role:'assistant', content:`Hola ${user.name.split(' ')[0]} 👋 ¿En qué te ayudo?` }] }
  })
  const [inp, setInp] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef(null)

  useEffect(() => {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-40))) } catch {}
  }, [msgs])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }) }, [msgs])

  useEffect(() => {
    if (user.token === 'demo' || !folders.length) return
    const load = async () => {
      setLoadingDrive(true)
      let ctx = ''
      for (const folder of folders) {
        for (const file of folder.files.slice(0,2)) {
          if (file.mimeType?.includes('spreadsheet')) {
            try { const c = await driveReadContent(user.token, file); ctx += `\n\n[${folder.name}: ${file.name}]\n${c.slice(0,3000)}` } catch {}
          }
        }
      }
      setDriveContext(ctx)
      setMsgs(prev => {
        const last = prev[prev.length-1]
        if (last?.role==='assistant' && last.content.includes('Leyendo')) {
          const msg = ctx ? `Hola ${user.name.split(' ')[0]} 👋 Leí tus planillas de Drive. Tengo tus datos reales. ¿Qué quieres saber? 📊` : `Hola ${user.name.split(' ')[0]} 👋 No encontré planillas con datos aún. Sube archivos a tu Drive o agrega datos en Mis Números.`
          return [...prev.slice(0,-1), { role:'assistant', content:msg }]
        }
        return prev
      })
      setLoadingDrive(false)
    }
    load()
  }, [folders])

  const system = `Eres el consejero financiero de ${user.name}, dueño/a de una clínica dental en Chile. Hablas como amigo experto, lenguaje simple.
DATOS APP: Ingresos ${clp(ing)}, Gastos ${clp(gas)}, Balance ${clp(ing-gas)}.
${driveContext ? `DATOS REALES DRIVE:\n${driveContext}` : 'Sin datos en Drive aún.'}
Responde con emojis, máx 250 palabras, español chileno. Un consejo concreto siempre.`

  const SUGERENCIAS = ['¿Estoy ganando suficiente?','¿En qué me gasto más?','Analiza mis planillas de Drive','¿Cuál es mi margen?','¿Qué mejorar?']

  const send = async (texto) => {
    const t = (texto||inp).trim(); if (!t||loading) return
    setInp('')
    const hist = [...msgs, { role:'user', content:t }]
    setMsgs([...hist, { role:'assistant', content:'', loading:true }]); setLoading(true)
    try {
      const reply = await askAI(hist.filter(m=>!m.loading).map(m=>({role:m.role,content:m.content})), system)
      setMsgs([...hist, { role:'assistant', content:reply }])
    } catch(e) { setMsgs([...hist, { role:'assistant', content:`❌ ${e.message}` }]) }
    setLoading(false)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', maxWidth:820, padding:'0 32px' }}>
      <div style={{ padding:'24px 0 14px', display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
        <div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:800, color:C.text }}>Consejero IA 🤖</h1>
          <p style={{ margin:'3px 0 0', fontSize:12, color:C.sub }}>{loadingDrive?'⏳ Leyendo Drive...':driveContext?'✅ Datos de Drive cargados':'📋 Agrega planillas en Drive para análisis real'}</p>
        </div>
        <button onClick={()=>{ const i=[{role:'assistant',content:`Hola ${user.name.split(' ')[0]} 👋 ¿En qué te ayudo?`}]; setMsgs(i); try{localStorage.setItem(CHAT_KEY,JSON.stringify(i))}catch{} }} style={{ background:'transparent', border:`1px solid ${C.border}`, color:C.sub, borderRadius:8, padding:'5px 10px', fontSize:11, cursor:'pointer' }}>🗑 Limpiar</button>
      </div>
      <div style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:14, paddingBottom:14 }}>
        {msgs.map((m,i)=>(
          <div key={i} style={{ display:'flex', justifyContent:m.role==='user'?'flex-end':'flex-start', gap:10, alignItems:'flex-start' }}>
            {m.role==='assistant'&&<div style={{ width:34,height:34,borderRadius:9,background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0 }}>🤖</div>}
            <div style={{ maxWidth:'78%', padding:'12px 14px', fontSize:14, lineHeight:1.7, whiteSpace:'pre-wrap', borderRadius:m.role==='user'?'14px 14px 4px 14px':'4px 14px 14px 14px', background:m.role==='user'?C.teal:C.white, color:m.role==='user'?'#fff':C.text, boxShadow:m.role==='assistant'?`0 1px 4px ${C.shadow}`:'none', border:m.role==='assistant'?`1px solid ${C.border}`:'none' }}>
              {m.loading?<div style={{display:'flex',gap:4}}>{[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:'50%',background:C.sub,animation:`dots 1.2s ${i*0.2}s infinite`}}/>)}</div>:m.content}
            </div>
            {m.role==='user'&&<div style={{width:34,height:34,borderRadius:9,background:C.blueL,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,overflow:'hidden'}}>{user.picture?<img src={user.picture} style={{width:'100%',height:'100%',objectFit:'cover'}}/>:<span style={{fontSize:14}}>👤</span>}</div>}
          </div>
        ))}
        <div ref={endRef}/>
      </div>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
        {SUGERENCIAS.map(s=><button key={s} onClick={()=>send(s)} style={{ background:C.white, border:`1px solid ${C.border}`, color:C.text, borderRadius:18, padding:'5px 12px', fontSize:12, cursor:'pointer' }}>{s}</button>)}
      </div>
      <div style={{ display:'flex', gap:10, paddingBottom:24 }}>
        <textarea value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(inp)}}} placeholder="Escribe tu pregunta... (Enter para enviar)" rows={2} style={{ flex:1, background:C.white, border:`1.5px solid ${loading?C.border:C.teal}`, color:C.text, borderRadius:11, padding:'11px 14px', fontSize:14, fontFamily:'inherit', outline:'none', resize:'none' }}/>
        <button onClick={()=>send(inp)} disabled={loading||!inp.trim()} style={{ background:loading||!inp.trim()?C.border:C.teal, color:'#fff', border:'none', borderRadius:11, padding:'11px 18px', fontSize:14, fontWeight:700, cursor:loading||!inp.trim()?'default':'pointer' }}>Enviar</button>
      </div>
      <style>{`@keyframes dots{0%,100%{opacity:.2;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}`}</style>
    </div>
  )
}

// ── BUSCADOR DE INSUMOS Y PROVEEDORES ─────────────────────────────
function Buscador({ user, folders }) {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [filtro, setFiltro] = useState('')
  const [modo, setModo] = useState('tabla') // 'tabla' | 'comparar'
  const [comparaTerm, setComparaTerm] = useState('')

  // Cargar todos los datos al abrir
  useEffect(() => {
    if (loaded || user.token === 'demo') return
    const load = async () => {
      setLoading(true)
      const rows = []
      for (const folder of folders) {
        for (const file of folder.files) {
          if (!file.mimeType?.includes('spreadsheet')) continue
          try {
            const csv = await driveReadContent(user.token, file)
            const parsed = parseProveedoresCSV(csv)
            rows.push(...parsed)
          } catch {}
        }
      }
      setAllRows(rows)
      setLoaded(true)
      setLoading(false)
    }
    load()
  }, [folders, loaded])

  const filas = allRows.filter(r => {
    if (!filtro) return true
    const q = filtro.toLowerCase()
    return r.articulo?.toLowerCase().includes(q) ||
           r.empresa?.toLowerCase().includes(q) ||
           r.rut?.toLowerCase().includes(q) ||
           r.contacto?.toLowerCase().includes(q)
  })

  // Comparador: agrupar por artículo y comparar precios
  const getComparacion = () => {
    if (!comparaTerm.trim()) return []
    const q = comparaTerm.toLowerCase()
    const filtered = allRows.filter(r =>
      r.articulo?.toLowerCase().includes(q) || r.empresa?.toLowerCase().includes(q)
    )
    const grupos = {}
    for (const row of filtered) {
      const key = row.articulo?.toLowerCase().trim() || 'sin nombre'
      if (!grupos[key]) grupos[key] = { nombre: row.articulo, proveedores: {} }
      const pKey = row.empresa || 'Desconocido'
      if (!grupos[key].proveedores[pKey]) grupos[key].proveedores[pKey] = []
      grupos[key].proveedores[pKey].push(row)
    }
    return Object.values(grupos).map(g => {
      const provList = Object.entries(g.proveedores).map(([nombre, rows]) => {
        const precioNum = rows[rows.length-1]?.precio?.replace(/[$,\s]/g,'') || '0'
        const precio = parseFloat(precioNum) || 0
        const fechas = rows.map(r=>r.fecha).filter(Boolean)
        return { nombre, precio, precioRaw:rows[rows.length-1]?.precio, fecha:fechas[fechas.length-1]||'', count:rows.length }
      }).filter(p => p.precio > 0).sort((a,b)=>a.precio-b.precio)
      const minPrecio = provList[0]?.precio || 0
      return { nombre:g.nombre, proveedores:provList, minPrecio }
    }).filter(g => g.proveedores.length > 0)
  }

  const thStyle = { padding:'10px 14px', fontSize:12, fontWeight:700, color:C.sub, background:C.bg, borderBottom:`1px solid ${C.border}`, textAlign:'left', whiteSpace:'nowrap' }
  const tdStyle = { padding:'10px 14px', fontSize:12, color:C.text, borderBottom:`1px solid ${C.border}`, verticalAlign:'middle' }

  return (
    <div style={{ padding:'24px 28px', maxWidth:1100 }}>
      <div style={{ marginBottom:18 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800, color:C.text }}>Buscador de Insumos y Proveedores 🔍</h1>
        <p style={{ margin:'4px 0 0', fontSize:13, color:C.sub }}>Todos tus proveedores e insumos en un lugar. Filtra, busca y compara precios.</p>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        {[['tabla','📋 Ver todos'],['comparar','⚖️ Comparar precios']].map(([m,l])=>(
          <button key={m} onClick={()=>setModo(m)} style={{ padding:'8px 18px', borderRadius:20, border:`2px solid ${modo===m?C.teal:C.border}`, background:modo===m?C.tealL:'transparent', color:modo===m?C.tealD:C.sub, fontSize:13, fontWeight:modo===m?700:400, cursor:'pointer' }}>{l}</button>
        ))}
      </div>

      {modo === 'tabla' && <>
        <div style={{ display:'flex', gap:10, marginBottom:14 }}>
          <input value={filtro} onChange={e=>setFiltro(e.target.value)} placeholder="Filtrar por artículo, empresa, RUT..." style={{ flex:1, background:C.white, border:`1.5px solid ${C.teal}`, color:C.text, borderRadius:10, padding:'11px 16px', fontSize:14, fontFamily:'inherit', outline:'none' }}/>
          {filtro && <button onClick={()=>setFiltro('')} style={{ background:C.bg, border:`1px solid ${C.border}`, color:C.sub, borderRadius:10, padding:'0 14px', cursor:'pointer', fontSize:13 }}>✕ Limpiar</button>}
          <button onClick={()=>{setLoaded(false)}} disabled={loading} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:10, padding:'11px 16px', fontSize:13, fontWeight:600, cursor:'pointer' }}>↻ Actualizar</button>
        </div>

        {loading && <div style={{ textAlign:'center', padding:40, color:C.sub }}>Cargando proveedores desde Drive...</div>}

        {!loading && user.token === 'demo' && (
          <div style={{ background:C.tealL, borderRadius:14, padding:'24px', textAlign:'center', border:`1px solid ${C.teal}33` }}>
            <div style={{ fontSize:32, marginBottom:8 }}>☁️</div>
            <div style={{ fontSize:14, color:C.tealD, fontWeight:600 }}>Conecta con Google para ver tus proveedores reales</div>
            <div style={{ fontSize:13, color:C.sub, marginTop:4 }}>En el modo demo no hay datos de Drive disponibles</div>
          </div>
        )}

        {!loading && loaded && (
          <div>
            <div style={{ fontSize:12, color:C.sub, marginBottom:10 }}>
              {filas.length} resultado{filas.length!==1?'s':''}{filtro?` para "${filtro}"`:' — todos los registros'}
            </div>
            <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'auto', boxShadow:`0 1px 6px ${C.shadow}` }}>
              <table style={{ width:'100%', borderCollapse:'collapse', minWidth:900 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Empresa</th>
                    <th style={thStyle}>Dirección</th>
                    <th style={thStyle}>RUT</th>
                    <th style={thStyle}>Contacto</th>
                    <th style={thStyle}>Teléfono</th>
                    <th style={thStyle}>Factura</th>
                    <th style={thStyle}>Fecha</th>
                    <th style={thStyle}>Artículo</th>
                    <th style={thStyle}>Cantidad</th>
                    <th style={thStyle}>Precio neto</th>
                    <th style={thStyle}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.length === 0
                    ? <tr><td colSpan={11} style={{ ...tdStyle, textAlign:'center', padding:32, color:C.sub }}>No se encontraron resultados para "{filtro}"</td></tr>
                    : filas.map((r,i) => (
                      <tr key={i} style={{ background:i%2===0?'transparent':C.bg }}>
                        <td style={{ ...tdStyle, fontWeight:600, color:C.tealD }}>{r.empresa || '—'}</td>
                        <td style={tdStyle}>{r.direccion || '—'}</td>
                        <td style={{ ...tdStyle, fontFamily:'monospace', fontSize:11 }}>{r.rut || '—'}</td>
                        <td style={tdStyle}>{r.contacto || '—'}</td>
                        <td style={{ ...tdStyle, fontFamily:'monospace' }}>{r.telefono || '—'}</td>
                        <td style={{ ...tdStyle, fontFamily:'monospace' }}>{r.factura || '—'}</td>
                        <td style={{ ...tdStyle, whiteSpace:'nowrap' }}>{r.fecha || '—'}</td>
                        <td style={{ ...tdStyle, maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={r.articulo}>{r.articulo || '—'}</td>
                        <td style={{ ...tdStyle, textAlign:'center' }}>{r.cantidad || '—'}</td>
                        <td style={{ ...tdStyle, fontWeight:700, color:C.blue, textAlign:'right' }}>{r.precio || '—'}</td>
                        <td style={{ ...tdStyle, fontWeight:700, color:C.text, textAlign:'right' }}>{r.total || '—'}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>}

      {modo === 'comparar' && <>
        <div style={{ background:C.goldL, borderRadius:12, padding:'12px 16px', marginBottom:16, border:`1px solid ${C.gold}33`, fontSize:13, color:C.text }}>
          💡 Busca un insumo para ver qué proveedor lo vende más barato. <strong>El precio más bajo se marca en verde.</strong>
        </div>
        <div style={{ display:'flex', gap:10, marginBottom:20 }}>
          <input value={comparaTerm} onChange={e=>setComparaTerm(e.target.value)} onKeyDown={e=>e.key==='Enter'&&e.target.blur()} placeholder="Ej: anestesia, guantes, fresas, composite..." style={{ flex:1, background:C.white, border:`1.5px solid ${C.teal}`, color:C.text, borderRadius:10, padding:'12px 16px', fontSize:14, fontFamily:'inherit', outline:'none' }}/>
        </div>

        {comparaTerm && (() => {
          const grupos = getComparacion()
          if (!grupos.length) return <div style={{ textAlign:'center', padding:40, color:C.sub }}>No se encontraron registros para "{comparaTerm}"</div>
          return (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {grupos.map((g,gi) => (
                <div key={gi} style={{ background:C.white, borderRadius:16, border:`1px solid ${C.border}`, overflow:'hidden', boxShadow:`0 1px 6px ${C.shadow}` }}>
                  <div style={{ padding:'14px 20px', background:C.bg, borderBottom:`1px solid ${C.border}` }}>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{g.nombre}</div>
                    <div style={{ fontSize:12, color:C.sub, marginTop:2 }}>{g.proveedores.length} proveedor{g.proveedores.length!==1?'es':''} · Mejor precio: <strong style={{ color:C.green }}>{g.proveedores[0]?.precioRaw}</strong></div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:`repeat(${Math.min(g.proveedores.length, 3)}, 1fr)`, gap:0 }}>
                    {g.proveedores.map((p,pi) => (
                      <div key={pi} style={{ padding:'16px 20px', borderRight:pi<g.proveedores.length-1?`1px solid ${C.border}`:'none', background:pi===0?C.greenL:'transparent' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
                          <div style={{ fontSize:13, fontWeight:700, color:pi===0?C.green:C.text }}>{p.nombre}</div>
                          {pi===0&&<span style={{ background:C.green, color:'#fff', fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20 }}>MÁS BARATO</span>}
                          {pi===g.proveedores.length-1&&pi!==0&&<span style={{ background:C.redL, color:C.red, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20 }}>MÁS CARO</span>}
                        </div>
                        <div style={{ fontSize:22, fontWeight:800, color:pi===0?C.green:pi===g.proveedores.length-1&&pi!==0?C.red:C.text }}>{p.precioRaw || '—'}</div>
                        <div style={{ fontSize:11, color:C.sub, marginTop:4 }}>Última compra: {p.fecha || '—'}</div>
                        <div style={{ fontSize:11, color:C.sub }}>{p.count} registro{p.count!==1?'s':''}</div>
                        {pi > 0 && g.proveedores[0].precio > 0 && p.precio > 0 && (
                          <div style={{ marginTop:6, fontSize:11, color:C.red, fontWeight:600 }}>
                            +{((p.precio - g.proveedores[0].precio) / g.proveedores[0].precio * 100).toFixed(1)}% más caro
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
      </>}
    </div>
  )
}

// ── MI DRIVE ──────────────────────────────────────────────────────
function MiDrive({ user, folders, loading, onRefresh, onAnalyze }) {
  const [sel, setSel] = useState(null)
  const [reading, setReading] = useState(null)
  const activeF = folders.find(f=>f.id===sel)
  const canRead = (m) => m?.includes('spreadsheet')||m?.includes('document')||m?.includes('csv')
  const readAndAnalyze = async (file) => {
    setReading(file.id)
    try { const text = await driveReadContent(user.token, file); onAnalyze(text, file.name) } catch(e) { alert('Error: '+e.message) }
    setReading(null)
  }
  return (
    <div style={{ padding:'28px', maxWidth:880 }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:20 }}>
        <div><h1 style={{ margin:0, fontSize:22, fontWeight:800, color:C.text }}>Mi Drive ☁️</h1><p style={{ margin:'3px 0 0', fontSize:13, color:C.sub }}>Planillas sincronizadas con Google Drive</p></div>
        <div style={{ display:'flex', gap:8 }}>
          <a href="https://drive.google.com" target="_blank" rel="noreferrer" style={{ background:C.white, color:C.teal, border:`1px solid ${C.teal}`, borderRadius:9, padding:'8px 14px', fontSize:13, fontWeight:600, textDecoration:'none' }}>Abrir Drive →</a>
          <button onClick={onRefresh} disabled={loading} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:9, padding:'9px 14px', fontSize:13, fontWeight:600, cursor:'pointer' }}>↻ Actualizar</button>
        </div>
      </div>
      {loading ? <div style={{ textAlign:'center', padding:40, color:C.sub }}>Cargando...</div> : <>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:12, marginBottom:16 }}>
          {folders.map(f=>(
            <button key={f.id} onClick={()=>setSel(sel===f.id?null:f.id)} style={{ background:sel===f.id?C.tealL:C.white, border:`2px solid ${sel===f.id?C.teal:C.border}`, borderRadius:14, padding:'16px', textAlign:'center', cursor:'pointer' }}>
              <div style={{ fontSize:28, marginBottom:6 }}>{f.emoji}</div>
              <div style={{ fontSize:13, color:sel===f.id?C.tealD:C.text, fontWeight:600 }}>{f.name}</div>
              <div style={{ fontSize:11, color:f.files.length>0?C.teal:C.light, marginTop:3 }}>{f.files.length>0?`${f.files.length} archivos`:'Vacía'}</div>
            </button>
          ))}
        </div>
        {activeF && (
          <div style={{ background:C.white, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden' }}>
            <div style={{ padding:'12px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between' }}>
              <span style={{ fontSize:14, fontWeight:700 }}>{activeF.emoji} {activeF.name}</span>
              <span style={{ fontSize:12, color:C.sub }}>{activeF.files.length} archivos</span>
            </div>
            {activeF.files.length===0
              ?<div style={{ padding:'28px', textAlign:'center', color:C.sub }}>Carpeta vacía</div>
              :activeF.files.map((f,i)=>(
                <div key={f.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 18px', borderBottom:i<activeF.files.length-1?`1px solid ${C.border}`:'none' }}>
                  <span style={{ fontSize:20 }}>{f.mimeType?.includes('spreadsheet')?'📊':'📄'}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color:C.text, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.name}</div>
                    {f.modifiedTime&&<div style={{ fontSize:11, color:C.sub }}>{new Date(f.modifiedTime).toLocaleDateString('es-CL')}</div>}
                  </div>
                  {canRead(f.mimeType)&&<button onClick={()=>readAndAnalyze(f)} disabled={reading===f.id} style={{ background:C.tealL, color:C.tealD, border:`1px solid ${C.teal}33`, borderRadius:7, padding:'5px 12px', fontSize:12, fontWeight:600, cursor:'pointer' }}>{reading===f.id?'Leyendo...':'🤖 Analizar'}</button>}
                </div>
              ))
            }
          </div>
        )}
      </>}
    </div>
  )
}

// ── APP ROOT ──────────────────────────────────────────────────────
const NAV = [
  { id:'inicio', label:'Inicio', icon:'🏠' },
  { id:'numeros', label:'Mis Números', icon:'📊' },
  { id:'ia', label:'Consejero IA', icon:'🤖' },
  { id:'buscador', label:'Buscador', icon:'🔍' },
  { id:'drive', label:'Mi Drive', icon:'☁️' },
]

export default function App() {
  const [authState, setAuthState] = useState('loading') // loading | loggedOut | reauth | loggedIn
  const [savedSessionUser, setSavedSessionUser] = useState(null)
  const [user, setUser] = useState(null)
  const [onboarded, setOnboarded] = useState(false)
  const [tab, setTab] = useState('inicio')
  const [txs, setTxs] = useState([])
  const [folders, setFolders] = useState([])
  const [folderIds, setFolderIds] = useState(null)
  const [driveLoading, setDriveLoading] = useState(false)
  const [aiSummary, setAiSummary] = useState('')
  const [loadingAI, setLoadingAI] = useState(false)

  // Check session on load
  useEffect(() => {
    const session = loadSession()
    if (!session) { setAuthState('loggedOut'); return }
    if (!session.expired) {
      // Token still valid, restore session directly
      setUser(session.user)
      setAuthState('loggedIn')
      loadDrive(session.user.token)
      const seen = localStorage.getItem(`dentaiq_onboarded_${session.user.email}`)
      setOnboarded(!!seen)
    } else {
      // Token expired, show reauth screen
      setSavedSessionUser(session.user)
      setAuthState('reauth')
    }
  }, [])

  const loadDrive = useCallback(async (token) => {
    if (token === 'demo') {
      setFolders(FOLDERS.map((f,i) => ({ id:String(i), name:f.name, emoji:f.emoji, files:[] })))
      return
    }
    setDriveLoading(true)
    try {
      const { folders: f, rootId } = await setupDrive(token)
      setFolders(f)
      // Store folder IDs for sync
      const ids = {}
      for (const folder of f) {
        if (folder.name === 'Ingresos') ids.ingresos = folder.id
        if (folder.name === 'Gastos') ids.gastos = folder.id
      }
      setFolderIds(ids)
    } catch(e) { console.error(e) }
    setDriveLoading(false)
  }, [])

  const handleLogin = async (u, shouldSave = true) => {
    setUser(u)
    if (shouldSave && u.token !== 'demo') saveSession(u)
    await loadDrive(u.token)
    const seen = localStorage.getItem(`dentaiq_onboarded_${u.email}`)
    setOnboarded(!!seen)
    setAuthState('loggedIn')
  }

  const handleLogout = () => {
    clearSession()
    setUser(null)
    setAuthState('loggedOut')
    setSavedSessionUser(null)
    setFolders([])
    setFolderIds(null)
    setTxs([])
  }

  const handleOnboardingDone = () => {
    if (user) localStorage.setItem(`dentaiq_onboarded_${user.email}`, '1')
    setOnboarded(true)
  }

  const handleAnalyzeFile = useCallback(() => { setTab('ia') }, [])

  // States
  if (authState === 'loading') {
    return (
      <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'sans-serif' }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:16 }}>🦷</div>
          <div style={{ fontSize:16, color:C.sub }}>Cargando DentaIQ...</div>
        </div>
      </div>
    )
  }

  if (authState === 'loggedOut') return <Welcome onLogin={handleLogin}/>

  if (authState === 'reauth') return (
    <Reconnecting savedUser={savedSessionUser} onLogin={handleLogin} onLogout={handleLogout}/>
  )

  if (!user) return <Welcome onLogin={handleLogin}/>
  if (!onboarded) return <Onboarding user={user} onDone={handleOnboardingDone}/>

  const totalFiles = folders.reduce((s,f)=>s+f.files.length,0)

  return (
    <div style={{ display:'flex', height:'100vh', background:C.bg, fontFamily:"'Sora',system-ui,sans-serif", color:C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input,select,textarea{outline:none;font-family:inherit}
        button{font-family:inherit}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:4px}
      `}</style>

      {/* Sidebar */}
      <div style={{ width:210, flexShrink:0, background:C.white, borderRight:`1px solid ${C.border}`, display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'18px 16px 14px', borderBottom:`1px solid ${C.border}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:9, marginBottom:12 }}>
            <div style={{ width:32, height:32, borderRadius:9, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:17 }}>🦷</div>
            <div><div style={{ fontSize:14, fontWeight:800, color:C.text }}>DentaIQ</div><div style={{ fontSize:10, color:C.sub }}>Gerente financiero</div></div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:7, padding:'7px 9px', background:C.bg, borderRadius:9, border:`1px solid ${C.border}` }}>
            {user.picture?<img src={user.picture} style={{ width:24, height:24, borderRadius:'50%' }}/>:<div style={{ width:24, height:24, borderRadius:'50%', background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:'#fff', fontWeight:700 }}>{user.name[0]}</div>}
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:12, color:C.text, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.name.split(' ')[0]}</div>
              <div style={{ fontSize:10, color:C.sub, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.email}</div>
            </div>
          </div>
        </div>

        <div style={{ flex:1, padding:'10px 8px', display:'flex', flexDirection:'column', gap:3 }}>
          {NAV.map(item => {
            const active = tab===item.id
            return (
              <button key={item.id} onClick={()=>setTab(item.id)} style={{ display:'flex', alignItems:'center', gap:9, padding:'9px 11px', borderRadius:9, background:active?C.tealL:'transparent', border:active?`1px solid ${C.teal}33`:'1px solid transparent', color:active?C.tealD:C.sub, cursor:'pointer', fontSize:13, fontWeight:active?700:400, textAlign:'left' }}>
                <span style={{ fontSize:16 }}>{item.icon}</span>
                {item.label}
                {item.id==='drive'&&totalFiles>0&&<span style={{ marginLeft:'auto', background:C.teal, color:'#fff', borderRadius:20, padding:'1px 6px', fontSize:10, fontWeight:700 }}>{totalFiles}</span>}
                {item.id==='ia'&&<span style={{ marginLeft:'auto', background:C.greenL, color:C.green, borderRadius:20, padding:'1px 6px', fontSize:10, fontWeight:700 }}>ON</span>}
              </button>
            )
          })}
        </div>

        <div style={{ padding:'12px 12px', borderTop:`1px solid ${C.border}` }}>
          <button onClick={handleLogout} style={{ width:'100%', background:'transparent', color:C.sub, border:`1px solid ${C.border}`, borderRadius:8, padding:'7px', fontSize:12, cursor:'pointer' }}>Cerrar sesión</button>
        </div>
      </div>

      {/* Contenido */}
      <div style={{ flex:1, overflowY:'auto' }}>
        {tab==='inicio'&&<Dashboard user={user} txs={txs} folders={folders} aiSummary={aiSummary} loadingAI={loadingAI}/>}
        {tab==='numeros'&&<MisNumeros txs={txs} setTxs={setTxs} user={user} folderIds={folderIds}/>}
        {tab==='ia'&&<Consejero user={user} txs={txs} folders={folders}/>}
        {tab==='buscador'&&<Buscador user={user} folders={folders}/>}
        {tab==='drive'&&<MiDrive user={user} folders={folders} loading={driveLoading} onRefresh={()=>loadDrive(user.token)} onAnalyze={handleAnalyzeFile}/>}
      </div>
    </div>
  )
}
