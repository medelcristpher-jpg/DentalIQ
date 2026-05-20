// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'

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

const SESSION_KEY = 'dentaiq_session_v4'

const C = {
  bg:'#F8F7F4', card:'#FFFFFF', border:'rgba(0,0,0,0.08)',
  teal:'#007A6B', tealL:'#E6F4F2', tealD:'#005549',
  gold:'#D97706', goldL:'#FEF3C7',
  red:'#DC2626', redL:'#FEE2E2',
  blue:'#1D4ED8', blueL:'#DBEAFE',
  text:'#111827', sub:'#6B7280', light:'#9CA3AF',
  green:'#059669', greenL:'#D1FAE5',
  white:'#FFFFFF', shadow:'rgba(0,0,0,0.06)',
  orange:'#EA580C', orangeL:'#FFF7ED',
}

const clp = (n) => {
  if (isNaN(n)||n===null||n===undefined) return '$0'
  const v = Number(n)
  if (Math.abs(v)>=1e6) return `$${(v/1e6).toFixed(1)}M`
  if (Math.abs(v)>=1e3) return `$${Math.round(v/1e3).toLocaleString('es-CL')}K`
  return `$${Math.round(v).toLocaleString('es-CL')}`
}

// ── SESIÓN ────────────────────────────────────────────────────────
function saveSession(u) { try { localStorage.setItem(SESSION_KEY, JSON.stringify({user:u, savedAt:Date.now()})) } catch {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY) } catch {} }
function loadSession() {
  try {
    const d = JSON.parse(localStorage.getItem(SESSION_KEY))
    if (!d) return null
    const age = (Date.now()-d.savedAt)/60000
    return { user:d.user, expired: age >= 50 }
  } catch { return null }
}

// ── GOOGLE AUTH ───────────────────────────────────────────────────
function loadGIS() {
  return new Promise(r => {
    if (window.google?.accounts) { r(); return }
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => r()
    document.head.appendChild(s)
  })
}

async function signIn(emailHint) {
  await loadGIS()
  return new Promise((resolve, reject) => {
    const c = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      hint: emailHint || '',
      callback: async (r) => {
        if (!r.access_token) { reject(new Error('Sin token')); return }
        try {
          const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${r.access_token}` }
          }).then(x => x.json())
          resolve({ email:u.email, name:u.name||u.email, picture:u.picture||'', token:r.access_token })
        } catch(e) { reject(e) }
      },
      error_callback: (e) => reject(new Error(e.type==='popup_closed'?'Cerraste la ventana':'Error de autenticación'))
    })
    c.requestAccessToken()
  })
}

// ── DRIVE API ─────────────────────────────────────────────────────
async function driveFind(t, q) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=10`, { headers:{Authorization:`Bearer ${t}`} })
  return (await r.json()).files || []
}

async function driveCreate(t, body) {
  return fetch('https://www.googleapis.com/drive/v3/files', { method:'POST', headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r=>r.json())
}

async function driveListFiles(t, parentId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`, { headers:{Authorization:`Bearer ${t}`} })
  return (await r.json()).files || []
}

async function driveListFolders(t, parentId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name,mimeType)&pageSize=20`, { headers:{Authorization:`Bearer ${t}`} })
  return (await r.json()).files || []
}

async function driveReadContent(t, file) {
  let url
  if (file.mimeType==='application/vnd.google-apps.spreadsheet')
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`
  else if (file.mimeType==='application/vnd.google-apps.document')
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`
  else
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
  const r = await fetch(url, { headers:{Authorization:`Bearer ${t}`} })
  return (await r.text()).slice(0, 10000)
}

async function getOrCreate(t, name, parentId) {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`
  const ex = await driveFind(t, q)
  if (ex.length) return ex[0].id
  const body = { name, mimeType:'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]
  return (await driveCreate(t, body)).id
}

async function createSheetIfNotExists(t, name, parentId, rows) {
  const ex = await driveFind(t, `name='${name}' and '${parentId}' in parents and trashed=false`)
  if (ex.length) return ex[0].id
  const file = await driveCreate(t, { name, mimeType:'application/vnd.google-apps.spreadsheet', parents:[parentId] })
  if (!file.id) return null
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/A1?valueInputOption=USER_ENTERED`, {
      method:'PUT', headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'},
      body:JSON.stringify({ values:rows, majorDimension:'ROWS' })
    })
  } catch {}
  return file.id
}

async function appendRowToSheet(token, fileId, values) {
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({ values:[values], majorDimension:'ROWS' })
    })
    return true
  } catch { return false }
}

async function findOrCreateMonthSheet(token, folderId, tipo) {
  const now = new Date()
  const mes = now.toLocaleDateString('es-CL', {month:'long'})
  const año = now.getFullYear()
  const name = `${tipo} ${mes} ${año}`
  const ex = await driveFind(token, `name='${name}' and '${folderId}' in parents and trashed=false`)
  if (ex.length) return ex[0].id
  const headers = tipo==='Ingresos'
    ? ['Fecha','Nombre Paciente','Servicio Realizado','Monto (CLP)','Método de Pago','Notas']
    : ['Fecha','Descripción del Gasto','Categoría','Monto (CLP)','Proveedor / Empresa','Notas']
  return await createSheetIfNotExists(token, name, folderId, [headers])
}

// ── EMOJI POR NOMBRE DE CARPETA ────────────────────────────────────
function folderEmoji(name) {
  const n = name.toLowerCase()
  if (n.includes('ingreso')) return '💰'
  if (n.includes('gasto')) return '💳'
  if (n.includes('factura')) return '🧾'
  if (n.includes('proveedor')||n.includes('inventario')) return '📦'
  if (n.includes('reporte')) return '📊'
  return '📁'
}

// ── SETUP DRIVE — DESCUBRE TODAS LAS CARPETAS ──────────────────────
async function setupDrive(t) {
  const rootId = await getOrCreate(t, 'DentaIQ')
  const now = new Date()
  const año = now.getFullYear()
  const mes = now.toLocaleDateString('es-CL', {month:'long'})
  const hoy = now.toLocaleDateString('es-CL')

  // Crear carpetas base si no existen
  const ingId = await getOrCreate(t, 'Ingresos', rootId)
  const gasId = await getOrCreate(t, 'Gastos', rootId)

  // Plantillas solo si carpeta vacía
  const ingFiles = await driveListFiles(t, ingId)
  if (ingFiles.length===0) {
    await createSheetIfNotExists(t, `Ingresos ${mes} ${año}`, ingId, [
      ['Fecha','Nombre Paciente','Servicio Realizado','Monto (CLP)','Método de Pago','Notas'],
      [hoy,'María González','Ortodoncia cuota','120000','Transferencia','Ejemplo'],
      [hoy,'Carlos Pérez','Implante dental','850000','Tarjeta','Ejemplo'],
    ])
  }
  const gasFiles = await driveListFiles(t, gasId)
  if (gasFiles.length===0) {
    await createSheetIfNotExists(t, `Gastos ${mes} ${año}`, gasId, [
      ['Fecha','Descripción del Gasto','Categoría','Monto (CLP)','Proveedor / Empresa','Notas'],
      [hoy,'Insumos dentales','Insumos','245000','3M Chile','Ejemplo'],
    ])
  }

  // ── Descubrir TODAS las carpetas en DentaIQ ──
  const allFolderMetas = await driveListFolders(t, rootId)
  const allFolders = []
  for (const fm of allFolderMetas) {
    const files = await driveListFiles(t, fm.id)
    allFolders.push({ id:fm.id, name:fm.name, emoji:folderEmoji(fm.name), files })
  }

  // FolderIds para sync
  const folderIds = { ingresos:ingId, gastos:gasId }
  const facturasFolder = allFolders.find(f=>f.name.toLowerCase().includes('factura'))
  if (facturasFolder) folderIds.facturas = facturasFolder.id

  return { allFolders, folderIds, rootId }
}

