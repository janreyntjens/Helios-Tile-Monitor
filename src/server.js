const path = require('path')
const { spawn } = require('child_process')
const express = require('express')
const { scanNetwork, getPublicData, executeAction } = require('./heliosClient')
const { loadState, saveState, defaultState } = require('./store')
const { StreamDeckManager } = require('./streamdeckManager')

const app = express()
const port = process.env.PORT || 3111
const publicDir = path.join(__dirname, '..', 'public')

app.use(express.json({ limit: '1mb' }))
app.use(express.static(publicDir))

let state = loadState()
let processors = new Map()
let scanStatus = {
  active: false,
  phase: 'idle',
  scanned: 0,
  total: 0,
  found: 0,
  subnet: '',
  startedAt: null,
  finishedAt: null,
  error: null
}
const DEFAULT_COLUMNS = 8
const MIN_COLUMNS = 1

function getStreamDeckMappings() {
  return Array.isArray(state?.config?.streamDeckMappings) ? state.config.streamDeckMappings : []
}

function mergeProcessorsIntoStore(items) {
  for (const item of items || []) {
    if (!item || !item.id) continue
    processors.set(item.id, { ...item, id: item.id })
  }
}

function createMappingId(mapping) {
  return `${mapping.deckId}:${mapping.keyIndex}`
}

function getExpectedTilesSlotKey(role, column) {
  return `${role}:${column}`
}

function getExpectedTilesForSlot(role, column, processorId = null) {
  const col = normalizeColumn(column)
  if (col === null) return 0

  const slotKey = getExpectedTilesSlotKey(role, col)
  const slotValue = state.config?.expectedTilesBySlot?.[slotKey]
  if (slotValue !== undefined && slotValue !== null) {
    return Number(slotValue || 0)
  }

  if (processorId) {
    return Number(state.config?.expectedTilesByProcessor?.[processorId] || 0)
  }

  return 0
}

function setExpectedTilesForSlot(role, column, expected) {
  const col = normalizeColumn(column)
  if (col === null) {
    throw new Error(`Column must be 0..${getColumnCount() - 1}`)
  }

  state.config.expectedTilesBySlot = {
    ...(state.config.expectedTilesBySlot || {}),
    [getExpectedTilesSlotKey(role, col)]: Math.round(Number(expected) || 0)
  }
}

async function handleGridButtonPress(row, column) {
  const col = normalizeColumn(column)
  if (col === null) {
    throw new Error(`Column must be 0..${getColumnCount() - 1}`)
  }

  const slot = state.assignments.columns[col]
  if (!slot) {
    throw new Error('Slot not found')
  }

  if (row === 0 || row === 3) {
    const role = row === 0 ? 'main' : 'backup'
    const target = getAssigned(role, col)
    if (!target) {
      throw new Error(`No ${role} processor assigned on column ${col + 1}`)
    }
    const action = normalizeRoleAction(
      role === 'main' ? state.config.goMainAction : state.config.goBackupAction,
      role
    )
    await executeAction(target.ip, action)
    return { ok: true, type: 'command', role, column: col }
  }

  if (row === 1 || row === 2) {
    const role = row === 1 ? 'main' : 'backup'
    const processorId = slot[role]
    if (!processorId) {
      throw new Error(`No ${role} processor assigned on column ${col + 1}`)
    }
    const processor = processors.get(processorId)
    if (!processor) {
      throw new Error('Assigned processor not available')
    }

    setExpectedTilesForSlot(role, col, Number(processor.tilesCount || 0))
    saveState(state)
    return { ok: true, type: 'expected-tiles', role, column: col, expected: Number(processor.tilesCount || 0) }
  }

  throw new Error('Unsupported grid row')
}

let recentStreamDeckAction = null

function setRecentStreamDeckAction(action) {
  recentStreamDeckAction = action
  // Clear after 2 seconds so the UI can show it briefly
  setTimeout(() => {
    recentStreamDeckAction = null
  }, 2000)
}

