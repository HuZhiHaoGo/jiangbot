import { describe, expect, it } from 'vitest'
import { developmentEnvironment, skipBlockingWindowsDevHmr } from '../src/main/development-environment'

const windowsDev = { development: true, packaged: false, platform: 'win32' } as const

describe('development worktree isolation', () => {
  it('uses the same data directory for Windows dev and production with their own port defaults', () => {
    const production = developmentEnvironment({ ...windowsDev, development: false, packaged: true }, 43129, {
      DSH_DEV_PROFILE: '../unsafe', DSH_DEV_HARNESS_PORT: 'invalid'
    })
    expect(production).toEqual({ profile: 'dsh-desktop', harnessPort: 43129, mobilePort: 43127 })
    expect(developmentEnvironment(windowsDev, 43129, {}))
      .toEqual({ profile: production.profile, harnessPort: 43130, mobilePort: 43128 })
  })

  it('keeps development installers and non-Windows development in the development directory', () => {
    expect(developmentEnvironment({ ...windowsDev, packaged: true }, 43129, {}).profile).toBe('dsh-desktop-dev')
    for (const platform of ['darwin', 'linux'] as const) {
      expect(developmentEnvironment({ ...windowsDev, platform }, 43129, {}).profile).toBe('dsh-desktop-dev')
    }
  })

  it('uses distinct profile and loopback ports for a second worktree', () => {
    expect(developmentEnvironment(windowsDev, 43129, {
      DSH_DEV_PROFILE: 'dsh-desktop-dev-workbench', DSH_DEV_HARNESS_PORT: '43132', DSH_DEV_MOBILE_PORT: '43133'
    })).toEqual({ profile: 'dsh-desktop-dev-workbench', harnessPort: 43132, mobilePort: 43133 })
  })

  it.each(['../profile', '/tmp/profile', 'a/b', 'a\\b', 'dsh-desktop', 'DSH-Desktop', 'dsh-desktop.', '..'])('rejects unsafe profile %s', profile => {
    expect(() => developmentEnvironment(windowsDev, 43129, { DSH_DEV_PROFILE: profile })).toThrow('DSH_DEV_PROFILE')
  })

  it.each(['0', '1023', '65536', '-1', '12.5', 'invalid', ' 43132 '])('rejects invalid port %s', value => {
    expect(() => developmentEnvironment(windowsDev, 43129, { DSH_DEV_HARNESS_PORT: value })).toThrow('DSH_DEV_HARNESS_PORT')
    expect(() => developmentEnvironment(windowsDev, 43129, { DSH_DEV_MOBILE_PORT: value })).toThrow('DSH_DEV_MOBILE_PORT')
  })

  it('skips the blocking HMR service only for unpackaged Windows development', () => {
    expect(skipBlockingWindowsDevHmr(true, 'win32')).toBe(false)
    expect(skipBlockingWindowsDevHmr(false, 'darwin')).toBe(false)
    expect(skipBlockingWindowsDevHmr(false, 'linux')).toBe(false)
    expect(skipBlockingWindowsDevHmr(false, 'win32')).toBe(true)
  })

  it('rejects colliding service ports', () => {
    expect(() => developmentEnvironment(windowsDev, 43129, { DSH_DEV_MOBILE_PORT: '43130' })).toThrow('must differ')
  })
})
