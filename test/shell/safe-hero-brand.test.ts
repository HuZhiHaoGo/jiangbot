import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSafeHeroBrand } from '../../src/main/shell/safe-hero-brand'
import { safeHeroBrandArgument, safeHeroBrandFromArguments } from '../../src/shared/safe-hero-brand'

describe('Safe Mode headline branding', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-safe-brand-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('loads the text brand from the active home and sends only hero fields to the window', async () => {
    await writeFile(join(directory, 'dsh-brand.json'), JSON.stringify({
      name: '示例品牌', headline: '欢迎来到「示例」', badge: '', intro: '本地工作台',
      favicon: 'https://example.invalid/icon.png', unrelated: 'never passed to the renderer'
    }))
    const expected = { mark: '示', headline: '欢迎来到「示例」', badge: '', intro: '本地工作台' }
    const brand = await readSafeHeroBrand(directory)
    expect(brand).toEqual(expected)
    if (brand === undefined) throw new Error('Expected safe branding')
    expect(safeHeroBrandFromArguments(['app.exe', safeHeroBrandArgument(brand)])).toEqual(expected)
  })

  it('falls back for absent, corrupt or oversized branding rather than blocking recovery', async () => {
    const file = join(directory, 'dsh-brand.json')
    await expect(readSafeHeroBrand(directory)).resolves.toBeUndefined()
    await writeFile(file, '{"headline":')
    await expect(readSafeHeroBrand(directory)).resolves.toBeUndefined()
    await writeFile(file, JSON.stringify({ headline: 'x'.repeat(70 * 1024) }))
    await expect(readSafeHeroBrand(directory)).resolves.toBeUndefined()
    expect(safeHeroBrandFromArguments(['--dsh-desktop-safe-hero-brand=%'])).toBeUndefined()
  })

  it('uses the name mark and text instead of loading a configured image', async () => {
    await writeFile(join(directory, 'dsh-brand.json'), JSON.stringify({
      name: '示例', logoText: 'data:image/svg+xml;base64,AA', headline: '本地品牌', intro: 'https://example.invalid/image.png'
    }))
    await expect(readSafeHeroBrand(directory)).resolves.toEqual({ mark: '示', headline: '本地品牌', badge: '', intro: '' })
  })
})
