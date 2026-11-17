const { existsSync } = require('node:fs')
const { copyFile, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

function loadPrivateSqlUsageSettings(source = join(__dirname, '../../.build/token-usage-sql.private.cjs')) {
  if (!existsSync(source)) return undefined
  try {
    return require(source)
  } catch {
    // A module syntax error can include the source line containing the password.
    throw new Error('Cannot load .build/token-usage-sql.private.cjs')
  }
}

async function stageSqlUsageResources(resourcesDir, settings) {
  const config = join(resourcesDir, 'token-usage-sql.json')
  const writer = join(resourcesDir, 'write-token-usage.ps1')
  // Discard stale credentials if the output directory is being reused.
  await rm(config, { force: true })
  await rm(writer, { force: true })
  if (settings === undefined) return
  if (settings === null || typeof settings !== 'object' || !['server', 'user', 'password'].every(key =>
    typeof settings[key] === 'string' && settings[key].trim().length > 0)) {
    throw new Error('Private SQL usage settings require server, user and password')
  }
  await copyFile(join(__dirname, '../../build/write-token-usage.ps1'), writer)
  const { server, user, password } = settings
  await writeFile(config, JSON.stringify({ server, user, password }), { mode: 0o600, flag: 'wx' })
}

module.exports = { loadPrivateSqlUsageSettings, stageSqlUsageResources }