// ── PARSEAR CSV DE PROVEEDORES ─────────────────────────────────────
// Estructura real: 0=código, 1=empresa, 2=dirección, 3=país, 4=RUT,
// 5=contacto, 6=descripción, 7=frecuencia, 8=términos, 9=email,
// 10=teléfono, 11=factura, 12=fecha, 13..N-5=artículo, N-4=precio,
// N-3=IVA, N-2=estado, N-1=total
function parseProveedorRow(line) {
  const cols = line.split(',').map(c=>c.trim())
  if (cols.length < 14) return null
  const total = cols[cols.length-1]
  const estado = cols[cols.length-2]
  const iva = cols[cols.length-3]
  const precio = cols[cols.length-4]
  const cantidad = cols[cols.length-5]
  const articulo = cols.slice(13, cols.length-5).join(' ').trim()
  return {
    empresa:cols[1]||'', direccion:cols[2]||'', rut:cols[4]||'',
    contacto:cols[5]||'', telefono:cols[10]||'', factura:cols[11]||'',
    fecha:cols[12]||'', articulo, cantidad, precio, iva, estado, total
  }
}

function parseProveedoresCSV(csv) {
  const lines = csv.split('\n').map(l=>l.trim()).filter(l=>l)
  const rows = []
  let start = 0
  for (let i=0; i<Math.min(5,lines.length); i++) {
    const n = lines[i].toLowerCase()
    if (n.includes('empresa')||n.includes('factura')||n.includes('articulo')||n.startsWith('código')) { start=i+1; break }
    if (lines[i].startsWith('📌')) start=i+1
  }
  for (let i=start; i<lines.length; i++) {
    const row = parseProveedorRow(lines[i])
    if (row?.articulo||row?.empresa) rows.push(row)
  }
  return rows
}

// Parsear facturas por pagar
function parseFacturasCSV(csv) {
  const lines = csv.split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('📌'))
  if (lines.length < 2) return []
  const headerLine = lines[0]
  const headers = headerLine.split(',').map(h=>h.toLowerCase().trim())
  const iEst = headers.findIndex(h=>h.includes('estado'))
  const iProv = headers.findIndex(h=>h.includes('proveedor'))
  const iMonto = headers.findIndex(h=>h.includes('monto')||h.includes('total'))
  const iDesc = headers.findIndex(h=>h.includes('descripción')||h.includes('descripcion'))
  const iFecha = headers.findIndex(h=>h.includes('vencimiento')||h.includes('fecha'))
  const rows = []
  for (let i=1; i<lines.length; i++) {
    const cols = lines[i].split(',').map(c=>c.trim())
    const estado = iEst>=0?cols[iEst]||'':''
    const proveedor = iProv>=0?cols[iProv]||'':cols[0]||''
    const monto = iMonto>=0?cols[iMonto]||'':''
    const desc = iDesc>=0?cols[iDesc]||'':''
    const fecha = iFecha>=0?cols[iFecha]||'':''
    rows.push({ estado, proveedor, monto, desc, fecha })
  }
  return rows
}

// ── IA ────────────────────────────────────────────────────────────
async function askAI(msgs, system) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json', Authorization:`Bearer ${AI_API_KEY}`},
    body:JSON.stringify({ model:AI_MODEL, messages:[{role:'system',content:system},...msgs] })
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error.message)
  return d.choices?.[0]?.message?.content || ''
}

// ── WELCOME ───────────────────────────────────────────────────────
function Welcome({ onLogin }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const login = async () => { setLoading(true); setError(''); try { const u=await signIn(); onLogin(u,true) } catch(e){setError(e.message)} setLoading(false) }
  const demo = () => onLogin({email:'demo@dentaiq.cl',name:'Dr. Demo',picture:'',token:'demo'}, false)
  return (
    <div style={{minHeight:'100vh',background:C.bg,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24,fontFamily:'inherit'}}>
      <div style={{marginBottom:36,textAlign:'center'}}>
        <div style={{width:60,height:60,borderRadius:18,background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',fontSize:30,margin:'0 auto 14px',boxShadow:'0 4px 20px rgba(0,122,107,0.3)'}}>🦷</div>
        <h1 style={{margin:'0 0 6px',fontSize:30,fontWeight:800,color:C.text}}>DentaIQ</h1>
        <p style={{margin:0,fontSize:15,color:C.sub}}>Tu gerente financiero inteligente</p>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:36,maxWidth:660,width:'100%'}}>
        {[['📊','Análisis automático','La IA lee tus planillas de Drive y te dice cómo va tu clínica.'],['🔍','Busca proveedores','Encuentra insumos, precios y compara proveedores al instante.'],['🔄','Sync Drive','Agrega datos en DentaIQ y se guardan en Drive automáticamente.']].map(([ico,t,d])=>(
          <div key={t} style={{background:C.white,borderRadius:14,padding:18,border:`1px solid ${C.border}`}}>
            <div style={{fontSize:26,marginBottom:8}}>{ico}</div>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:5}}>{t}</div>
            <div style={{fontSize:12,color:C.sub,lineHeight:1.5}}>{d}</div>
          </div>
        ))}
      </div>
      <div style={{background:C.white,borderRadius:18,padding:'28px 32px',border:`1px solid ${C.border}`,boxShadow:`0 2px 12px ${C.shadow}`,width:'100%',maxWidth:360,textAlign:'center'}}>
        <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:4}}>Empieza gratis</div>
        <div style={{fontSize:12,color:C.sub,marginBottom:18}}>Tu sesión se recordará por 50 minutos</div>
        <button onClick={login} disabled={loading} style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:10,background:C.white,color:'#3c4043',border:'1.5px solid #dadce0',borderRadius:11,padding:'12px',fontSize:14,fontWeight:500,cursor:'pointer',marginBottom:9,opacity:loading?0.7:1}}>
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          {loading?'Conectando...':'Continuar con Google'}
        </button>
        <button onClick={demo} style={{width:'100%',background:C.teal,color:'#fff',border:'none',borderRadius:11,padding:'12px',fontSize:14,fontWeight:700,cursor:'pointer',marginBottom:12}}>🚀 Ver demo</button>
        {error&&<div style={{padding:'8px 12px',background:C.redL,borderRadius:8,fontSize:12,color:C.red,marginBottom:10}}>{error}</div>}
        <p style={{margin:0,fontSize:10,color:C.light}}>Sesión recordada automáticamente · Sin contraseña adicional</p>
      </div>
    </div>
  )
}

// ── RECONNECT ─────────────────────────────────────────────────────
function Reconnecting({ savedUser, onLogin, onLogout }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const reconnect = async () => { setLoading(true); setError(''); try { const u=await signIn(savedUser.email); onLogin(u,true) } catch(e){setError(e.message);setLoading(false)} }
  return (
    <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'inherit'}}>
      <div style={{background:C.white,borderRadius:18,padding:'36px',maxWidth:360,width:'100%',textAlign:'center',border:`1px solid ${C.border}`,boxShadow:`0 4px 20px ${C.shadow}`}}>
        <div style={{fontSize:44,marginBottom:14}}>🦷</div>
        <h2 style={{margin:'0 0 6px',fontSize:19,fontWeight:800,color:C.text}}>Bienvenido de vuelta</h2>
        <p style={{fontSize:13,color:C.sub,marginBottom:20}}>Tu sesión expiró. Un clic para reconectar.</p>
        <div style={{display:'flex',alignItems:'center',gap:9,padding:'9px 12px',background:C.bg,borderRadius:9,marginBottom:18,border:`1px solid ${C.border}`}}>
          {savedUser.picture?<img src={savedUser.picture} style={{width:30,height:30,borderRadius:'50%'}}/>:<div style={{width:30,height:30,borderRadius:'50%',background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700}}>{savedUser.name[0]}</div>}
          <div style={{textAlign:'left'}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text}}>{savedUser.name}</div>
            <div style={{fontSize:11,color:C.sub}}>{savedUser.email}</div>
          </div>
        </div>
        <button onClick={reconnect} disabled={loading} style={{width:'100%',background:C.teal,color:'#fff',border:'none',borderRadius:11,padding:'13px',fontSize:14,fontWeight:700,cursor:'pointer',marginBottom:10,opacity:loading?0.7:1}}>
          {loading?'⏳ Reconectando...':'🔄 Reconectar con Google'}
        </button>
        {error&&<div style={{padding:'8px',background:C.redL,borderRadius:8,fontSize:12,color:C.red,marginBottom:10}}>{error}</div>}
        <button onClick={onLogout} style={{background:'none',border:'none',color:C.sub,fontSize:12,cursor:'pointer'}}>Usar otra cuenta</button>
      </div>
    </div>
  )
}

