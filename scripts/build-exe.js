#!/usr/bin/env node
/* Build single-file Windows exe for Helios Monitor with embedded icon. */
const path = require('path')
const fs = require('fs')
const { exec } = require('@yao-pkg/pkg')
const { rcedit } = require('rcedit')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const distDir = path.join(root, 'dist')
const outName = `helios-monitor-${pkg.version}.exe`
const outPath = path.join(distDir, outName)
const iconPath = path.join(root, 'logo.ico')
const target = 'node20-win-x64'

async function main() {
  fs.mkdirSync(distDir, { recursive: true })
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath)

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

  if (fs.existsSync(iconPath)) {
    console.log(`[build-exe] embedding icon + version metadata via rcedit ...`)
    // Wait briefly so pkg releases the file handle on Windows.
    await new Promise(r => setTimeout(r, 500))
    await rcedit(outPath, {
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
  } else {
    console.warn('[build-exe] logo.ico not found, skipping icon embed')
  }

  console.log(`[build-exe] done -> ${outPath}`)
}

main().catch(err => {
  console.error('[build-exe] failed:', err)
  process.exit(1)
})
