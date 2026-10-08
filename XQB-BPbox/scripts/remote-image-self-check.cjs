const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const directory = path.resolve(__dirname, '../.tmp/remote-image-test')
if (!process.versions.electron) {
  fs.mkdirSync(directory, { recursive: true })
  require('esbuild').buildSync({
    entryPoints: [path.resolve(__dirname, '../src/main/remoteBp/prepareRemoteImage.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(directory, 'prepare.cjs'),
    logLevel: 'silent'
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.status, 0, 'Electron image preparation test failed')
} else {
  const { app, nativeImage } = require('electron')
  app.setPath('userData', path.join(directory, 'user-data'))
  app.disableHardwareAcceleration()
  app
    .whenReady()
    .then(() => {
      const { prepareRemoteImage } = require(path.join(directory, 'prepare.cjs'))
      for (const transparent of [false, true]) {
        const width = 960,
          height = 1440
      const bitmap = Buffer.alloc(width * height * 4)
      let noise = 123456789
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4
          const alpha = transparent && x < width / 4 ? 0 : 255
          noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
          bitmap[offset] = alpha ? (noise >>> 24) : 0
          bitmap[offset + 1] = alpha ? ((noise >>> 16) & 255) : 0
          bitmap[offset + 2] = alpha ? ((noise >>> 8) & 255) : 0
            bitmap[offset + 3] = alpha
          }
        const original = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
        for (const type of ['avatar', 'portrait', 'light-cone']) {
          const prepared = prepareRemoteImage(original, type, 'image/png')
          const image = nativeImage.createFromBuffer(Buffer.from(prepared.data))
          const size = image.getSize()
          assert.ok(prepared.data.length < original.length,
            `${type}: expected a smaller preview, got ${prepared.data.length} from ${original.length}`)
          assert.ok(size.width <= (type === 'portrait' ? 480 : 256))
          assert.ok(size.height <= (type === 'portrait' ? 720 : type === 'avatar' ? 256 : 384))
          assert.ok(Math.abs(size.width / size.height - width / height) < 0.01)
          assert.equal(prepared.mimeType, transparent ? 'image/png' : 'image/jpeg')
          if (transparent) assert.equal(image.toBitmap()[3], 0, 'transparent edges must survive')
          console.log(
            `PASS ${type} ${transparent ? 'transparent' : 'opaque'}: ${original.length} -> ${prepared.data.length} bytes`
          )
        }
      }
      const invalid = Buffer.from('unsupported image')
      assert.deepEqual(prepareRemoteImage(invalid, 'avatar', 'image/png').data, invalid)
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
