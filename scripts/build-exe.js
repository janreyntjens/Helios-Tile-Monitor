#!/usr/bin/env node
/* Build single-file Windows exe for Helios Monitor with embedded icon. */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { exec } = require('@yao-pkg/pkg')
const { rcedit } = require('rcedit')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const distDir = path.join(root, 'dist')
const outName = `helios-monitor-${pkg.version}.exe`
const outPath = path.join(distDir, outName)
const iconPath = path.join(root, 'logo.ico')
const nodeRange = 'node20'
const target = `${nodeRange}-win-x64`

function findFetchedBinary() {
  const cacheRoot = path.join(os.homedir(), '.pkg-cache')
  if (!fs.existsSync(cacheRoot)) return null
  const versions = fs.readdirSync(cacheRoot)
  for (const v of versions) {
    const dir = path.join(cacheRoot, v)
    if (!fs.statSync(dir).isDirectory()) continue
    const files = fs.readdirSync(dir)
    const match = files.find(f => (f.startsWith('fetched-') || f.startsWith('built-')) && f.endsWith('-win-x64'))
    if (match) return path.join(dir, match)
  }
  return null
}

async function ensureBaseBinaryWithIcon() {
  // First do a dry pkg call to make sure base node binary is fetched.
  let bin = findFetchedBinary()
  if (!bin) {
    console.log('[build-exe] fetching base Node binary via pkg ...')
    const tmpOut = path.join(distDir, '.warmup.exe')
    fs.mkdirSync(distDir, { recursive: true })
    await exec(['.', '--targets', target, '--output', tmpOut])
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
    bin = findFetchedBinary()
  }
  if (!bin) throw new Error('could not locate fetched Node binary in pkg cache')

  if (fs.existsSync(iconPath)) {
    console.log(`[build-exe] embedding icon into base binary: ${bin}`)
    await rcedit(bin, {
      icon: iconPath,
      'version-string': {
        ProductName: 'Helios Monitor',
        FileDescription: 'Helios Monitor',
        CompanyName: 'Jan Reyntjens',
        LegalCopyright: 'Jan Reyntjens',
        OriginalFilename: outName,
        InternalName: 'helios-monitor'
      },
      'product-version': pkg.version,
      'file-version': pkg.version
    })
    // pkg verifies hash for "fetched-*" binaries and re-downloads if changed.
    // Rename to "built-*" so pkg trusts our modified copy.
    const dir = path.dirname(bin)
    const base = path.basename(bin)
    if (base.startsWith('fetched-')) {
      const builtName = 'built-' + base.slice('fetched-'.length)
      const builtPath = path.join(dir, builtName)
      if (fs.existsSync(builtPath)) fs.unlinkSync(builtPath)
      fs.renameSync(bin, builtPath)
      console.log(`[build-exe] renamed base binary -> ${builtName}`)
    }
  } else {
    console.warn('[build-exe] logo.ico not found, skipping icon embed')
  }
}

async function main() {
  fs.mkdirSync(distDir, { recursive: true })
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath)

  await ensureBaseBinaryWithIcon()

  console.log(`[build-exe] packaging ${outName} ...`)
  await exec([
    '.',
    '--targets', target,
    '--output', outPath,
    '--compress', 'GZip'
  ])

  if (!fs.existsSync(outPath)) {
    throw new Error(`pkg did not produce ${outPath}`)
  }

  console.log(`[build-exe] done -> ${outPath}`)
}

main().catch(err => {
  console.error('[build-exe] failed:', err)
  process.exit(1)
})
