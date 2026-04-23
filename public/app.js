const dom = {
  appShell: document.getElementById('appShell'),
  scanBtn: document.getElementById('scanBtn'),
  scanProgress: document.getElementById('scanProgress'),
  scanProgressFill: document.getElementById('scanProgressFill'),
  scanProgressText: document.getElementById('scanProgressText'),
  demoBtn: document.getElementById('demoBtn'),
  scanDecksBtn: document.getElementById('scanDecksBtn'),
  disconnectDeckBtn: document.getElementById('disconnectDeckBtn'),
  deckSelect: document.getElementById('deckSelect'),
  deckKeyMap: document.getElementById('deckKeyMap'),
  deckMappings: document.getElementById('deckMappings'),
  toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  removeColumnBtn: document.getElementById('removeColumnBtn'),
  addColumnBtn: document.getElementById('addColumnBtn'),
  boardTitle: document.getElementById('boardTitle'),
  processorList: document.getElementById('processorList'),
  monitorBoard: document.getElementById('monitorBoard'),
  statusLine: document.getElementById('statusLine'),
  expectedModal: document.getElementById('expectedModal'),
  expectedModalTitle: document.getElementById('expectedModalTitle'),
  expectedModalInput: document.getElementById('expectedModalInput'),
  expectedModalSave: document.getElementById('expectedModalSave'),
  expectedModalCancel: document.getElementById('expectedModalCancel')
}

const DEFAULT_COLUMNS = 8
const MIN_COLUMNS = 1
const GRID_ROWS = 4
const ROLE_ROWS = {
  main: 0,
  mainTiles: 1,
  backupTiles: 2,
  backup: 3
}

const boardButtons = []

// Context menu for unmapping deck keys
const contextMenu = document.createElement('div')
contextMenu.className = 'context-menu hidden'
document.body.appendChild(contextMenu)

let state = {
  processors: [],
  config: {
    columnCount: DEFAULT_COLUMNS,
    expectedTilesBySlot: {},
    expectedTilesByProcessor: {},
    streamDeckMappings: []
  },
  slots: [],
  streamDeck: {
    devices: [],
    mappings: []
  }
}

const SIDEBAR_STORAGE_KEY = 'helios.sidebarCollapsed'
const DND_TYPES = {
  processor: 'application/x-helios-processor',
  deckKey: 'application/x-helios-deck-key',
  gridButton: 'application/x-helios-grid-button'
}
const previousDeckKeyState = new Map()

function setStatus(text, isError = false) {
  dom.statusLine.textContent = text
  dom.statusLine.style.color = isError ? '#ff6478' : '#98a2bb'
}

function setScanProgress(visible, percent = 0, text = '') {
  if (!dom.scanProgress || !dom.scanProgressFill || !dom.scanProgressText) return

  dom.scanProgress.classList.toggle('hidden', !visible)
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
  dom.scanProgressFill.style.width = `${clamped}%`
  if (text) {
    dom.scanProgressText.textContent = text
  }
}

// Poll for Stream Deck actions and display them
setInterval(async () => {
  try {
    const response = await fetch('/api/stream-deck/last-action')
    const data = await response.json()
    if (data.action) {
      setStatus(data.action.message, !data.action.success)
    }
  } catch (err) {
    // Polling failed, ignore silently
  }
}, 500)

function hasAssignedProcessor() {
  return (state.slots || []).some((slot) => slot?.mainId || slot?.backupId)
}

function applySidebarMode(collapsed) {
  dom.appShell.classList.toggle('sidebar-collapsed', collapsed)
  dom.toggleSidebarBtn.textContent = collapsed ? '⇥' : '⇤'
  dom.toggleSidebarBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
}

function updateSidebarToggleAvailability() {
  const enabled = hasAssignedProcessor()
  dom.toggleSidebarBtn.disabled = !enabled
  if (!enabled) {
    dom.toggleSidebarBtn.title = 'Assign at least one processor before minimizing'
    applySidebarMode(false)
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'false')
  }
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function shortName(value, max = 16) {
  if (!value) return '-'
  return value.length > max ? `${value.slice(0, max - 1)}.` : value
}