// ── ONBOARDING ────────────────────────────────────────────────────
function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0)
  const steps = [
    {icon:'👋',title:`Hola ${user.name.split(' ')[0]}`,desc:'DentaIQ encontró o creó tus carpetas en Drive. Tu sesión se recordará automáticamente.'},
    {icon:'🔄',title:'Sync automático',desc:'Agrega datos en "Mis Números" y se guardan en tu planilla de Drive. También puedes editar la planilla directamente.'},
    {icon:'🔍',title:'Buscador de proveedores',desc:'Busca cualquier insumo en todos tus archivos de Drive. Ve precios, compara proveedores y detecta alzas de precio.'},
    {icon:'🤖',title:'IA con datos reales',desc:'El Consejero IA lee TODAS tus planillas automáticamente y responde con tus números reales.'},
  ]
  const s = steps[step]
  return (
    <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{background:C.white,borderRadius:22,padding:'44px 36px',maxWidth:460,width:'100%',textAlign:'center',border:`1px solid ${C.border}`,boxShadow:`0 4px 24px ${C.shadow}`}}>
        <div style={{fontSize:52,marginBottom:18}}>{s.icon}</div>
        <h2 style={{margin:'0 0 10px',fontSize:22,fontWeight:800,color:C.text}}>{s.title}</h2>
        <p style={{margin:'0 0 28px',fontSize:14,color:C.sub,lineHeight:1.7}}>{s.desc}</p>
        <div style={{display:'flex',justifyContent:'center',gap:7,marginBottom:24}}>
          {steps.map((_,i)=><div key={i} style={{width:i===step?22:7,height:7,borderRadius:4,background:i===step?C.teal:C.border,transition:'all 0.2s'}}/>)}
        </div>
        <button onClick={()=>step<steps.length-1?setStep(s=>s+1):onDone()} style={{width:'100%',background:C.teal,color:'#fff',border:'none',borderRadius:11,padding:'13px',fontSize:14,fontWeight:700,cursor:'pointer'}}>
          {step<steps.length-1?'Siguiente →':'¡Empezar!'}
        </button>
        {step>0&&<button onClick={()=>setStep(s=>s-1)} style={{marginTop:9,background:'none',border:'none',color:C.sub,fontSize:12,cursor:'pointer'}}>← Volver</button>}
      </div>
    </div>
  )
}

