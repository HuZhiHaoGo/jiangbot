import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { RELEASE_HIDDEN_SETTINGS_SECTIONS } from '../src/shared/desktop-sidebar'

const source = await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', import.meta.url), 'utf8')
const rows = [
  { id: 'general', label: '通用设置' },
  { id: 'models', label: '模型' },
  { id: 'plugins', label: '内置插件' },
  { id: 'market', label: '插件市场' },
  { id: 'token-usage', label: 'Token 用量' },
  { id: 'brand', label: '品牌 Branding' }
]

function openPanel({ hiddenSettingsSections, activeId, sections = rows }) {
  let renderPanel
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    react: { useId: () => 'settings', useRef: current => ({ current }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': { useModalLayer() {} }
  }
  vm.runInNewContext(source.replace('exports.SettingsDocumentStore =', 'exports.SettingsPanel = SettingsPanel; exports.SettingsDocumentStore ='), {
    document: { querySelector: () => ({}), body: {} },
    window: {
      dshDesktop: hiddenSettingsSections ? { hiddenSettingsSections } : undefined,
      __ModuleLoader__: { load({ factory }) { renderPanel = factory(id => dependencies[id]).SettingsPanel } }
    }
  })
  const renderSlot = vi.fn()
  const onSelect = vi.fn()
  const tree = renderPanel({ rows: sections, activeId, renderSlot, onSelect, onClose() {} })
  const flatten = node => !node ? [] : Array.isArray(node)
    ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)]
  const nav = flatten(tree).find(node => node.type === 'nav')
  const buttons = flatten(nav).filter(node => node.type === 'button')
  return { buttons, labels: buttons.map(button => button.props.children[1].props.children), renderSlot, onSelect }
}

describe('Windows release settings navigation', () => {
  it('shows every settings entry in dev and opens the requested section', () => {
    const panel = openPanel({ activeId: 'models' })
    expect(panel.labels).toEqual(rows.map(row => row.label))
    expect(panel.renderSlot).toHaveBeenCalledWith('settings.section', expect.anything(), { only: 'models' })
  })

  it.each(RELEASE_HIDDEN_SETTINGS_SECTIONS)('falls back to the first visible section when opening %s', activeId => {
    const panel = openPanel({ hiddenSettingsSections: RELEASE_HIDDEN_SETTINGS_SECTIONS, activeId })
    expect(panel.labels).toEqual(['通用设置', 'Token 用量'])
    expect(panel.buttons[0].props['aria-current']).toBe('true')
    expect(panel.renderSlot).toHaveBeenCalledWith('settings.section', expect.anything(), { only: 'general' })
    panel.buttons[1].props.onClick()
    expect(panel.onSelect).toHaveBeenCalledExactlyOnceWith('token-usage')
  })

  it('handles a settings panel whose installed sections are all hidden', () => {
    const panel = openPanel({ hiddenSettingsSections: RELEASE_HIDDEN_SETTINGS_SECTIONS, sections: [{ id: 'market' }] })
    expect(panel.labels).toEqual([])
    expect(panel.renderSlot.mock.calls.some(([name]) => name === 'settings.section')).toBe(false)
  })
})
