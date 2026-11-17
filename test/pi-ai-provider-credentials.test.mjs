import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '@deepseek-ai/dsh-llm-pi-ai'
import { redactSecrets } from '@deepseek-ai/dsh-settings'

const route = 'test-gateway'
const fakeKey = 'test-inline-credential'
const reference = 'TEST_GATEWAY_API_KEY'
const baseURL = 'https://gateway.example.test/v1'
const provider = { api: 'openai-completions', baseURL, models: [{ id: 'test-model' }] }
const rawConfig = auth => ({ providers: { [route]: { ...provider, ...auth } } })

function activate(auth, services = {}) {
  let adapter
  let discover
  const llm = {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: (_routes, value) => { adapter = value },
    registerModelDiscovery: (_namespace, value) => { discover = value }
  }
  const config = Config(rawConfig(auth))
  apply({
    llm,
    fiber: {},
    inject() {},
    on() {},
    waterfall: (_event, _request, headers) => headers,
    get: name => services[name]
  }, config)
  return { adapter, discover }
}

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['inline key', { apiKey: fakeKey }],
  ['credential provider', { apiKeyEnv: reference }, { credentials: { resolve: async name => name === reference ? { value: fakeKey } : undefined } }],
  ['launch environment', { apiKeyEnv: reference }, { launchEnvironment: new Map([[reference, { value: fakeKey }]]) }]
])('authenticates requests and model discovery using the %s', async (_source, auth, services) => {
  const requests = []
  vi.stubGlobal('fetch', async (target, init) => {
    const url = String(target)
    const headers = new Headers(init?.headers)
    requests.push([url, headers.get('authorization')])
    if (url.endsWith('/models')) {
      return Response.json({ data: [{ id: 'test-model' }] })
    }
    return Response.json({ error: { message: 'End request capture' } }, { status: 400 })
  })
  const { adapter, discover } = activate(auth, services)
  const request = {
    provider: route,
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  }
  for await (const _chunk of adapter.stream(request)) { /* Consume through HTTP dispatch. */ }
  await discover({ provider: route, baseURL, api: provider.api })
  expect(requests).toEqual([
    [baseURL + '/chat/completions', 'Bearer ' + fakeKey],
    [baseURL + '/models', 'Bearer ' + fakeKey]
  ])
})

it.each([
  [{ apiKey: fakeKey, apiKeyEnv: reference }, 'only one of apiKey and apiKeyEnv', fakeKey],
  [{ apiKeyEnv: fakeKey }, 'use apiKey for a direct key', fakeKey],
  [{ apiKey: 'invalid\ncredential' }, 'valid in an HTTP header', 'invalid'],
  [{ apiKey: [fakeKey] }, 'valid in an HTTP header', fakeKey],
  [{ apiKey: 987654321 }, 'valid in an HTTP header', '987654321']
])('rejects conflicting or invalid credentials without echoing the input', (auth, expected, sensitive) => {
  expect(() => activate(auth)).toThrow(expected)
  expect(() => activate(auth)).not.toThrow(sensitive)
})

it('projects only the inline credential status into the settings view', () => {
  const raw = rawConfig({ apiKey: fakeKey })
  const settings = redactSecrets(Config, raw)
  expect(settings.value).toEqual(rawConfig({}))
  expect(settings.secrets).toContainEqual({ path: ['providers', route, 'apiKey'], set: true })
  expect(JSON.stringify(settings)).not.toContain(fakeKey)
  expect(redactSecrets(Config, rawConfig({ apiKeyEnv: reference })).value).toEqual(rawConfig({ apiKeyEnv: reference }))
})
