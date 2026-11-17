import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSafeHeroBrand, type SafeHeroBrand } from '../../shared/safe-hero-brand'

const MAX_BRAND_FILE_BYTES = 64 * 1024

function plainText(value: unknown): string {
  // Do not resolve third-party logo paths, remote URLs or embedded images in Safe Mode.
  if (typeof value !== 'string' || /^(?:data:|https?:|file:|<svg\b)/iu.test(value.trim())) return ''
  return value.trim()
}

/** Read only the ordinary profile's local brand text without loading its brand plugin. */
export async function readSafeHeroBrand(dshHome: string): Promise<SafeHeroBrand | undefined> {
  try {
    const file = await open(join(dshHome, 'dsh-brand.json'))
    try {
      const stats = await file.stat()
      if (!stats.isFile() || stats.size > MAX_BRAND_FILE_BYTES) return
      const buffer = Buffer.alloc(MAX_BRAND_FILE_BYTES + 1)
      const { bytesRead } = await file.read(buffer)
      if (bytesRead > MAX_BRAND_FILE_BYTES) return
      const document: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/u, ''))
      if (document === null || typeof document !== 'object') return
      const { name, logoText, headline, badge, intro }: Record<string, unknown> = { ...document }
      return parseSafeHeroBrand({
        mark: plainText(logoText) || Array.from(plainText(name))[0] || '',
        headline: plainText(headline), badge: plainText(badge), intro: plainText(intro)
      })
    } finally {
      await file.close()
    }
  } catch {
    // Missing, invalid and inaccessible branding must all permit recovery to open.
    return undefined
  }
}
