/* eslint-disable @typescript-eslint/no-require-imports -- Local maintenance CLI. */
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const root = path.resolve(
  rootIndex >= 0 ? args[rootIndex + 1] : process.env.XQB_BP_ROOT || process.cwd()
)
const legacyRoots = args.flatMap((arg, i) =>
  arg === '--legacy-root' ? [path.resolve(args[i + 1])] : []
)
const output = path.resolve(__dirname, '../.tmp/resource-migration.cjs')
require('esbuild').buildSync({
  entryPoints: [path.resolve(__dirname, '../src/main/resourceMigration.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  logLevel: 'silent'
})
const report = require(output).migrateResourcePaths(root, legacyRoots, args.includes('--apply'))
const reportPath = report.backupDirectory
  ? path.join(report.backupDirectory, 'report.json')
  : path.resolve(__dirname, '../.tmp/resource-path-plan.json')
if (!report.applied) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(
  JSON.stringify(
    {
      applied: report.applied,
      root,
      scanned: report.scannedFiles.length,
      changedFiles: report.changedFiles,
      copies: report.copies.length,
      copiedGiB: Number((report.copiedBytes / 1024 ** 3).toFixed(3)),
      issues: report.issues.length,
      reportPath
    },
    null,
    2
  )
)