const streamDeckManager = new StreamDeckManager(async ({ deckId, keyIndex }) => {
  const mappings = getStreamDeckMappings()
  const mapping = mappings.find((m) => m.deckId === deckId && Number(m.keyIndex) === Number(keyIndex))
  if (!mapping) {
    console.log(`[StreamDeck] Key ${keyIndex} on ${deckId}: No mapping found`)
    return
  }
  console.log(`[StreamDeck] Key ${keyIndex} on ${deckId}: Calling handleGridButtonPress(${mapping.row}, ${mapping.col})`)
  try {
    const result = await handleGridButtonPress(Number(mapping.row), Number(mapping.col))
    console.log(`[StreamDeck] Key ${keyIndex}: Action completed successfully`)
    setRecentStreamDeckAction({
      success: true,
      message: `Stream Deck K${keyIndex + 1} action executed`
    })
  } catch (err) {
    console.error(`[StreamDeck] Key ${keyIndex}: Action failed:`, err.message)
    setRecentStreamDeckAction({
      success: false,
      message: err.message,
      timestamp: Date.now()
    })
  }
})

function getColumnCount() {
  const configured = Number(state?.config?.columnCount || DEFAULT_COLUMNS)
  if (!Number.isInteger(configured) || configured < MIN_COLUMNS) {
    return DEFAULT_COLUMNS
  }
  return configured
}

function ensureColumnStructure() {
  if (!state.assignments || !Array.isArray(state.assignments.columns)) {
    state.assignments = { columns: [] }
  }

  const targetCount = getColumnCount()
  while (state.assignments.columns.length < targetCount) {
    state.assignments.columns.push({ main: null, backup: null })
  }

  if (state.assignments.columns.length > targetCount) {
    state.assignments.columns = state.assignments.columns.slice(0, targetCount)
  }
}

ensureColumnStructure()

function buildRedundancyAction(role) {
  return {
    type: 'patch-model',
    path: '/api/v1/public',
    body: {
      dev: {
        display: {
          redundancy: {
            state: role === 'main' ? 'main' : 'backup'
          }
        }
      }
    }
  }
}

function normalizeRoleAction(action, role) {
  if (!action || typeof action !== 'object' || !action.type) {
    return buildRedundancyAction(role)
  }

  if (action.type === 'preset') {
    const preset = String(action.presetName || '').trim().toLowerCase()
    if ((role === 'main' && preset === 'go main') || (role === 'backup' && preset === 'go backup')) {
      return buildRedundancyAction(role)
    }
  }

  return action
}

function sanitizeConfig(next) {
  const safe = {
    columnCount: getColumnCount(),
    expectedTilesBySlot: {
      ...(state.config?.expectedTilesBySlot || {}),
      ...((typeof next.expectedTilesBySlot === 'object' && next.expectedTilesBySlot) || {})
    },
    expectedTilesByProcessor: {
      ...(state.config?.expectedTilesByProcessor || {}),
      ...((typeof next.expectedTilesByProcessor === 'object' && next.expectedTilesByProcessor) || {})
    },
    streamDeckMappings: Array.isArray(next.streamDeckMappings)
      ? next.streamDeckMappings
      : getStreamDeckMappings(),
    goMainAction: normalizeRoleAction(next.goMainAction || state.config.goMainAction, 'main'),
    goBackupAction: normalizeRoleAction(next.goBackupAction || state.config.goBackupAction, 'backup')
  }

  if (!safe.goMainAction.type) safe.goMainAction = buildRedundancyAction('main')
  if (!safe.goBackupAction.type) safe.goBackupAction = buildRedundancyAction('backup')

  return safe
}

function normalizeColumn(column) {
  const parsed = Number(column)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= getColumnCount()) {
    return null
  }
  return parsed
}

function getAssigned(role, column) {
  const col = normalizeColumn(column)
  if (col === null) return null
  const assignedId = state.assignments?.columns?.[col]?.[role]
  if (!assignedId) return null
  return processors.get(assignedId) || null
}