// ── DASHBOARD ─────────────────────────────────────────────────────
function Dashboard({ user, txs, allFolders, aiSummary, loadingAI }) {
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const margen = ing-gas
  const pct = ing>0?(margen/ing)*100:0
  const [facturas, setFacturas] = useState([])

  useEffect(() => {
    if (user.token==='demo') return
    const facturasFolder = allFolders.find(f=>f.name.toLowerCase().includes('factura'))
    if (!facturasFolder||!facturasFolder.files.length) return
    const load = async () => {
      try {
        const csv = await driveReadContent(user.token, facturasFolder.files[0])
        const rows = parseFacturasCSV(csv)
        setFacturas(rows.filter(r=>r.estado?.toLowerCase().includes('pendiente')||r.estado?.includes('⏳')))
      } catch {}
    }
    load()
  }, [allFolders])

  const totalFacturas = facturas.reduce((s,f)=>{
    const n = parseFloat(f.monto?.replace(/[$,.]/g,'')||'0')
    return s+(isNaN(n)?0:n)
  },0)

  return (
    <div style={{padding:'28px 32px',maxWidth:960}}>
      <div style={{marginBottom:20}}>
        <h1 style={{margin:0,fontSize:24,fontWeight:800,color:C.text}}>Hola, {user.name.split(' ')[0]} 👋</h1>
        <p style={{margin:'3px 0 0',fontSize:13,color:C.sub}}>{new Date().toLocaleDateString('es-CL',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
      </div>

      {/* Estado del negocio */}
      <div style={{background:margen>=0?C.tealL:C.redL,borderRadius:18,padding:'18px 22px',marginBottom:18,border:`1px solid ${margen>=0?C.teal+'33':C.red+'33'}`}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <span style={{fontSize:28}}>{margen>=0?'✅':'⚠️'}</span>
          <div>
            <div style={{fontSize:16,fontWeight:800,color:margen>=0?C.tealD:C.red}}>
              {txs.length===0?'Conecta Drive para ver tu situación financiera':'Tu clínica está '+(margen>=0?'ganando dinero':'en pérdida este mes')}
            </div>
            {txs.length>0&&<div style={{fontSize:13,color:margen>=0?C.teal:C.red}}>Margen: {pct.toFixed(1)}% — {pct>40?'excelente 🌟':pct>25?'bien, puede mejorar':'necesita atención'}</div>}
          </div>
        </div>
      </div>

      {/* KPIs */}
      {txs.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginBottom:18}}>
          {[{label:'Lo que entró',value:clp(ing),icon:'📈',color:C.green,bg:C.greenL},{label:'Lo que salió',value:clp(gas),icon:'📉',color:C.red,bg:C.redL},{label:'Lo que queda',value:clp(margen),icon:margen>=0?'💰':'🚨',color:margen>=0?C.teal:C.red,bg:margen>=0?C.tealL:C.redL}].map(k=>(
            <div key={k.label} style={{background:k.bg,borderRadius:13,padding:'16px 18px',border:`1px solid ${k.color}33`}}>
              <div style={{fontSize:24,marginBottom:6}}>{k.icon}</div>
              <div style={{fontSize:11,color:C.sub,marginBottom:3}}>{k.label}</div>
              <div style={{fontSize:24,fontWeight:800,color:k.color}}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:14,marginBottom:18}}>
        {/* Resumen IA */}
        <div style={{background:C.white,borderRadius:16,padding:'18px 22px',border:`1px solid ${C.border}`,boxShadow:`0 1px 6px ${C.shadow}`}}>
          <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:12}}>
            <div style={{width:32,height:32,borderRadius:9,background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',fontSize:15}}>🤖</div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:C.text}}>Consejero IA</div>
              <div style={{fontSize:11,color:C.sub}}>Análisis de tus planillas Drive</div>
            </div>
            {loadingAI&&<div style={{marginLeft:'auto',fontSize:11,color:C.sub}}>Analizando...</div>}
          </div>
          {aiSummary
            ?<p style={{margin:0,fontSize:13,color:C.text,lineHeight:1.7,whiteSpace:'pre-wrap'}}>{aiSummary}</p>
            :<p style={{margin:0,fontSize:13,color:C.sub,fontStyle:'italic'}}>Abre el Consejero IA y pregúntale sobre tu negocio.</p>
          }
        </div>

        {/* Facturas por Pagar */}
        <div style={{background:facturas.length>0?C.orangeL:C.white,borderRadius:16,padding:'18px 20px',border:`1px solid ${facturas.length>0?C.orange+'44':C.border}`,boxShadow:`0 1px 6px ${C.shadow}`}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <div style={{width:32,height:32,borderRadius:9,background:facturas.length>0?C.orange:C.sub,display:'flex',alignItems:'center',justifyContent:'center',fontSize:15}}>🧾</div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:C.text}}>Facturas por Pagar</div>
              <div style={{fontSize:11,color:C.sub}}>{facturas.length>0?`${facturas.length} pendiente${facturas.length>1?'s':''}`:user.token==='demo'?'Demo':'Sin datos'}</div>
            </div>
          </div>
          {facturas.length>0?(
            <>
              <div style={{fontSize:22,fontWeight:800,color:C.orange,marginBottom:8}}>{clp(totalFacturas)}</div>
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {facturas.slice(0,3).map((f,i)=>(
                  <div key={i} style={{fontSize:11,color:C.text,display:'flex',justifyContent:'space-between'}}>
                    <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'60%'}}>{f.proveedor||f.desc||'—'}</span>
                    <span style={{fontWeight:700,color:C.orange,flexShrink:0}}>{f.monto||'—'}</span>
                  </div>
                ))}
                {facturas.length>3&&<div style={{fontSize:11,color:C.sub}}>+{facturas.length-3} más...</div>}
              </div>
            </>
          ):(
            <div style={{fontSize:12,color:C.sub}}>
              {user.token==='demo'?'Conecta Google para ver tus facturas pendientes':'Agrega facturas en la carpeta "Facturas por Pagar" de Drive'}
            </div>
          )}
        </div>
      </div>

      {/* Carpetas Drive */}
      <div style={{background:C.white,borderRadius:16,padding:'16px 20px',border:`1px solid ${C.border}`,boxShadow:`0 1px 6px ${C.shadow}`}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>☁️ Tus carpetas en Drive</div>
        <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(allFolders.length,5)},1fr)`,gap:9}}>
          {allFolders.map(f=>(
            <div key={f.id} style={{textAlign:'center',padding:'11px 8px',background:C.bg,borderRadius:11,border:`1px solid ${C.border}`}}>
              <div style={{fontSize:22,marginBottom:3}}>{f.emoji}</div>
              <div style={{fontSize:11,color:C.text,fontWeight:500,marginBottom:2}}>{f.name}</div>
              <div style={{fontSize:10,color:f.files.length>0?C.teal:C.light}}>{f.files.length>0?`${f.files.length} archivos`:'Vacía'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── MIS NÚMEROS ───────────────────────────────────────────────────
function MisNumeros({ txs, setTxs, user, folderIds }) {
  const [form, setForm] = useState({tipo:'I',desc:'',cat:'Servicios dentales',monto:'',metodo:'Transferencia'})
  const [open, setOpen] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const CATS_I = ['Servicios dentales','Ortodoncia','Implantes','Blanqueamiento','Convenios','Otros ingresos']
  const CATS_G = ['Insumos y materiales','Personal','Arriendo','Equipos','Servicios básicos','Publicidad','Contabilidad','Otros gastos']
  const METODOS = ['Transferencia','Efectivo','Tarjeta débito','Tarjeta crédito','Cheque']
  const inp = {width:'100%',background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:'9px 12px',fontSize:13,fontFamily:'inherit',outline:'none'}
  const catG = CATS_G.map(cat=>({cat,total:txs.filter(t=>t.tipo==='G'&&t.cat===cat).reduce((s,t)=>s+t.monto,0)})).filter(c=>c.total>0).sort((a,b)=>b.total-a.total)
  const catI = CATS_I.map(cat=>({cat,total:txs.filter(t=>t.tipo==='I'&&t.cat===cat).reduce((s,t)=>s+t.monto,0)})).filter(c=>c.total>0).sort((a,b)=>b.total-a.total)
  const maxG = catG[0]?.total||1, maxI = catI[0]?.total||1

  const guardar = async () => {
    if (!form.desc.trim()||!form.monto) return
    const fecha = new Date().toLocaleDateString('es-CL')
    const tx = {id:Date.now(),tipo:form.tipo,desc:form.desc,cat:form.cat,monto:parseInt(form.monto),fecha,fuente:'manual',metodo:form.metodo}
    setTxs(p=>[tx,...p])
    setForm({tipo:'I',desc:'',cat:'Servicios dentales',monto:'',metodo:'Transferencia'})
    setOpen(false)
    if (user.token!=='demo'&&folderIds) {
      try {
        const fId = form.tipo==='I'?folderIds.ingresos:folderIds.gastos
        if (fId) {
          const sheetId = await findOrCreateMonthSheet(user.token, fId, form.tipo==='I'?'Ingresos':'Gastos')
          if (sheetId) {
            const vals = form.tipo==='I'
              ?[fecha,form.desc,form.cat,parseInt(form.monto),form.metodo,'Desde DentaIQ']
              :[fecha,form.desc,form.cat,parseInt(form.monto),'','Desde DentaIQ']
            await appendRowToSheet(user.token, sheetId, vals)
            setSyncMsg('✅ Guardado en Drive')
          }
        }
      } catch { setSyncMsg('⚠️ Solo guardado localmente') }
      setTimeout(()=>setSyncMsg(''),3000)
    }
  }

  return (
    <div style={{padding:'28px 32px',maxWidth:880}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18}}>
        <div>
          <h1 style={{margin:0,fontSize:22,fontWeight:800,color:C.text}}>Mis Números</h1>
          <p style={{margin:'3px 0 0',fontSize:12,color:C.sub}}>Se sincroniza automáticamente con Google Drive</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {syncMsg&&<span style={{fontSize:12,color:syncMsg.includes('✅')?C.green:C.gold,fontWeight:600}}>{syncMsg}</span>}
          <button onClick={()=>setOpen(!open)} style={{background:C.teal,color:'#fff',border:'none',borderRadius:9,padding:'9px 16px',fontSize:13,fontWeight:700,cursor:'pointer'}}>+ Agregar</button>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:11,marginBottom:18}}>
        {[['Lo que entró',ing,C.green,C.greenL,'📈'],['Lo que salió',gas,C.red,C.redL,'📉'],['Balance',ing-gas,ing-gas>=0?C.teal:C.red,ing-gas>=0?C.tealL:C.redL,ing-gas>=0?'✅':'⚠️']].map(([l,v,c,bg,ico])=>(
          <div key={l} style={{background:bg,borderRadius:13,padding:'14px 16px',border:`1px solid ${c}33`}}>
            <div style={{fontSize:18,marginBottom:5}}>{ico}</div>
            <div style={{fontSize:11,color:C.sub,marginBottom:2}}>{l}</div>
            <div style={{fontSize:20,fontWeight:800,color:c}}>{clp(v)}</div>
          </div>
        ))}
      </div>

      {txs.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:18}}>
          {[['📉 Gastos por categoría',catG,C.red,maxG],['📈 Ingresos por categoría',catI,C.green,maxI]].map(([title,data,color,maxVal])=>(
            <div key={title} style={{background:C.white,borderRadius:13,padding:'16px',border:`1px solid ${C.border}`}}>
              <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:11}}>{title}</div>
              {data.length===0?<div style={{fontSize:12,color:C.sub}}>Sin datos</div>:data.map(({cat,total})=>(
                <div key={cat} style={{marginBottom:7}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                    <span style={{fontSize:11,color:C.text}}>{cat}</span>
                    <span style={{fontSize:11,fontWeight:700,color:color}}>{clp(total)}</span>
                  </div>
                  <div style={{height:4,background:C.bg,borderRadius:3}}>
                    <div style={{height:'100%',width:`${(total/maxVal)*100}%`,background:color,borderRadius:3}}/>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {open&&(
        <div style={{background:C.white,borderRadius:14,padding:20,marginBottom:12,border:`1px solid ${C.border}`,boxShadow:`0 2px 8px ${C.shadow}`}}>
          <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:12}}>¿Qué quieres registrar?</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
            <div>
              <label style={{fontSize:10,color:C.sub,display:'block',marginBottom:4,fontWeight:600}}>TIPO</label>
              <div style={{display:'flex',gap:5}}>
                {[['I','💰 Entró'],['G','💳 Salió']].map(([v,l])=>(
                  <button key={v} onClick={()=>setForm({...form,tipo:v,cat:v==='I'?CATS_I[0]:CATS_G[0]})} style={{flex:1,padding:'7px 4px',borderRadius:7,border:`2px solid ${form.tipo===v?C.teal:C.border}`,background:form.tipo===v?C.tealL:'transparent',color:form.tipo===v?C.tealD:C.sub,fontSize:11,fontWeight:form.tipo===v?700:400,cursor:'pointer'}}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={{fontSize:10,color:C.sub,display:'block',marginBottom:4,fontWeight:600}}>CATEGORÍA</label>
              <select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})} style={inp}>{(form.tipo==='I'?CATS_I:CATS_G).map(o=><option key={o}>{o}</option>)}</select>
            </div>
            {form.tipo==='I'&&<div>
              <label style={{fontSize:10,color:C.sub,display:'block',marginBottom:4,fontWeight:600}}>MÉTODO</label>
              <select value={form.metodo} onChange={e=>setForm({...form,metodo:e.target.value})} style={inp}>{METODOS.map(o=><option key={o}>{o}</option>)}</select>
            </div>}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'2fr 1fr auto',gap:10,alignItems:'flex-end'}}>
            <div>
              <label style={{fontSize:10,color:C.sub,display:'block',marginBottom:4,fontWeight:600}}>DESCRIPCIÓN</label>
              <input value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder={form.tipo==='I'?'Ej: Ortodoncia Ana García':'Ej: Insumos Septodont'} style={inp}/>
            </div>
            <div>
              <label style={{fontSize:10,color:C.sub,display:'block',marginBottom:4,fontWeight:600}}>MONTO (CLP)</label>
              <input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="150000" style={inp}/>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button onClick={guardar} style={{background:C.teal,color:'#fff',border:'none',borderRadius:8,padding:'9px 16px',fontSize:13,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>💾 Guardar</button>
              <button onClick={()=>setOpen(false)} style={{background:C.bg,color:C.sub,border:`1px solid ${C.border}`,borderRadius:8,padding:'9px 12px',fontSize:13,cursor:'pointer'}}>✕</button>
            </div>
          </div>
          {user.token!=='demo'&&<p style={{margin:'8px 0 0',fontSize:10,color:C.sub}}>💡 Se sincronizará automáticamente con tu planilla de Drive</p>}
        </div>
      )}

      {txs.length===0
        ?<div style={{background:C.white,borderRadius:13,padding:'32px',textAlign:'center',border:`2px dashed ${C.border}`}}>
          <div style={{fontSize:34,marginBottom:10}}>📋</div>
          <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:5}}>Nada registrado aún</div>
          <div style={{fontSize:12,color:C.sub}}>Agrega un ingreso o gasto — se sincronizará con Drive automáticamente</div>
        </div>
        :<div style={{background:C.white,borderRadius:13,border:`1px solid ${C.border}`,overflow:'hidden',boxShadow:`0 1px 6px ${C.shadow}`}}>
          <div style={{padding:'10px 16px',borderBottom:`1px solid ${C.border}`,fontSize:12,fontWeight:700,color:C.text}}>Últimas transacciones</div>
          {txs.slice(0,20).map((tx,i)=>(
            <div key={tx.id} style={{display:'flex',alignItems:'center',gap:11,padding:'11px 16px',borderBottom:i<Math.min(txs.length,20)-1?`1px solid ${C.border}`:'none'}}>
              <div style={{width:36,height:36,borderRadius:9,background:tx.tipo==='I'?C.greenL:C.redL,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>{tx.tipo==='I'?'📈':'📉'}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,color:C.text,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{tx.desc}</div>
                <div style={{fontSize:11,color:C.sub,marginTop:1}}>{tx.cat} · {tx.fecha}</div>
              </div>
              <div style={{fontSize:14,fontWeight:800,color:tx.tipo==='I'?C.green:C.red,flexShrink:0}}>{tx.tipo==='I'?'+':'−'}{clp(tx.monto)}</div>
            </div>
          ))}
        </div>
      }
    </div>
  )
}

// ── CONSEJERO IA — lee TODAS las carpetas ─────────────────────────
function Consejero({ user, txs, allFolders }) {
  const CHAT_KEY = `dentaiq_chat_${user.email}`
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const [driveCtx, setDriveCtx] = useState('')
  const [driveStatus, setDriveStatus] = useState('idle') // idle|loading|ready|empty
  const [msgs, setMsgs] = useState(()=>{ try{const s=localStorage.getItem(CHAT_KEY);return s?JSON.parse(s):[{role:'assistant',content:`Hola ${user.name.split(' ')[0]} 👋 Cargando tus datos de Drive...`}]}catch{return [{role:'assistant',content:`Hola 👋 ¿En qué te ayudo?`}]} })
  const [inp, setInp] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef(null)

  useEffect(()=>{ try{localStorage.setItem(CHAT_KEY,JSON.stringify(msgs.slice(-40)))}catch{} },[msgs])
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}) },[msgs])

  // Cargar datos de TODAS las carpetas cuando allFolders tenga archivos
  useEffect(()=>{
    if (user.token==='demo'||driveStatus!=='idle') return
    const hasFiles = allFolders.some(f=>f.files.length>0)
    if (!hasFiles) return
    const load = async () => {
      setDriveStatus('loading')
      let ctx = ''
      for (const folder of allFolders) {
        // Leer hasta 2 archivos por carpeta
        for (const file of folder.files.slice(0,2)) {
          if (file.mimeType?.includes('spreadsheet')||file.mimeType?.includes('document')) {
            try {
              const content = await driveReadContent(user.token, file)
              if (content.trim().length > 50) {
                ctx += `\n\n=== ${folder.name}: ${file.name} ===\n${content.slice(0,2500)}`
              }
            } catch {}
          }
        }
      }
      setDriveCtx(ctx)
      setDriveStatus(ctx?'ready':'empty')
      setMsgs(prev=>{
        const last = prev[prev.length-1]
        if (last?.role==='assistant'&&(last.content.includes('Cargando')||last.content.includes('leyendo'))) {
          const msg = ctx
            ?`Hola ${user.name.split(' ')[0]} 👋 Leí ${allFolders.filter(f=>f.files.length>0).length} carpetas de Drive con tus datos reales. ¿Qué quieres saber? 📊`
            :`Hola ${user.name.split(' ')[0]} 👋 No encontré planillas con datos en Drive aún. Cuando subas archivos, podré analizarlos automáticamente.`
          return [...prev.slice(0,-1),{role:'assistant',content:msg}]
        }
        return prev
      })
    }
    load()
  },[allFolders, driveStatus])

  const system = `Eres consejero financiero de ${user.name}, clínica dental en Chile. Lenguaje simple, como amigo experto.
DATOS APP: Ingresos ${clp(ing)}, Gastos ${clp(gas)}, Balance ${clp(ing-gas)}.
${driveCtx?`DATOS REALES DE DRIVE:\n${driveCtx}`:'Sin datos en Drive todavía.'}
Usa los datos de Drive cuando estén disponibles. Emojis, máx 250 palabras, español chileno. Consejo concreto siempre.`

  const SUGS = ['¿Estoy ganando suficiente?','¿En qué me gasto más?','Analiza mis planillas de Drive','¿Cuál es mi margen real?','¿Qué puedo mejorar?']

  const send = async (texto) => {
    const t=(texto||inp).trim(); if(!t||loading) return
    setInp('')
    const hist=[...msgs,{role:'user',content:t}]
    setMsgs([...hist,{role:'assistant',content:'',loading:true}]); setLoading(true)
    try { const reply=await askAI(hist.filter(m=>!m.loading).map(m=>({role:m.role,content:m.content})),system); setMsgs([...hist,{role:'assistant',content:reply}]) }
    catch(e) { setMsgs([...hist,{role:'assistant',content:`❌ ${e.message}`}]) }
    setLoading(false)
  }

  const statusText = driveStatus==='loading'?'⏳ Leyendo Drive...':driveStatus==='ready'?`✅ ${allFolders.filter(f=>f.files.length>0).length} carpetas cargadas`:driveStatus==='empty'?'📋 Sin datos en Drive':'⏳ Esperando datos...'

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh',maxWidth:800,padding:'0 28px'}}>
      <div style={{padding:'22px 0 12px',display:'flex',justifyContent:'space-between',alignItems:'flex-end'}}>
        <div>
          <h1 style={{margin:0,fontSize:21,fontWeight:800,color:C.text}}>Consejero IA 🤖</h1>
          <p style={{margin:'3px 0 0',fontSize:11,color:C.sub}}>{statusText}</p>
        </div>
        <div style={{display:'flex',gap:6}}>
          {driveStatus!=='idle'&&driveStatus!=='loading'&&<button onClick={()=>setDriveStatus('idle')} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.sub,borderRadius:7,padding:'4px 9px',fontSize:11,cursor:'pointer'}}>↻ Recargar Drive</button>}
          <button onClick={()=>{const i=[{role:'assistant',content:`Hola ${user.name.split(' ')[0]} 👋 ¿En qué te ayudo?`}];setMsgs(i);try{localStorage.setItem(CHAT_KEY,JSON.stringify(i))}catch{}}} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.sub,borderRadius:7,padding:'4px 9px',fontSize:11,cursor:'pointer'}}>🗑 Limpiar</button>
        </div>
      </div>
      <div style={{flex:1,overflowY:'auto',display:'flex',flexDirection:'column',gap:12,paddingBottom:12}}>
        {msgs.map((m,i)=>(
          <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start',gap:9,alignItems:'flex-start'}}>
            {m.role==='assistant'&&<div style={{width:32,height:32,borderRadius:9,background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',fontSize:15,flexShrink:0}}>🤖</div>}
            <div style={{maxWidth:'78%',padding:'11px 13px',fontSize:13,lineHeight:1.7,whiteSpace:'pre-wrap',borderRadius:m.role==='user'?'13px 13px 4px 13px':'4px 13px 13px 13px',background:m.role==='user'?C.teal:C.white,color:m.role==='user'?'#fff':C.text,boxShadow:m.role==='assistant'?`0 1px 4px ${C.shadow}`:'none',border:m.role==='assistant'?`1px solid ${C.border}`:'none'}}>
              {m.loading?<div style={{display:'flex',gap:4}}>{[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:'50%',background:C.sub,animation:`dots 1.2s ${i*0.2}s infinite`}}/>)}</div>:m.content}
            </div>
            {m.role==='user'&&<div style={{width:32,height:32,borderRadius:9,background:C.blueL,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,overflow:'hidden'}}>{user.picture?<img src={user.picture} style={{width:'100%',height:'100%',objectFit:'cover'}}/>:<span style={{fontSize:13}}>👤</span>}</div>}
          </div>
        ))}
        <div ref={endRef}/>
      </div>
      <div style={{display:'flex',gap:7,flexWrap:'wrap',marginBottom:9}}>
        {SUGS.map(s=><button key={s} onClick={()=>send(s)} style={{background:C.white,border:`1px solid ${C.border}`,color:C.text,borderRadius:17,padding:'5px 11px',fontSize:11,cursor:'pointer'}}>{s}</button>)}
      </div>
      <div style={{display:'flex',gap:9,paddingBottom:22}}>
        <textarea value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(inp)}}} placeholder="Escribe tu pregunta... (Enter para enviar)" rows={2} style={{flex:1,background:C.white,border:`1.5px solid ${loading?C.border:C.teal}`,color:C.text,borderRadius:10,padding:'10px 13px',fontSize:13,fontFamily:'inherit',outline:'none',resize:'none'}}/>
        <button onClick={()=>send(inp)} disabled={loading||!inp.trim()} style={{background:loading||!inp.trim()?C.border:C.teal,color:'#fff',border:'none',borderRadius:10,padding:'10px 16px',fontSize:13,fontWeight:700,cursor:loading||!inp.trim()?'default':'pointer'}}>Enviar</button>
      </div>
      <style>{`@keyframes dots{0%,100%{opacity:.2;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}`}</style>
    </div>
  )
}

// ── BUSCADOR — busca en TODAS las carpetas ────────────────────────
function Buscador({ user, allFolders }) {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [filtro, setFiltro] = useState('')
  const [modo, setModo] = useState('tabla')
  const [comparaTerm, setComparaTerm] = useState('')

  useEffect(()=>{
    if (loaded||user.token==='demo') return
    const hasFiles = allFolders.some(f=>f.files.length>0)
    if (!hasFiles) return
    const load = async () => {
      setLoading(true)
      const rows = []
      // Buscar en TODAS las carpetas, especialmente Inventario Proveedores
      for (const folder of allFolders) {
        for (const file of folder.files) {
          if (!file.mimeType?.includes('spreadsheet')) continue
          try {
            const csv = await driveReadContent(user.token, file)
            const parsed = parseProveedoresCSV(csv)
            if (parsed.length>0) rows.push(...parsed.map(r=>({...r,_carpeta:folder.name,_archivo:file.name})))
          } catch {}
        }
      }
      setAllRows(rows)
      setLoaded(true)
      setLoading(false)
    }
    load()
  },[allFolders, loaded])

  const filas = allRows.filter(r=>{
    if (!filtro) return true
    const q = filtro.toLowerCase()
    return r.articulo?.toLowerCase().includes(q)||r.empresa?.toLowerCase().includes(q)||r.rut?.toLowerCase().includes(q)||r.contacto?.toLowerCase().includes(q)
  })

  const getComparacion = () => {
    if (!comparaTerm.trim()) return []
    const q = comparaTerm.toLowerCase()
    const filtered = allRows.filter(r=>r.articulo?.toLowerCase().includes(q)||r.empresa?.toLowerCase().includes(q))
    const grupos = {}
    for (const row of filtered) {
      const key = (row.articulo||'').toLowerCase().trim()||'sin nombre'
      if (!grupos[key]) grupos[key] = {nombre:row.articulo||'—',proveedores:{}}
      const pk = row.empresa||'Desconocido'
      if (!grupos[key].proveedores[pk]) grupos[key].proveedores[pk] = []
      grupos[key].proveedores[pk].push(row)
    }
    return Object.values(grupos).map(g=>{
      const provList = Object.entries(g.proveedores).map(([nombre,rows])=>{
        const last = rows[rows.length-1]
        const precioNum = parseFloat(last?.precio?.replace(/[$\s]/g,'')||'0')||0
        return {nombre, precio:precioNum, precioRaw:last?.precio||'—', fecha:last?.fecha||'', count:rows.length}
      }).filter(p=>p.precio>0).sort((a,b)=>a.precio-b.precio)
      return {nombre:g.nombre, proveedores:provList}
    }).filter(g=>g.proveedores.length>0)
  }

  const th = {padding:'9px 13px',fontSize:11,fontWeight:700,color:C.sub,background:C.bg,borderBottom:`1px solid ${C.border}`,textAlign:'left',whiteSpace:'nowrap'}
  const td = {padding:'9px 13px',fontSize:11,color:C.text,borderBottom:`1px solid ${C.border}`,verticalAlign:'middle'}

  return (
    <div style={{padding:'24px 28px',maxWidth:1100}}>
      <div style={{marginBottom:16}}>
        <h1 style={{margin:0,fontSize:21,fontWeight:800,color:C.text}}>Buscador de Insumos y Proveedores 🔍</h1>
        <p style={{margin:'3px 0 0',fontSize:12,color:C.sub}}>Busca en todas tus carpetas de Drive · Filtra · Compara precios</p>
      </div>

      <div style={{display:'flex',gap:8,marginBottom:14}}>
        {[['tabla','📋 Ver todos'],['comparar','⚖️ Comparar precios']].map(([m,l])=>(
          <button key={m} onClick={()=>setModo(m)} style={{padding:'7px 16px',borderRadius:18,border:`2px solid ${modo===m?C.teal:C.border}`,background:modo===m?C.tealL:'transparent',color:modo===m?C.tealD:C.sub,fontSize:12,fontWeight:modo===m?700:400,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {modo==='tabla'&&<>
        <div style={{display:'flex',gap:9,marginBottom:12}}>
          <input value={filtro} onChange={e=>setFiltro(e.target.value)} placeholder="Filtrar por artículo, empresa, RUT, contacto..." style={{flex:1,background:C.white,border:`1.5px solid ${C.teal}`,color:C.text,borderRadius:9,padding:'10px 14px',fontSize:13,fontFamily:'inherit',outline:'none'}}/>
          {filtro&&<button onClick={()=>setFiltro('')} style={{background:C.bg,border:`1px solid ${C.border}`,color:C.sub,borderRadius:9,padding:'0 12px',cursor:'pointer',fontSize:12}}>✕</button>}
          <button onClick={()=>setLoaded(false)} disabled={loading} style={{background:C.teal,color:'#fff',border:'none',borderRadius:9,padding:'10px 14px',fontSize:12,fontWeight:600,cursor:'pointer'}}>↻ Actualizar</button>
        </div>

        {loading&&<div style={{textAlign:'center',padding:40,color:C.sub}}>Cargando datos de todas las carpetas de Drive...</div>}

        {!loading&&user.token==='demo'&&(
          <div style={{background:C.tealL,borderRadius:13,padding:24,textAlign:'center',border:`1px solid ${C.teal}33`}}>
            <div style={{fontSize:30,marginBottom:8}}>☁️</div>
            <div style={{fontSize:13,color:C.tealD,fontWeight:600}}>Conecta con Google para buscar en tus proveedores</div>
          </div>
        )}

        {!loading&&loaded&&(
          <div>
            <div style={{fontSize:11,color:C.sub,marginBottom:8}}>{filas.length} resultado{filas.length!==1?'s':''}{filtro?` para "${filtro}"`:` en total de ${allRows.length} registros`}</div>
            <div style={{background:C.white,borderRadius:13,border:`1px solid ${C.border}`,overflow:'auto',boxShadow:`0 1px 6px ${C.shadow}`}}>
              <table style={{width:'100%',borderCollapse:'collapse',minWidth:950}}>
                <thead>
                  <tr>
                    <th style={th}>Empresa</th>
                    <th style={th}>Dirección</th>
                    <th style={th}>RUT</th>
                    <th style={th}>Contacto</th>
                    <th style={th}>Teléfono</th>
                    <th style={th}>Factura</th>
                    <th style={th}>Fecha</th>
                    <th style={th}>Artículo</th>
                    <th style={th}>Cant.</th>
                    <th style={th}>Precio neto</th>
                    <th style={th}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.length===0
                    ?<tr><td colSpan={11} style={{...td,textAlign:'center',padding:28,color:C.sub}}>No se encontraron resultados{filtro?` para "${filtro}"`:''}. Intenta con otro término.</td></tr>
                    :filas.map((r,i)=>(
                      <tr key={i} style={{background:i%2===0?'transparent':C.bg}}>
                        <td style={{...td,fontWeight:600,color:C.tealD,whiteSpace:'nowrap'}}>{r.empresa||'—'}</td>
                        <td style={{...td,whiteSpace:'nowrap'}}>{r.direccion||'—'}</td>
                        <td style={{...td,fontFamily:'monospace',fontSize:10}}>{r.rut||'—'}</td>
                        <td style={{...td,whiteSpace:'nowrap'}}>{r.contacto||'—'}</td>
                        <td style={{...td,fontFamily:'monospace'}}>{r.telefono||'—'}</td>
                        <td style={{...td,fontFamily:'monospace'}}>{r.factura||'—'}</td>
                        <td style={{...td,whiteSpace:'nowrap'}}>{r.fecha||'—'}</td>
                        <td style={{...td,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.articulo}>{r.articulo||'—'}</td>
                        <td style={{...td,textAlign:'center'}}>{r.cantidad||'—'}</td>
                        <td style={{...td,fontWeight:700,color:C.blue,textAlign:'right',whiteSpace:'nowrap'}}>{r.precio||'—'}</td>
                        <td style={{...td,fontWeight:700,textAlign:'right',whiteSpace:'nowrap'}}>{r.total||'—'}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading&&!loaded&&!user.token==='demo'&&(
          <div style={{textAlign:'center',padding:32,color:C.sub}}>
            <div style={{fontSize:30,marginBottom:8}}>⏳</div>
            Esperando que Drive cargue los archivos...
          </div>
        )}
      </>}

      {modo==='comparar'&&<>
        <div style={{background:C.goldL,borderRadius:11,padding:'11px 14px',marginBottom:14,border:`1px solid ${C.gold}33`,fontSize:12,color:C.text}}>
          💡 Busca un insumo para ver todos los proveedores que lo venden y comparar precios. <strong>Verde = más barato</strong>
        </div>
        <div style={{display:'flex',gap:9,marginBottom:18}}>
          <input value={comparaTerm} onChange={e=>setComparaTerm(e.target.value)} placeholder="Ej: anestesia, guantes, isocaine, acrilico..." style={{flex:1,background:C.white,border:`1.5px solid ${C.teal}`,color:C.text,borderRadius:9,padding:'11px 14px',fontSize:13,fontFamily:'inherit',outline:'none'}}/>
        </div>

        {comparaTerm&&(()=>{
          const grupos = getComparacion()
          if (!loaded) return <div style={{textAlign:'center',padding:32,color:C.sub}}>Carga los datos primero en "Ver todos"</div>
          if (!grupos.length) return <div style={{textAlign:'center',padding:32,color:C.sub}}>No se encontraron registros para "<strong>{comparaTerm}</strong>"</div>
          return (
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              {grupos.map((g,gi)=>(
                <div key={gi} style={{background:C.white,borderRadius:14,border:`1px solid ${C.border}`,overflow:'hidden',boxShadow:`0 1px 6px ${C.shadow}`}}>
                  <div style={{padding:'12px 18px',background:C.bg,borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div style={{fontSize:13,fontWeight:700,color:C.text}}>{g.nombre}</div>
                    <div style={{fontSize:11,color:C.sub}}>{g.proveedores.length} proveedor{g.proveedores.length!==1?'es':''} · Mejor: <strong style={{color:C.green}}>{g.proveedores[0]?.precioRaw}</strong></div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(g.proveedores.length,4)},1fr)`}}>
                    {g.proveedores.map((p,pi)=>(
                      <div key={pi} style={{padding:'14px 18px',borderRight:pi<g.proveedores.length-1?`1px solid ${C.border}`:'none',background:pi===0?C.greenL:'transparent'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                          <div style={{fontSize:12,fontWeight:700,color:pi===0?C.green:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'70%'}}>{p.nombre}</div>
                          {pi===0&&<span style={{background:C.green,color:'#fff',fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:18,flexShrink:0}}>MEJOR</span>}
                          {pi===g.proveedores.length-1&&pi!==0&&<span style={{background:C.redL,color:C.red,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:18,flexShrink:0}}>MÁS CARO</span>}
                        </div>
                        <div style={{fontSize:20,fontWeight:800,color:pi===0?C.green:pi===g.proveedores.length-1&&pi!==0?C.red:C.text}}>{p.precioRaw}</div>
                        <div style={{fontSize:10,color:C.sub,marginTop:3}}>Última compra: {p.fecha||'—'}</div>
                        <div style={{fontSize:10,color:C.sub}}>{p.count} registro{p.count!==1?'s':''}</div>
                        {pi>0&&g.proveedores[0].precio>0&&p.precio>0&&(
                          <div style={{marginTop:5,fontSize:10,color:C.red,fontWeight:600}}>
                            +{((p.precio-g.proveedores[0].precio)/g.proveedores[0].precio*100).toFixed(1)}% más caro
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
function MiDrive({ user, allFolders, loading, onRefresh, onAnalyze }) {
  const [sel, setSel] = useState(null)
  const [reading, setReading] = useState(null)
  const activeF = allFolders.find(f=>f.id===sel)
  const canRead = m=>m?.includes('spreadsheet')||m?.includes('document')||m?.includes('csv')
  const readAndAnalyze = async (file) => {
    setReading(file.id)
    try { const text=await driveReadContent(user.token,file); onAnalyze(text,file.name) } catch(e){alert('Error: '+e.message)}
    setReading(null)
  }
  return (
    <div style={{padding:'24px 28px',maxWidth:880}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:18}}>
        <div><h1 style={{margin:0,fontSize:21,fontWeight:800,color:C.text}}>Mi Drive ☁️</h1><p style={{margin:'3px 0 0',fontSize:12,color:C.sub}}>Todas tus carpetas sincronizadas</p></div>
        <div style={{display:'flex',gap:8}}>
          <a href="https://drive.google.com" target="_blank" rel="noreferrer" style={{background:C.white,color:C.teal,border:`1px solid ${C.teal}`,borderRadius:9,padding:'8px 13px',fontSize:12,fontWeight:600,textDecoration:'none'}}>Abrir Drive →</a>
          <button onClick={onRefresh} disabled={loading} style={{background:C.teal,color:'#fff',border:'none',borderRadius:9,padding:'8px 13px',fontSize:12,fontWeight:600,cursor:'pointer'}}>↻ Actualizar</button>
        </div>
      </div>
      {loading?<div style={{textAlign:'center',padding:40,color:C.sub}}>Cargando...</div>:<>
        <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(allFolders.length,4)},1fr)`,gap:11,marginBottom:14}}>
          {allFolders.map(f=>(
            <button key={f.id} onClick={()=>setSel(sel===f.id?null:f.id)} style={{background:sel===f.id?C.tealL:C.white,border:`2px solid ${sel===f.id?C.teal:C.border}`,borderRadius:13,padding:'14px',textAlign:'center',cursor:'pointer'}}>
              <div style={{fontSize:26,marginBottom:5}}>{f.emoji}</div>
              <div style={{fontSize:12,color:sel===f.id?C.tealD:C.text,fontWeight:600,marginBottom:2}}>{f.name}</div>
              <div style={{fontSize:10,color:f.files.length>0?C.teal:C.light}}>{f.files.length>0?`${f.files.length} archivos`:'Vacía'}</div>
            </button>
          ))}
        </div>
        {activeF&&(
          <div style={{background:C.white,borderRadius:13,border:`1px solid ${C.border}`,overflow:'hidden'}}>
            <div style={{padding:'11px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between'}}>
              <span style={{fontSize:13,fontWeight:700}}>{activeF.emoji} {activeF.name}</span>
              <span style={{fontSize:11,color:C.sub}}>{activeF.files.length} archivos</span>
            </div>
            {activeF.files.length===0?<div style={{padding:'26px',textAlign:'center',color:C.sub}}>Carpeta vacía</div>:activeF.files.map((f,i)=>(
              <div key={f.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 16px',borderBottom:i<activeF.files.length-1?`1px solid ${C.border}`:'none'}}>
                <span style={{fontSize:19}}>{f.mimeType?.includes('spreadsheet')?'📊':'📄'}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,color:C.text,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.name}</div>
                  {f.modifiedTime&&<div style={{fontSize:10,color:C.sub}}>{new Date(f.modifiedTime).toLocaleDateString('es-CL')}</div>}
                </div>
                {canRead(f.mimeType)&&<button onClick={()=>readAndAnalyze(f)} disabled={reading===f.id} style={{background:C.tealL,color:C.tealD,border:`1px solid ${C.teal}33`,borderRadius:7,padding:'5px 11px',fontSize:11,fontWeight:600,cursor:'pointer'}}>{reading===f.id?'Leyendo...':'🤖 Analizar'}</button>}
              </div>
            ))}
          </div>
        )}
      </>}
    </div>
  )
}

// ── APP ROOT ──────────────────────────────────────────────────────
const NAV = [
  {id:'inicio',label:'Inicio',icon:'🏠'},
  {id:'numeros',label:'Mis Números',icon:'📊'},
  {id:'ia',label:'Consejero IA',icon:'🤖'},
  {id:'buscador',label:'Buscador',icon:'🔍'},
  {id:'drive',label:'Mi Drive',icon:'☁️'},
]

export default function App() {
  const [authState, setAuthState] = useState('loading')
  const [savedUser, setSavedUser] = useState(null)
  const [user, setUser] = useState(null)
  const [onboarded, setOnboarded] = useState(false)
  const [tab, setTab] = useState('inicio')
  const [txs, setTxs] = useState([])
  const [allFolders, setAllFolders] = useState([])
  const [folderIds, setFolderIds] = useState(null)
  const [driveLoading, setDriveLoading] = useState(false)
  const [aiSummary, setAiSummary] = useState('')
  const [loadingAI, setLoadingAI] = useState(false)

  useEffect(()=>{
    const s = loadSession()
    if (!s) { setAuthState('loggedOut'); return }
    if (!s.expired) { setUser(s.user); setAuthState('loggedIn'); loadDrive(s.user.token); const seen=localStorage.getItem(`dentaiq_ob_${s.user.email}`); setOnboarded(!!seen) }
    else { setSavedUser(s.user); setAuthState('reauth') }
  },[])

  const loadDrive = useCallback(async (token) => {
    if (token==='demo') { setAllFolders([{id:'1',name:'Ingresos',emoji:'💰',files:[]},{id:'2',name:'Gastos',emoji:'💳',files:[]}]); return }
    setDriveLoading(true)
    try {
      const {allFolders:af, folderIds:fids} = await setupDrive(token)
      setAllFolders(af)
      setFolderIds(fids)
    } catch(e){console.error(e)}
    setDriveLoading(false)
  },[])

  const handleLogin = async (u, shouldSave=true) => {
    setUser(u)
    if (shouldSave&&u.token!=='demo') saveSession(u)
    await loadDrive(u.token)
    const seen = localStorage.getItem(`dentaiq_ob_${u.email}`)
    setOnboarded(!!seen)
    setAuthState('loggedIn')
  }

  const handleLogout = () => { clearSession(); setUser(null); setAuthState('loggedOut'); setSavedUser(null); setAllFolders([]); setFolderIds(null); setTxs([]) }

  const handleOnboardingDone = () => { if(user)localStorage.setItem(`dentaiq_ob_${user.email}`,'1'); setOnboarded(true) }
  const handleAnalyzeFile = useCallback(()=>setTab('ia'),[])

  if (authState==='loading') return <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'sans-serif'}}><div style={{textAlign:'center'}}><div style={{fontSize:46,marginBottom:14}}>🦷</div><div style={{fontSize:15,color:C.sub}}>Cargando DentaIQ...</div></div></div>
  if (authState==='loggedOut') return <Welcome onLogin={handleLogin}/>
  if (authState==='reauth') return <Reconnecting savedUser={savedUser} onLogin={handleLogin} onLogout={handleLogout}/>
  if (!user) return <Welcome onLogin={handleLogin}/>
  if (!onboarded) return <Onboarding user={user} onDone={handleOnboardingDone}/>

  const totalFiles = allFolders.reduce((s,f)=>s+f.files.length,0)

  return (
    <div style={{display:'flex',height:'100vh',background:C.bg,fontFamily:"'Sora',system-ui,sans-serif",color:C.text}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}input,select,textarea{outline:none;font-family:inherit}button{font-family:inherit}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:4px}`}</style>

      <div style={{width:205,flexShrink:0,background:C.white,borderRight:`1px solid ${C.border}`,display:'flex',flexDirection:'column'}}>
        <div style={{padding:'16px 14px 13px',borderBottom:`1px solid ${C.border}`}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:11}}>
            <div style={{width:30,height:30,borderRadius:8,background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>🦷</div>
            <div><div style={{fontSize:13,fontWeight:800,color:C.text}}>DentaIQ</div><div style={{fontSize:9,color:C.sub}}>Gerente financiero</div></div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:7,padding:'6px 8px',background:C.bg,borderRadius:8,border:`1px solid ${C.border}`}}>
            {user.picture?<img src={user.picture} style={{width:22,height:22,borderRadius:'50%'}}/>:<div style={{width:22,height:22,borderRadius:'50%',background:C.teal,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:'#fff',fontWeight:700}}>{user.name[0]}</div>}
            <div style={{minWidth:0}}>
              <div style={{fontSize:11,color:C.text,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user.name.split(' ')[0]}</div>
              <div style={{fontSize:9,color:C.sub,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user.email}</div>
            </div>
          </div>
        </div>
        <div style={{flex:1,padding:'9px 7px',display:'flex',flexDirection:'column',gap:2}}>
          {NAV.map(item=>{
            const active=tab===item.id
            return (
              <button key={item.id} onClick={()=>setTab(item.id)} style={{display:'flex',alignItems:'center',gap:8,padding:'9px 10px',borderRadius:8,background:active?C.tealL:'transparent',border:active?`1px solid ${C.teal}33`:'1px solid transparent',color:active?C.tealD:C.sub,cursor:'pointer',fontSize:12,fontWeight:active?700:400,textAlign:'left'}}>
                <span style={{fontSize:15}}>{item.icon}</span>
                {item.label}
                {item.id==='drive'&&totalFiles>0&&<span style={{marginLeft:'auto',background:C.teal,color:'#fff',borderRadius:18,padding:'1px 6px',fontSize:9,fontWeight:700}}>{totalFiles}</span>}
                {item.id==='ia'&&<span style={{marginLeft:'auto',background:C.greenL,color:C.green,borderRadius:18,padding:'1px 6px',fontSize:9,fontWeight:700}}>ON</span>}
              </button>
            )
          })}
        </div>
        <div style={{padding:'11px 11px',borderTop:`1px solid ${C.border}`}}>
          <button onClick={handleLogout} style={{width:'100%',background:'transparent',color:C.sub,border:`1px solid ${C.border}`,borderRadius:7,padding:'6px',fontSize:11,cursor:'pointer'}}>Cerrar sesión</button>
        </div>
      </div>

      <div style={{flex:1,overflowY:'auto'}}>
        {tab==='inicio'&&<Dashboard user={user} txs={txs} allFolders={allFolders} aiSummary={aiSummary} loadingAI={loadingAI}/>}
        {tab==='numeros'&&<MisNumeros txs={txs} setTxs={setTxs} user={user} folderIds={folderIds}/>}
        {tab==='ia'&&<Consejero user={user} txs={txs} allFolders={allFolders}/>}
        {tab==='buscador'&&<Buscador user={user} allFolders={allFolders}/>}
        {tab==='drive'&&<MiDrive user={user} allFolders={allFolders} loading={driveLoading} onRefresh={()=>loadDrive(user.token)} onAnalyze={handleAnalyzeFile}/>}
      </div>
    </div>
  )
}
