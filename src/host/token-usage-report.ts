import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { parseTokenUsageReport, type TokenUsageReport } from '../shared/token-usage-report'

function requestKind(options: GenerateOptions): string {
  if (typeof options.purpose === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/u.test(options.purpose)) return options.purpose
  if (options.system?.startsWith('REVIEW_POLICY')) return 'auto-review'
  if (options.system?.startsWith('Translate the following text')) return 'translation'
  return options.sessionId === undefined ? 'other' : 'chat'
}

function responseModel(replay: unknown): string | undefined {
  if (typeof replay !== 'object' || replay === null || !('response' in replay)) return
  const body = replay.response
  if (typeof body === 'object' && body !== null && 'kind' in body && body.kind === 'pi-ai'
    && 'version' in body && body.version === 2 && 'responseModel' in body
    && typeof body.responseModel === 'string' && body.responseModel.length > 0) return body.responseModel
}

/** Observe actual provider usage without changing the stream or awaiting the reporter. */
export async function* observeTokenUsage(
  options: GenerateOptions,
  stream: AsyncIterable<StreamChunk>,
  publish: (report: TokenUsageReport) => void
): AsyncIterable<StreamChunk> {
  let usedAt = Date.now()
  let usage: TokenUsage | undefined
  const sendUsage = (modelName = options.model) => {
    if (usage === undefined) return
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage
    usage = undefined
    const report = parseTokenUsageReport({
      sessionId: options.sessionId ?? null, modelName, requestKind: requestKind(options), usedAt,
      inputTokens, outputTokens, cacheReadTokens: cacheReadTokens ?? null, cacheWriteTokens: cacheWriteTokens ?? null
    })
    if (report === undefined) return
    try { publish(report) } catch { console.warn('[token-usage] Host could not publish usage report') }
  }
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') {
        sendUsage(responseModel(chunk.replayState))
        usedAt = Date.now()
      }
      yield chunk
    }
  } finally {
    // A consumer can cancel after the provider has already sent usage.
    sendUsage()
  }
}
