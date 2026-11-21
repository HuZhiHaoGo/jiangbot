import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
  ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)]
const evaluate = node => typeof node.type === 'function' ? node.type(node.props) : node

async function sidebar({ collapsed = false, panels = [], unpinned = [], contribution, hideSidebarManagement = false } = {}) {
  let plugin
  let registration
  let Root
  const calls = []
  const jsx = (type, props, key) => ({ type, props, key })
  const store = initial => {
    let current = initial
    return { getSnapshot: () => current, set: value => { current = value }, subscribe: () => () => {} }
  }
  const primitives = { Tooltip: 'Tooltip', Menu: 'Menu', useModalLayer() {}, isDarwinDesktop: () => false }
  const dependencies = {
    react: { useState: value => [value, () => {}], useRef: current => ({ current }), useEffect() {}, useLayoutEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: store },
    '@deepseek-ai/dsh-client-ui-slots': { resolveSlotLabel: label => label },
    '@deepseek-ai/dsh-client-ui-primitives': primitives
  }
  const sandbox = { window: { dshDesktop: { hideSidebarManagement }, __ModuleLoader__: { load({ factory }) { plugin = factory(id => dependencies[id]) } } } }
  // Capture the public slot registration from the installed factory.
  vm.runInNewContext(await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js', import.meta.url), 'utf8'), sandbox)
  sandbox.document = { documentElement: { hasAttribute: () => false } }
  const startSession = vi.fn()
  const selectPanel = vi.fn()
  const toggleSidebar = vi.fn()
  plugin.apply({
    get: name => name === 'uiWorkspace' ? { startSession } : undefined, layout: { selectPanel, toggleSidebar },
    locale: { register() {}, subscribe: () => () => {} }, effect() {}, shortcuts: { catalog: {} },
    slots: {
      inject: (_name, callback) => callback(),
      register(options, component) { if (options.name === 'sidebar') { registration = options; Root = component }; return () => {} },
      entriesOfSlot: () => [], subscribe: () => () => {}
    }
  })
  expect(registration.children['sidebar.primaryNavigation']).toEqual({ kind: 'single', scope: 'root' })
  const { hooks: _hooks, ...injected } = registration.inject()
  const props = {
    ...injected, collapsed, width: 240, drawer: false,
    usePanels: select => select(panels), useEntryPins: select => select(unpinned),
    useEntryActions: select => select(true), useShortcuts: select => select([]),
    usePanelInfo: select => select({ activePanelId: 'plugins' }), useRemoteAccess: () => true,
    t: key => key,
    renderSlot(name, owner, options) {
      calls.push({ name, owner, options })
      if (name === 'sidebar.primaryNavigation') return contribution ? contribution(owner) : options.fallback
      return { type: 'slot', props: { name, owner, options } }
    }
  }
  return { render: () => Root(props), calls, startSession, selectPanel, toggleSidebar }
}

const panels = [{ id: 'plugins', label: 'Plugins', order: 0 }, { id: 'schedules', label: 'Schedules', order: 1 }, { id: 'custom', label: 'Custom', order: 2 }]
const panelsWithMarket = [panels[0], { id: 'dsh-market', label: 'Plugin Market', order: 1 }, ...panels.slice(1)]

describe('sidebar primary navigation public slot', () => {
  it.each([false, true])('opens Plugins while keeping Plugin Market hidden in the Windows release (collapsed=%s)', async collapsed => {
    const shell = await sidebar({ collapsed, panels: panelsWithMarket, unpinned: ['plugins'], hideSidebarManagement: true })
    const tree = flatten(shell.render())
    const rows = tree.filter(node => node.type?.name === 'PanelRow')
    expect(rows.map(node => node.props.id)).toEqual(['plugins', 'schedules', 'custom'])
    flatten(evaluate(rows[0])).find(node => node.type === 'button').props.onClick()
    expect(shell.selectPanel).toHaveBeenCalledExactlyOnceWith('plugins')
    const more = tree.find(node => node.type?.name === 'PanelMoreMenu')
    expect(more.props.entries.map(entry => entry.id)).toEqual(['schedules', 'custom'])
    const menu = evaluate(more)
    more.props.onOpen('dsh-market')
    expect(menu.props.anchor.props.children.props['aria-label']).toBe('panels.more')
    expect(menu.props.children.props.name).toBe('sidebar.panellist.actions')
    menu.props.children.props.owner.onOpen('custom')
    expect(shell.selectPanel.mock.calls).toEqual([['plugins'], ['custom']])
  })

  it('keeps the Plugin Market row and its navigation in development', async () => {
    const shell = await sidebar({ panels: panelsWithMarket })
    const tree = flatten(shell.render())
    const row = tree.find(node => node.type?.name === 'PanelRow' && node.props.id === 'dsh-market')
    flatten(evaluate(row)).find(node => node.type === 'button').props.onClick()
    expect(shell.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-market')
  })

  it('omits Plugin Market from panel metadata supplied to Windows release navigation contributions', async () => {
    const contribution = vi.fn()
    const shell = await sidebar({ panels: panelsWithMarket, hideSidebarManagement: true, contribution })
    shell.render()
    expect(contribution.mock.calls[0][0].panels.map(panel => panel.id)).toEqual(['plugins', 'schedules', 'custom'])
  })

  it('keeps native pinned rows and More callbacks when no contribution is registered', async () => {
    const shell = await sidebar({ panels, unpinned: ['plugins', 'custom'] })
    const tree = shell.render()
    const native = flatten(tree).filter(node => node.type?.name === 'PanelRow')
    expect(native.map(node => node.props.id)).toEqual(['plugins', 'schedules'])
    const pluginRow = evaluate(native[0])
    const button = flatten(pluginRow).find(node => node.type === 'button')
    button.props.onClick()
    expect(shell.selectPanel).toHaveBeenCalledExactlyOnceWith('plugins')
    const more = flatten(tree).find(node => node.type?.name === 'PanelMoreMenu')
    expect(more.props.entries.map(entry => entry.id)).toEqual(['schedules', 'custom'])
    more.props.onOpen('custom')
    expect(shell.selectPanel).toHaveBeenLastCalledWith('custom')
    more.props.onOpen('unknown')
    expect(shell.selectPanel).toHaveBeenCalledTimes(2)
    expect(shell.calls.filter(call => call.name === 'sidebar.primaryNavigation')).toHaveLength(1)
    const names = shell.calls.map(call => call.name)
    expect(names.indexOf('sidebar.quickSwitcher')).toBeLessThan(names.indexOf('sidebar.primaryNavigation'))
    expect(names.indexOf('sidebar.primaryNavigation')).toBeLessThan(names.indexOf('sidebar.workspaces'))
  })

  it.each([false, true])('renders one contribution with real navigation callbacks (collapsed=%s)', async collapsed => {
    let owner
    const contribution = vi.fn(props => { owner = props; return { type: 'custom-navigation', props: { style: { width: '100%' }, children: 'A deliberately long full-width navigation contribution' } } })
    const shell = await sidebar({ collapsed, panels, contribution })
    const tree = shell.render()
    expect(contribution).toHaveBeenCalledTimes(1)
    expect(flatten(tree).filter(node => node.type === 'custom-navigation')).toHaveLength(1)
    expect(flatten(tree).filter(node => node.type?.name === 'PanelRow' || node.type?.name === 'PanelMoreMenu')).toHaveLength(0)
    expect(owner.wide).toBe(!collapsed)
    expect(owner.panels).toBe(panels)
    owner.startSession('workspace-id')
    expect(shell.startSession).toHaveBeenCalledExactlyOnceWith('workspace-id')
    owner.selectPanel('schedules')
    expect(shell.selectPanel).toHaveBeenCalledExactlyOnceWith('schedules')
    owner.expandSidebar()
    expect(shell.toggleSidebar).toHaveBeenCalledTimes(collapsed ? 1 : 0)
    owner.renderPanelIcon('plugins')
    expect(shell.calls.at(-1)).toMatchObject({ name: 'sidebar.panellist', owner: { size: 16, active: false }, options: { only: 'plugins' } })
    const clicked = vi.fn()
    const action = evaluate(owner.renderAction({ id: 'custom', label: 'Long accessible custom label', expanded: false, active: true, onClick: clicked }))
    expect(action.props.side).toBe('right')
    expect(action.props.disabled).toBe(!collapsed)
    const button = flatten(action).find(node => node.type === 'button')
    expect(button.props).toMatchObject({ 'aria-label': 'Long accessible custom label', 'aria-current': 'page', 'aria-haspopup': 'menu', 'aria-expanded': false })
    button.props.onClick()
    expect(clicked).toHaveBeenCalledTimes(1)
    const label = flatten(button).find(node => node.type === 'span' && node.props.children === 'Long accessible custom label')
    if (collapsed) expect(label).toBeUndefined()
    else expect(label.props.className).toBeTruthy()
  })

  it('keeps empty native navigation empty while allowing a contribution without panel entries', async () => {
    const empty = await sidebar()
    expect(flatten(empty.render()).filter(node => node.type === 'nav')).toHaveLength(0)
    const custom = await sidebar({ contribution: () => ({ type: 'custom-navigation', props: {} }) })
    expect(flatten(custom.render()).filter(node => node.type === 'custom-navigation')).toHaveLength(1)
  })
})

describe('sidebar More entries', () => {
  it.each([false, true])('filters plugin actions while preserving other More operations when hideSidebarManagement=%s', async hideSidebarManagement => {
    let plugin
    const registrations = new Map()
    const jsx = (type, props, key) => ({ type, props, key })
    const dependencies = {
      '@deepseek-ai/dsh-client-store': { createSnapshotStore: () => ({ set() {} }) },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      '@deepseek-ai/dsh-client-ui-primitives': { MenuItemButton: 'menuitem' }
    }
    const sandbox = { window: { dshDesktop: { hideSidebarManagement }, __ModuleLoader__: { load({ factory }) { plugin = factory(id => dependencies[id]) } } } }
    vm.runInNewContext(await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-entry-customization/lib/client.js', import.meta.url), 'utf8'), sandbox)
    const openList = vi.fn()
    const startSession = vi.fn()
    const onDismiss = vi.fn()
    const tokenUsage = vi.fn()
    const openView = vi.fn()
    const reorder = vi.fn()
    const t = key => key
    const sidebarActions = 'sidebar.panellist.actions'
    const conversationActions = 'conversation.session.header.views.actions'
    const guideActions = 'sidebar.right.tab.guide.actions'
    registrations.set(sidebarActions, [() => jsx('menuitem', { children: 'Token usage', onSelect: tokenUsage })])
    registrations.set(guideActions, [() => jsx('menuitem', { children: 'Reorder', onSelect: reorder })])
    plugin.apply({
      effect() {}, inject() {},
      locale: { bind: () => t }, get: key => key === 'pluginNavigation' ? { openList } : undefined,
      uiWorkspace: { startSession },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, render) => {
          const entries = registrations.get(options.name) ?? []
          const folded = options.name === conversationActions ? [{ id: 'context', label: 'Context' }] : []
          entries.push(() => render({ ...options.inject(), entries: folded, onOpen: openView, t, usePluginNavigation: select => select(true), onDismiss }))
          registrations.set(options.name, entries)
        }
      }
    })
    const buttons = name => flatten(registrations.get(name).map(render => render())).filter(node => node.type === 'menuitem')
    const sidebar = buttons(sidebarActions)
    expect(sidebar.map(item => item.props.children)).toEqual(hideSidebarManagement ? ['Token usage'] : ['Token usage', 'install', 'create'])
    sidebar[0].props.onSelect()
    expect(tokenUsage).toHaveBeenCalledOnce()
    if (!hideSidebarManagement) {
      sidebar[1].props.onSelect()
      sidebar[2].props.onSelect()
      expect(openList).toHaveBeenCalledOnce()
      expect(startSession).toHaveBeenCalledWith(undefined, expect.objectContaining({ prompt: 'createPrompt.sidebar' }))
    }
    const conversation = buttons(conversationActions)
    expect(flatten(conversation[0]).some(node => node.props.children === 'Context')).toBe(true)
    expect(conversation.slice(1).map(item => item.props.children)).toEqual(hideSidebarManagement ? [] : ['install', 'create'])
    conversation[0].props.onSelect()
    expect(openView).toHaveBeenCalledExactlyOnceWith('context')
    const guide = buttons(guideActions)
    expect(guide.map(item => item.props.children)).toEqual(['Reorder', ...(hideSidebarManagement ? [] : ['install', 'create'])])
    guide[0].props.onSelect()
    expect(reorder).toHaveBeenCalledOnce()
  })
})
