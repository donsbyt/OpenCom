import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const root = process.cwd()
const vendorRoot = path.join(root, 'vendor', 'minimatch')
const vendorNodeModules = path.join(vendorRoot, 'node_modules')

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${res.status ?? 'unknown'}`)
  }
}

async function packAndExtract(spec, dest) {
  const work = await fs.mkdtemp(path.join(tmpdir(), 'opencom-pack-'))
  try {
    run('npm', ['pack', spec, '--silent'], work)
    const files = await fs.readdir(work)
    const tgz = files.find(f => f.endsWith('.tgz'))
    if (!tgz) throw new Error(`No tarball produced for ${spec}`)
    run('tar', ['-xzf', tgz], work)

    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(path.join(work, 'package'), dest, {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
    })
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

async function main() {
  await fs.rm(vendorRoot, { recursive: true, force: true })
  await fs.mkdir(vendorNodeModules, { recursive: true })

  await packAndExtract('minimatch@9.0.9', vendorRoot)
  await packAndExtract('brace-expansion@2.0.1', path.join(vendorNodeModules, 'brace-expansion'))
  await packAndExtract('balanced-match@1.0.2', path.join(vendorNodeModules, 'balanced-match'))

  await fs.writeFile(
    path.join(vendorRoot, 'index.js'),
    "module.exports = require('./dist/commonjs/index.js')\n"
  )

  await fs.writeFile(
    path.join(vendorRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'minimatch',
        main: 'index.js',
        type: 'commonjs',
      },
      null,
      2
    ) + '\n'
  )

  console.log('Ensured vendored minimatch dependencies')
}

main().catch(err => {
  console.error(err?.message || err)
  process.exit(1)
})
