/** The text-only portion of the ordinary Profile's brand, safe to show in recovery. */
export interface SafeHeroBrand {
  readonly mark: string
  readonly headline: string
  readonly badge: string
  readonly intro: string
}

const ARG_PREFIX = '--dsh-desktop-safe-hero-brand='

/** Validate the renderer snapshot at both ends of the window argument. */
export function parseSafeHeroBrand(value: unknown): SafeHeroBrand | undefined {
  if (value === null || typeof value !== 'object') return
  const { mark, headline, badge, intro }: Record<string, unknown> = { ...value }
  if (typeof mark !== 'string' || mark.length > 16
    || typeof headline !== 'string' || headline.length > 120
    || typeof badge !== 'string' || badge.length > 32
    || typeof intro !== 'string' || intro.length > 180
    || !(headline || badge || intro)) return
  return { mark, headline, badge, intro }
}

export function safeHeroBrandArgument(brand: SafeHeroBrand): string {
  return ARG_PREFIX + encodeURIComponent(JSON.stringify(brand))
}

export function safeHeroBrandFromArguments(argv: readonly string[]): SafeHeroBrand | undefined {
  const payload = argv.find(arg => arg.startsWith(ARG_PREFIX))?.slice(ARG_PREFIX.length)
  if (!payload || payload.length > 8_000) return
  try {
    return parseSafeHeroBrand(JSON.parse(decodeURIComponent(payload)))
  } catch {
    return undefined
  }
}
