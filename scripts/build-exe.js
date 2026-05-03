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

function findCachedBinary(prefix) {
  const cacheRoot = path.join(os.homedir(), '.pkg-cache')
  if (!fs.existsSync(cacheRoot)) return null
  const versions = fs.readdirSync(cacheRoot)
  for (const v of versions) {
    const dir = path.join(cacheRoot, v)
    if (!fs.statSync(dir).isDirectory()) continue
    const files = fs.readdirSync(dir)
    const f = files.find(n => n.startsWith(prefix) && n.endsWith('-win-x64'))
    if (f) return path.join(dir, f)
  }
  return null
}

function findFetchedBinary() {
  return findCachedBinary('fetched-') || findCachedBinary('built-')
}

async function ensureBaseBinaryWithIcon() {
  // Prefer the original "fetched-*" binary because pkg always reads that file.
  // If only "built-*" is present (e.g. from a previous run), bootstrap the
  // fetched-* file from it so pkg has something to read.
  let bin = findCachedBinary('fetched-')
  if (!bin) {
    const built = findCachedBinary('built-')
    if (built) {
      bin = built.replace(/[\\/]built-/, m => m.replace('built-', 'fetched-'))
      fs.copyFileSync(built, bin)
      console.log(`[build-exe] bootstrapped ${path.basename(bin)} from built-*`)
    }
  }
  if (!bin) {
    console.log('[build-exe] fetching base Node binary via pkg ...')
    const tmpOut = path.join(distDir, '.warmup.exe')
    fs.mkdirSync(distDir, { recursive: true })
    await exec(['.', '--targets', target, '--output', tmpOut])
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
    bin = findCachedBinary('fetched-')
  }
  if (!bin) throw new Error('could not locate fetched Node binary in pkg cache')

  if (!fs.existsSync(iconPath)) {
    console.warn('[build-exe] logo.ico not found, skipping icon embed')
    return
  }

  // Patch on a "built-*" copy so we keep the original fetched-* as backup
  // until we explicitly overwrite it below.
  const dir = path.dirname(bin)
  const base = path.basename(bin)
  const builtName = 'built-' + base.slice('fetched-'.length)
  const builtPath = path.join(dir, builtName)
  fs.copyFileSync(bin, builtPath)
  console.log(`[build-exe] copied base binary -> ${builtName}`)

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
  fs.copyFileSync(builtPath, bin)
  console.log(`[build-exe] overwrote ${path.basename(bin)} with patched binary`)
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
