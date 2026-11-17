import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { observeTokenUsage } from '../../src/host/token-usage-report'
import { createTokenUsageQueue } from '../../src/main/shell/backend/sql-token-reporter'
import { parseTokenUsageReport, tokenTotal, type TokenUsageReport } from '../../src/shared/token-usage-report'

const require = createRequire(import.meta.url)
const { loadPrivateSqlUsageSettings, stageSqlUsageResources } = require('../../scripts/release/stage-sql-usage-resources.cjs') as {
  loadPrivateSqlUsageSettings(source: string): unknown
  stageSqlUsageResources(resources: string, settings?: unknown): Promise<void>
}

const request: GenerateOptions = { model: 'model', provider: 'test', messages: [], sessionId: SessionId('session') }
const report: TokenUsageReport = {
  sessionId: 'session', modelName: 'model', requestKind: 'chat', usedAt: Date.now(),
  inputTokens: 120, outputTokens: 34, cacheReadTokens: 6, cacheWriteTokens: null
}

async function* chunks(items: readonly StreamChunk[]) {
  yield* items
}

describe('built-in SQL usage reporting', () => {
  it('forwards the original stream and publishes each actual usage once, including auxiliary calls', async () => {
    const events: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'private' },
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 34, cacheReadTokens: 6 } },
      { type: 'finish', reason: { kind: 'stop' } }
    ]
    const publish = vi.fn<(row: TokenUsageReport) => void>()
    const received = []
    for await (const chunk of observeTokenUsage(request, chunks(events), publish)) received.push(chunk)
    expect(received).toEqual(events)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith({ ...report, usedAt: expect.any(Number) })
    const { sessionId: _sessionId, ...aux } = request
    for await (const _chunk of observeTokenUsage({ ...aux, system: 'Translate the following text' }, chunks(events), publish)) {
      // Consume the provider response.
    }
    expect(publish.mock.calls[1]?.[0]).toMatchObject({ sessionId: null, requestKind: 'translation' })
    for await (const _chunk of observeTokenUsage(request, chunks(events.slice(2)), publish)) {
      // A provider that reports no usage still completes normally.
    }
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('rejects unusable counts and excludes unexpected properties at the Host boundary', () => {
    expect(parseTokenUsageReport({ ...report, messages: ['private'] })).toEqual(report)
    expect(parseTokenUsageReport({ ...report, cacheReadTokens: -1 })).toBeUndefined()
    expect(parseTokenUsageReport({ ...report, inputTokens: Number.MAX_SAFE_INTEGER })).toBeUndefined()
  })

  it('retries asynchronously with the original event ID and preserves the request time', async () => {
    const write = vi.fn().mockResolvedValueOnce('retry').mockResolvedValueOnce('ok')
    const reporter = createTokenUsageQueue('001234', write)
    const usedAt = Date.now() - 600_000
    try {
      reporter.enqueue({ ...report, usedAt })
      expect(write).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
      const first = write.mock.calls[0]?.[0][0]
      expect(first).toMatchObject({
        employeeNo: '001234', totalTokens: tokenTotal(report), usedAtUtc: new Date(usedAt).toISOString()
      })
      expect(write.mock.calls[1]?.[0][0]).toEqual(first)
    } finally {
      reporter.dispose()
    }
  })

  it('stages both resources for configured packages and removes them when the package is rebuilt without config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'token-usage-pack-'))
    try {
      const resources = join(root, 'resources')
      await mkdir(resources)
      const source = join(root, 'token-usage-sql.private.cjs')
      const config = { server: 'tcp:fixture.invalid,1433', user: 'test-only', password: 'test-only' }
      await writeFile(source, `module.exports = ${JSON.stringify({ ...config, ignored: 'other configuration' })}\n`)
      await stageSqlUsageResources(resources, loadPrivateSqlUsageSettings(source))
      const packaged = join(resources, 'token-usage-sql.json')
      expect(JSON.parse(await readFile(packaged, 'utf8'))).toEqual(config)
      expect(await readFile(join(resources, 'write-token-usage.ps1'), 'utf8')).toContain('INSERT INTO [dbo].[ModelTokenUsage]')
      await stageSqlUsageResources(resources, loadPrivateSqlUsageSettings(join(root, 'missing.cjs')))
      await expect(readFile(packaged)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('runs the writer in Windows PowerShell and reports a safe failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'token-usage-writer-'))
    try {
      const config = join(root, 'config.json')
      const fakePassword = 'fixture-password-only'
      await writeFile(config, JSON.stringify({ server: 'tcp:127.0.0.1,1', user: 'fixture-user', password: fakePassword }))
      const row = {
        ...report, employeeNo: userInfo().username, eventId: 'f5fced6a-0dac-4858-bdb6-f8b6902248c7',
        usedAtUtc: new Date(report.usedAt).toISOString(), totalTokens: tokenTotal(report)
      }
      const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', resolve('build/write-token-usage.ps1'), '-ConfigPath', config
      ], { input: JSON.stringify([row]), encoding: 'utf8', timeout: 40_000, windowsHide: true })
      expect(result.status).not.toBe(0)
      // Windows AppContainer can reject SqlConnection construction before any network access.
      expect(result.stderr).toMatch(/stage=(?:connection sql=-?\d+|configuration error=unexpected)/)
      expect(result.stderr).not.toContain(fakePassword)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)

  it.skipIf(process.platform !== 'win32')('builds the SQL connection settings with Windows PowerShell', async () => {
    const script = await readFile(resolve('build/write-token-usage.ps1'), 'utf8')
    const start = script.indexOf('  $builder = New-Object')
    const end = script.indexOf('  $password = ConvertTo-SecureString', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const code = `$ErrorActionPreference = 'Stop'
$settings = @{ server = 'test-server' }
${script.slice(start, end)}
if ($builder['Data Source'] -ne 'test-server' -or $builder['Connect Timeout'] -ne 30 -or
    -not $builder['Encrypt'] -or -not $builder['TrustServerCertificate']) { exit 1 }`
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
