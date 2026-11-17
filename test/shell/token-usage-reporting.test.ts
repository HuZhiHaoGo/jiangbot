import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
