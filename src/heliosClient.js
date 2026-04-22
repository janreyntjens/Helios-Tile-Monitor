const os = require('os')

function toTitleCaseWords(value) {
  return String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function presetNameCandidates(rawName) {
  const original = String(rawName || '').trim()
  const candidates = [original, toTitleCaseWords(original), original.toLowerCase()]
  return Array.from(new Set(candidates.filter(Boolean)))
}

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  return promise(controller.signal).finally(() => clearTimeout(timeout))
}

function normalizeProcessor(ip, data) {
  const description = data?.sys?.description || data?.sys?.name || ip
  const tilesCount = Number(data?.dev?.display?.tilesCount || 0)
  const redundancy = data?.dev?.display?.redundancy || {}
  const id = data?.sys?.serial || data?.sys?.mac || data?.sys?.id || ip

  return {
    id,
    ip,
    description,
    tilesCount,
    redundancy: {
      info: redundancy.info || '',
      mode: redundancy.mode || '',
      role: redundancy.role || '',
      state: redundancy.state || '',
      status: redundancy.status || ''
    },
    lastSeenAt: Date.now()
  }
}

async function getPublicData(ip, timeoutMs = 1200) {
  const url = `http://${ip}/api/v1/public?sys.description&dev.display.tilesCount&dev.display.redundancy`

  return withTimeout(
    async (signal) => {
      const response = await fetch(url, { method: 'GET', signal })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()
      return normalizeProcessor(ip, data)
    },
    timeoutMs
  )
}

function getLocalSubnets() {
  const interfaces = os.networkInterfaces()
  const subnets = new Map()

  function ipToInt(ip) {
    const parts = String(ip).split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null
    }
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  }

  function intToIp(value) {
    return [
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255
    ].join('.')
  }

  function countMaskBits(maskInt) {
    let value = maskInt >>> 0
    let bits = 0
    while (value) {
      bits += value & 1
      value >>>= 1
    }
    return bits
  }

  for (const ifaceName of Object.keys(interfaces)) {
    for (const net of interfaces[ifaceName] || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (!net.address || !net.netmask) continue

      const addressInt = ipToInt(net.address)
      const maskInt = ipToInt(net.netmask)
      if (addressInt === null || maskInt === null) continue
      const prefixLength = countMaskBits(maskInt)

      const network = (addressInt & maskInt) >>> 0
      const broadcast = (network | (~maskInt >>> 0)) >>> 0

      let start = network
      let end = broadcast

      // Skip network/broadcast where a host range exists.
      if (broadcast - network >= 2) {
        start = network + 1
        end = broadcast - 1
      }

      if (end < start) {
        start = addressInt
        end = addressInt
      }

      const key = `${network}/${maskInt}`
      if (!subnets.has(key)) {
        subnets.set(key, {
          iface: ifaceName,
          address: net.address,
          netmask: net.netmask,
          prefixLength,
          network,
          broadcast,
          start,
          end,
          label: `${ifaceName} ${intToIp(network)}/${net.netmask}`
        })
      }
    }
  }

  return Array.from(subnets.values())
}

async function scanSubnetRange({ startIp, endIp, timeoutMs = 900, concurrency = 20, onProbe = null } = {}) {
  const ips = []
  for (let ip = Number(startIp); ip <= Number(endIp); ip += 1) {
    const a = (ip >>> 24) & 255
    const b = (ip >>> 16) & 255
    const c = (ip >>> 8) & 255
    const d = ip & 255
    ips.push(`${a}.${b}.${c}.${d}`)
  }

  const found = []
  let index = 0

  async function worker() {
    while (index < ips.length) {
      const currentIndex = index
      index += 1
      const ip = ips[currentIndex]

      try {
        const proc = await getPublicData(ip, timeoutMs)
        found.push(proc)
        if (typeof onProbe === 'function') onProbe({ ip, found: true, processor: proc })
      } catch (_) {
        // Ignore unreachable hosts.
        if (typeof onProbe === 'function') onProbe({ ip, found: false })
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return found
}

function getFastScanRange(subnet) {
  const hostCount = subnet.end - subnet.start + 1
  if (subnet.prefixLength >= 24 || hostCount <= 254) {
    return {
      start: subnet.start,
      end: subnet.end,
      label: subnet.label
    }
  }

  // For /16,/12,/8 networks: scan the adapter's local /24 first for speed.
  const addressInt = Number(subnet.start <= subnet.end ? ipFromString(subnet.address) : subnet.network)
  const local24Network = (addressInt & 0xffffff00) >>> 0
  const start = Math.max(subnet.start, local24Network + 1)
  const end = Math.min(subnet.end, local24Network + 254)

  return {
    start,
    end,
    label: `${subnet.label} (fast /24)`
  }
}

function getDeepScanRange(subnet) {
  return {
    start: subnet.start,
    end: subnet.end,
    label: subnet.label
  }
}

function ipFromString(ip) {
  const parts = String(ip).split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return 0
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

async function scanNetwork({ timeoutMs = 450, concurrency = 48, onProgress = null, mode = 'fast' } = {}) {
  const subnets = getLocalSubnets()
  const ranges = subnets.map((subnet) => (mode === 'deep' ? getDeepScanRange(subnet) : getFastScanRange(subnet)))
  const all = []
  const totalHosts = ranges.reduce((sum, range) => sum + (range.end - range.start + 1), 0)
  let scannedHosts = 0

  for (const range of ranges) {
    const results = await scanSubnetRange({
      startIp: range.start,
      endIp: range.end,
      timeoutMs,
      concurrency,
      onProbe: ({ found }) => {
        scannedHosts += 1
        if (typeof onProgress === 'function') {
          onProgress({
            scanned: scannedHosts,
            total: totalHosts,
            found: all.length + (found ? 1 : 0),
            subnet: range.label
          })
        }
      }
    })
    all.push(...results)
  }

  const unique = new Map()
  for (const proc of all) {
    unique.set(proc.id, proc)
  }

  return Array.from(unique.values())
}

async function executeAction(ip, action) {
  if (!ip || !action || !action.type) {
    throw new Error('Invalid action configuration')
  }

  if (action.type === 'preset') {
    const presetName = action.presetName || ''
    if (!presetName) {
      throw new Error('Preset name is required')
    }

    const candidates = presetNameCandidates(presetName)
    let lastStatus = 0
    for (const candidate of candidates) {
      const response = await fetch(`http://${ip}/api/v1/presets/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetName: candidate })
      })

      if (response.ok) {
        return { ok: true, mode: 'preset', presetName: candidate }
      }

      lastStatus = response.status
      // 404 can indicate a casing/name mismatch; try next candidate.
      if (response.status !== 404) {
        throw new Error(`Preset command failed (${response.status})`)
      }
    }

    throw new Error(`Preset command failed (${lastStatus || 404})`)
  }

  if (action.type === 'post' || action.type === 'patch-model') {
    const path = action.path || '/api/v1/public'
    const body = action.body || {}
    const method = action.type === 'patch-model' ? 'PATCH' : 'POST'

    const response = await fetch(`http://${ip}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      throw new Error(`Command failed (${response.status})`)
    }

    return { ok: true, mode: action.type, path }
  }

  throw new Error(`Unsupported action type: ${action.type}`)
}

module.exports = {
  scanNetwork,
  getPublicData,
  executeAction
}
