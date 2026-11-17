import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tokenTotal, type TokenUsageReport } from '../../../shared/token-usage-report'

interface SqlUsageRow extends Omit<TokenUsageReport, 'usedAt'> {
  readonly eventId: string
  readonly employeeNo: string
  readonly usedAtUtc: string
  readonly totalTokens: number
}
type WriteBatch = (rows: readonly SqlUsageRow[], signal: AbortSignal) => Promise<'ok' | 'retry' | 'failed'>

export function createTokenUsageQueue(employeeNo: string, write: WriteBatch, warn = console.warn) {
  const queue: Array<{ row: SqlUsageRow; queuedAt: number }> = []
  const controller = new AbortController()
  let running = false
  let dropped = 0
  async function drain(): Promise<void> {
    try {
      while (!controller.signal.aborted && queue.length > 0) {
        const cutoff = Date.now() - 60_000
        const batch = queue.splice(0, 20).filter(item => {
          if (item.queuedAt >= cutoff) return true
          dropped += 1
          return false
        }).map(item => item.row)
        if (dropped > 0) {
          warn(`[token-usage] SQL queue dropped ${String(dropped)} event(s) due to backlog or expiry`)
          dropped = 0
        }
        if (batch.length === 0) continue
        try {
          let result = await write(batch, controller.signal)
          if (result === 'retry' && !controller.signal.aborted) {
            await delay(250, undefined, { signal: controller.signal })
            result = await write(batch, controller.signal)
          }
          if (result !== 'ok' && !controller.signal.aborted) warn('[token-usage] SQL batch was not confirmed')
        } catch {
          if (!controller.signal.aborted) warn('[token-usage] SQL writer failed to run')
        }
      }
    } finally {
      running = false
    }
  }

  return {
    enqueue({ usedAt, ...report }: TokenUsageReport) {
      if (controller.signal.aborted) return
      if (queue.length >= 200) {
        dropped += 1
        return
      }
      queue.push({ queuedAt: Date.now(), row: {
        ...report, employeeNo, eventId: randomUUID(), usedAtUtc: new Date(usedAt).toISOString(),
        totalTokens: tokenTotal({ ...report, usedAt })
      } })
      if (running) return
      running = true
      setImmediate(() => { void drain().catch(() => warn('[token-usage] SQL queue stopped unexpectedly')) })
    },
    dispose() {
      controller.abort()
      queue.length = 0
    }
  }
}

export function createPackagedTokenReporter(resources: string): ReturnType<typeof createTokenUsageQueue> | undefined {
  const root = process.env.SystemRoot
  if (process.platform !== 'win32' || !root) return
  const config = join(resources, 'token-usage-sql.json')
  const script = join(resources, 'write-token-usage.ps1')
  if (!existsSync(config)) return
  if (!existsSync(script)) {
    console.warn('[token-usage] SQL reporting disabled: missing packaged writer')
    return
  }
  let employeeNo: string
  try {
    employeeNo = userInfo().username
    if (!employeeNo || employeeNo.length > 64) throw new Error('Invalid account')
  } catch {
    console.warn('[token-usage] SQL reporting disabled: Windows account unavailable')
    return
  }
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return createTokenUsageQueue(employeeNo, (rows, signal) => new Promise(resolve => {
    const child = execFile(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
      '-File', script, '-ConfigPath', config
    ], { signal, timeout: 8_000, windowsHide: true, maxBuffer: 8_192 }, error => {
      if (!error) resolve('ok')
      else if (error.killed || error.code === 2) resolve('retry')
      else resolve('failed')
    })
    // execFile reports a failed spawn or early exit through its callback.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(rows))
  }))
}
