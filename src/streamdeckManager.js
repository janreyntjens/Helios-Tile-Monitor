class StreamDeckManager {
  constructor(onKeyDown) {
    this.onKeyDown = onKeyDown
    this.devices = []
    this.openedDecks = new Map()
    this.lastAppliedSignaturesByDeck = new Map()
    this.lastMappedKeysByDeck = new Map()
    this.available = false
    this.sdk = null

    try {
      // Optional at runtime: app keeps working without Stream Deck package/hardware.
      this.sdk = require('@elgato-stream-deck/node')
      this.available = true
    } catch (_error) {
      this.available = false
    }
  }

  getDeviceId(device) {
    return device.serialNumber || device.path
  }

  normalizeKeyIndex(input) {
    const direct = Number(input)
    if (Number.isInteger(direct) && direct >= 0) {
      return direct
    }

    if (input && typeof input === 'object') {
      const fromIndex = Number(input.index)
      if (Number.isInteger(fromIndex) && fromIndex >= 0) {
        return fromIndex
      }

      const fromHidIndex = Number(input.hidIndex)
      if (Number.isInteger(fromHidIndex) && fromHidIndex >= 0) {
        return fromHidIndex
      }
    }

    return null
  }

  resolveKeyCount(device) {
    const direct = Number(device?.keyCount || 0)
    if (Number.isInteger(direct) && direct > 0) {
      return direct
    }

    const model = String(device?.model || device?.productName || '').toLowerCase()
    if (model.includes('mini')) return 6
    if (model.includes('pedal')) return 3
    if (model.includes('neo')) return 8
    if (model.includes('xl')) return 32
    if (model.includes('plus')) return 32
    if (model.includes('original')) return 15
    if (model.includes('mk.2')) return 15

    return 15
  }

  getDevices() {
    return this.devices.map((device) => {
      const id = this.getDeviceId(device)
      return {
        id,
        path: device.path,
        serialNumber: device.serialNumber || '',
        model: device.productName || device.model || 'Stream Deck',
        keyCount: this.resolveKeyCount(device),
        connected: this.openedDecks.has(id)
      }
    })
  }

  async scanAndConnect() {
    if (!this.available) {
      console.log('[StreamDeck] SDK not available')
      this.devices = []
      return []
    }

    try {
      const list = await this.sdk.listStreamDecks()
      this.devices = Array.isArray(list) ? list : []
      console.log(`[StreamDeck] Found ${this.devices.length} device(s)`)
    } catch (error) {
      console.error('[StreamDeck] List error:', error.message)
      this.devices = []
      return []
    }

    const seen = new Set()

    for (const device of this.devices) {
      const id = this.getDeviceId(device)
      seen.add(id)

      if (!this.openedDecks.has(id)) {
        try {
          console.log(`[StreamDeck] Opening device ${id}...`)
          const deck = await this.sdk.openStreamDeck(device.path)

          try {
            if (typeof deck.setBrightness === 'function') {
              await deck.setBrightness(100)
              console.log(`[StreamDeck] Brightness set to 100% on ${id}`)
            }
          } catch (error) {
            console.warn(`[StreamDeck] Failed to set brightness on ${id}:`, error.message)
          }
          
          deck.on('down', (eventPayload) => {
            const keyIndex = this.normalizeKeyIndex(eventPayload)
            if (keyIndex === null) {
              console.warn('[StreamDeck] Unsupported down payload, key press ignored')
              return
            }

            console.log(`[StreamDeck] Key ${keyIndex} pressed on ${id}`)
            Promise.resolve(this.onKeyDown({ deckId: id, keyIndex })).catch((err) => {
              console.error('[StreamDeck] Callback error:', err.message)
            })
          })
          
          this.openedDecks.set(id, { deck, device })
          this.lastAppliedSignaturesByDeck.delete(id)
          this.lastMappedKeysByDeck.delete(id)
          console.log(`[StreamDeck] Device ${id} opened and listening`)
          
          // Clear the panel to replace Elgato logo
          this.clearDevice(deck, id)
        } catch (error) {
          console.error(`[StreamDeck] Failed to open device ${id}:`, error.message)
        }
      }
    }

    for (const [id, entry] of this.openedDecks.entries()) {
      if (!seen.has(id)) {
        try {
          console.log(`[StreamDeck] Closing disconnected device ${id}`)
          await entry.deck.close()
        } catch (error) {
          console.error(`[StreamDeck] Failed to close device ${id}:`, error.message)
        }
        this.openedDecks.delete(id)
        this.lastAppliedSignaturesByDeck.delete(id)
        this.lastMappedKeysByDeck.delete(id)
      }
    }

    return this.getDevices()
  }

  clearDevice(deck, deckId) {
    try {
      if (typeof deck.clearPanel === 'function') {
        deck.clearPanel()
        console.log(`[StreamDeck] Cleared panel on ${deckId}`)
      }
    } catch (error) {
      console.error(`[StreamDeck] Failed to clear panel on ${deckId}:`, error.message)
    }
  }

  async disconnectDevice(deckId) {
    const entry = this.openedDecks.get(deckId)
    if (!entry) {
      console.warn(`[StreamDeck] Device ${deckId} not found in openedDecks`)
      return false
    }

    try {
      await entry.deck.close()
      console.log(`[StreamDeck] Closed device ${deckId}`)
    } catch (error) {
      console.error(`[StreamDeck] Failed to close device ${deckId}:`, error.message)
    }

    this.openedDecks.delete(deckId)
    this.lastAppliedSignaturesByDeck.delete(deckId)
    this.lastMappedKeysByDeck.delete(deckId)

    return true
  }

  compareTiles(found, expected) {
    if (expected <= 0) return 'warn'
    if (found === expected) return 'ok'
    if (found < expected) return 'alert'
    return 'warn'
  }

  getProcessorHealth(processor, tileClass) {
    if (!processor) {
      return { className: 'empty', shouldBlink: false, statusText: '' }
    }

    if (tileClass === 'alert') {
      return { className: 'alert', shouldBlink: true, statusText: 'LOW TILES' }
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
      return { className: 'alert', shouldBlink: false, statusText: 'MIXED' }
    }

    if (summary.includes('standby')) {
      return { className: 'warn', shouldBlink: false, statusText: 'STANDBY' }
    }

    if (summary.includes('active')) {
      return { className: 'ok', shouldBlink: false, statusText: 'ACTIVE' }
    }

    return { className: 'warn', shouldBlink: false, statusText: 'ONLINE' }
  }

  formatDisplayLine(value, max = 12) {
    const clean = String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9 .\/-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (clean.length <= max) return clean
    return `${clean.slice(0, Math.max(0, max - 1))}.`
  }

  formatStatusForDeck(value) {
    const clean = String(value || '').toUpperCase().trim()
    if (!clean) return 'EMPTY'
    if (clean === 'ACTIVE') return 'ACTV'
    if (clean === 'STANDBY') return 'STBY'
    if (clean === 'MIXED') return 'MIXD'
    if (clean === 'LOW TILES') return 'LOW'
    if (clean === 'TILES MISSING') return 'LOW'
    if (clean === 'UNASSIGNED') return 'EMPTY'
    if (clean === 'ONLINE') return 'ON'
    return clean.length > 5 ? clean.slice(0, 5) : clean
  }

  getMappedVisual(mapping, context = {}) {
    const slots = Array.isArray(context.slots) ? context.slots : []
    const expectedBySlot = context.expectedTilesBySlot || {}
    const expectedByProcessor = context.expectedTilesByProcessor || {}
    const slot = slots[Number(mapping.col)] || {}

    const getExpected = (role, processorId) => {
      const slotKey = `${role}:${Number(mapping.col)}`
      if (expectedBySlot[slotKey] !== undefined && expectedBySlot[slotKey] !== null) {
        return Number(expectedBySlot[slotKey] || 0)
      }
      return Number(expectedByProcessor?.[processorId] || 0)
    }

    if (Number(mapping.row) === 0) {
      const label = slot.main?.description || 'UNASSIGNED'
      const found = Number(slot.main?.tilesCount || 0)
      const expected = getExpected('main', slot.mainId)
      const health = this.getProcessorHealth(slot.main, this.compareTiles(found, expected))
      return {
        line1: '[M] MAIN',
        line2: this.formatStatusForDeck(health.statusText),
        line3: this.formatDisplayLine(label, 8),
        className: health.className,
        shouldBlink: health.shouldBlink,
        emphasizeLine2: true
      }
    }

    if (Number(mapping.row) === 1) {
      const found = Number(slot.main?.tilesCount || 0)
      const expected = getExpected('main', slot.mainId)
      const className = this.compareTiles(found, expected)
      return {
        line1: '[MT] TILES',
        line2: `${found}`,
        line3: `${found}/${expected}`,
        className,
        shouldBlink: className === 'alert',
        emphasizeLine2: true
      }
    }

    if (Number(mapping.row) === 2) {
      const found = Number(slot.backup?.tilesCount || 0)
      const expected = getExpected('backup', slot.backupId)
      const className = this.compareTiles(found, expected)
      return {
        line1: '[BT] TILES',
        line2: `${found}`,
        line3: `${found}/${expected}`,
        className,
        shouldBlink: className === 'alert',
        emphasizeLine2: true
      }
    }

    const label = slot.backup?.description || 'UNASSIGNED'
    const backupFound = Number(slot.backup?.tilesCount || 0)
    const backupExpected = getExpected('backup', slot.backupId)
    const backupTilesClass = this.compareTiles(backupFound, backupExpected)
    const health = this.getProcessorHealth(slot.backup, backupTilesClass)
    return {
      line1: '[B] BACKUP',
      line2: this.formatStatusForDeck(health.statusText),
      line3: this.formatDisplayLine(label, 8),
      className: health.className,
      shouldBlink: health.shouldBlink,
      emphasizeLine2: true
    }
  }

  getClassColor(className, shouldBlink = false, blinkOn = true) {
    if (shouldBlink && !blinkOn) return [8, 10, 18]
    if (className === 'ok') return [0, 210, 120]
    if (className === 'warn') return [255, 150, 0]
    if (className === 'alert') return [255, 45, 70]
    if (className === 'empty') return [72, 80, 96]
    return [12, 16, 28]
  }

  getFontGlyph(ch) {
    const font = {
      ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
      '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
      '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
      '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
      '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
      '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
      '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
      '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
      '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
      '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
      '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
      '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
      '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
      '9': ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
      'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
      'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
      'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
      'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
      'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
      'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
      'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
      'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
      'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
      'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
      'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
      'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
      'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
      'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
      'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
      'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
      'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
      'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
      'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
      'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
      'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
      'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
      'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
      'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
      'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100']
      ,
      'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
      '[': ['01110', '01000', '01000', '01000', '01000', '01000', '01110'],
      ']': ['01110', '00010', '00010', '00010', '00010', '00010', '01110']
    }

    return font[ch] || font[' ']
  }

  drawText(buffer, width, height, text, x, y, color, opts = {}) {
    const value = String(text || '').toUpperCase().slice(0, 12)
    const scale = Number(opts.scale || 1)
    const bold = Boolean(opts.bold)
    let cursorX = x

    const drawPixel = (px, py) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return
      const i = (py * width + px) * 4
      buffer[i] = color[0]
      buffer[i + 1] = color[1]
      buffer[i + 2] = color[2]
      buffer[i + 3] = 255
    }

    for (const ch of value) {
      const glyph = this.getFontGlyph(ch)
      for (let row = 0; row < glyph.length; row += 1) {
        for (let col = 0; col < glyph[row].length; col += 1) {
          if (glyph[row][col] !== '1') continue

          const baseX = cursorX + col * scale
          const baseY = y + row * scale

          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              drawPixel(baseX + sx, baseY + sy)
              if (bold) drawPixel(baseX + sx + 1, baseY + sy)
            }
          }
        }
      }
      cursorX += 6 * scale + (bold ? 1 : 0)
    }
  }

  measureTextWidth(text, opts = {}) {
    const value = String(text || '').toUpperCase().slice(0, 12)
    const scale = Number(opts.scale || 1)
    const bold = Boolean(opts.bold)
    if (!value) return 0
    return value.length * (6 * scale + (bold ? 1 : 0))
  }

  getCenteredX(width, text, opts = {}) {
    const textWidth = this.measureTextWidth(text, opts)
    return Math.max(2, Math.floor((width - textWidth) / 2))
  }

  createKeyImageBuffer(pixelSize, visual, blinkOn = true) {
    const width = Math.max(16, Number(pixelSize?.width || 72))
    const height = Math.max(16, Number(pixelSize?.height || 72))
    const bg = this.getClassColor(visual.className, visual.shouldBlink, blinkOn)
    const blinkHidden = Boolean(visual.shouldBlink && !blinkOn)
    const buffer = new Uint8Array(width * height * 4)

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        buffer[i] = bg[0]
        buffer[i + 1] = bg[1]
        buffer[i + 2] = bg[2]
        buffer[i + 3] = 255
      }
    }

    const line1Color = blinkHidden ? [165, 174, 196] : [255, 255, 255]
    const line2Color = blinkHidden ? [150, 160, 185] : [255, 255, 255]
    const smallBold = { bold: true }
    this.drawText(buffer, width, height, visual.line1, this.getCenteredX(width, visual.line1, smallBold), 5, line1Color, smallBold)

    if (visual.emphasizeLine2) {
      const bigOpts = { scale: 2, bold: true }
      const glyphHeight = 7 * bigOpts.scale
      const yCentered = Math.max(16, Math.floor((height - glyphHeight) / 2))
      this.drawText(buffer, width, height, visual.line2, this.getCenteredX(width, visual.line2, bigOpts), yCentered, line2Color, bigOpts)
    } else {
      this.drawText(buffer, width, height, visual.line2, this.getCenteredX(width, visual.line2, smallBold), 27, line2Color, smallBold)
    }

    this.drawText(buffer, width, height, visual.line3, this.getCenteredX(width, visual.line3, smallBold), 58, line2Color, smallBold)

    return buffer
  }

  getFirstLcdButtonControl(deck) {
    const controls = Array.isArray(deck?.CONTROLS) ? deck.CONTROLS : []
    return controls.find((c) => c?.type === 'button' && c?.feedbackType === 'lcd') || null
  }

  createSolidKeyImageBuffer(pixelSize, color = [0, 0, 0]) {
    const width = Math.max(16, Number(pixelSize?.width || 72))
    const height = Math.max(16, Number(pixelSize?.height || 72))
    const buffer = new Uint8Array(width * height * 4)

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        buffer[i] = color[0]
        buffer[i + 1] = color[1]
        buffer[i + 2] = color[2]
        buffer[i + 3] = 255
      }
    }

    return buffer
  }

  async clearKey(deck, lcdControl, keyIndex) {
    if (lcdControl && typeof deck.fillKeyBuffer === 'function') {
      const blank = this.createSolidKeyImageBuffer(lcdControl.pixelSize, [0, 0, 0])
      await deck.fillKeyBuffer(keyIndex, blank, { format: 'rgba' })
      return
    }

    if (typeof deck.fillKeyColor === 'function') {
      await deck.fillKeyColor(keyIndex, 0, 0, 0)
    }
  }

  async applyMappings(mappings, context = {}) {
    if (!this.available) {
      return
    }

    const list = Array.isArray(mappings) ? mappings : []

    for (const [deckId, entry] of this.openedDecks.entries()) {
      if (!entry.deck) {
        continue
      }

      try {
        const mappedKeys = list.filter((m) => m.deckId === deckId)
        const blinkOn = Math.floor(Date.now() / 450) % 2 === 0
        const lcdControl = this.getFirstLcdButtonControl(entry.deck)

        const previousSignatures = this.lastAppliedSignaturesByDeck.get(deckId) || new Map()
        const previousMappedKeys = this.lastMappedKeysByDeck.get(deckId) || new Set()
        const nextSignatures = new Map()
        const nextMappedKeys = new Set()
        const visualsByKey = new Map()

        for (const mapping of mappedKeys) {
          const keyIndex = Number(mapping.keyIndex)
          const visual = this.getMappedVisual(mapping, context)
          const blinkState = visual.shouldBlink ? (blinkOn ? 'on' : 'off') : 'steady'
          const keySignature = `${visual.line1}:${visual.line2}:${visual.line3}:${visual.className}:${blinkState}`
          nextSignatures.set(keyIndex, keySignature)
          nextMappedKeys.add(keyIndex)
          visualsByKey.set(keyIndex, visual)
        }

        for (const keyIndex of previousMappedKeys) {
          if (!nextMappedKeys.has(keyIndex)) {
            try {
              await this.clearKey(entry.deck, lcdControl, keyIndex)
            } catch (error) {
              console.error(`[StreamDeck] Failed to clear key ${keyIndex}:`, error.message)
            }
          }
        }

        for (const mapping of mappedKeys) {
          try {
            const keyIndex = Number(mapping.keyIndex)
            const visual = visualsByKey.get(keyIndex)
            const previousSignature = previousSignatures.get(keyIndex)
            const nextSignature = nextSignatures.get(keyIndex)

            if (previousSignature === nextSignature) {
              continue
            }

            if (lcdControl && typeof entry.deck.fillKeyBuffer === 'function') {
              const image = this.createKeyImageBuffer(lcdControl.pixelSize, visual, blinkOn)
              await entry.deck.fillKeyBuffer(keyIndex, image, { format: 'rgba' })
            } else if (typeof entry.deck.fillKeyColor === 'function') {
              const rgb = this.getClassColor(visual.className, visual.shouldBlink, blinkOn)
              await entry.deck.fillKeyColor(keyIndex, rgb[0], rgb[1], rgb[2])
            }
          } catch (error) {
            console.error(`[StreamDeck] Failed to fill key ${mapping.keyIndex}:`, error.message)
          }
        }

        this.lastAppliedSignaturesByDeck.set(deckId, nextSignatures)
        this.lastMappedKeysByDeck.set(deckId, nextMappedKeys)
      } catch (error) {
        console.error(`[StreamDeck] Error applying mappings to ${deckId}:`, error.message)
      }
    }
  }
}

module.exports = {
  StreamDeckManager
}
