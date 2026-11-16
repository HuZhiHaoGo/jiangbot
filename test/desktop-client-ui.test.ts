import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    root: { kind: 'single'; scope: 'root' }
  }
}

const projectRoot = path.resolve(import.meta.dirname, '..')
// jsdom has no bundled declarations; constrain this adapter to the DOM APIs used here.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis }
}

interface Registration {
  config: { name: string; id?: string; order?: number; priority?: number }
  component: (props: Record<string, unknown>) => unknown
}

describe('DSH Desktop client slot occupants', () => {
  it('registers one occupant per brand seat and displays the product name as text', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ textContent?: string }> = []
    const removeStyle = vi.fn()
    let disposeStyle: (() => void) | undefined
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: removeStyle })),
      head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
    }
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        dshDesktop: { getRepairDraft: vi.fn(), openRepairAgent: vi.fn() },
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const FishLogo = vi.fn()
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => effect(),
          useState: (initial: unknown) => [initial, vi.fn()]
        }
      }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return { FishLogo }
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    plugin.apply({ slots, locale: { register: () => () => undefined, bind: () => (key: string) => key }, effect: (setup: () => (() => void) | undefined) => { disposeStyle = setup() } })

    expect(plugin.inject).toEqual(['locale', 'slots', 'remote.session', 'sessions', 'uiWorkspace'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'conversation.input.dock',
      'sidebar.settings.action',
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item'
    ])
    expect(registrations.some(({ config }) => config.name === 'settings.sidebar.footer')).toBe(false)
    // Desktop toolbar styles have an owned lifetime; branding stays in currentColor.
    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toContain("[data-dsh-preset-search]")
    expect(appended[0]?.textContent).toContain("[data-dsh-market-nav-icon] span[class*=\"navIcon\"]")
    expect(appended[0]?.textContent).toContain("[data-dsh-better-sidebar-settings-nav] span[class*=\"navIcon\"]")
    // These are the named header containers in skills-manager 1.4.10 / archive-manager 1.3.6.
    // Check rendered visibility, including controls outside the targeted headers.
    const dom = new JSDOM(`<!doctype html><html><head></head><body>
      <div class="dssm-title-row"><h2>Skills</h2><div class="dssm-feedback-links"><button>GitHub</button><button>Feedback</button></div></div>
      <div class="dsham_settingsTitleRow"><h2>Archives</h2><div class="dsham_settingsLinks"><button>GitHub</button><button>Feedback</button></div></div>
      <button id="refresh">Refresh skills</button><button id="archive">Archive session</button>
      <div id="other-links" class="dssm-feedback-links">Other links</div>
    </body></html>`)
    const style = dom.window.document.createElement('style')
    style.textContent = appended[0]?.textContent ?? ''
    dom.window.document.head.appendChild(style)
    for (const selector of ['.dssm-title-row > .dssm-feedback-links', '.dsham_settingsTitleRow > .dsham_settingsLinks']) {
      const element = dom.window.document.querySelector(selector)
      if (!element) throw new Error(`Missing header fixture: ${selector}`)
      expect(dom.window.getComputedStyle(element).display).toBe('none')
    }
    for (const element of dom.window.document.querySelectorAll('h2, #refresh, #archive, #other-links')) {
      expect(dom.window.getComputedStyle(element).display).not.toBe('none')
    }
    style.remove()
    const links = dom.window.document.querySelector('.dssm-title-row > .dssm-feedback-links')
    if (!links) throw new Error('Missing skills header')
    expect(dom.window.getComputedStyle(links).display).not.toBe('none')
    dom.window.close()
    disposeStyle?.()
    expect(removeStyle).toHaveBeenCalledOnce()

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({}) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarName.type).toBe('span')
    expect(sidebarName.props.children).toEqual(['匠宝'])

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    expect(sidebarMark.props.height).toBe(17)
    const [markPath] = sidebarMark.props.children as Array<{ type: unknown; props: Record<string, unknown> }>
    if (!markPath) throw new Error('Expected the sidebar brand SVG path')
    expect(markPath.type).toBe('path')
    expect(markPath.props.fill).toBe('currentColor')

    const heroSlot = 'conversation.hero.brand.mark'
    const desktopHero = registrations.find(({ config }) => config.name === heroSlot)
    if (!desktopHero) throw new Error('Expected the Desktop hero registration')
    const heroMark = desktopHero.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe(FishLogo)
    expect(heroMark.props.size).toBe(48)

    const core = new SlotCore()
    core.register({ name: 'root', children: { [heroSlot]: { kind: 'single', scope: 'root' } } },
      ({ renderSlot }) => renderSlot(heroSlot, { size: 48 }))
    const fallback = () => null
    core.register({ name: heroSlot, priority: desktopHero.config.priority }, fallback)
    expect(core.entriesOfSlot(heroSlot).map(entry => entry.component)).toEqual([fallback])
    const custom = () => null
    const removeCustom = core.register({ name: heroSlot }, custom)
    expect(core.entriesOfSlot(heroSlot).map(entry => entry.component)).toEqual([custom])
    removeCustom()
    expect(core.entriesOfSlot(heroSlot).map(entry => entry.component)).toEqual([fallback])
  })
})
