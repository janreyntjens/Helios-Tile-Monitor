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
const target = 'node20-win-x64'

function findFetchedBinary() {
  const cacheRoot = path.join(os.homedir(), '.pkg-cache')
  if (!fs.existsSync(cacheRoot)) return null
  const versions = fs.readdirSync(cacheRoot)
  for (const v of versions) {
    const dir = path.join(cacheRoot, v)
    if (!fs.statSync(dir).isDirectory()) continue
    const files = fs.readdirSync(dir)
    const fetched = files.find(f => f.startsWith('fetched-') && f.endsWith('-win-x64'))
    if (fetched) return path.join(dir, fetched)
    const built = files.find(f => f.startsWith('built-') && f.endsWith('-win-x64'))
    if (built) return path.join(dir, built)
  }
  return null
}

async function ensureBaseBinaryWithIcon() {
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

  // pkg verifies hash on "fetched-*" and re-downloads if changed, but it
  // trusts "built-*". So copy fetched-* -> built-* (keeping the original) and
  // patch resources on the built-* copy.
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

  console.log(`[build-exe] embedding icon + version metadata into ${builtName}`)
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

  // pkg always reads "fetched-*" (see producer.js), so overwrite it with our
  // patched copy. pkg only verifies the hash when downloading; once present,
  // it trusts the file contents.
  if (builtPath !== bin) {
    fs.copyFileSync(builtPath, bin)
    console.log(`[build-exe] overwrote ${path.basename(bin)} with patched binary`)
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
