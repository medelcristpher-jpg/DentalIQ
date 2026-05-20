// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'

const GOOGLE_CLIENT_ID = '33863186131-3rgcbifmp7sjkacuhqinr41nkbca7v09.apps.googleusercontent.com'
const AI_MODEL = 'llama-3.3-70b-versatile'
const AI_API_KEY = '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'
const SCOPES = ['https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile'].join(' ')
const SESSION_KEY = 'dentaiq_v7'

const C = {
  bg:'#F8F7F4',border:'rgba(0,0,0,0.08)',
  teal:'#007A6B',tealL:'#E6F4F2',tealD:'#005549',
  gold:'#D97706',goldL:'#FEF3C7',
  red:'#DC2626',redL:'#FEE2E2',
  blue:'#1D4ED8',blueL:'#DBEAFE',
  text:'#111827',sub:'#6B7280',light:'#9CA3AF',
  green:'#059669',greenL:'#D1FAE5',
  white:'#FFFFFF',shadow:'rgba(0,0,0,0.06)',
  orange:'#EA580C',orangeL:'#FFF7ED',
}

const fmt = n => {
  if (!n || isNaN(n)) return '$0'
  const v = Math.abs(Number(n))
  const sign = Number(n) < 0 ? '-' : ''
  if (v >= 1e9) return `${sign}$${(v/1e9).toFixed(1)}B`
  if (v >= 1e6) return `${sign}$${(v/1e6).toFixed(1)}M`
  if (v >= 1e3) return `${sign}$${Math.round(v/1e3).toLocaleString('es-CL')}K`
  return `${sign}$${Math.round(v).toLocaleString('es-CL')}`
}

// ── SESIÓN ────────────────────────────────────────────────────────
const saveSession = u => { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ user:u, at:Date.now() })) } catch {} }
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY) } catch {} }
const loadSession = () => {
  try {
    const d = JSON.parse(localStorage.getItem(SESSION_KEY))
    if (!d) return null
    return { user: d.user, expired: (Date.now() - d.at) / 60000 >= 50 }
  } catch { return null }
}

// ── GOOGLE AUTH ───────────────────────────────────────────────────
const loadGIS = () => new Promise(r => {
  if (window.google?.accounts) { r(); return }
  const s = document.createElement('script')
  s.src = 'https://accounts.google.com/gsi/client'
  s.onload = () => r()
  document.head.appendChild(s)
})

async function signIn(hint) {
  await loadGIS()
  return new Promise((resolve, reject) => {
    const c = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: SCOPES, hint: hint || '',
      callback: async r => {
        if (!r.access_token) { reject(new Error('Sin token')); return }
        try {
          const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${r.access_token}` } }).then(x => x.json())
          resolve({ email: u.email, name: u.name || u.email, picture: u.picture || '', token: r.access_token })
        } catch(e) { reject(e) }
      },
      error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'Cerraste la ventana' : 'Error de autenticación'))
    })
    c.requestAccessToken()
  })
}

// ── XLSX desde CDN (para leer archivos .xlsx de Drive) ────────────
let xlsxLib = null
async function getXLSX() {
  if (xlsxLib) return xlsxLib
  if (window.XLSX) { xlsxLib = window.XLSX; return xlsxLib }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    s.onload = () => { xlsxLib = window.XLSX; resolve(xlsxLib) }
    s.onerror = reject
    document.head.appendChild(s)
  })
}

// ── DRIVE API ─────────────────────────────────────────────────────
const authH = t => ({ Authorization: `Bearer ${t}` })

async function driveFind(t, q) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=10`, { headers: authH(t) })
  return (await r.json()).files || []
}

async function driveCreate(t, body) {
  return fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { ...authH(t), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
}

async function driveListFiles(t, parentId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`, { headers: authH(t) })
  return (await r.json()).files || []
}

async function driveListFolders(t, parentId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name,mimeType)&pageSize=20`, { headers: authH(t) })
  return (await r.json()).files || []
}

// ── LEER ARCHIVO — soporta Google Sheets Y .xlsx ──────────────────
async function readFileAsCSV(token, file) {
  const mime = file.mimeType || ''

  if (mime === 'application/vnd.google-apps.spreadsheet') {
    // Google Sheets → exportar como CSV
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`, { headers: authH(token) })
    if (!r.ok) throw new Error(`Export error ${r.status}`)
    return await r.text()
  }

  if (mime.includes('spreadsheetml') || mime.includes('excel') || mime.includes('xlsx') || file.name?.endsWith('.xlsx') || file.name?.endsWith('.xls')) {
    // Archivo Excel → descargar como binario y parsear con SheetJS
    const XLSX = await getXLSX()
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: authH(token) })
    if (!r.ok) throw new Error(`Download error ${r.status}`)
    const buf = await r.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_csv(ws)
  }

  if (mime.includes('document')) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`, { headers: authH(token) })
    return await r.text()
  }

  throw new Error('Formato no soportado: ' + mime)
}

// ── PARSEAR MONTO (CLP o USD) ─────────────────────────────────────
function parseMonto(str) {
  if (!str) return 0
  // Limpiar: quitar $, espacios, comillas
  const clean = String(str).replace(/[$"\s]/g, '').trim()
  // Formato CLP: "47,648" → 47648
  // Formato USD: "35.00" → 35.00
  const hasDot = clean.includes('.')
  const hasComma = clean.includes(',')

  let num
  if (hasDot && hasComma) {
    // Ambos: determinar cuál es decimal
    const lastComma = clean.lastIndexOf(',')
    const lastDot = clean.lastIndexOf('.')
    if (lastDot > lastComma) {
      // Formato USD: 1,234.56
      num = parseFloat(clean.replace(/,/g, ''))
    } else {
      // Formato CLP europeo: 1.234,56
      num = parseFloat(clean.replace(/\./g, '').replace(',', '.'))
    }
  } else if (hasComma && !hasDot) {
    // CLP sin decimales: 47,648 → 47648
    num = parseFloat(clean.replace(/,/g, ''))
  } else {
    num = parseFloat(clean)
  }

  return isNaN(num) ? 0 : num
}

// ── ANALIZAR CSV Y EXTRAER FINANCIEROS ────────────────────────────
function analizarCSV(csv, nombreArchivo, nombreCarpeta) {
  const lines = csv.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^,+$/))
  if (lines.length < 2) return null

  const nombreLower = (nombreArchivo + ' ' + nombreCarpeta).toLowerCase()
  const esIngreso = nombreLower.includes('ingreso')
  const esGasto = nombreLower.includes('gasto') || nombreLower.includes('mayo') || nombreLower.includes('abril') || nombreLower.includes('junio')

  // Encontrar fila de headers
  let headerIdx = 0
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const l = lines[i].toLowerCase()
    if (l.includes('fecha') || l.includes('monto') || l.includes('total') || l.includes('nombre') || l.includes('rut')) {
      headerIdx = i; break
    }
  }

  const headers = lines[headerIdx].split(',').map(h => h.replace(/"/g, '').toLowerCase().trim())

  // Encontrar columnas de montos
  const montoIdxs = []
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h.includes('monto') || h.includes('total') || h.includes('efectivo') ||
        h.includes('transferencia') || h.includes('tarjeta') || h.includes('precio') ||
        h.includes('cantidad a pagar') || h.includes('descripción') && false) {
      montoIdxs.push(i)
    }
  }

  let totalMonto = 0
  let filas = 0
  const categorias = {}
  const detalles = []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    // Parsear CSV con comillas
    const cols = []
    let cur = '', inQ = false
    for (const ch of line + ',') {
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = '' }
      else { cur += ch }
    }

    if (cols.every(c => !c)) continue
    filas++

    // Sumar montos de las columnas identificadas
    let montoFila = 0
    if (montoIdxs.length > 0) {
      for (const idx of montoIdxs) {
        const v = parseMonto(cols[idx])
        if (v > 0) { montoFila = v; break }
      }
    } else {
      // Sin headers de monto: buscar cualquier columna con $ o número grande
      for (const col of cols) {
        if (col.includes('$') || /^\s*[\d,.]+\s*$/.test(col)) {
          const v = parseMonto(col)
          if (v > 100) { montoFila = v; break } // > 100 para evitar columnas de cuotas
        }
      }
    }

    // Si el monto parece USD (< 1000) y es ingreso, convertir a CLP
    if (esIngreso && montoFila > 0 && montoFila < 1000) {
      montoFila = montoFila * 930 // USD → CLP aprox
    }

    totalMonto += montoFila

    // Categoría o descripción
    const descIdx = headers.findIndex(h => h.includes('descripción') || h.includes('descripcion') || h.includes('procedimiento') || h.includes('servicio'))
    if (descIdx >= 0 && cols[descIdx]) {
      const cat = cols[descIdx].slice(0, 40)
      categorias[cat] = (categorias[cat] || 0) + 1
    }

    // Guardar primeras filas para contexto
    if (detalles.length < 8) {
      detalles.push(cols.slice(0, 8).join(' | '))
    }
  }

  const topCats = Object.entries(categorias).sort((a,b) => b[1]-a[1]).slice(0, 4).map(([k,v]) => `${k.slice(0,30)} (${v}x)`)

  const resumen = `
📄 ${nombreArchivo} [${nombreCarpeta}]
  Tipo: ${esIngreso ? 'INGRESOS' : esGasto ? 'GASTOS' : 'DATOS'}
  Registros: ${filas}
  Total ${esIngreso?'ingresos':'gastos'}: $${Math.round(totalMonto).toLocaleString('es-CL')} CLP
  ${topCats.length > 0 ? 'Top categorías: ' + topCats.join(', ') : ''}
  Muestra de datos:
  ${detalles.slice(0, 5).join('\n  ')}
`

  return { resumen, totalMonto, esIngreso, esGasto, filas }
}

