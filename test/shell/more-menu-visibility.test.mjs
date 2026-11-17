import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { expect, it, vi } from 'vitest'

const installed = name => readFile(new URL(`../../node_modules/@deepseek-ai/${name}`, import.meta.url), 'utf8')
const jsx = (type, props) => ({ type, props })
const flatten = tree => Array.isArray(tree) ? tree.flatMap(flatten)
  : tree && typeof tree === 'object' ? [tree, ...flatten(tree.props.children)] : []

it.each([
  { release: true, limit: 4, actions: ['entry-customization'], folded: undefined },
  { release: true, limit: 1, actions: ['entry-customization'], folded: ['context'] },
  { release: true, limit: 4, actions: ['entry-customization', 'other-action'], folded: [] },
  { release: false, limit: 4, actions: ['entry-customization'], folded: [] },
  { release: true, limit: 1, actions: [], folded: undefined }
])('uses the real header behavior with $actions, release=$release, tab limit=$limit', async ({ release, limit, actions, folded }) => {
  const source = await installed('dsh-client-ui-conversation/lib/client.js')
  const start = source.indexOf('function ConversationSessionHeader(')
  const header = source.slice(start, source.indexOf('\n\t\t/**', start))
  const snapshot = source.slice(source.indexOf('const viewActions = {'), source.indexOf('const bindings = /* @__PURE__ */ new Set();'))
  const selectView = vi.fn()
  const tabs = [{ id: 'chat', label: 'Chat' }, { id: 'context', label: 'Context' }]
  const render = vm.runInNewContext(`(() => { ${snapshot} ${header}
    return (props) => ConversationSessionHeader({ ...props, useEntryActions: select => select(viewActions.getSnapshot()), standaloneEntryActions });
  })()`, {
    window: { dshDesktop: { hideSidebarManagement: release } },
    slots: { entriesOfSlot: () => actions.map(id => ({ options: { id } })), subscribe() {} },
    react: {
      useRef: () => ({ current: null }), useState: () => [limit, () => {}], useLayoutEffect() {},
      useMemo: compute => compute(), useSyncExternalStore: (_subscribe, snapshot) => snapshot()
    },
    react_jsx_runtime: { jsx, jsxs: jsx },
    resolveActiveView: values => values[0], deriveAncestry() {}, equalBreadcrumbs() {},
    ConversationRoot_module_css_default: {}, clsx() {}, FIXED_VIEW_ID: 'chat',
    ViewsMoreMenu: 'views-more', ViewTabLabel: 'view-tab-label'
  })
  const nodes = flatten(render({
    sessionId: 's', useContextMenu: () => ({}), useSessions: () => [],
    useConversationViews: select => select(tabs), useStore: select => select({ view: 'chat' }),
    useEntryPins: select => select([]), renderSlot() {}, selectView, t: key => key
  }))
  const more = nodes.find(node => node.type === 'views-more')
  expect(more?.props.entries.map(entry => entry.id)).toEqual(folded)
  if (folded?.length) {
    more.props.onOpen(folded[0])
    expect(selectView).toHaveBeenCalledExactlyOnceWith('context')
  }
})

it.each([false, true])('filters the Better Sidebar guide data menu only in a release: %s', async release => {
  const source = await installed('dsh-web-frontend/dist/assets/index-BgUyXZcc.js')
  const start = source.indexOf('function DshDesktopMenu(')
  const end = source.indexOf('const FU=Object.freeze', start)
  const render = vm.runInNewContext(`${source.slice(start, end)}\nDshDesktopMenu`, {
    window: { dshDesktop: { hideSidebarManagement: release } },
    p: { jsx },
    $4: 'menu'
  })
  const items = [
    { id: 'open:long-label', label: 'A long folded entry from a different plugin' },
    { id: 'overflow-separator', type: 'separator' },
    { id: 'browse' }, { id: 'create' }, { id: 'actions-separator', type: 'separator' }, { id: 'order' }
  ]
  const onSelect = vi.fn()
  const menu = render({ anchor: jsx('button', { 'data-guide-more': 'true' }), items, onSelect })
  expect(menu.props.items.map(item => item.id)).toEqual(release
    ? ['open:long-label', 'overflow-separator', 'order'] : items.map(item => item.id))
  menu.props.onSelect('order')
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('order')
  expect(render({ anchor: jsx('button', {}), items }).props.items).toBe(items)
})
