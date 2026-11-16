/**
 * Unpackaged Windows development deadlocks in `@deepseek-ai/dsh-hmr`:
 * the watcher never becomes ready, so profile boot never finishes.
 * Packaged launches keep the upstream service.
 */
export function skipBlockingWindowsDevHmr(packaged: boolean, platform: NodeJS.Platform): boolean {
  return !packaged && platform === 'win32'
}

/** A Windows checkout uses the installed profile by default. Overrides still allow isolated worktrees. */
export function developmentEnvironment(
  { development, packaged, platform }: { development: boolean; packaged: boolean; platform: NodeJS.Platform },
  defaultHarnessPort: number,
  env: NodeJS.ProcessEnv = process.env
): {
  profile: string
  harnessPort: number
  mobilePort: number
} {
  if (!development) return { profile: 'dsh-desktop', harnessPort: defaultHarnessPort, mobilePort: 43127 }
  const override = env.DSH_DEV_PROFILE
  if (override && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(override) || override.replace(/\.+$/u, '').toLowerCase() === 'dsh-desktop')) {
    throw new Error('DSH_DEV_PROFILE must be a separate development directory name.')
  }
  const profile = override || (platform === 'win32' && !packaged ? 'dsh-desktop' : 'dsh-desktop-dev')
  const port = (value: string | undefined, fallback: number, name: string): number => {
    if (!value) return fallback
    const parsed = Number(value)
    if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(`${name} must be an integer from 1024 to 65535.`)
    }
    return parsed
  }
  const harnessPort = port(env.DSH_DEV_HARNESS_PORT, defaultHarnessPort + 1, 'DSH_DEV_HARNESS_PORT')
  const mobilePort = port(env.DSH_DEV_MOBILE_PORT, 43128, 'DSH_DEV_MOBILE_PORT')
  if (harnessPort === mobilePort) throw new Error('Development Harness and mobile ports must differ.')
  return { profile, harnessPort, mobilePort }
}