async function getOrCreate(t, name, parentId) {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`
  const ex = await driveFind(t, q); if (ex.length) return ex[0].id
  const body = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]
  return (await driveCreate(t, body)).id
}

async function createSheetIfNotExists(t, name, parentId, rows) {
  const ex = await driveFind(t, `name='${name}' and '${parentId}' in parents and trashed=false`); if (ex.length) return ex[0].id
  const file = await driveCreate(t, { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [parentId] }); if (!file.id) return null
  try { await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/A1?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { ...authH(t), 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows, majorDimension: 'ROWS' }) }) } catch {}
  return file.id
}

async function appendRowToSheet(token, fileId, values) {
  try { await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { ...authH(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values], majorDimension: 'ROWS' }) }); return true } catch { return false }
}

async function findOrCreateMonthSheet(token, folderId, tipo) {
  const now = new Date(), mes = now.toLocaleDateString('es-CL', { month: 'long' }), año = now.getFullYear(), name = `${tipo} ${mes} ${año}`
  const ex = await driveFind(token, `name='${name}' and '${folderId}' in parents and trashed=false`); if (ex.length) return ex[0].id
  const headers = tipo === 'Ingresos' ? ['Fecha', 'Nombre Paciente', 'Servicio', 'Monto (CLP)', 'Método de Pago', 'Notas'] : ['Fecha', 'Descripción', 'Categoría', 'Monto (CLP)', 'Proveedor', 'Notas']
  return await createSheetIfNotExists(token, name, folderId, [headers])
}

const folderEmoji = name => { const n = name.toLowerCase(); if (n.includes('ingreso')) return '💰'; if (n.includes('gasto')) return '💳'; if (n.includes('factura')) return '🧾'; if (n.includes('proveedor') || n.includes('inventario')) return '📦'; if (n.includes('reporte')) return '📊'; return '📁' }

// ── SETUP DRIVE ───────────────────────────────────────────────────
async function setupDrive(t) {
  const rootId = await getOrCreate(t, 'DentaIQ')
  const now = new Date(), mes = now.toLocaleDateString('es-CL', { month: 'long' }), año = now.getFullYear(), hoy = now.toLocaleDateString('es-CL')
  const ingId = await getOrCreate(t, 'Ingresos', rootId)
  const gasId = await getOrCreate(t, 'Gastos', rootId)
  const ingFiles = await driveListFiles(t, ingId)
  if (ingFiles.length === 0) await createSheetIfNotExists(t, `Ingresos ${mes} ${año}`, ingId, [['Fecha', 'Nombre Paciente', 'Servicio', 'Monto (CLP)', 'Método de Pago', 'Notas'], [hoy, 'Ejemplo Paciente', 'Limpieza dental', '35000', 'Efectivo', '']])
  const gasFiles = await driveListFiles(t, gasId)
  if (gasFiles.length === 0) await createSheetIfNotExists(t, `Gastos ${mes} ${año}`, gasId, [['Fecha', 'Descripción', 'Categoría', 'Monto (CLP)', 'Proveedor', 'Notas'], [hoy, 'Insumos dentales', 'Insumos', '245000', '3M Chile', '']])
  const subFolders = await driveListFolders(t, rootId)
  const allFolders = []
  for (const sf of subFolders) {
    const files = await driveListFiles(t, sf.id)
    allFolders.push({ id: sf.id, name: sf.name, emoji: folderEmoji(sf.name), files })
  }
  return { allFolders, folderIds: { ingresos: ingId, gastos: gasId }, rootId }
}

// ── PROCESAR DATOS FINANCIEROS DESDE DRIVE ────────────────────────
async function procesarDrive(token, allFolders, onProgress) {
  let totalIngresos = 0, totalGastos = 0, rawContext = '', filesRead = 0

  for (const folder of allFolders) {
    for (const file of folder.files.slice(0, 3)) {
      const mime = file.mimeType || ''
      const isReadable = mime.includes('spreadsheet') || mime.includes('sheet') || mime.includes('xlsx') || mime.includes('excel') || file.name?.endsWith('.xlsx')
      if (!isReadable) continue
      try {
        onProgress?.(`Leyendo ${file.name}...`)
        const csv = await readFileAsCSV(token, file)
        const analisis = analizarCSV(csv, file.name, folder.name)
        if (analisis && analisis.filas > 0) {
          rawContext += analisis.resumen
          if (analisis.esIngreso) totalIngresos += analisis.totalMonto
          if (analisis.esGasto) totalGastos += analisis.totalMonto
          filesRead++
        }
      } catch(e) {
        console.warn(`No se pudo leer ${file.name}:`, e.message)
        rawContext += `\n[${folder.name}/${file.name}: no se pudo leer - ${e.message}]\n`
      }
    }
  }

  return { totalIngresos, totalGastos, rawContext, filesRead }
}

// ── IA ────────────────────────────────────────────────────────────
async function askAI(msgs, system) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, ...msgs] })
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error.message)
  return d.choices?.[0]?.message?.content || ''
}

// ── PARSEAR PROVEEDORES ────────────────────────────────────────────
function parseProvRow(line) {
  const cols = []; let cur = '', inQ = false
  for (const ch of line + ',') {
    if (ch === '"') inQ = !inQ
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = '' }
    else cur += ch
  }
  if (cols.length < 14) return null
  const total = cols[cols.length - 1], estado = cols[cols.length - 2], iva = cols[cols.length - 3], precio = cols[cols.length - 4], cantidad = cols[cols.length - 5]
  const articulo = cols.slice(13, cols.length - 5).join(' ').trim()
  return { empresa: cols[1] || '', direccion: cols[2] || '', rut: cols[4] || '', contacto: cols[5] || '', telefono: cols[10] || '', factura: cols[11] || '', fecha: cols[12] || '', articulo, cantidad, precio, iva, estado, total }
}

function parseProvCSV(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(l => l)
  const rows = []; let start = 0
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const n = lines[i].toLowerCase()
    if (n.includes('empresa') || n.includes('factura') || n.includes('articulo') || n.startsWith('código')) { start = i + 1; break }
    if (lines[i].startsWith('📌')) start = i + 1
  }
  for (let i = start; i < lines.length; i++) {
    const r = parseProvRow(lines[i]); if (r?.articulo || r?.empresa) rows.push(r)
  }
  return rows
}

// ── COMPONENTS ────────────────────────────────────────────────────

function Welcome({ onLogin }) {
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const login = async () => { setLoading(true); setError(''); try { const u = await signIn(); onLogin(u, true) } catch(e) { setError(e.message) }; setLoading(false) }
  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'inherit' }}>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{ width: 60, height: 60, borderRadius: 18, background: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 14px', boxShadow: '0 4px 20px rgba(0,122,107,0.3)' }}>🦷</div>
        <h1 style={{ margin: '0 0 6px', fontSize: 28, fontWeight: 800, color: C.text }}>DentaIQ</h1>
        <p style={{ margin: 0, fontSize: 14, color: C.sub }}>Tu gerente financiero inteligente</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 28, maxWidth: 600, width: '100%' }}>
        {[['📊', 'Datos reales de Drive', 'Lee tus planillas (.xlsx y Google Sheets) y muestra ingresos, gastos y balance real.'], ['🔍', 'Buscador de proveedores', 'Busca insumos, compara precios entre proveedores al instante.'], ['🔄', 'Sync automático', 'Lo que agregas en DentaIQ se guarda en Drive automáticamente.']].map(([i, t, d]) => (
          <div key={t} style={{ background: C.white, borderRadius: 13, padding: 16, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>{i}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t}</div>
            <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.5 }}>{d}</div>
          </div>
        ))}
      </div>
      <div style={{ background: C.white, borderRadius: 16, padding: '24px 28px', border: `1px solid ${C.border}`, boxShadow: `0 2px 12px ${C.shadow}`, width: '100%', maxWidth: 340, textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3 }}>Empieza gratis</div>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 16 }}>Sesión recordada por 50 minutos</div>
        <button onClick={login} disabled={loading} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: C.white, color: '#3c4043', border: '1.5px solid #dadce0', borderRadius: 10, padding: '12px', fontSize: 13, fontWeight: 500, cursor: 'pointer', marginBottom: 9, opacity: loading ? 0.7 : 1 }}>
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          {loading ? 'Conectando...' : 'Continuar con Google'}
        </button>
        <button onClick={() => onLogin({ email: 'demo@dentaiq.cl', name: 'Dr. Demo', picture: '', token: 'demo' }, false)} style={{ width: '100%', background: C.teal, color: '#fff', border: 'none', borderRadius: 10, padding: '12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>🚀 Ver demo</button>
        {error && <div style={{ padding: '8px', background: C.redL, borderRadius: 7, fontSize: 12, color: C.red, marginBottom: 8 }}>{error}</div>}
        <p style={{ margin: 0, fontSize: 10, color: C.light }}>Lee .xlsx y Google Sheets · Solo carpeta DentaIQ</p>
      </div>
    </div>
  )
}

function Reconnecting({ savedUser, onLogin, onLogout }) {
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const reconnect = async () => { setLoading(true); setError(''); try { const u = await signIn(savedUser.email); onLogin(u, true) } catch(e) { setError(e.message); setLoading(false) } }
  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>
      <div style={{ background: C.white, borderRadius: 16, padding: 32, maxWidth: 320, width: '100%', textAlign: 'center', border: `1px solid ${C.border}`, boxShadow: `0 4px 20px ${C.shadow}` }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🦷</div>
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: C.text }}>Bienvenido de vuelta</h2>
        <p style={{ fontSize: 12, color: C.sub, marginBottom: 18 }}>Un clic para reconectar.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: C.bg, borderRadius: 8, marginBottom: 16, border: `1px solid ${C.border}` }}>
          {savedUser.picture ? <img src={savedUser.picture} style={{ width: 28, height: 28, borderRadius: '50%' }} /> : <div style={{ width: 28, height: 28, borderRadius: '50%', background: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700 }}>{savedUser.name[0]}</div>}
          <div style={{ textAlign: 'left' }}><div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{savedUser.name}</div><div style={{ fontSize: 10, color: C.sub }}>{savedUser.email}</div></div>
        </div>
        <button onClick={reconnect} disabled={loading} style={{ width: '100%', background: C.teal, color: '#fff', border: 'none', borderRadius: 10, padding: '12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 9, opacity: loading ? 0.7 : 1 }}>{loading ? '⏳ Reconectando...' : '🔄 Reconectar'}</button>
        {error && <div style={{ padding: '7px', background: C.redL, borderRadius: 7, fontSize: 11, color: C.red, marginBottom: 8 }}>{error}</div>}
        <button onClick={onLogout} style={{ background: 'none', border: 'none', color: C.sub, fontSize: 11, cursor: 'pointer' }}>Usar otra cuenta</button>
      </div>
    </div>
  )
}

function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0)
  const steps = [
    { icon: '👋', title: `Hola ${user.name.split(' ')[0]}`, desc: 'DentaIQ lee tus planillas de Drive automáticamente, incluyendo archivos .xlsx y Google Sheets.' },
    { icon: '📊', title: 'Datos reales en el Dashboard', desc: 'Los ingresos y gastos se extraen directamente de tus archivos. El Dashboard muestra tus cifras reales.' },
    { icon: '🔄', title: 'Sync bidireccional', desc: 'Agrega transacciones en DentaIQ y se guardan en Drive. O edita tus planillas directamente.' },
    { icon: '🤖', title: 'IA con tus números', desc: 'El Consejero IA usa tus planillas reales para responder preguntas sobre tus finanzas.' },
  ]
  const s = steps[step]
  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: C.white, borderRadius: 20, padding: '40px 32px', maxWidth: 440, width: '100%', textAlign: 'center', border: `1px solid ${C.border}`, boxShadow: `0 4px 24px ${C.shadow}` }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{s.icon}</div>
        <h2 style={{ margin: '0 0 10px', fontSize: 20, fontWeight: 800, color: C.text }}>{s.title}</h2>
        <p style={{ margin: '0 0 26px', fontSize: 14, color: C.sub, lineHeight: 1.7 }}>{s.desc}</p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 7, marginBottom: 22 }}>{steps.map((_, i) => <div key={i} style={{ width: i === step ? 20 : 7, height: 7, borderRadius: 4, background: i === step ? C.teal : C.border, transition: 'all 0.2s' }} />)}</div>
        <button onClick={() => step < steps.length - 1 ? setStep(s => s + 1) : onDone()} style={{ width: '100%', background: C.teal, color: '#fff', border: 'none', borderRadius: 10, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>{step < steps.length - 1 ? 'Siguiente →' : '¡Empezar!'}</button>
        {step > 0 && <button onClick={() => setStep(s => s - 1)} style={{ marginTop: 8, background: 'none', border: 'none', color: C.sub, fontSize: 12, cursor: 'pointer' }}>← Volver</button>}
      </div>
    </div>
  )
}

// ── DASHBOARD — muestra valores reales de Drive ───────────────────
function Dashboard({ user, txs, allFolders, driveData }) {
  const manualIng = txs.filter(t => t.tipo === 'I').reduce((s, t) => s + t.monto, 0)
  const manualGas = txs.filter(t => t.tipo === 'G').reduce((s, t) => s + t.monto, 0)

  // Combinar datos manuales + datos de Drive
  const totalIng = manualIng + (driveData.totalIngresos || 0)
  const totalGas = manualGas + (driveData.totalGastos || 0)
  const balance = totalIng - totalGas
  const pct = totalIng > 0 ? (balance / totalIng) * 100 : 0
  const hasData = totalIng > 0 || totalGas > 0

  const statusText = driveData.loading ? '⏳ Analizando tus planillas...'
    : driveData.loaded ? `✅ ${driveData.filesRead} archivo${driveData.filesRead !== 1 ? 's' : ''} analizados`
    : allFolders.some(f => f.files.length > 0) ? '⏳ Cargando datos...' : '📂 Agrega archivos a tus carpetas en Drive'

  return (
    <div style={{ padding: '24px 28px', maxWidth: 940 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Hola, {user.name.split(' ')[0]} 👋</h1>
        <p style={{ margin: '3px 0 0', fontSize: 12, color: C.sub }}>{new Date().toLocaleDateString('es-CL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>

      {/* Estado del negocio */}
      <div style={{ background: !hasData ? C.tealL : balance >= 0 ? C.tealL : C.redL, borderRadius: 16, padding: '16px 20px', marginBottom: 16, border: `1px solid ${!hasData ? C.teal + '44' : balance >= 0 ? C.teal + '44' : C.red + '44'}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ fontSize: 26 }}>{!hasData ? '📂' : balance >= 0 ? '✅' : '⚠️'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: !hasData ? C.tealD : balance >= 0 ? C.tealD : C.red }}>
              {!hasData ? statusText : `Tu clínica está ${balance >= 0 ? 'ganando dinero' : 'en pérdida'} este mes`}
            </div>
            {hasData && <div style={{ fontSize: 12, color: balance >= 0 ? C.teal : C.red }}>
              Margen: {pct.toFixed(1)}% — {pct > 40 ? 'excelente 🌟' : pct > 25 ? 'bien' : 'necesita atención'}
            </div>}
            {driveData.loading && <div style={{ fontSize: 11, color: C.sub, marginTop: 3 }}>Leyendo tus archivos de Drive (puede tomar 10-20 seg)...</div>}
          </div>
        </div>
      </div>

      {/* KPIs con datos reales */}
      {(hasData || driveData.loading) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
          {[
            { label: 'Total Ingresos', value: fmt(totalIng), sub: driveData.totalIngresos > 0 ? `Drive: ${fmt(driveData.totalIngresos)}` : 'Sin datos Drive', icon: '📈', c: C.green, bg: C.greenL },
            { label: 'Total Gastos', value: fmt(totalGas), sub: driveData.totalGastos > 0 ? `Drive: ${fmt(driveData.totalGastos)}` : 'Sin datos Drive', icon: '📉', c: C.red, bg: C.redL },
            { label: 'Balance', value: fmt(balance), sub: `Margen ${pct.toFixed(1)}%`, icon: balance >= 0 ? '💰' : '🚨', c: balance >= 0 ? C.teal : C.red, bg: balance >= 0 ? C.tealL : C.redL },
          ].map(k => (
            <div key={k.label} style={{ background: k.bg, borderRadius: 13, padding: '14px 16px', border: `1px solid ${k.c}33` }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>{k.icon}</div>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 2 }}>{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: k.c }}>{driveData.loading ? '...' : k.value}</div>
              {k.sub && <div style={{ fontSize: 10, color: C.sub, marginTop: 3 }}>{k.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Nota si hay datos manuales Y Drive */}
      {manualIng + manualGas > 0 && driveData.totalIngresos + driveData.totalGastos > 0 && (
        <div style={{ background: C.goldL, borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: C.text, border: `1px solid ${C.gold}33` }}>
          💡 Los totales incluyen datos manuales ({fmt(manualIng)} ingresos, {fmt(manualGas)} gastos) + datos de Drive
        </div>
      )}

      {/* Carpetas */}
      <div style={{ background: C.white, borderRadius: 14, padding: '14px 18px', border: `1px solid ${C.border}`, boxShadow: `0 1px 6px ${C.shadow}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 11 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>☁️ Carpetas en DentaIQ Drive</div>
          <div style={{ fontSize: 11, color: driveData.loaded ? C.green : C.sub }}>{statusText}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(allFolders.length || 2, 5)}, 1fr)`, gap: 8 }}>
          {allFolders.map(f => (
            <div key={f.id} style={{ textAlign: 'center', padding: '10px 7px', background: C.bg, borderRadius: 10, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 20, marginBottom: 3 }}>{f.emoji}</div>
              <div style={{ fontSize: 10, color: C.text, fontWeight: 500, marginBottom: 2 }}>{f.name}</div>
              <div style={{ fontSize: 10, color: f.files.length > 0 ? C.teal : C.light }}>{f.files.length > 0 ? `${f.files.length} archivos` : 'Vacía'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── MIS NÚMEROS ───────────────────────────────────────────────────
function MisNumeros({ txs, setTxs, user, folderIds }) {
  const [form, setForm] = useState({ tipo: 'I', desc: '', cat: 'Servicios dentales', monto: '', metodo: 'Transferencia' })
  const [open, setOpen] = useState(false), [syncMsg, setSyncMsg] = useState('')
  const ing = txs.filter(t => t.tipo === 'I').reduce((s, t) => s + t.monto, 0)
  const gas = txs.filter(t => t.tipo === 'G').reduce((s, t) => s + t.monto, 0)
  const CATS_I = ['Servicios dentales', 'Ortodoncia', 'Implantes', 'Blanqueamiento', 'Convenios', 'Otros ingresos']
  const CATS_G = ['Insumos y materiales', 'Personal', 'Arriendo', 'Equipos', 'Servicios básicos', 'Publicidad', 'Contabilidad', 'Otros gastos']
  const METODOS = ['Transferencia', 'Efectivo', 'Tarjeta débito', 'Tarjeta crédito', 'Cheque']
  const inp = { width: '100%', background: C.bg, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '8px 11px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }

  const guardar = async () => {
    if (!form.desc.trim() || !form.monto) return
    const fecha = new Date().toLocaleDateString('es-CL')
    const tx = { id: Date.now(), tipo: form.tipo, desc: form.desc, cat: form.cat, monto: parseInt(form.monto), fecha, fuente: 'manual' }
    setTxs(p => [tx, ...p]); setForm({ tipo: 'I', desc: '', cat: 'Servicios dentales', monto: '', metodo: 'Transferencia' }); setOpen(false)
    if (user.token !== 'demo' && folderIds) {
      try {
        const fId = form.tipo === 'I' ? folderIds.ingresos : folderIds.gastos
        if (fId) {
          const sId = await findOrCreateMonthSheet(user.token, fId, form.tipo === 'I' ? 'Ingresos' : 'Gastos')
          if (sId) {
            const vals = form.tipo === 'I' ? [fecha, form.desc, form.cat, parseInt(form.monto), form.metodo, 'DentaIQ'] : [fecha, form.desc, form.cat, parseInt(form.monto), '', 'DentaIQ']
            await appendRowToSheet(user.token, sId, vals)
            setSyncMsg('✅ Guardado en Drive')
          }
        }
      } catch { setSyncMsg('⚠️ Solo guardado localmente') }
      setTimeout(() => setSyncMsg(''), 3000)
    }
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 860 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div><h1 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: C.text }}>Mis Números</h1><p style={{ margin: '3px 0 0', fontSize: 12, color: C.sub }}>Registra y sincroniza con Drive automáticamente</p></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {syncMsg && <span style={{ fontSize: 12, color: syncMsg.includes('✅') ? C.green : C.gold, fontWeight: 600 }}>{syncMsg}</span>}
          <button onClick={() => setOpen(!open)} style={{ background: C.teal, color: '#fff', border: 'none', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+ Agregar</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
        {[['Lo que entró', ing, C.green, C.greenL, '📈'], ['Lo que salió', gas, C.red, C.redL, '📉'], ['Balance', ing - gas, ing - gas >= 0 ? C.teal : C.red, ing - gas >= 0 ? C.tealL : C.redL, ing - gas >= 0 ? '✅' : '⚠️']].map(([l, v, c, bg, ico]) => (
          <div key={l} style={{ background: bg, borderRadius: 12, padding: '13px 15px', border: `1px solid ${c}33` }}>
            <div style={{ fontSize: 18, marginBottom: 5 }}>{ico}</div><div style={{ fontSize: 11, color: C.sub, marginBottom: 2 }}>{l}</div><div style={{ fontSize: 20, fontWeight: 800, color: c }}>{fmt(v)}</div>
          </div>
        ))}
      </div>
      {open && (
        <div style={{ background: C.white, borderRadius: 13, padding: 18, marginBottom: 12, border: `1px solid ${C.border}`, boxShadow: `0 2px 8px ${C.shadow}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 12 }}>¿Qué quieres registrar?</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 9, marginBottom: 9 }}>
            <div><label style={{ fontSize: 10, color: C.sub, display: 'block', marginBottom: 4, fontWeight: 600 }}>TIPO</label><div style={{ display: 'flex', gap: 5 }}>{[['I', '💰 Entró'], ['G', '💳 Salió']].map(([v, l]) => <button key={v} onClick={() => setForm({ ...form, tipo: v, cat: v === 'I' ? CATS_I[0] : CATS_G[0] })} style={{ flex: 1, padding: '7px 3px', borderRadius: 6, border: `2px solid ${form.tipo === v ? C.teal : C.border}`, background: form.tipo === v ? C.tealL : 'transparent', color: form.tipo === v ? C.tealD : C.sub, fontSize: 11, fontWeight: form.tipo === v ? 700 : 400, cursor: 'pointer' }}>{l}</button>)}</div></div>
            <div><label style={{ fontSize: 10, color: C.sub, display: 'block', marginBottom: 4, fontWeight: 600 }}>CATEGORÍA</label><select value={form.cat} onChange={e => setForm({ ...form, cat: e.target.value })} style={inp}>{(form.tipo === 'I' ? CATS_I : CATS_G).map(o => <option key={o}>{o}</option>)}</select></div>
            {form.tipo === 'I' && <div><label style={{ fontSize: 10, color: C.sub, display: 'block', marginBottom: 4, fontWeight: 600 }}>MÉTODO</label><select value={form.metodo} onChange={e => setForm({ ...form, metodo: e.target.value })} style={inp}>{METODOS.map(o => <option key={o}>{o}</option>)}</select></div>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 9, alignItems: 'flex-end' }}>
            <div><label style={{ fontSize: 10, color: C.sub, display: 'block', marginBottom: 4, fontWeight: 600 }}>DESCRIPCIÓN</label><input value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} placeholder={form.tipo === 'I' ? 'Ej: Ortodoncia Ana García' : 'Ej: Insumos Septodont'} style={inp} /></div>
            <div><label style={{ fontSize: 10, color: C.sub, display: 'block', marginBottom: 4, fontWeight: 600 }}>MONTO (CLP)</label><input type="number" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} placeholder="150000" style={inp} /></div>
            <div style={{ display: 'flex', gap: 6 }}><button onClick={guardar} style={{ background: C.teal, color: '#fff', border: 'none', borderRadius: 7, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>💾 Guardar</button><button onClick={() => setOpen(false)} style={{ background: C.bg, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 11px', fontSize: 12, cursor: 'pointer' }}>✕</button></div>
          </div>
          {user.token !== 'demo' && <p style={{ margin: '7px 0 0', fontSize: 10, color: C.sub }}>💡 Se guardará en tu planilla de Drive automáticamente</p>}
        </div>
      )}
      {txs.length === 0
        ? <div style={{ background: C.white, borderRadius: 12, padding: '28px', textAlign: 'center', border: `2px dashed ${C.border}` }}><div style={{ fontSize: 32, marginBottom: 9 }}>📋</div><div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 5 }}>Nada registrado manualmente</div><div style={{ fontSize: 12, color: C.sub }}>Los datos de Drive se ven en el Dashboard y Consejero IA</div></div>
        : <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <div style={{ padding: '9px 15px', borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.text }}>Transacciones manuales</div>
          {txs.slice(0, 20).map((tx, i) => (
            <div key={tx.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 15px', borderBottom: i < Math.min(txs.length, 20) - 1 ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: tx.tipo === 'I' ? C.greenL : C.redL, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>{tx.tipo === 'I' ? '📈' : '📉'}</div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, color: C.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.desc}</div><div style={{ fontSize: 10, color: C.sub, marginTop: 1 }}>{tx.cat} · {tx.fecha}</div></div>
              <div style={{ fontSize: 13, fontWeight: 800, color: tx.tipo === 'I' ? C.green : C.red, flexShrink: 0 }}>{tx.tipo === 'I' ? '+' : '−'}{fmt(tx.monto)}</div>
            </div>
          ))}
        </div>
      }
    </div>
  )
}

// ── CONSEJERO IA — recibe driveData pre-procesado ─────────────────
function Consejero({ user, txs, driveData }) {
  const CHAT_KEY = `dentaiq_chat_${user.email}`
  const manualIng = txs.filter(t => t.tipo === 'I').reduce((s, t) => s + t.monto, 0)
  const manualGas = txs.filter(t => t.tipo === 'G').reduce((s, t) => s + t.monto, 0)
  const totalIng = manualIng + (driveData.totalIngresos || 0)
  const totalGas = manualGas + (driveData.totalGastos || 0)

  const [msgs, setMsgs] = useState(() => {
    try { const s = localStorage.getItem(CHAT_KEY); return s ? JSON.parse(s) : [{ role: 'assistant', content: `Hola ${user.name.split(' ')[0]} 👋 ${driveData.loaded ? `Leí ${driveData.filesRead} archivos de Drive. ¿Qué quieres saber? 📊` : 'Cargando tus datos de Drive...'}` }] }
    catch { return [{ role: 'assistant', content: `Hola 👋 ¿En qué te ayudo?` }] }
  })
  const [inp, setInp] = useState(''), [loading, setLoading] = useState(false)
  const endRef = useRef(null)

  useEffect(() => { try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-40))) } catch {} }, [msgs])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  // Actualizar mensaje inicial cuando driveData carga
  useEffect(() => {
    if (!driveData.loaded) return
    setMsgs(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.content.includes('Cargando')) {
        const msg = driveData.filesRead > 0
          ? `Hola ${user.name.split(' ')[0]} 👋 Leí ${driveData.filesRead} archivos de Drive.\n\n📊 Resumen:\n• Ingresos: ${fmt(driveData.totalIngresos)} CLP\n• Gastos: ${fmt(driveData.totalGastos)} CLP\n• Balance: ${fmt(driveData.totalIngresos - driveData.totalGastos)} CLP\n\n¿Qué quieres saber?`
          : `Hola ${user.name.split(' ')[0]} 👋 No encontré archivos legibles en Drive. Sube tus planillas a las carpetas.`
        return [...prev.slice(0, -1), { role: 'assistant', content: msg }]
      }
      return prev
    })
  }, [driveData.loaded])

  // ✅ system se construye dentro de send() con datos actuales
  const send = async (texto) => {
    const t = (texto || inp).trim(); if (!t || loading) return
    setInp('')

    const system = `Eres consejero financiero de ${user.name}, clínica dental en Chile. Lenguaje simple, amigo experto.

DATOS FINANCIEROS ACTUALES:
• Ingresos totales: ${fmt(totalIng)} CLP (manual: ${fmt(manualIng)} + Drive: ${fmt(driveData.totalIngresos || 0)})
• Gastos totales: ${fmt(totalGas)} CLP (manual: ${fmt(manualGas)} + Drive: ${fmt(driveData.totalGastos || 0)})
• Balance: ${fmt(totalIng - totalGas)} CLP
• Margen: ${totalIng > 0 ? ((totalIng - totalGas) / totalIng * 100).toFixed(1) : 0}%

${driveData.rawContext ? `DETALLE DE PLANILLAS DRIVE (usa estos datos para responder con precisión):\n${driveData.rawContext}` : 'Sin datos de Drive disponibles.'}

INSTRUCCIONES:
- IMPORTANTE: Si hay datos de Drive, responde con cifras específicas. NO digas "no hay datos".
- Lenguaje simple, emojis, máx 250 palabras, español chileno
- Siempre da un consejo concreto y accionable`

    const hist = [...msgs, { role: 'user', content: t }]
    setMsgs([...hist, { role: 'assistant', content: '', loading: true }]); setLoading(true)
    try {
      const reply = await askAI(hist.filter(m => !m.loading).map(m => ({ role: m.role, content: m.content })), system)
      setMsgs([...hist, { role: 'assistant', content: reply }])
    } catch(e) { setMsgs([...hist, { role: 'assistant', content: `❌ ${e.message}` }]) }
    setLoading(false)
  }

  const statusLabel = driveData.loading ? '⏳ Leyendo archivos...' : driveData.loaded ? `✅ ${driveData.filesRead} archivos cargados · Ingresos: ${fmt(driveData.totalIngresos)} · Gastos: ${fmt(driveData.totalGastos)}` : '⏳ Esperando datos...'
  const SUGS = ['¿Estoy ganando suficiente?', '¿En qué me gasto más?', '¿Cuánto gané este mes?', 'Analiza mis gastos de Drive', '¿Cuál es mi margen real?']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 800, padding: '0 24px' }}>
      <div style={{ padding: '18px 0 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: C.text }}>Consejero IA 🤖</h1>
          <p style={{ margin: '2px 0 0', fontSize: 10, color: C.sub }}>{statusLabel}</p>
        </div>
        <button onClick={() => { const i = [{ role: 'assistant', content: `Hola 👋 ¿En qué te ayudo?` }]; setMsgs(i); try { localStorage.setItem(CHAT_KEY, JSON.stringify(i)) } catch {} }} style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.sub, borderRadius: 7, padding: '4px 9px', fontSize: 11, cursor: 'pointer' }}>🗑 Limpiar</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 11, paddingBottom: 11 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 8, alignItems: 'flex-start' }}>
            {m.role === 'assistant' && <div style={{ width: 30, height: 30, borderRadius: 8, background: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>🤖</div>}
            <div style={{ maxWidth: '78%', padding: '10px 13px', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', borderRadius: m.role === 'user' ? '13px 13px 4px 13px' : '4px 13px 13px 13px', background: m.role === 'user' ? C.teal : C.white, color: m.role === 'user' ? '#fff' : C.text, boxShadow: m.role === 'assistant' ? `0 1px 4px ${C.shadow}` : 'none', border: m.role === 'assistant' ? `1px solid ${C.border}` : 'none' }}>
              {m.loading ? <div style={{ display: 'flex', gap: 4 }}>{[0, 1, 2].map(i => <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: C.sub, animation: `dots 1.2s ${i * 0.2}s infinite` }} />)}</div> : m.content}
            </div>
            {m.role === 'user' && <div style={{ width: 30, height: 30, borderRadius: 8, background: C.blueL, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>{user.picture ? <img src={user.picture} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 13 }}>👤</span>}</div>}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>{SUGS.map(s => <button key={s} onClick={() => send(s)} style={{ background: C.white, border: `1px solid ${C.border}`, color: C.text, borderRadius: 17, padding: '5px 11px', fontSize: 11, cursor: 'pointer' }}>{s}</button>)}</div>
      <div style={{ display: 'flex', gap: 8, paddingBottom: 20 }}>
        <textarea value={inp} onChange={e => setInp(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(inp) } }} placeholder="Escribe tu pregunta... (Enter para enviar)" rows={2} style={{ flex: 1, background: C.white, border: `1.5px solid ${loading ? C.border : C.teal}`, color: C.text, borderRadius: 10, padding: '10px 13px', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'none' }} />
        <button onClick={() => send(inp)} disabled={loading || !inp.trim()} style={{ background: loading || !inp.trim() ? C.border : C.teal, color: '#fff', border: 'none', borderRadius: 10, padding: '10px 15px', fontSize: 13, fontWeight: 700, cursor: loading || !inp.trim() ? 'default' : 'pointer' }}>Enviar</button>
      </div>
      <style>{`@keyframes dots{0%,100%{opacity:.2;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}`}</style>
    </div>
  )
}

// ── BUSCADOR ──────────────────────────────────────────────────────
function Buscador({ user, allFolders }) {
  const [allRows, setAllRows] = useState([]), [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false)
  const [filtro, setFiltro] = useState(''), [modo, setModo] = useState('tabla'), [comparaTerm, setComparaTerm] = useState('')

  useEffect(() => {
    if (loaded || user.token === 'demo') return
    const hasFiles = allFolders.some(f => f.files.length > 0); if (!hasFiles) return
    const load = async () => {
      setLoading(true); const rows = []
      for (const folder of allFolders) {
        for (const file of folder.files) {
          const mime = file.mimeType || ''
          const isSheet = mime.includes('spreadsheet') || mime.includes('xlsx') || mime.includes('sheet') || file.name?.endsWith('.xlsx')
          if (!isSheet) continue
          try {
            const csv = await readFileAsCSV(user.token, file)
            const parsed = parseProvCSV(csv)
            if (parsed.length > 0) rows.push(...parsed.map(r => ({ ...r, _carpeta: folder.name, _archivo: file.name })))
          } catch {}
        }
      }
      setAllRows(rows); setLoaded(true); setLoading(false)
    }
    load()
  }, [allFolders, loaded])

  const filas = allRows.filter(r => {
    if (!filtro) return true
    const q = filtro.toLowerCase()
    return r.articulo?.toLowerCase().includes(q) || r.empresa?.toLowerCase().includes(q) || r.rut?.toLowerCase().includes(q) || r.contacto?.toLowerCase().includes(q)
  })

  const getComparacion = () => {
    if (!comparaTerm.trim()) return []
    const q = comparaTerm.toLowerCase()
    const filtered = allRows.filter(r => r.articulo?.toLowerCase().includes(q) || r.empresa?.toLowerCase().includes(q))
    const grupos = {}
    for (const row of filtered) {
      const key = (row.articulo || '').toLowerCase().trim() || 'sin nombre'
      if (!grupos[key]) grupos[key] = { nombre: row.articulo || '—', proveedores: {} }
      const pk = row.empresa || 'Desconocido'
      if (!grupos[key].proveedores[pk]) grupos[key].proveedores[pk] = []
      grupos[key].proveedores[pk].push(row)
    }
    return Object.values(grupos).map(g => {
      const provList = Object.entries(g.proveedores).map(([nombre, rows]) => {
        const last = rows[rows.length - 1]; const pn = parseFloat(last?.precio?.replace(/[$\s]/g, '') || '0') || 0
        return { nombre, precio: pn, precioRaw: last?.precio || '—', fecha: last?.fecha || '', count: rows.length }
      }).filter(p => p.precio > 0).sort((a, b) => a.precio - b.precio)
      return { nombre: g.nombre, proveedores: provList }
    }).filter(g => g.proveedores.length > 0)
  }

  const th = { padding: '8px 11px', fontSize: 11, fontWeight: 700, color: C.sub, background: C.bg, borderBottom: `1px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap' }
  const td = { padding: '8px 11px', fontSize: 11, color: C.text, borderBottom: `1px solid ${C.border}`, verticalAlign: 'middle' }

  return (
    <div style={{ padding: '22px 24px', maxWidth: 1080 }}>
      <div style={{ marginBottom: 13 }}><h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>Buscador de Insumos y Proveedores 🔍</h1><p style={{ margin: '3px 0 0', fontSize: 12, color: C.sub }}>Busca en todas las carpetas de DentaIQ</p></div>
      <div style={{ display: 'flex', gap: 7, marginBottom: 11 }}>
        {[['tabla', '📋 Ver todos'], ['comparar', '⚖️ Comparar precios']].map(([m, l]) => <button key={m} onClick={() => setModo(m)} style={{ padding: '6px 13px', borderRadius: 17, border: `2px solid ${modo === m ? C.teal : C.border}`, background: modo === m ? C.tealL : 'transparent', color: modo === m ? C.tealD : C.sub, fontSize: 12, fontWeight: modo === m ? 700 : 400, cursor: 'pointer' }}>{l}</button>)}
      </div>

      {modo === 'tabla' && <>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input value={filtro} onChange={e => setFiltro(e.target.value)} placeholder="Filtrar por artículo, empresa, RUT, contacto..." style={{ flex: 1, background: C.white, border: `1.5px solid ${C.teal}`, color: C.text, borderRadius: 9, padding: '9px 13px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
          {filtro && <button onClick={() => setFiltro('')} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.sub, borderRadius: 9, padding: '0 11px', cursor: 'pointer', fontSize: 12 }}>✕</button>}
          <button onClick={() => setLoaded(false)} disabled={loading} style={{ background: C.teal, color: '#fff', border: 'none', borderRadius: 9, padding: '9px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>↻</button>
        </div>
        {loading && <div style={{ textAlign: 'center', padding: 36, color: C.sub }}>Cargando desde Drive (leyendo archivos .xlsx)...</div>}
        {!loading && user.token === 'demo' && <div style={{ background: C.tealL, borderRadius: 12, padding: 22, textAlign: 'center', border: `1px solid ${C.teal}33` }}><div style={{ fontSize: 28, marginBottom: 7 }}>☁️</div><div style={{ fontSize: 13, color: C.tealD, fontWeight: 600 }}>Conecta Google para buscar en tus proveedores</div></div>}
        {!loading && loaded && <>
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 7 }}>{filas.length} resultado{filas.length !== 1 ? 's' : ''}{filtro ? ` para "${filtro}"` : ` — ${allRows.length} registros totales`}</div>
          <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'auto', boxShadow: `0 1px 6px ${C.shadow}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead><tr><th style={th}>Empresa</th><th style={th}>Dirección</th><th style={th}>RUT</th><th style={th}>Contacto</th><th style={th}>Teléfono</th><th style={th}>Factura</th><th style={th}>Fecha</th><th style={th}>Artículo</th><th style={th}>Cant.</th><th style={th}>Precio neto</th><th style={th}>Total</th></tr></thead>
              <tbody>
                {filas.length === 0
                  ? <tr><td colSpan={11} style={{ ...td, textAlign: 'center', padding: 26, color: C.sub }}>No se encontraron resultados{filtro ? ` para "${filtro}"` : ''}.</td></tr>
                  : filas.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : C.bg }}>
                      <td style={{ ...td, fontWeight: 600, color: C.tealD, whiteSpace: 'nowrap' }}>{r.empresa || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.direccion || '—'}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 10 }}>{r.rut || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.contacto || '—'}</td>
                      <td style={{ ...td, fontFamily: 'monospace' }}>{r.telefono || '—'}</td>
                      <td style={{ ...td, fontFamily: 'monospace' }}>{r.factura || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.fecha || '—'}</td>
                      <td style={{ ...td, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.articulo}>{r.articulo || '—'}</td>
                      <td style={{ ...td, textAlign: 'center' }}>{r.cantidad || '—'}</td>
                      <td style={{ ...td, fontWeight: 700, color: C.blue, textAlign: 'right', whiteSpace: 'nowrap' }}>{r.precio || '—'}</td>
                      <td style={{ ...td, fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' }}>{r.total || '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>}
      </>}

      {modo === 'comparar' && <>
        <div style={{ background: C.goldL, borderRadius: 10, padding: '10px 13px', marginBottom: 12, border: `1px solid ${C.gold}33`, fontSize: 12, color: C.text }}>💡 Busca un insumo para comparar precios. <strong>Verde = más barato</strong></div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input value={comparaTerm} onChange={e => setComparaTerm(e.target.value)} placeholder="Ej: anestesia, guantes, isocaine..." style={{ flex: 1, background: C.white, border: `1.5px solid ${C.teal}`, color: C.text, borderRadius: 9, padding: '10px 13px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
        </div>
        {comparaTerm && (() => {
          const grupos = getComparacion()
          if (!loaded) return <div style={{ textAlign: 'center', padding: 28, color: C.sub }}>Ve a "Ver todos" primero para cargar los datos</div>
          if (!grupos.length) return <div style={{ textAlign: 'center', padding: 28, color: C.sub }}>No se encontraron registros para "<strong>{comparaTerm}</strong>"</div>
          return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{grupos.map((g, gi) => (
            <div key={gi} style={{ background: C.white, borderRadius: 13, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
              <div style={{ padding: '11px 17px', background: C.bg, borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{g.nombre}</div>
                <div style={{ fontSize: 11, color: C.sub }}>{g.proveedores.length} proveedor{g.proveedores.length !== 1 ? 'es' : ''} · Mejor: <strong style={{ color: C.green }}>{g.proveedores[0]?.precioRaw}</strong></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(g.proveedores.length, 4)}, 1fr)` }}>
                {g.proveedores.map((p, pi) => (
                  <div key={pi} style={{ padding: '13px 17px', borderRight: pi < g.proveedores.length - 1 ? `1px solid ${C.border}` : 'none', background: pi === 0 ? C.greenL : 'transparent' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: pi === 0 ? C.green : C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{p.nombre}</div>
                      {pi === 0 && <span style={{ background: C.green, color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 17, flexShrink: 0 }}>MEJOR</span>}
                      {pi === g.proveedores.length - 1 && pi !== 0 && <span style={{ background: C.redL, color: C.red, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 17, flexShrink: 0 }}>MÁS CARO</span>}
                    </div>
                    <div style={{ fontSize: 19, fontWeight: 800, color: pi === 0 ? C.green : C.text }}>{p.precioRaw}</div>
                    <div style={{ fontSize: 10, color: C.sub, marginTop: 3 }}>Última: {p.fecha || '—'} · {p.count} compra{p.count !== 1 ? 's' : ''}</div>
                    {pi > 0 && g.proveedores[0].precio > 0 && p.precio > 0 && <div style={{ marginTop: 4, fontSize: 10, color: C.red, fontWeight: 600 }}>+{((p.precio - g.proveedores[0].precio) / g.proveedores[0].precio * 100).toFixed(1)}% más caro</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}</div>
        })()}
      </>}
    </div>
  )
}

// ── MI DRIVE ──────────────────────────────────────────────────────
function MiDrive({ user, allFolders, loading, onRefresh }) {
  const [sel, setSel] = useState(null)
  const activeF = allFolders.find(f => f.id === sel)
  return (
    <div style={{ padding: '22px 24px', maxWidth: 860 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>Mi Drive ☁️</h1><p style={{ margin: '3px 0 0', fontSize: 12, color: C.sub }}>Solo muestra carpetas dentro de DentaIQ</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="https://drive.google.com" target="_blank" rel="noreferrer" style={{ background: C.white, color: C.teal, border: `1px solid ${C.teal}`, borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>Abrir Drive →</a>
          <button onClick={onRefresh} disabled={loading} style={{ background: C.teal, color: '#fff', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>↻ Actualizar</button>
        </div>
      </div>
      {loading ? <div style={{ textAlign: 'center', padding: 36, color: C.sub }}>Cargando...</div> : <>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(allFolders.length || 2, 4)}, 1fr)`, gap: 10, marginBottom: 12 }}>
          {allFolders.map(f => (
            <button key={f.id} onClick={() => setSel(sel === f.id ? null : f.id)} style={{ background: sel === f.id ? C.tealL : C.white, border: `2px solid ${sel === f.id ? C.teal : C.border}`, borderRadius: 12, padding: '13px', textAlign: 'center', cursor: 'pointer' }}>
              <div style={{ fontSize: 24, marginBottom: 5 }}>{f.emoji}</div>
              <div style={{ fontSize: 12, color: sel === f.id ? C.tealD : C.text, fontWeight: 600, marginBottom: 2 }}>{f.name}</div>
              <div style={{ fontSize: 10, color: f.files.length > 0 ? C.teal : C.light }}>{f.files.length > 0 ? `${f.files.length} archivos` : 'Vacía'}</div>
            </button>
          ))}
        </div>
        {activeF && (
          <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <div style={{ padding: '10px 15px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{activeF.emoji} {activeF.name}</span>
              <span style={{ fontSize: 11, color: C.sub }}>{activeF.files.length} archivos</span>
            </div>
            {activeF.files.length === 0
              ? <div style={{ padding: '24px', textAlign: 'center', color: C.sub }}>Carpeta vacía</div>
              : activeF.files.map((f, i) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 15px', borderBottom: i < activeF.files.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                  <span style={{ fontSize: 18 }}>{f.mimeType?.includes('spreadsheet') || f.name?.endsWith('.xlsx') ? '📊' : '📄'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: C.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                    {f.modifiedTime && <div style={{ fontSize: 10, color: C.sub }}>{new Date(f.modifiedTime).toLocaleDateString('es-CL')}</div>}
                  </div>
                  {f.name?.endsWith('.xlsx') && <span style={{ fontSize: 10, color: C.sub, background: C.bg, padding: '2px 6px', borderRadius: 4 }}>Excel</span>}
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
const NAV = [{ id: 'inicio', label: 'Inicio', icon: '🏠' }, { id: 'numeros', label: 'Mis Números', icon: '📊' }, { id: 'ia', label: 'Consejero IA', icon: '🤖' }, { id: 'buscador', label: 'Buscador', icon: '🔍' }, { id: 'drive', label: 'Mi Drive', icon: '☁️' }]

export default function App() {
  const [authState, setAuthState] = useState('loading'), [savedUser, setSavedUser] = useState(null)
  const [user, setUser] = useState(null), [onboarded, setOnboarded] = useState(false)
  const [tab, setTab] = useState('inicio'), [txs, setTxs] = useState([])
  const [allFolders, setAllFolders] = useState([]), [folderIds, setFolderIds] = useState(null)
  const [driveLoading, setDriveLoading] = useState(false)

  // ✅ driveData a nivel de App — compartido con TODOS los componentes
  const [driveData, setDriveData] = useState({ totalIngresos: 0, totalGastos: 0, rawContext: '', filesRead: 0, loading: false, loaded: false })

  useEffect(() => {
    const s = loadSession()
    if (!s) { setAuthState('loggedOut'); return }
    if (!s.expired) { setUser(s.user); setAuthState('loggedIn'); loadDrive(s.user.token); const seen = localStorage.getItem(`diq_ob_${s.user.email}`); setOnboarded(!!seen) }
    else { setSavedUser(s.user); setAuthState('reauth') }
  }, [])

  const loadDrive = useCallback(async token => {
    if (token === 'demo') {
      setAllFolders([{ id: '1', name: 'Ingresos', emoji: '💰', files: [] }, { id: '2', name: 'Gastos', emoji: '💳', files: [] }])
      setDriveData({ totalIngresos: 0, totalGastos: 0, rawContext: '', filesRead: 0, loading: false, loaded: true })
      return
    }
    setDriveLoading(true)
    try {
      const { allFolders: af, folderIds: fids } = await setupDrive(token)
      setAllFolders(af)
      setFolderIds(fids)

      // ✅ Procesar financieros inmediatamente después de cargar Drive
      const hasFiles = af.some(f => f.files.length > 0)
      if (hasFiles) {
        setDriveData(p => ({ ...p, loading: true }))
        const result = await procesarDrive(token, af, msg => console.log(msg))
        setDriveData({ ...result, loading: false, loaded: true })
      } else {
        setDriveData({ totalIngresos: 0, totalGastos: 0, rawContext: '', filesRead: 0, loading: false, loaded: true })
      }
    } catch(e) {
      console.error('Drive error:', e)
      setDriveData(p => ({ ...p, loading: false, loaded: true }))
    }
    setDriveLoading(false)
  }, [])

  const handleLogin = async (u, save = true) => {
    setUser(u); if (save && u.token !== 'demo') saveSession(u)
    await loadDrive(u.token)
    setOnboarded(!!localStorage.getItem(`diq_ob_${u.email}`))
    setAuthState('loggedIn')
  }

  const handleLogout = () => { clearSession(); setUser(null); setAuthState('loggedOut'); setSavedUser(null); setAllFolders([]); setFolderIds(null); setTxs([]); setDriveData({ totalIngresos: 0, totalGastos: 0, rawContext: '', filesRead: 0, loading: false, loaded: false }) }
  const handleOnboardingDone = () => { if (user) localStorage.setItem(`diq_ob_${user.email}`, '1'); setOnboarded(true) }

  if (authState === 'loading') return <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}><div style={{ textAlign: 'center' }}><div style={{ fontSize: 44, marginBottom: 12 }}>🦷</div><div style={{ fontSize: 14, color: C.sub }}>Cargando DentaIQ...</div></div></div>
  if (authState === 'loggedOut') return <Welcome onLogin={handleLogin} />
  if (authState === 'reauth') return <Reconnecting savedUser={savedUser} onLogin={handleLogin} onLogout={handleLogout} />
  if (!user) return <Welcome onLogin={handleLogin} />
  if (!onboarded) return <Onboarding user={user} onDone={handleOnboardingDone} />

  const totalFiles = allFolders.reduce((s, f) => s + f.files.length, 0)

  return (
    <div style={{ display: 'flex', height: '100vh', background: C.bg, fontFamily: "'Sora',system-ui,sans-serif", color: C.text }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}input,select,textarea{outline:none;font-family:inherit}button{font-family:inherit}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:4px}`}</style>
      <div style={{ width: 200, flexShrink: 0, background: C.white, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '15px 13px 12px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 29, height: 29, borderRadius: 8, background: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>🦷</div>
            <div><div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>DentaIQ</div><div style={{ fontSize: 9, color: C.sub }}>Gerente financiero</div></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: C.bg, borderRadius: 8, border: `1px solid ${C.border}` }}>
            {user.picture ? <img src={user.picture} style={{ width: 21, height: 21, borderRadius: '50%' }} /> : <div style={{ width: 21, height: 21, borderRadius: '50%', background: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700 }}>{user.name[0]}</div>}
            <div style={{ minWidth: 0 }}><div style={{ fontSize: 11, color: C.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name.split(' ')[0]}</div><div style={{ fontSize: 9, color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div></div>
          </div>
        </div>
        <div style={{ flex: 1, padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map(item => {
            const active = tab === item.id
            return (
              <button key={item.id} onClick={() => setTab(item.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 8, background: active ? C.tealL : 'transparent', border: active ? `1px solid ${C.teal}33` : '1px solid transparent', color: active ? C.tealD : C.sub, cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 400, textAlign: 'left' }}>
                <span style={{ fontSize: 14 }}>{item.icon}</span>{item.label}
                {item.id === 'drive' && totalFiles > 0 && <span style={{ marginLeft: 'auto', background: C.teal, color: '#fff', borderRadius: 17, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>{totalFiles}</span>}
                {item.id === 'ia' && <span style={{ marginLeft: 'auto', background: C.greenL, color: C.green, borderRadius: 17, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>ON</span>}
              </button>
            )
          })}
        </div>
        <div style={{ padding: '10px', borderTop: `1px solid ${C.border}` }}>
          {driveData.loading && <div style={{ fontSize: 10, color: C.sub, textAlign: 'center', marginBottom: 6 }}>⏳ Leyendo Drive...</div>}
          <button onClick={handleLogout} style={{ width: '100%', background: 'transparent', color: C.sub, border: `1px solid ${C.border}`, borderRadius: 7, padding: '6px', fontSize: 11, cursor: 'pointer' }}>Cerrar sesión</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'inicio' && <Dashboard user={user} txs={txs} allFolders={allFolders} driveData={driveData} />}
        {tab === 'numeros' && <MisNumeros txs={txs} setTxs={setTxs} user={user} folderIds={folderIds} />}
        {tab === 'ia' && <Consejero user={user} txs={txs} driveData={driveData} />}
        {tab === 'buscador' && <Buscador user={user} allFolders={allFolders} />}
        {tab === 'drive' && <MiDrive user={user} allFolders={allFolders} loading={driveLoading} onRefresh={() => loadDrive(user.token)} />}
      </div>
    </div>
  )
}
