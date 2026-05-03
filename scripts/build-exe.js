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
    // Prefer the original fetched-* file so we always have a clean source to copy from.
    const fetched = files.find(f => f.startsWith('fetched-') && f.endsWith('-win-x64'))
    if (fetched) return path.join(dir, fetched)
    const built = files.find(f => f.startsWith('built-') && f.endsWith('-win-x64'))
    if (built) return path.join(dir, built)
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

  if (!fs.existsSync(iconPath)) {
    console.warn('[build-exe] logo.ico not found, skipping icon embed')
    return
  }

  // Copy fetched-* -> built-* (pkg trusts built-* without hash verification).
  const dir = path.dirname(bin)
  const base = path.basename(bin)
  const builtName = base.startsWith('fetched-')
    ? 'built-' + base.slice('fetched-'.length)
    : base
  const builtPath = path.join(dir, builtName)
  if (builtPath !== bin) {
    fs.copyFileSync(bin, builtPath)
    console.log(`[build-exe] copied base binary -> ${builtName}`)
  }

  console.log(`[build-exe] embedding icon into ${builtPath}`)
  await rcedit(builtPath, {
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