function getSlots() {
  const slots = []
  for (let col = 0; col < getColumnCount(); col += 1) {
    const mainId = state.assignments?.columns?.[col]?.main || null
    const backupId = state.assignments?.columns?.[col]?.backup || null
    slots.push({
      column: col,
      mainId,
      backupId,
      main: getAssigned('main', col),
      backup: getAssigned('backup', col)
    })
  }
  return slots
}

function getStreamDeckRenderContext() {
  return {
    slots: getSlots(),
    expectedTilesBySlot: state.config?.expectedTilesBySlot || {},
    expectedTilesByProcessor: state.config?.expectedTilesByProcessor || {}
  }
}

function currentStateResponse() {
  const slots = getSlots()
  const processorsList = Array.from(processors.entries())
    .map(([processorKey, processor]) => ({
      ...processor,
      processorKey
    }))
    .sort((a, b) => a.description.localeCompare(b.description))

  return {
    config: state.config,
    assignments: state.assignments,
    processors: processorsList,
    slots,
    streamDeck: {
      devices: streamDeckManager.getDevices(),
      mappings: getStreamDeckMappings()
    },
    main: slots[0]?.main || null,
    backup: slots[0]?.backup || null,
    serverTime: Date.now()
  }
}

function buildResetState() {
  return {
    config: {
      ...defaultState.config,
      expectedTilesBySlot: {},
      expectedTilesByProcessor: {},
      streamDeckMappings: []
    },
    assignments: {
      columns: defaultState.assignments.columns.map((column) => ({ ...column }))
    }
  }
}

async function refreshAssignedProcessors() {
  const assigned = new Set()

  for (const column of state.assignments?.columns || []) {
    if (column.main) assigned.add(column.main)
    if (column.backup) assigned.add(column.backup)
  }

  for (const id of Array.from(assigned)) {
    const existing = processors.get(id)
    if (!existing) continue

    try {
      const fresh = await getPublicData(existing.ip, 1200)
      processors.set(id, {
        ...fresh,
        id
      })
    } catch (_) {
      processors.set(id, {
        ...existing,
        online: false
      })
    }
  }
}

app.get('/api/state', (_req, res) => {
  res.json(currentStateResponse())
})

app.get('/api/stream-deck/last-action', (_req, res) => {
  res.json({ action: recentStreamDeckAction })
})

app.get('/api/scan/status', (_req, res) => {
  res.json({ ok: true, status: scanStatus })
})

