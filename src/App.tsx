// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'

const GOOGLE_CLIENT_ID = '33863186131-3rgcbifmp7sjkacuhqinr41nkbca7v09.apps.googleusercontent.com'
const AI_PROVIDER = 'groq'
const AI_MODEL = 'llama-3.3-70b-versatile'
const AI_API_KEY = 'gsk_GgF94WGwrVjrX2sYD5mrWGdyb3FY0ccWjS9jhKEWdsG5gc'

const C = {
  bg:'#F8F7F4',card:'#FFFFFF',border:'rgba(0,0,0,0.08)',
  teal:'#007A6B',tealL:'#E6F4F2',tealD:'#005549',
  gold:'#D97706',goldL:'#FEF3C7',
  red:'#DC2626',redL:'#FEE2E2',
  blue:'#1D4ED8',blueL:'#DBEAFE',
  text:'#111827',sub:'#6B7280',light:'#9CA3AF',
  green:'#059669',greenL:'#D1FAE5',
  white:'#FFFFFF',shadow:'rgba(0,0,0,0.06)',
}

const clp = (n) => {
  if (Math.abs(n)>=1e6) return `$${(n/1e6).toFixed(1)}M`
  if (Math.abs(n)>=1e3) return `$${Math.round(n/1e3).toLocaleString('es-CL')}K`
  return `$${Math.round(n).toLocaleString('es-CL')}`
}

// ── Google OAuth ──────────────────────────────────────────────────
function loadGIS() {
  return new Promise(r => {
    if (window.google?.accounts) { r(); return }
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => r()
    document.head.appendChild(s)
  })
}

