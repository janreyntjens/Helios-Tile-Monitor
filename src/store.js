const fs = require('fs')
const path = require('path')

const dataDir = path.join(process.pkg ? path.dirname(process.execPath) : process.cwd(), 'data')
const dataPath = path.join(dataDir, 'state.json')
const DEFAULT_COLUMNS = 8
const MIN_COLUMNS = 1

function emptyColumns(count = DEFAULT_COLUMNS) {
  return Array.from({ length: count }, () => ({
    main: null,
    backup: null
  }))
}

const defaultState = {
  config: {
    columnCount: DEFAULT_COLUMNS,
    expectedTilesBySlot: {},
    expectedTilesByProcessor: {},
    streamDeckMappings: [],
    goMainAction: {
      type: 'patch-model',
      path: '/api/v1/public',
      body: {
        dev: {
          display: {
            redundancy: {
              state: 'main'
            }
          }
        }
      }
    },
    goBackupAction: {
      type: 'patch-model',
      path: '/api/v1/public',
      body: {
        dev: {
          display: {
            redundancy: {
              state: 'backup'
            }
          }
        }
      }
    }
  },
  assignments: {
    columns: emptyColumns()
  }
}

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify(defaultState, null, 2), 'utf8')
  }
}

function loadState() {
  ensureStore()
  const raw = fs.readFileSync(dataPath, 'utf8')

  try {
    const parsed = JSON.parse(raw)
    const parsedAssignments = parsed.assignments || {}
    const parsedColumnCount = Number(parsed?.config?.columnCount || DEFAULT_COLUMNS)
    const baseColumnCount = Number.isInteger(parsedColumnCount) && parsedColumnCount >= MIN_COLUMNS
      ? parsedColumnCount
      : DEFAULT_COLUMNS
    const columnCount = Math.max(
      baseColumnCount,
      Array.isArray(parsedAssignments.columns) ? parsedAssignments.columns.length : 0
    )
    const columns = emptyColumns(columnCount)

    if (Array.isArray(parsedAssignments.columns)) {
      for (let i = 0; i < columns.length; i += 1) {
        columns[i] = {
          ...columns[i],
          ...(parsedAssignments.columns[i] || {})
        }
      }
    } else {
      // Backward compatibility with old shape { main, backup }.
      columns[0] = {
        main: parsedAssignments.main || null,
        backup: parsedAssignments.backup || null
      }
    }

    return {
      ...defaultState,
      ...parsed,
      config: {
        ...defaultState.config,
        ...(parsed.config || {}),
        columnCount
      },
      assignments: {
        columns
      }
    }
  } catch (error) {
    return {
      ...defaultState,
      assignments: {
        columns: emptyColumns(DEFAULT_COLUMNS)
      }
    }
  }
}

function saveState(nextState) {
  ensureStore()
  fs.writeFileSync(dataPath, JSON.stringify(nextState, null, 2), 'utf8')
}

module.exports = {
  loadState,
  saveState,
  defaultState
}