function compareTiles(found, expected) {
  if (expected <= 0) return 'warn'
  if (found === expected) return 'ok'
  if (found < expected) return 'alert'
  return 'warn'
}

function getProcessorHealth(processor, tileClass) {
  if (!processor) {
    return { className: 'empty', blink: false, label: 'UNASSIGNED' }
  }

  if (tileClass === 'alert') {
    return { className: 'alert', blink: true, label: 'TILES MISSING' }
  }

  const redundancy = processor.redundancy || {}
  const summary = [
    redundancy.status,
    redundancy.state,
    redundancy.mode,
    redundancy.info,
    redundancy.role
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (summary.includes('mixed')) {
    return { className: 'alert', blink: false, label: 'MIXED' }
  }

  if (summary.includes('standby')) {
    return { className: 'warn', blink: false, label: 'STANDBY' }
  }

  if (summary.includes('active')) {
    return { className: 'ok', blink: false, label: 'ACTIVE' }
  }

  return { className: 'warn', blink: false, label: 'ONLINE' }
}

function getColumnCount() {
  const fromConfig = Number(state.config?.columnCount || DEFAULT_COLUMNS)
  const fromSlots = Array.isArray(state.slots) ? state.slots.length : 0
  const count = Math.max(fromConfig, fromSlots, MIN_COLUMNS)
  return Number.isInteger(count) ? count : DEFAULT_COLUMNS
}

function getExpectedTiles(role, column, processorKey) {
  const slotKey = `${role}:${column}`
  const slotValue = state.config?.expectedTilesBySlot?.[slotKey]
  if (slotValue !== undefined && slotValue !== null) {
    return Number(slotValue || 0)
  }

  if (!processorKey) return 0
  return Number(state.config?.expectedTilesByProcessor?.[processorKey] || 0)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`)
  }

  return data
}

function setDragPayload(event, type, payload) {
  const encoded = JSON.stringify(payload)
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(type, encoded)
  event.dataTransfer.setData('text/plain', encoded)
}

function getDragPayload(event, type) {
  const raw = event.dataTransfer.getData(type)
  let candidate = raw

  // Some browsers do not expose custom MIME payload during dragover.
  // Fall back to text/plain so drop zones can still accept the drag.
  if (!candidate) {
    candidate = event.dataTransfer.getData('text/plain')
  }

  if (!candidate) return null

  try {
    const parsed = JSON.parse(candidate)

    if (!parsed || typeof parsed !== 'object') return null

    if (type === DND_TYPES.gridButton) {
      return Number.isInteger(Number(parsed.row)) && Number.isInteger(Number(parsed.col)) ? parsed : null
    }

    if (type === DND_TYPES.deckKey) {
      return parsed.deckId != null && parsed.keyIndex != null ? parsed : null
    }

    if (type === DND_TYPES.processor) {
      return parsed.processorId ? parsed : null
    }

    return parsed
  } catch (_error) {
    return null
  }
}

function updateBoardHeader() {
  dom.boardTitle.textContent = `Button Matrix ${getColumnCount()} x ${GRID_ROWS}`
  dom.monitorBoard.style.setProperty('--grid-cols', String(getColumnCount()))
}

function renderProcessors() {
  dom.processorList.innerHTML = ''

  for (const processor of state.processors) {
    const card = document.createElement('div')
    card.className = 'processor-card'
    card.draggable = true
    card.dataset.id = processor.processorKey || processor.id

    card.innerHTML = `
      <strong>${esc(processor.description)}</strong>
      <div class="meta">IP: <a href="http://${esc(processor.ip)}" target="_blank" rel="noopener noreferrer" class="ip-link" title="Open processor web interface">${esc(processor.ip)}</a> | tiles: ${processor.tilesCount}</div>
      <div class="meta">role: ${esc(processor.redundancy?.role || '-')}</div>
    `

    card.addEventListener('dragstart', (event) => {
      setDragPayload(event, DND_TYPES.processor, {
        processorId: processor.processorKey || processor.id
      })
    })

    dom.processorList.appendChild(card)
  }
}

function showDeckKeyContextMenu(event, deckId, keyIndex, mapping) {
  contextMenu.innerHTML = ''
  contextMenu.classList.remove('hidden')

  const unmapBtn = document.createElement('button')
  unmapBtn.type = 'button'
  unmapBtn.textContent = 'Unmap'
  unmapBtn.addEventListener('click', async () => {
    contextMenu.classList.add('hidden')
    try {
      await api('/api/streamdecks/unmap', {
        method: 'POST',
        body: JSON.stringify({ deckId, keyIndex })
      })
      setStatus('Mapping removed.')
      await refreshState()
    } catch (error) {
      setStatus(error.message, true)
    }
  })
  contextMenu.appendChild(unmapBtn)

  contextMenu.style.left = `${event.clientX}px`
  contextMenu.style.top = `${event.clientY}px`

  document.addEventListener('click', closeContextMenu, { once: true })
}

function showBoardContextMenu(event, row, col) {
  const role = getRoleForRow(row)
  if (!role) return

  const slot = state.slots?.[col] || {}
  const assigned = role === 'main' ? slot.main : slot.backup
  if (!assigned) return

  contextMenu.innerHTML = ''
  contextMenu.classList.remove('hidden')

  const unassignBtn = document.createElement('button')
  unassignBtn.type = 'button'
  unassignBtn.textContent = `Unassign ${role.toUpperCase()} C${col + 1}`
  unassignBtn.addEventListener('click', async () => {
    contextMenu.classList.add('hidden')
    try {
      await api('/api/unassign', {
        method: 'POST',
        body: JSON.stringify({ role, column: col })
      })
      setStatus(`${role.toUpperCase()} unassigned from column ${col + 1}.`)
      await refreshState()
    } catch (error) {
      setStatus(error.message, true)
    }
  })
  contextMenu.appendChild(unassignBtn)

  contextMenu.style.left = `${event.clientX}px`
  contextMenu.style.top = `${event.clientY}px`

  document.addEventListener('click', closeContextMenu, { once: true })
}

function closeContextMenu() {
  contextMenu.classList.add('hidden')
}

function renderStreamDeckPanel() {
  const devices = state.streamDeck?.devices || []
  const mappings = state.streamDeck?.mappings || []

  dom.deckSelect.innerHTML = ''
  for (const device of devices) {
    const option = document.createElement('option')
    option.value = device.id
    option.textContent = `${device.model} (${device.id})`
    dom.deckSelect.appendChild(option)
  }

  if (devices.length === 0) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'No Stream Deck found'
    dom.deckSelect.appendChild(option)
  }

  if (devices.length > 0 && !Array.from(dom.deckSelect.options).some((o) => o.value === dom.deckSelect.value)) {
    dom.deckSelect.value = devices[0].id
  }

  // Mappings list is now hidden; users can unmap via right-click on deck keys
  dom.deckMappings.innerHTML = ''

  renderDeckKeyMap()
}

function calculateDeckKeyColumns(keyCount) {
  // Map common Stream Deck key counts to optimal grid layouts
  const layouts = {
    6: 3,    // Mini: 2x3
    15: 5,   // Old format
    20: 5,   // Old format
    32: 8,   // Plus/Pro: 4x8
    40: 8    // Original: 5x8
  }

  if (layouts[keyCount]) {
    return layouts[keyCount]
  }

  // For unknown counts, calculate: prefer wider layouts for typical decks
  if (keyCount <= 6) return 3
  if (keyCount <= 15) return 5
  if (keyCount <= 32) return 8
  return Math.ceil(Math.sqrt(keyCount))
}

function getGridButtonLabel(row, col) {
  const slot = state.slots?.[col] || { main: null, backup: null }
  if (row === ROLE_ROWS.main) {
    return `GO MAIN C${col + 1} (${slot.main?.description || 'unassigned'})`
  }
  if (row === ROLE_ROWS.mainTiles) {
    return `MAIN TILES C${col + 1}`
  }
  if (row === ROLE_ROWS.backupTiles) {
    return `BACKUP TILES C${col + 1}`
  }
  if (row === ROLE_ROWS.backup) {
    return `GO BACKUP C${col + 1} (${slot.backup?.description || 'unassigned'})`
  }
  return `Button ${row + 1}.${col + 1}`
}

function getGridButtonBadge(row) {
  if (row === ROLE_ROWS.main) return 'M'
  if (row === ROLE_ROWS.mainTiles) return 'MT'
  if (row === ROLE_ROWS.backupTiles) return 'BT'
  if (row === ROLE_ROWS.backup) return 'B'
  return '?'
}

function renderDeckKeyMap() {
  const deckId = dom.deckSelect.value
  const devices = state.streamDeck?.devices || []
  const mappings = state.streamDeck?.mappings || []
  const selectedDeck = devices.find((d) => d.id === deckId)

  dom.deckKeyMap.innerHTML = ''

  if (!selectedDeck) {
    dom.deckKeyMap.innerHTML = '<div class="meta">No deck selected.</div>'
    return
  }

  const keyCount = Number(selectedDeck.keyCount || 0)
  if (!Number.isInteger(keyCount) || keyCount <= 0) {
    dom.deckKeyMap.innerHTML = '<div class="meta">No key metadata available.</div>'
    return
  }

  const colCount = calculateDeckKeyColumns(keyCount)
  dom.deckKeyMap.style.setProperty('--deck-key-cols', String(colCount))
  const nextDeckState = new Map()

  for (let index = 0; index < keyCount; index += 1) {
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.className = 'deck-key'
    cell.draggable = true

    const activeMapping = mappings.find((m) => m.deckId === deckId && Number(m.keyIndex) === index)
    const stateKey = `${deckId}:${index}`
    const currentState = activeMapping ? `${Number(activeMapping.row)}:${Number(activeMapping.col)}` : ''
    const previousState = previousDeckKeyState.get(stateKey) || ''

    if (activeMapping) {
      cell.classList.add('mapped')
    }

    if (!previousState && currentState) {
      cell.classList.add('map-pulse')
    } else if (previousState && !currentState) {
      cell.classList.add('unmap-pulse')
    } else if (previousState && currentState && previousState !== currentState) {
      cell.classList.add('remap-pulse')
    }

    const targetLabel = activeMapping
      ? getGridButtonLabel(Number(activeMapping.row), Number(activeMapping.col))
      : 'Drop a board button here'

    cell.innerHTML = `<span class="deck-key-index">K${index + 1}</span><span class="deck-key-target">${esc(targetLabel)}</span>`

    cell.addEventListener('dragstart', (event) => {
      setDragPayload(event, DND_TYPES.deckKey, {
        deckId,
        keyIndex: index
      })
    })

    cell.addEventListener('dragover', (event) => {
      // Always allow hover drop, validate payload in drop handler.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      if (getDragPayload(event, DND_TYPES.gridButton)) {
        cell.classList.add('drag-over')
      }
    })

    cell.addEventListener('dragleave', () => {
      cell.classList.remove('drag-over')
    })

    cell.addEventListener('drop', async (event) => {
      cell.classList.remove('drag-over')
      const gridPayload = getDragPayload(event, DND_TYPES.gridButton)
      if (!gridPayload) return

      event.preventDefault()
      try {
        await createDeckMapping(deckId, index, Number(gridPayload.row), Number(gridPayload.col))
      } catch (error) {
        setStatus(error.message, true)
      }
    })

    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (!activeMapping) {
        return
      }
      showDeckKeyContextMenu(event, deckId, index, activeMapping)
    })

    dom.deckKeyMap.appendChild(cell)
    nextDeckState.set(stateKey, currentState)
  }

  for (const key of Array.from(previousDeckKeyState.keys())) {
    if (key.startsWith(`${deckId}:`)) {
      previousDeckKeyState.delete(key)
    }
  }
  for (const [key, value] of nextDeckState.entries()) {
    previousDeckKeyState.set(key, value)
  }
}

function paintBoardButtons() {
  for (const btn of boardButtons) {
    const row = Number(btn.dataset.row)
    const col = Number(btn.dataset.col)
    const slot = state.slots?.[col] || { main: null, backup: null, mainId: null, backupId: null }

    const main = slot.main
    const backup = slot.backup
    const mainTiles = Number(main?.tilesCount || 0)
    const backupTiles = Number(backup?.tilesCount || 0)
    const expectedMain = getExpectedTiles('main', col, slot.mainId)
    const expectedBackup = getExpectedTiles('backup', col, slot.backupId)
    const mainClass = compareTiles(mainTiles, expectedMain)
    const backupClass = compareTiles(backupTiles, expectedBackup)
    const mainHealth = getProcessorHealth(main, mainClass)
    const backupHealth = getProcessorHealth(backup, backupClass)

    let className = 'pad-btn'

    if (row === ROLE_ROWS.main) {
      className += ` ${mainHealth.className} processor`
      if (mainHealth.blink) className += ' blink'
      btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="status-big">${esc(mainHealth.label)}</span><span class="caption">${esc(shortName(main?.description || 'unassigned'))}</span>`
    } else if (row === ROLE_ROWS.mainTiles) {
      if (!main) {
        className += ' empty tiles'
        btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="big-value">-</span><span class="caption">Main tiles | unassigned</span>`
      } else {
        className += ` ${mainClass} tiles`
        if (mainClass === 'alert') className += ' blink'
        btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="big-value">${mainTiles}</span><span class="caption">Main tiles | expected ${expectedMain}</span>`
      }
    } else if (row === ROLE_ROWS.backupTiles) {
      if (!backup) {
        className += ' empty tiles'
        btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="big-value">-</span><span class="caption">Backup tiles | unassigned</span>`
      } else {
        className += ` ${backupClass} tiles`
        if (backupClass === 'alert') className += ' blink'
        btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="big-value">${backupTiles}</span><span class="caption">Backup tiles | expected ${expectedBackup}</span>`
      }
    } else if (row === ROLE_ROWS.backup) {
      className += ` ${backupHealth.className} processor`
      if (backupHealth.blink) className += ' blink'
      btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="status-big">${esc(backupHealth.label)}</span><span class="caption">${esc(shortName(backup?.description || 'unassigned'))}</span>`
    } else {
      btn.innerHTML = `<span class="slot">R${row + 1} C${col + 1}</span><span class="label">Slot ${row + 1}.${col + 1}</span>`
    }

    btn.className = className
  }
}

function getRoleForRow(row) {
  if (row === ROLE_ROWS.main) return 'main'
  if (row === ROLE_ROWS.backup) return 'backup'
  return null
}

function askExpectedTiles(title, currentValue) {
  return new Promise((resolve) => {
    dom.expectedModalTitle.textContent = title
    dom.expectedModalInput.value = String(currentValue)
    dom.expectedModal.classList.remove('hidden')
    dom.expectedModal.setAttribute('aria-hidden', 'false')
    dom.expectedModalInput.focus()
    dom.expectedModalInput.select()

    const close = (value) => {
      dom.expectedModal.classList.add('hidden')
      dom.expectedModal.setAttribute('aria-hidden', 'true')
      dom.expectedModalSave.removeEventListener('click', onSave)
      dom.expectedModalCancel.removeEventListener('click', onCancel)
      dom.expectedModal.removeEventListener('click', onBackdrop)
      dom.expectedModalInput.removeEventListener('keydown', onKeyDown)
      resolve(value)
    }

    const onSave = () => {
      const parsed = Number(dom.expectedModalInput.value)
      if (!Number.isFinite(parsed) || parsed < 0) {
        close(NaN)
        return
      }
      close(Math.round(parsed))
    }

    const onCancel = () => close(null)
    const onBackdrop = (event) => {
      if (event.target === dom.expectedModal) close(null)
    }

    const onKeyDown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onSave()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }

    dom.expectedModalSave.addEventListener('click', onSave)
    dom.expectedModalCancel.addEventListener('click', onCancel)
    dom.expectedModal.addEventListener('click', onBackdrop)
    dom.expectedModalInput.addEventListener('keydown', onKeyDown)
  })
}

async function setExpectedTilesForSlot(processor, processorKey, role, column, rowLabel) {
  const currentExpected = getExpectedTiles(role, column, processorKey)
  const suggestedValue = Number.isFinite(Number(processor?.tilesCount)) ? Number(processor.tilesCount) : currentExpected
  const processorName = processor?.description || `${role.toUpperCase()} column ${column + 1}`
  const processorIp = processor?.ip || 'manual value'
  const value = await askExpectedTiles(
    `Expected tiles for ${processorName} (${processorIp})`,
    suggestedValue
  )

  if (value === null) return
  if (!Number.isFinite(value) || value < 0) {
    setStatus('Enter a valid number >= 0.', true)
    return
  }

  await api('/api/expected-tiles', {
    method: 'POST',
    body: JSON.stringify({
      role,
      column,
      processorId: processorKey,
      expected: Math.round(value)
    })
  })

  setStatus(`Expected ${role} tiles saved for column ${column + 1}.`)
  await refreshState()
}

function pickProcessorFromDiscovered(rowLabel) {
  if (!Array.isArray(state.processors) || state.processors.length === 0) {
    setStatus(`No assigned processor on ${rowLabel}, and no discovered processors available.`, true)
    return null
  }

  const lines = state.processors
    .map((p, i) => `${i + 1}. ${p.description} (${p.ip})`)
    .join('\n')

  const selected = window.prompt(
    `No processor assigned on ${rowLabel}.\nChoose processor number:\n\n${lines}`,
    '1'
  )

  if (selected === null) return null
  const index = Number(selected) - 1
  if (!Number.isInteger(index) || index < 0 || index >= state.processors.length) {
    setStatus('Invalid processor selection.', true)
    return null
  }

  const chosen = state.processors[index]
  return {
    processor: chosen,
    processorKey: chosen.processorKey || chosen.id
  }
}

async function assign(role, id, column) {
  await api('/api/assign', {
    method: 'POST',
    body: JSON.stringify({ role, id, column })
  })
  setStatus(`${role.toUpperCase()} assigned on column ${column + 1}.`)
  await refreshState()
}

async function triggerCommand(role, column) {
  const result = await api(`/api/command/${role}`, {
    method: 'POST',
    body: JSON.stringify({ column })
  })
  const targetName = result?.target?.description || result?.target?.ip || role
  setStatus(`Command executed on ${targetName} (column ${column + 1}).`)
}

function createBoard() {
  dom.monitorBoard.innerHTML = ''
  boardButtons.length = 0

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < getColumnCount(); col += 1) {
      const button = document.createElement('button')
      button.className = 'pad-btn'
      button.dataset.row = String(row)
      button.dataset.col = String(col)
      button.type = 'button'
      button.draggable = true

      button.addEventListener('dragstart', (event) => {
        setDragPayload(event, DND_TYPES.gridButton, { row, col })
      })

      button.addEventListener('click', async () => {
        try {
          if (row === ROLE_ROWS.main) {
            await triggerCommand('main', col)
          } else if (row === ROLE_ROWS.mainTiles) {
            const slot = state.slots?.[col]
            await setExpectedTilesForSlot(slot?.main, slot?.mainId, 'main', col, `row 2 column ${col + 1}`)
          } else if (row === ROLE_ROWS.backupTiles) {
            const slot = state.slots?.[col]
            await setExpectedTilesForSlot(slot?.backup, slot?.backupId, 'backup', col, `row 3 column ${col + 1}`)
          } else if (row === ROLE_ROWS.backup) {
            await triggerCommand('backup', col)
          }
        } catch (error) {
          setStatus(error.message, true)
        }
      })

      button.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        showBoardContextMenu(event, row, col)
      })

      button.addEventListener('dragover', (event) => {
        // Some browsers don't expose drag payload during dragover.
        // Always allow drop and validate the payload in drop handler.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        button.classList.add('drag-over')
      })

      button.addEventListener('dragleave', () => {
        button.classList.remove('drag-over')
      })

      button.addEventListener('drop', async (event) => {
        button.classList.remove('drag-over')
        const deckKeyPayload = getDragPayload(event, DND_TYPES.deckKey)
        const processorPayload = getDragPayload(event, DND_TYPES.processor)

        if (deckKeyPayload) {
          event.preventDefault()
          try {
            await createDeckMapping(deckKeyPayload.deckId, Number(deckKeyPayload.keyIndex), row, col)
          } catch (error) {
            setStatus(error.message, true)
          }
          return
        }

        if (processorPayload) {
          event.preventDefault()
          const role = getRoleForRow(row)

          if (!role) {
            setStatus('Drop processors on row 1 for MAIN or row 4 for BACKUP.', true)
            return
          }

          try {
            await assign(role, processorPayload.processorId, col)
          } catch (error) {
            setStatus(error.message, true)
          }
        }
      })

      boardButtons.push(button)
      dom.monitorBoard.appendChild(button)
    }
  }
}

function loadDemoData() {
  const makeProcessor = (id, name, ip, role, status, tiles, expected) => ({
    id,
    processorKey: id,
    description: name,
    ip,
    tilesCount: tiles,
    redundancy: { role, status, state: status, mode: 'auto', info: '', active: status === 'active' }
  })

  const demoProcessors = [
    makeProcessor('p1', 'HELIOS-MAIN-01', '192.168.1.101', 'active', 'active', 24, 24),
    makeProcessor('p2', 'HELIOS-BACKUP-01', '192.168.1.102', 'standby', 'standby', 24, 24),
    makeProcessor('p3', 'HELIOS-MAIN-02', '192.168.1.103', 'active', 'active', 12, 16),
    makeProcessor('p4', 'HELIOS-BACKUP-02', '192.168.1.104', 'standby', 'mixed', 12, 16),
    makeProcessor('p5', 'HELIOS-SOLO', '192.168.1.105', 'active', 'active', 0, 8),
  ]

  const cols = 3
  const demoSlots = Array.from({ length: cols }, (_, i) => ({
    main: i < demoProcessors.length ? { ...demoProcessors[i * 2] } : null,
    backup: i * 2 + 1 < demoProcessors.length ? { ...demoProcessors[i * 2 + 1] } : null
  }))

  state = {
    ...state,
    processors: demoProcessors,
    config: {
      ...state.config,
      columnCount: cols,
      expectedTilesBySlot: {
        'main:0': 24, 'backup:0': 24,
        'main:1': 16, 'backup:1': 16,
        'main:2': 8,  'backup:2': 0
      }
    },
    slots: demoSlots
  }

  updateBoardHeader()
  createBoard()
  renderProcessors()
  paintBoardButtons()
  setStatus('Demo data geladen — dit zijn nep-processors.')
}

async function refreshState() {
  const data = await api('/api/state')
  state = {
    processors: Array.isArray(data.processors) ? data.processors : [],
    config: data.config || { columnCount: DEFAULT_COLUMNS, expectedTilesBySlot: {}, expectedTilesByProcessor: {}, streamDeckMappings: [] },
    slots: Array.isArray(data.slots) ? data.slots : [],
    streamDeck: data.streamDeck || { devices: [], mappings: [] }
  }

  updateBoardHeader()
  createBoard()
  renderProcessors()
  renderStreamDeckPanel()
  paintBoardButtons()
  updateSidebarToggleAvailability()
}

async function scan() {
  dom.scanBtn.disabled = true
  setStatus('Fast scan running on all adapter subnets...')
  setScanProgress(true, 0, 'Preparing scan...')

  let requestFinished = false
  const poll = (async () => {
    while (true) {
      try {
        const info = await api('/api/scan/status')
        const status = info?.status || {}
        const phase = String(status.phase || 'idle')
        const total = Number(status.total || 0)
        const scanned = Number(status.scanned || 0)
        const found = Number(status.found || 0)
        const percent = total > 0 ? (scanned / total) * 100 : 0
        const subnet = status.subnet ? ` | ${status.subnet}` : ''
        const phaseLabel = phase === 'fast' ? 'Fast scan' : 'Scan'
        setScanProgress(true, percent, `${phaseLabel}: ${scanned}/${total} hosts, found ${found}${subnet}`)

        if (requestFinished && !status.active) {
          setScanProgress(true, 100, `Fast scan complete: ${found} processor(s) found.`)
          return
        }
      } catch (_) {
        // Polling failures are transient; keep scanning.
      }

      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()

  try {
    const result = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify({})
    })
    requestFinished = true

    setStatus(`Fast scan complete: ${result.fastCount || result.count} processor(s) found.`)
    await refreshState()
  } finally {
    requestFinished = true
    dom.scanBtn.disabled = false
    await poll
  }
}

async function addColumn() {
  await api('/api/columns/add', { method: 'POST' })
  setStatus('Column added.')
  await refreshState()
}

async function removeColumn() {
  await api('/api/columns/remove', { method: 'POST' })
  setStatus('Column erased.')
  await refreshState()
}

async function clearAll() {
  const confirmed = window.confirm('Clear all assignments, expected tiles, Stream Deck mappings, and reset columns to default?')
  if (!confirmed) return

  closeContextMenu()
  await api('/api/reset', { method: 'POST' })
  setStatus('Everything cleared. You can start from zero.')
  await refreshState()
}

async function scanStreamDecks() {
  await api('/api/streamdecks/scan', { method: 'POST' })
  setStatus('Stream Deck scan complete.')
  await refreshState()
}

async function disconnectStreamDeck() {
  const deckId = dom.deckSelect.value
  if (!deckId) {
    setStatus('No Stream Deck selected.', true)
    return
  }

  await api('/api/streamdecks/disconnect', {
    method: 'POST',
    body: JSON.stringify({ deckId })
  })

  setStatus(`Stream Deck ${deckId} disconnected. Use Scan Decks to reconnect.`)
  await refreshState()
}

async function createDeckMapping(deckId, keyIndex, row, col) {
  await api('/api/streamdecks/map', {
    method: 'POST',
    body: JSON.stringify({ deckId, keyIndex, row, col })
  })

  const mappedLabel = getGridButtonLabel(row, col)
  setStatus(`Mapped key ${keyIndex + 1} to ${mappedLabel}.`)
  await refreshState()
}

function wireEvents() {
  dom.scanBtn.addEventListener('click', async () => {
    try {
      await scan()
    } catch (error) {
      setStatus(error.message, true)
    }
  })

  dom.addColumnBtn.addEventListener('click', async () => {
    try {
      await addColumn()
    } catch (error) {
      setStatus(error.message, true)
    }
  })

  dom.removeColumnBtn.addEventListener('click', async () => {
    try {
      await removeColumn()
    } catch (error) {
      setStatus(error.message, true)
    }
  })

  dom.clearAllBtn.addEventListener('click', async () => {
    try {
      await clearAll()
    } catch (error) {
      setStatus(error.message, true)
    }
  })

  dom.toggleSidebarBtn.addEventListener('click', () => {
    if (dom.toggleSidebarBtn.disabled) return
    const nextCollapsed = !dom.appShell.classList.contains('sidebar-collapsed')
    applySidebarMode(nextCollapsed)
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(nextCollapsed))
  })

  dom.demoBtn.addEventListener('click', () => {
    loadDemoData()
  })

  dom.scanDecksBtn.addEventListener('click', async () => {
    try {
      await scanStreamDecks()
    } catch (error) {
      setStatus(error.message, true)
    }
  })

  dom.disconnectDeckBtn.addEventListener('click', async () => {
    try {
      await disconnectStreamDeck()
    } catch (error) {
      setStatus(error.message, true)
    }
  })

  dom.deckSelect.addEventListener('change', () => {
    renderDeckKeyMap()
  })
}

async function init() {
  wireEvents()

  const savedCollapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  applySidebarMode(savedCollapsed)

  try {
    await refreshState()
  } catch (error) {
    setStatus(error.message, true)
  }

  setInterval(async () => {
    try {
      await refreshState()
    } catch (_) {
      // Background refresh error ignored.
    }
  }, 2000)
}

init()