async function signIn() {
  await loadGIS()
  return new Promise((resolve, reject) => {
    const c = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      callback: async (r) => {
        if (!r.access_token) { reject(new Error('No se pudo conectar')); return }
        try {
          const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${r.access_token}` }
          }).then(x => x.json())
          resolve({ email: u.email, name: u.name || u.email, picture: u.picture || '', token: r.access_token })
        } catch(e) { reject(e) }
      },
      error_callback: (e) => reject(new Error(
        e.type === 'popup_closed' ? 'Cerraste la ventana de Google' : 'Error de autenticación'
      ))
    })
    c.requestAccessToken()
  })
}

// ── Google Drive API ──────────────────────────────────────────────
const driveH = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

async function driveFind(t, q) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=5`, { headers: { Authorization: `Bearer ${t}` } })
  return (await r.json()).files || []
}

async function driveCreate(t, body) {
  return fetch('https://www.googleapis.com/drive/v3/files', { method:'POST', headers: driveH(t), body: JSON.stringify(body) }).then(r => r.json())
}

async function driveListFiles(t, parentId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=50`, { headers: { Authorization: `Bearer ${t}` } })
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
  return (await r.text()).slice(0, 6000)
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

const FOLDERS = [
  { name:'Ingresos', emoji:'💰' },
  { name:'Gastos', emoji:'💳' },
  { name:'Facturas', emoji:'🧾' },
  { name:'Proveedores', emoji:'📦' },
  { name:'Reportes', emoji:'📊' },
]

async function setupDrive(t) {
  const rootId = await getOrCreate(t, 'DentaIQ')
  const folders = []
  for (const { name, emoji } of FOLDERS) {
    const id = await getOrCreate(t, name, rootId)
    const files = await driveListFiles(t, id)
    folders.push({ id, name, emoji, files })
  }
  return folders
}

// ── IA ────────────────────────────────────────────────────────────
async function askAI(msgs, system) {
  if (AI_PROVIDER === 'groq' || AI_PROVIDER === 'openai') {
    const url = AI_PROVIDER === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions'
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role:'system', content:system }, ...msgs] })
    })
    const d = await r.json()
    if (d.error) throw new Error(d.error.message)
    return d.choices?.[0]?.message?.content || ''
  }
  if (AI_PROVIDER === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':AI_API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
      body: JSON.stringify({ model:AI_MODEL, max_tokens:1200, system, messages:msgs })
    })
    const d = await r.json()
    if (d.error) throw new Error(d.error.message)
    return d.content?.[0]?.text || ''
  }
  if (AI_PROVIDER === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ system_instruction:{ parts:[{ text:system }] }, contents:msgs.map(m => ({ role: m.role==='assistant'?'model':'user', parts:[{ text:m.content }] })) })
    })
    const d = await r.json()
    if (d.error) throw new Error(d.error.message)
    return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }
  throw new Error('Provider no configurado')
}

// ── Pantalla de bienvenida ────────────────────────────────────────
function Welcome({ onLogin }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loginDemo = () => {
    onLogin({ email:'demo@dentaiq.cl', name:'Dr. Demo', picture:'', token:'demo' })
  }

  const login = async () => {
    setLoading(true); setError('')
    try {
      const u = await signIn()
      onLogin(u)
    } catch(e) {
      setError(e.message)
    }
    setLoading(false)
  }

  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'24px', fontFamily:'inherit' }}>
      <div style={{ marginBottom:48, textAlign:'center' }}>
        <div style={{ width:64, height:64, borderRadius:20, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32, margin:'0 auto 16px', boxShadow:'0 4px 20px rgba(0,122,107,0.3)' }}>🦷</div>
        <h1 style={{ margin:'0 0 6px', fontSize:32, fontWeight:800, color:C.text, letterSpacing:'-0.02em' }}>DentaIQ</h1>
        <p style={{ margin:0, fontSize:16, color:C.sub }}>Tu gerente financiero inteligente</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:48, maxWidth:680, width:'100%' }}>
        {[
          ['📊','¿Estoy ganando?','Sabe exactamente cuánto entra y cuánto sale cada mes, sin hacer cálculos.'],
          ['🤖','La IA te explica','Entiende tus finanzas en lenguaje simple, no en jerga contable.'],
          ['☁️','Solo sube archivos','Arrastra tus boletas y planillas a Drive. El resto lo hace DentaIQ.'],
        ].map(([icon,title,desc]) => (
          <div key={title} style={{ background:C.white, borderRadius:16, padding:'20px', border:`1px solid ${C.border}`, boxShadow:`0 1px 4px ${C.shadow}` }}>
            <div style={{ fontSize:28, marginBottom:10 }}>{icon}</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:6 }}>{title}</div>
            <div style={{ fontSize:13, color:C.sub, lineHeight:1.5 }}>{desc}</div>
          </div>
        ))}
      </div>

      <div style={{ background:C.white, borderRadius:20, padding:'36px 40px', border:`1px solid ${C.border}`, boxShadow:`0 2px 12px ${C.shadow}`, width:'100%', maxWidth:400, textAlign:'center' }}>
        <div style={{ fontSize:15, fontWeight:700, color:C.text, marginBottom:4 }}>Empieza gratis hoy</div>
        <div style={{ fontSize:13, color:C.sub, marginBottom:24 }}>Solo necesitas tu cuenta de Google</div>

        <button onClick={login} disabled={loading} style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:12, background:C.white, color:'#3c4043', border:'1.5px solid #dadce0', borderRadius:12, padding:'14px 20px', fontSize:15, fontWeight:500, cursor:loading?'default':'pointer', marginBottom:12, boxShadow:'0 1px 3px rgba(0,0,0,0.08)', opacity:loading?0.7:1 }}>
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {loading ? 'Conectando...' : 'Continuar con Google'}
        </button>

        <button onClick={loginDemo} style={{ width:'100%', background:C.teal, color:'#fff', border:'none', borderRadius:12, padding:'14px 20px', fontSize:15, fontWeight:700, cursor:'pointer', marginBottom:16 }}>
          🚀 Ver demo ahora
        </button>

        {error && <div style={{ padding:'10px 14px', background:C.redL, borderRadius:8, fontSize:13, color:C.red, marginBottom:12 }}>{error}</div>}

        <p style={{ margin:0, fontSize:11, color:C.light }}>El demo muestra todas las funciones sin Google.<br/>El login real conecta tu Drive automáticamente.</p>
      </div>
      <p style={{ marginTop:24, fontSize:12, color:C.light }}>Diseñado para clínicas dentales · Chile</p>
    </div>
  )
}

// ── Onboarding ────────────────────────────────────────────────────
function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0)
  const steps = [
    { icon:'👋', title:`Hola ${user.name.split(' ')[0]}`, desc:'DentaIQ ya creó tu carpeta en Google Drive. En 3 pasos te mostramos cómo funciona.' },
    { icon:'☁️', title:'Sube tus documentos a Drive', desc:'Abre Google Drive → Carpeta "DentaIQ" → Sube tus boletas, facturas o planillas. Puedes hacerlo desde el celular con una foto.' },
    { icon:'🤖', title:'La IA lee y analiza todo', desc:'Cada vez que abras DentaIQ, la IA revisará tus archivos y te dirá si estás ganando o perdiendo y qué puedes mejorar.' },
    { icon:'💬', title:'Pregúntale lo que quieras', desc:'¿Cuánto gané este mes? ¿Me conviene comprar un equipo? Escríbelo en lenguaje normal y te responde al instante.' },
  ]
  const s = steps[step]
  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ background:C.white, borderRadius:24, padding:'48px 40px', maxWidth:480, width:'100%', textAlign:'center', border:`1px solid ${C.border}`, boxShadow:`0 4px 24px ${C.shadow}` }}>
        <div style={{ fontSize:56, marginBottom:20 }}>{s.icon}</div>
        <h2 style={{ margin:'0 0 12px', fontSize:24, fontWeight:800, color:C.text }}>{s.title}</h2>
        <p style={{ margin:'0 0 36px', fontSize:15, color:C.sub, lineHeight:1.7 }}>{s.desc}</p>
        <div style={{ display:'flex', justifyContent:'center', gap:8, marginBottom:32 }}>
          {steps.map((_,i) => <div key={i} style={{ width:i===step?24:8, height:8, borderRadius:4, background:i===step?C.teal:C.border, transition:'all 0.2s' }}/>)}
        </div>
        <button onClick={() => step < steps.length-1 ? setStep(s=>s+1) : onDone()} style={{ width:'100%', background:C.teal, color:'#fff', border:'none', borderRadius:12, padding:'14px', fontSize:15, fontWeight:700, cursor:'pointer' }}>
          {step < steps.length-1 ? 'Siguiente →' : '¡Empezar ahora!'}
        </button>
        {step > 0 && <button onClick={() => setStep(s=>s-1)} style={{ marginTop:12, background:'none', border:'none', color:C.sub, fontSize:13, cursor:'pointer' }}>← Volver</button>}
      </div>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────
function Dashboard({ user, txs, folders, aiSummary, loadingAI }) {
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const margen = ing - gas
  const pct = ing > 0 ? (margen/ing)*100 : 0
  const totalFiles = folders.reduce((s,f)=>s+f.files.length,0)

  return (
    <div style={{ padding:'32px', maxWidth:960 }}>
      <div style={{ marginBottom:28 }}>
        <h1 style={{ margin:0, fontSize:26, fontWeight:800, color:C.text }}>Hola, {user.name.split(' ')[0]} 👋</h1>
        <p style={{ margin:'4px 0 0', fontSize:14, color:C.sub }}>{new Date().toLocaleDateString('es-CL',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
      </div>

      <div style={{ background:margen>=0?C.tealL:C.redL, borderRadius:20, padding:'24px 28px', marginBottom:24, border:`1px solid ${margen>=0?C.teal+'33':C.red+'33'}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:8 }}>
          <span style={{ fontSize:32 }}>{margen>=0?'✅':'⚠️'}</span>
          <div>
            <div style={{ fontSize:18, fontWeight:800, color:margen>=0?C.tealD:C.red }}>
              {txs.length===0 ? 'Aún no hay datos' : 'Tu clínica está '+(margen>=0?'ganando dinero':'en pérdida este mes')}
            </div>
            {txs.length>0 && <div style={{ fontSize:14, color:margen>=0?C.teal:C.red }}>Margen: {pct.toFixed(1)}% — {pct>40?'excelente 🌟':pct>25?'bien, puede mejorar':'necesita atención'}</div>}
          </div>
        </div>
        {txs.length===0 && <div style={{ fontSize:14, color:C.sub }}>Sube archivos a tu Drive o agrega transacciones manualmente.</div>}
      </div>

      {txs.length>0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:24 }}>
          {[
            { label:'Lo que entró este mes', value:clp(ing), icon:'📈', color:C.green, bg:C.greenL },
            { label:'Lo que salió este mes', value:clp(gas), icon:'📉', color:C.red, bg:C.redL },
            { label:'Lo que te queda', value:clp(margen), icon:margen>=0?'💰':'🚨', color:margen>=0?C.teal:C.red, bg:margen>=0?C.tealL:C.redL },
          ].map(k => (
            <div key={k.label} style={{ background:k.bg, borderRadius:16, padding:'20px 22px', border:`1px solid ${k.color}33` }}>
              <div style={{ fontSize:28, marginBottom:8 }}>{k.icon}</div>
              <div style={{ fontSize:12, color:C.sub, marginBottom:4 }}>{k.label}</div>
              <div style={{ fontSize:28, fontWeight:800, color:k.color }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ background:C.white, borderRadius:20, padding:'24px 28px', marginBottom:24, border:`1px solid ${C.border}`, boxShadow:`0 1px 6px ${C.shadow}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🤖</div>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:C.text }}>Lo que dice tu consejero IA</div>
            <div style={{ fontSize:12, color:C.sub }}>Análisis automático basado en tus datos</div>
          </div>
          {loadingAI && <div style={{ marginLeft:'auto', fontSize:12, color:C.sub }}>Analizando...</div>}
        </div>
        {aiSummary
          ? <p style={{ margin:0, fontSize:14, color:C.text, lineHeight:1.7, whiteSpace:'pre-wrap' }}>{aiSummary}</p>
          : <p style={{ margin:0, fontSize:14, color:C.sub, fontStyle:'italic' }}>{totalFiles===0?'Sube documentos a tu Drive para recibir análisis automático.':'Cargando análisis...'}</p>
        }
      </div>

      <div style={{ background:C.white, borderRadius:20, padding:'20px 24px', border:`1px solid ${C.border}`, boxShadow:`0 1px 6px ${C.shadow}` }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:14 }}>☁️ Tus carpetas en Drive</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10 }}>
          {folders.map(f => (
            <div key={f.id} style={{ textAlign:'center', padding:'12px 8px', background:C.bg, borderRadius:12, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:24, marginBottom:4 }}>{f.emoji}</div>
              <div style={{ fontSize:12, color:C.text, fontWeight:500, marginBottom:2 }}>{f.name}</div>
              <div style={{ fontSize:11, color:f.files.length>0?C.teal:C.light }}>{f.files.length>0?`${f.files.length} archivos`:'Vacía'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Mis Números ───────────────────────────────────────────────────
function MisNumeros({ txs, setTxs }) {
  const [form, setForm] = useState({ tipo:'I', desc:'', cat:'Servicios dentales', monto:'' })
  const [open, setOpen] = useState(false)
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const CATS_I = ['Servicios dentales','Ortodoncia','Implantes','Blanqueamiento','Convenios','Otros ingresos']
  const CATS_G = ['Insumos y materiales','Personal','Arriendo','Equipos','Servicios básicos','Publicidad','Contabilidad','Otros gastos']
  const inp = { width:'100%', background:C.bg, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:'10px 12px', fontSize:14, fontFamily:'inherit', outline:'none' }
  const guardar = () => {
    if (!form.desc.trim() || !form.monto) return
    setTxs(p => [{ id:Date.now(), tipo:form.tipo, desc:form.desc, cat:form.cat, monto:parseInt(form.monto), fecha:new Date().toLocaleDateString('es-CL'), fuente:'manual' }, ...p])
    setForm({ tipo:'I', desc:'', cat:'Servicios dentales', monto:'' }); setOpen(false)
  }
  return (
    <div style={{ padding:'32px', maxWidth:840 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div><h1 style={{ margin:0, fontSize:24, fontWeight:800, color:C.text }}>Mis Números</h1><p style={{ margin:'4px 0 0', fontSize:14, color:C.sub }}>Registro de lo que entra y lo que sale</p></div>
        <button onClick={()=>setOpen(!open)} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:10, padding:'10px 20px', fontSize:14, fontWeight:700, cursor:'pointer' }}>+ Agregar</button>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:20 }}>
        {[['Lo que entró',ing,C.green,C.greenL,'📈'],['Lo que salió',gas,C.red,C.redL,'📉'],['Balance',ing-gas,ing-gas>=0?C.teal:C.red,ing-gas>=0?C.tealL:C.redL,ing-gas>=0?'✅':'⚠️']].map(([l,v,c,bg,ico]) => (
          <div key={l} style={{ background:bg, borderRadius:14, padding:'16px 18px', border:`1px solid ${c}33` }}>
            <div style={{ fontSize:20, marginBottom:6 }}>{ico}</div>
            <div style={{ fontSize:12, color:C.sub, marginBottom:3 }}>{l}</div>
            <div style={{ fontSize:22, fontWeight:800, color:c }}>{clp(v)}</div>
          </div>
        ))}
      </div>
      {open && (
        <div style={{ background:C.white, borderRadius:16, padding:24, marginBottom:16, border:`1px solid ${C.border}`, boxShadow:`0 2px 8px ${C.shadow}` }}>
          <div style={{ fontSize:15, fontWeight:700, color:C.text, marginBottom:16 }}>¿Qué quieres registrar?</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <div>
              <label style={{ fontSize:12, color:C.sub, display:'block', marginBottom:6, fontWeight:500 }}>¿QUÉ ES?</label>
              <div style={{ display:'flex', gap:8 }}>
                {[['I','💰 Entró'],['G','💳 Salió']].map(([v,l]) => (
                  <button key={v} onClick={()=>setForm({...form,tipo:v,cat:v==='I'?CATS_I[0]:CATS_G[0]})} style={{ flex:1, padding:'10px', borderRadius:8, border:`2px solid ${form.tipo===v?C.teal:C.border}`, background:form.tipo===v?C.tealL:'transparent', color:form.tipo===v?C.tealD:C.sub, fontSize:13, fontWeight:form.tipo===v?700:400, cursor:'pointer' }}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize:12, color:C.sub, display:'block', marginBottom:6, fontWeight:500 }}>CATEGORÍA</label>
              <select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})} style={inp}>
                {(form.tipo==='I'?CATS_I:CATS_G).map(o=><option key={o}>{o}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:12, color:C.sub, display:'block', marginBottom:6, fontWeight:500 }}>DESCRIPCIÓN</label>
            <input value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder={form.tipo==='I'?'Ej: Pago ortodoncia Ana García':'Ej: Compra insumos Septodont'} style={inp}/>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:12, alignItems:'flex-end' }}>
            <div>
              <label style={{ fontSize:12, color:C.sub, display:'block', marginBottom:6, fontWeight:500 }}>MONTO (pesos chilenos)</label>
              <input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="150000" style={inp}/>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={guardar} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:8, padding:'10px 20px', fontSize:14, fontWeight:700, cursor:'pointer' }}>Guardar</button>
              <button onClick={()=>setOpen(false)} style={{ background:C.bg, color:C.sub, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 16px', fontSize:14, cursor:'pointer' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
      {txs.length===0
        ? <div style={{ background:C.white, borderRadius:16, padding:'40px', textAlign:'center', border:`2px dashed ${C.border}` }}>
            <div style={{ fontSize:40, marginBottom:12 }}>📋</div>
            <div style={{ fontSize:15, fontWeight:600, color:C.text, marginBottom:6 }}>Nada registrado aún</div>
            <div style={{ fontSize:13, color:C.sub }}>Agrega tu primer ingreso o gasto con el botón "+ Agregar"</div>
          </div>
        : <div style={{ background:C.white, borderRadius:16, border:`1px solid ${C.border}`, overflow:'hidden', boxShadow:`0 1px 6px ${C.shadow}` }}>
            {txs.map((tx,i) => (
              <div key={tx.id} style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 20px', borderBottom:i<txs.length-1?`1px solid ${C.border}`:'none' }}>
                <div style={{ width:40, height:40, borderRadius:10, background:tx.tipo==='I'?C.greenL:C.redL, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>{tx.tipo==='I'?'📈':'📉'}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, color:C.text, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tx.desc}</div>
                  <div style={{ fontSize:12, color:C.sub, marginTop:2 }}>{tx.cat} · {tx.fecha}</div>
                </div>
                <div style={{ fontSize:16, fontWeight:800, color:tx.tipo==='I'?C.green:C.red, flexShrink:0 }}>{tx.tipo==='I'?'+':'−'}{clp(tx.monto)}</div>
              </div>
            ))}
          </div>
      }
    </div>
  )
}

// ── Consejero IA ──────────────────────────────────────────────────
function Consejero({ user, txs, folders }) {
  const ing = txs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
  const gas = txs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
  const totalFiles = folders.reduce((s,f)=>s+f.files.length,0)
  const system = `Eres el consejero financiero de ${user.name}, dueño/a de una clínica dental en Chile.
Habla como un amigo experto, en lenguaje simple sin jerga contable.
DATOS: Ingresos ${clp(ing)}, Gastos ${clp(gas)}, Balance ${clp(ing-gas)} (${ing>0?(((ing-gas)/ing)*100).toFixed(1)+'%':'sin datos'}).
Archivos en Drive: ${totalFiles}.
Responde con emojis, máx 200 palabras, español chileno natural. Da siempre un consejo concreto.`

  const SUGERENCIAS = ['¿Estoy ganando suficiente?','¿En qué me gasto más?','¿Qué hago para ganar más?','Explícame mi situación','¿Cuándo contratar personal?','¿Me conviene equipo nuevo?']
  const [msgs, setMsgs] = useState([{ role:'assistant', content:`Hola ${user.name.split(' ')[0]} 👋 Soy tu consejero financiero. ¿Qué quieres saber sobre tu negocio?` }])
  const [inp, setInp] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }) }, [msgs])

  const send = async (texto) => {
    const t = (texto || inp).trim(); if (!t || loading) return
    setInp('')
    const hist = [...msgs, { role:'user', content:t }]
    setMsgs([...hist, { role:'assistant', content:'', loading:true }]); setLoading(true)
    try {
      const reply = await askAI(hist.filter(m=>!m.loading).map(m=>({role:m.role,content:m.content})), system)
      setMsgs([...hist, { role:'assistant', content:reply }])
    } catch(e) {
      setMsgs([...hist, { role:'assistant', content:`❌ ${e.message}` }])
    }
    setLoading(false)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', maxWidth:800, padding:'0 32px' }}>
      <div style={{ padding:'32px 0 20px' }}>
        <h1 style={{ margin:0, fontSize:24, fontWeight:800, color:C.text }}>Tu Consejero IA 🤖</h1>
        <p style={{ margin:'4px 0 0', fontSize:14, color:C.sub }}>Pregúntale lo que quieras sobre tu negocio, en tus palabras</p>
      </div>
      <div style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:16, paddingBottom:16 }}>
        {msgs.map((m,i) => (
          <div key={i} style={{ display:'flex', justifyContent:m.role==='user'?'flex-end':'flex-start', gap:12, alignItems:'flex-start' }}>
            {m.role==='assistant' && <div style={{ width:36, height:36, borderRadius:10, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>🤖</div>}
            <div style={{ maxWidth:'78%', padding:'14px 16px', fontSize:14, lineHeight:1.7, whiteSpace:'pre-wrap', borderRadius:m.role==='user'?'16px 16px 4px 16px':'4px 16px 16px 16px', background:m.role==='user'?C.teal:C.white, color:m.role==='user'?'#fff':C.text, boxShadow:m.role==='assistant'?`0 1px 4px ${C.shadow}`:'none', border:m.role==='assistant'?`1px solid ${C.border}`:'none' }}>
              {m.loading ? <div style={{ display:'flex', gap:4 }}>{[0,1,2].map(i=><div key={i} style={{ width:8, height:8, borderRadius:'50%', background:C.sub, animation:`dots 1.2s ${i*0.2}s infinite ease-in-out` }}/>)}</div> : m.content}
            </div>
            {m.role==='user' && <div style={{ width:36, height:36, borderRadius:10, background:C.blueL, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' }}>{user.picture?<img src={user.picture} style={{width:'100%',height:'100%',objectFit:'cover'}}/>:<span style={{fontSize:16}}>👤</span>}</div>}
          </div>
        ))}
        <div ref={endRef}/>
      </div>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
        {SUGERENCIAS.map(s => <button key={s} onClick={()=>send(s)} style={{ background:C.white, border:`1px solid ${C.border}`, color:C.text, borderRadius:20, padding:'6px 14px', fontSize:12, cursor:'pointer', boxShadow:`0 1px 3px ${C.shadow}` }}>{s}</button>)}
      </div>
      <div style={{ display:'flex', gap:12, paddingBottom:28 }}>
        <textarea value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(inp)}}} placeholder="Escribe tu pregunta... (Enter para enviar)" rows={2} style={{ flex:1, background:C.white, border:`1.5px solid ${loading?C.border:C.teal}`, color:C.text, borderRadius:12, padding:'12px 16px', fontSize:14, fontFamily:'inherit', outline:'none', resize:'none', boxShadow:`0 1px 4px ${C.shadow}` }}/>
        <button onClick={()=>send(inp)} disabled={loading||!inp.trim()} style={{ background:loading||!inp.trim()?C.border:C.teal, color:'#fff', border:'none', borderRadius:12, padding:'12px 20px', fontSize:14, fontWeight:700, cursor:loading||!inp.trim()?'default':'pointer' }}>Enviar</button>
      </div>
      <style>{`@keyframes dots{0%,100%{opacity:.2;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}`}</style>
    </div>
  )
}

// ── Mi Drive ──────────────────────────────────────────────────────
function MiDrive({ user, folders, loading, onRefresh, onAnalyze }) {
  const [sel, setSel] = useState(null)
  const [reading, setReading] = useState(null)
  const activeF = folders.find(f=>f.id===sel)
  const canRead = (m) => m.includes('spreadsheet')||m.includes('document')||m.includes('text')||m.includes('csv')
  const readAndAnalyze = async (file) => {
    setReading(file.id)
    try { const text = await driveReadContent(user.token, file); onAnalyze(text, file.name) }
    catch(e) { alert('Error al leer: '+e.message) }
    setReading(null)
  }
  return (
    <div style={{ padding:'32px', maxWidth:900 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div><h1 style={{ margin:0, fontSize:24, fontWeight:800, color:C.text }}>Mi Drive ☁️</h1><p style={{ margin:'4px 0 0', fontSize:14, color:C.sub }}>Archivos en tu Google Drive</p></div>
        <div style={{ display:'flex', gap:10 }}>
          <a href="https://drive.google.com" target="_blank" rel="noreferrer" style={{ background:C.white, color:C.teal, border:`1px solid ${C.teal}`, borderRadius:10, padding:'9px 16px', fontSize:13, fontWeight:600, textDecoration:'none' }}>Abrir Drive →</a>
          <button onClick={onRefresh} disabled={loading} style={{ background:C.teal, color:'#fff', border:'none', borderRadius:10, padding:'10px 16px', fontSize:13, fontWeight:600, cursor:'pointer' }}>↻ Actualizar</button>
        </div>
      </div>
      <div style={{ background:C.goldL, borderRadius:14, padding:'14px 18px', marginBottom:20, border:`1px solid ${C.gold}33`, display:'flex', gap:12 }}>
        <span style={{ fontSize:20 }}>💡</span>
        <div style={{ fontSize:13, color:C.text, lineHeight:1.6 }}><strong>¿Cómo agregar archivos?</strong> Abre Google Drive → carpeta <strong>DentaIQ</strong> → sube tus boletas, planillas o facturas. También desde el celular con una foto.</div>
      </div>
      {loading && <div style={{ textAlign:'center', padding:40, color:C.sub }}>Cargando archivos...</div>}
      {!loading && <>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12, marginBottom:20 }}>
          {folders.map(f => (
            <button key={f.id} onClick={()=>setSel(sel===f.id?null:f.id)} style={{ background:sel===f.id?C.tealL:C.white, border:`2px solid ${sel===f.id?C.teal:C.border}`, borderRadius:14, padding:'16px 10px', textAlign:'center', cursor:'pointer', boxShadow:`0 1px 4px ${C.shadow}` }}>
              <div style={{ fontSize:28, marginBottom:6 }}>{f.emoji}</div>
              <div style={{ fontSize:13, color:sel===f.id?C.tealD:C.text, fontWeight:600, marginBottom:3 }}>{f.name}</div>
              <div style={{ fontSize:11, color:f.files.length>0?C.teal:C.light }}>{f.files.length>0?`${f.files.length} archivo${f.files.length>1?'s':''}`:'Vacía'}</div>
            </button>
          ))}
        </div>
        {activeF && (
          <div style={{ background:C.white, borderRadius:16, border:`1px solid ${C.border}`, overflow:'hidden', boxShadow:`0 1px 6px ${C.shadow}` }}>
            <div style={{ padding:'14px 20px', borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between' }}>
              <span style={{ fontSize:15, fontWeight:700, color:C.text }}>{activeF.emoji} {activeF.name}</span>
              <span style={{ fontSize:12, color:C.sub }}>{activeF.files.length} archivos</span>
            </div>
            {activeF.files.length===0
              ? <div style={{ padding:'32px', textAlign:'center' }}><div style={{ fontSize:32, marginBottom:8 }}>📂</div><div style={{ fontSize:14, color:C.sub }}>Carpeta vacía. Sube archivos desde Google Drive.</div></div>
              : activeF.files.map((f,i) => (
                <div key={f.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 20px', borderBottom:i<activeF.files.length-1?`1px solid ${C.border}`:'none' }}>
                  <span style={{ fontSize:22 }}>{f.mimeType.includes('spreadsheet')?'📊':f.mimeType.includes('document')?'📝':f.mimeType.includes('pdf')?'📕':'📄'}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color:C.text, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.name}</div>
                    {f.modifiedTime && <div style={{ fontSize:11, color:C.sub, marginTop:1 }}>{new Date(f.modifiedTime).toLocaleDateString('es-CL')}</div>}
                  </div>
                  {canRead(f.mimeType) && <button onClick={()=>readAndAnalyze(f)} disabled={reading===f.id} style={{ background:C.tealL, color:C.tealD, border:`1px solid ${C.teal}33`, borderRadius:8, padding:'6px 14px', fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap' }}>{reading===f.id?'Analizando...':'🤖 Analizar con IA'}</button>}
                </div>
              ))
            }
          </div>
        )}
      </>}
    </div>
  )
}

// ── App raíz ──────────────────────────────────────────────────────
const NAV = [
  { id:'inicio', label:'Inicio', icon:'🏠' },
  { id:'numeros', label:'Mis Números', icon:'📊' },
  { id:'ia', label:'Consejero IA', icon:'🤖' },
  { id:'drive', label:'Mi Drive', icon:'☁️' },
]

export default function App() {
  const [user, setUser] = useState(null)
  const [onboarded, setOnboarded] = useState(false)
  const [tab, setTab] = useState('inicio')
  const [txs, setTxs] = useState([])
  const [folders, setFolders] = useState([])
  const [driveLoading, setDriveLoading] = useState(false)
  const [aiSummary, setAiSummary] = useState('')
  const [loadingAI, setLoadingAI] = useState(false)

  const loadDrive = useCallback(async (token) => {
    if (token === 'demo') { setFolders([]); return }
    setDriveLoading(true)
    try { const f = await setupDrive(token); setFolders(f) } catch(e) { console.error(e) }
    setDriveLoading(false)
  }, [])

  const generateSummary = useCallback(async (currentTxs, currentFolders, userName) => {
    setLoadingAI(true)
    const ing = currentTxs.filter(t=>t.tipo==='I').reduce((s,t)=>s+t.monto,0)
    const gas = currentTxs.filter(t=>t.tipo==='G').reduce((s,t)=>s+t.monto,0)
    const totalFiles = currentFolders.reduce((s,f)=>s+f.files.length,0)
    try {
      const summary = await askAI([{ role:'user', content:'Dame un resumen financiero breve.' }],
        `Eres consejero de ${userName}, dentista chileno/a. Ingresos ${clp(ing)}, Gastos ${clp(gas)}, Balance ${clp(ing-gas)}. Archivos en Drive: ${totalFiles}. Máx 3 oraciones simples, un consejo concreto.`)
      setAiSummary(summary)
    } catch {}
    setLoadingAI(false)
  }, [])

  const handleLogin = async (u) => {
    setUser(u)
    await loadDrive(u.token)
    const seen = localStorage.getItem(`dentaiq_onboarded_${u.email}`)
    setOnboarded(!!seen)
    if (seen) generateSummary([], [], u.name)
  }

  const handleOnboardingDone = () => {
    if (user) localStorage.setItem(`dentaiq_onboarded_${user.email}`, '1')
    setOnboarded(true)
    generateSummary(txs, folders, user?.name || '')
  }

  const handleAnalyzeFile = useCallback((content, fileName) => { setTab('ia') }, [])

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

      <div style={{ width:220, flexShrink:0, background:C.white, borderRight:`1px solid ${C.border}`, display:'flex', flexDirection:'column', boxShadow:`1px 0 4px ${C.shadow}` }}>
        <div style={{ padding:'22px 20px 18px', borderBottom:`1px solid ${C.border}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>🦷</div>
            <div><div style={{ fontSize:16, fontWeight:800, color:C.text }}>DentaIQ</div><div style={{ fontSize:10, color:C.sub }}>Tu gerente financiero</div></div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:C.bg, borderRadius:10, border:`1px solid ${C.border}` }}>
            {user.picture ? <img src={user.picture} style={{ width:26, height:26, borderRadius:'50%' }}/> : <div style={{ width:26, height:26, borderRadius:'50%', background:C.teal, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'#fff', fontWeight:700 }}>{user.name[0]}</div>}
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:12, color:C.text, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.name.split(' ')[0]}</div>
              <div style={{ fontSize:10, color:C.sub, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.email}</div>
            </div>
          </div>
        </div>

        <div style={{ flex:1, padding:'12px 10px', display:'flex', flexDirection:'column', gap:4 }}>
          {NAV.map(item => {
            const active = tab===item.id
            return (
              <button key={item.id} onClick={()=>setTab(item.id)} style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 12px', borderRadius:10, background:active?C.tealL:'transparent', border:active?`1px solid ${C.teal}33`:'1px solid transparent', color:active?C.tealD:C.sub, cursor:'pointer', fontSize:14, fontWeight:active?700:400, textAlign:'left' }}>
                <span style={{ fontSize:18 }}>{item.icon}</span>
                {item.label}
                {item.id==='drive' && totalFiles>0 && <span style={{ marginLeft:'auto', background:C.teal, color:'#fff', borderRadius:20, padding:'1px 7px', fontSize:10, fontWeight:700 }}>{totalFiles}</span>}
                {item.id==='ia' && <span style={{ marginLeft:'auto', background:C.greenL, color:C.green, borderRadius:20, padding:'1px 7px', fontSize:10, fontWeight:700 }}>ON</span>}
              </button>
            )
          })}
        </div>

        <div style={{ padding:'14px 16px', borderTop:`1px solid ${C.border}` }}>
          <button onClick={()=>setUser(null)} style={{ width:'100%', background:'transparent', color:C.sub, border:`1px solid ${C.border}`, borderRadius:8, padding:'7px', fontSize:12, cursor:'pointer' }}>Cerrar sesión</button>
        </div>
      </div>

      <div style={{ flex:1, overflowY:'auto' }}>
        {tab==='inicio' && <Dashboard user={user} txs={txs} folders={folders} aiSummary={aiSummary} loadingAI={loadingAI}/>}
        {tab==='numeros' && <MisNumeros txs={txs} setTxs={setTxs}/>}
        {tab==='ia' && <Consejero user={user} txs={txs} folders={folders}/>}
        {tab==='drive' && <MiDrive user={user} folders={folders} loading={driveLoading} onRefresh={()=>user&&loadDrive(user.token)} onAnalyze={handleAnalyzeFile}/>}
      </div>
    </div>
  )
}