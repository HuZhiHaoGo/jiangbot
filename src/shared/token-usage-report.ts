export interface TokenUsageReport {
  readonly sessionId: string | null
  readonly modelName: string
  readonly requestKind: string
  readonly usedAt: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
}

export function tokenTotal(report: TokenUsageReport): number {
  return report.inputTokens + report.outputTokens + (report.cacheReadTokens ?? 0) + (report.cacheWriteTokens ?? 0)
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Rebuild the narrow DTO, discarding any extra fields that arrive from Host. */
export function parseTokenUsageReport(value: unknown): TokenUsageReport | undefined {
  if (value === null || typeof value !== 'object') return
  const row: Record<string, unknown> = { ...value }
  const { sessionId, modelName, requestKind, usedAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = row
  if (!(sessionId === null || (typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 128))
    || typeof modelName !== 'string' || modelName.length === 0 || modelName.length > 256
    || typeof requestKind !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(requestKind)
    || !isCount(usedAt) || usedAt > 253_402_300_799_999
    || !isCount(inputTokens) || !isCount(outputTokens)
    || !(cacheReadTokens === null || isCount(cacheReadTokens))
    || !(cacheWriteTokens === null || isCount(cacheWriteTokens))) return
  const report = { sessionId, modelName, requestKind, usedAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
  if (isCount(tokenTotal(report))) return report
}