app.post('/api/scan', async (req, res) => {
  if (scanStatus.active) {
    return res.status(409).json({ ok: false, error: 'Scan already in progress' })
  }

  const body = req.body || {}
  scanStatus = {
    active: true,
    phase: 'fast',
    scanned: 0,
    total: 0,
    found: 0,
    subnet: '',
    startedAt: Date.now(),
    finishedAt: null,
    error: null
  }

  try {
    const fastTimeoutMs = Number(body.timeoutMs || 450)
    const fastConcurrency = Number(body.concurrency || 48)

    const fastFound = await scanNetwork({
      mode: 'fast',
      timeoutMs: fastTimeoutMs,
      concurrency: fastConcurrency,
      onProgress: ({ scanned, total, found: foundCount, subnet }) => {
        scanStatus.phase = 'fast'
        scanStatus.scanned = scanned
        scanStatus.total = total
        scanStatus.found = foundCount
        scanStatus.subnet = subnet || ''
      }
    })

    mergeProcessorsIntoStore(fastFound)

    scanStatus.active = false
    scanStatus.phase = 'done'
    scanStatus.found = processors.size
    scanStatus.finishedAt = Date.now()

    return res.json({
      ok: true,
      count: processors.size,
      fastCount: fastFound.length,
      backgroundScan: false,
      processors: Array.from(processors.values())
    })
  } catch (error) {
    scanStatus.active = false
    scanStatus.phase = 'error'
    scanStatus.error = error.message
    scanStatus.finishedAt = Date.now()
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/assign', (req, res) => {
  ensureColumnStructure()
  const { role, id, column } = req.body || {}

  if (!['main', 'backup'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Role must be main or backup' })
  }

  const col = column === undefined ? 0 : normalizeColumn(column)
  if (col === null) {
    return res.status(400).json({ ok: false, error: `Column must be 0..${getColumnCount() - 1}` })
  }

  if (!id || !processors.has(id)) {
    return res.status(400).json({ ok: false, error: 'Unknown processor id' })
  }

  const wasUnassigned = !state.assignments.columns[col][role]
  const processor = processors.get(id)

  state.assignments.columns[col][role] = id

  if (wasUnassigned && processor) {
    setExpectedTilesForSlot(role, col, Number(processor.tilesCount || 0))
  }

  saveState(state)
  return res.json({ ok: true, assignments: state.assignments, config: state.config })
})

app.post('/api/unassign', (req, res) => {
  ensureColumnStructure()
  const { role, column } = req.body || {}
  if (!['main', 'backup'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Role must be main or backup' })
  }

  if (column === undefined || column === null) {
    for (let col = 0; col < getColumnCount(); col += 1) {
      state.assignments.columns[col][role] = null
    }
  } else {
    const col = normalizeColumn(column)
    if (col === null) {
      return res.status(400).json({ ok: false, error: `Column must be 0..${getColumnCount() - 1}` })
    }
    state.assignments.columns[col][role] = null
  }

  saveState(state)
  return res.json({ ok: true, assignments: state.assignments })
})

app.post('/api/config', (req, res) => {
  state.config = sanitizeConfig(req.body || {})
  ensureColumnStructure()
  saveState(state)
  res.json({ ok: true, config: state.config })
})

app.post('/api/reset', async (_req, res) => {
  state = buildResetState()
  ensureColumnStructure()
  recentStreamDeckAction = null
  saveState(state)

  try {
    await streamDeckManager.applyMappings([], getStreamDeckRenderContext())
    return res.json({ ok: true, state: currentStateResponse() })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/columns/add', (_req, res) => {
  const nextCount = getColumnCount() + 1
  state.config = {
    ...state.config,
    columnCount: nextCount
  }
  ensureColumnStructure()
  saveState(state)
  return res.json({ ok: true, columnCount: nextCount, assignments: state.assignments })
})

app.post('/api/columns/remove', (_req, res) => {
  const current = getColumnCount()
  if (current <= MIN_COLUMNS) {
    return res.status(400).json({ ok: false, error: `Minimum column count is ${MIN_COLUMNS}` })
  }

  const nextCount = current - 1
  state.config = {
    ...state.config,
    columnCount: nextCount
  }
  ensureColumnStructure()
  saveState(state)
  return res.json({ ok: true, columnCount: nextCount, assignments: state.assignments })
})

app.post('/api/streamdecks/scan', async (_req, res) => {
  try {
    const devices = await streamDeckManager.scanAndConnect()
    await streamDeckManager.applyMappings(getStreamDeckMappings(), getStreamDeckRenderContext())
    return res.json({ ok: true, devices, mappings: getStreamDeckMappings() })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/streamdecks/disconnect', async (req, res) => {
  try {
    const { deckId } = req.body || {}
    if (!deckId) {
      return res.status(400).json({ ok: false, error: 'deckId is required' })
    }

    const disconnected = await streamDeckManager.disconnectDevice(deckId)
    if (!disconnected) {
      return res.status(404).json({ ok: false, error: `Device ${deckId} not found` })
    }

    return res.json({ ok: true, message: `Device ${deckId} disconnected` })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/api/streamdecks/map', async (req, res) => {
  const { deckId, keyIndex, row, col } = req.body || {}

  if (!deckId || typeof deckId !== 'string') {
    return res.status(400).json({ ok: false, error: 'deckId is required' })
  }

  const key = Number(keyIndex)
  const gridRow = Number(row)
  const gridCol = Number(col)

  if (!Number.isInteger(key) || key < 0) {
    return res.status(400).json({ ok: false, error: 'keyIndex must be >= 0' })
  }

  if (!Number.isInteger(gridRow) || gridRow < 0 || gridRow > 3) {
    return res.status(400).json({ ok: false, error: 'row must be 0..3' })
  }

  if (normalizeColumn(gridCol) === null) {
    return res.status(400).json({ ok: false, error: `col must be 0..${getColumnCount() - 1}` })
  }

  const current = getStreamDeckMappings().filter((m) => !(m.deckId === deckId && Number(m.keyIndex) === key))
  const mapping = {
    id: createMappingId({ deckId, keyIndex: key }),
    deckId,
    keyIndex: key,
    row: gridRow,
    col: gridCol
  }
  current.push(mapping)

  state.config.streamDeckMappings = current
  saveState(state)
  await streamDeckManager.applyMappings(current, getStreamDeckRenderContext())
  return res.json({ ok: true, mappings: current })
})

app.post('/api/streamdecks/unmap', async (req, res) => {
  const { deckId, keyIndex } = req.body || {}
  const key = Number(keyIndex)
  const nextMappings = getStreamDeckMappings().filter(
    (m) => !(m.deckId === deckId && Number(m.keyIndex) === key)
  )
  state.config.streamDeckMappings = nextMappings
  saveState(state)
  await streamDeckManager.applyMappings(nextMappings, getStreamDeckRenderContext())
  return res.json({ ok: true, mappings: nextMappings })
})

app.post('/api/grid/press', async (req, res) => {
  const row = Number(req.body?.row)
  const col = Number(req.body?.col)
  try {
    const result = await handleGridButtonPress(row, col)
    return res.json({ ok: true, result })
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/api/expected-tiles', (req, res) => {
  const { processorId, role, column, expected } = req.body || {}

  if (!['main', 'backup'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'role must be main or backup' })
  }

  const col = normalizeColumn(column)
  if (col === null) {
    return res.status(400).json({ ok: false, error: `column must be 0..${getColumnCount() - 1}` })
  }

  const parsedExpected = Number(expected)
  if (!Number.isFinite(parsedExpected) || parsedExpected < 0) {
    return res.status(400).json({ ok: false, error: 'expected must be >= 0' })
  }

  setExpectedTilesForSlot(role, col, parsedExpected)

  if (processorId && typeof processorId === 'string') {
    state.config.expectedTilesByProcessor = {
      ...(state.config.expectedTilesByProcessor || {}),
      [processorId]: Math.round(parsedExpected)
    }
  }

  saveState(state)
  return res.json({ ok: true, config: state.config })
})

app.post('/api/command/:role', async (req, res) => {
  const role = req.params.role
  const col = req.body?.column === undefined ? 0 : normalizeColumn(req.body.column)
  if (!['main', 'backup'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Role must be main or backup' })
  }

  if (col === null) {
    return res.status(400).json({ ok: false, error: `Column must be 0..${getColumnCount() - 1}` })
  }

  const target = getAssigned(role, col)
  if (!target) {
    return res.status(400).json({ ok: false, error: `No ${role} processor assigned on column ${col + 1}` })
  }

  const action = normalizeRoleAction(
    role === 'main' ? state.config.goMainAction : state.config.goBackupAction,
    role
  )

  try {
    const result = await executeAction(target.ip, action)
    return res.json({ ok: true, target, result })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

setInterval(() => {
  refreshAssignedProcessors().catch(() => {
    // Silent background refresh.
  })
}, 2000)

setInterval(() => {
  // Keep Stream Deck mappings active and support blink animation.
  streamDeckManager.applyMappings(getStreamDeckMappings(), getStreamDeckRenderContext()).catch(() => {
    // Ignore draw errors in background.
  })
}, 450)

// Initial Stream Deck scan at startup
streamDeckManager.scanAndConnect().catch(() => {
  // Ignore startup scan error
})

app.listen(port, () => {
  const url = `http://localhost:${port}`
  console.log(`Helios monitor server gestart op ${url}`)
  if (process.env.HELIOS_NO_BROWSER === '1') return
  // Auto-open the default browser (Windows: 'start', macOS: 'open', Linux: 'xdg-open').
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (err) {
    console.warn('[browser] could not auto-open:', err && err.message)
  }
})
