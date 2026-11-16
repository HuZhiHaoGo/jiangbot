import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Set DSH_MAKENSIS to electron-builder's pinned makensis to compile the actual
// includes on any host. The same fixture also exercises silent failure on Windows.
const compiler = process.env.DSH_MAKENSIS

describe('Windows installation error dialogs', () => {
  it('localizes errors and defaults silent retry dialogs to cancellation', async () => {
    const helper = await readFile(resolve('build/installer-errors.nsh'), 'utf8')
    expect(helper).toContain('$LANGUAGE == 2052')
    expect(helper).toContain('StrCpy $dshInstallError "${EN}"')
    expect(helper).toContain('StrCpy $dshInstallError "${ZH}"')
    expect(helper).toContain('/SD IDCANCEL IDRETRY ${RETRY_LABEL}')
    expect(helper).toContain('DetailPrint $dshInstallError')
  })

  it('bounds both automatic rename retries before the existing dialogs', async () => {
    const source = await readFile(resolve('build/installer-directories.nsh'), 'utf8')
    expect(source).toContain('${If} $dshRenameRetries < 5')
    expect(source).toContain('Sleep 400')
    expect(source).toContain('!insertmacro dshRenameWithRetry $dshFinalDirectory $dshOldDirectory')
    expect(source).toContain('!insertmacro dshRenameWithRetry $dshNewDirectory $dshFinalDirectory')
    expect(source).toContain('Call dshRollbackDirectories')
  })

  it.skipIf(!compiler && process.env.DSH_TEST_NSIS !== '1')('compiles the real installer includes and preserves old files on silent failure', async () => {
    const tool: { path: string, env?: Record<string, string> } = compiler
      ? { path: compiler }
      : await createRequire(import.meta.url)('app-builder-lib/out/toolsets/windows.js').getMakeNsisPath(undefined)
    const temp = await mkdtemp(join(tmpdir(), 'dsh-nsis-errors-'))
    try {
      const executable = join(temp, 'errors.exe')
      const payload = join(temp, 'not-an-executable.txt')
      await writeFile(payload, 'Deliberately invalid extraction helper for failure injection.')
      await writeFile(join(temp, 'LICENSE.txt'), 'fixture')
      await writeFile(join(temp, 'COPYING'), 'fixture')
      const script = join(temp, 'errors.nsi')
      // Use the real directory page callbacks and transaction, not a JS model.
      await writeFile(script, String.raw`
Unicode true
Name "DSH failure fixture"
OutFile "${executable}"
RequestExecutionLevel user
!define APP_FILENAME "dsh-fixture"
!define APP_EXECUTABLE_FILENAME "JiangBot.exe"
!define INSTALL_REGISTRY_KEY "Software\JiangBotInstallerTest\${randomUUID()}"
!define DSH_SEVENZIP_PATH "${payload}"
!define DSH_SEVENZIP_LICENSE_DIR "${temp}"
!include "FileFunc.nsh"
Var parameters
Var scenario
Var oldDesktopLink
Var newDesktopLink
Var oldStartMenuLink
Var newStartMenuLink
!macro installApplicationFiles
  !insertmacro dshExtractPayload "$PLUGINSDIR\missing.7z"
!macroend
!include "${resolve('build/installer.nsh')}"
Section
  InitPluginsDir
  ${'$'}{GetParameters} $parameters
  ${'$'}{GetOptions} $parameters "/ROOT=" $INSTDIR
  ${'$'}{GetOptions} $parameters "/CASE=" $scenario
  ${'$'}{If} $scenario == "staging"
    ; The parent is a file, so CreateDirectory cannot succeed.
    StrCpy $INSTDIR "$INSTDIR\child"
    !insertmacro dshStageApplication
  ${'$'}{ElseIf} $scenario == "extract"
    !insertmacro dshExtractPayload "$PLUGINSDIR\missing.7z"
  ${'$'}{ElseIf} $scenario == "legacy"
    SetShellVarContext current
    WriteRegStr HKCU "${'$'}{INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
    !insertmacro dshFindLegacyUpgrade
    DeleteRegKey HKCU "${'$'}{INSTALL_REGISTRY_KEY}"
    ${'$'}{If} $dshLegacyUpgrade != "1"
      SetErrorLevel 98
      Quit
    ${'$'}{EndIf}
    StrCpy $oldDesktopLink "$INSTDIR\..\legacy-desktop.lnk"
    StrCpy $newDesktopLink "$INSTDIR\..\new-desktop.lnk"
    StrCpy $oldStartMenuLink "$INSTDIR\..\legacy-menu.lnk"
    StrCpy $newStartMenuLink "$INSTDIR\..\new-menu.lnk"
    StrCpy $dshFinalDirectory $INSTDIR
    StrCpy $dshNewDirectory "$INSTDIR.new"
    StrCpy $dshOldDirectory "$INSTDIR.old"
    Call dshPromoteDirectories
    ${'$'}{If} ${'$'}{Errors}
      SetErrorLevel 2
      Quit
    ${'$'}{EndIf}
    !insertmacro dshRemoveLegacyShortcuts
    !insertmacro dshFinishDirectories
    SetErrorLevel 0
    Quit
  ${'$'}{Else}
    StrCpy $dshFinalDirectory $INSTDIR
    StrCpy $dshNewDirectory "$INSTDIR.new"
    StrCpy $dshOldDirectory "$INSTDIR.old"
    ${'$'}{If} $scenario == "rollback"
      ; Model a completed backup followed by a missing staged directory.
      StrCpy $dshOldMoved "1"
    ${'$'}{EndIf}
    Call dshPromoteDirectories
    ${'$'}{If} ${'$'}{Errors}
      SetErrorLevel 2
      Quit
    ${'$'}{EndIf}
  ${'$'}{EndIf}
  ; Every injected failure must quit before reaching this sentinel.
  SetErrorLevel 99
SectionEnd
`)
      execFileSync(tool.path, [process.platform === 'win32' ? '/V2' : '-V2', script], { timeout: 30_000, env: { ...process.env, ...tool.env } })
      expect((await readFile(executable)).subarray(0, 2).toString()).toBe('MZ')
      if (process.platform !== 'win32') return

      const target = join(temp, 'legacy')
      await mkdir(target)
      await mkdir(`${target}.new`)
      await writeFile(join(target, 'DSH Desktop.exe'), 'previous binary')
      await writeFile(join(`${target}.new`, 'JiangBot.exe'), 'new binary')
      for (const file of ['legacy-desktop.lnk', 'legacy-menu.lnk', 'new-desktop.lnk', 'user-data.txt']) {
        await writeFile(join(temp, file), 'preserved outside the application directory')
      }
      const upgrade = spawnSync(executable, ['/S', '/CASE=legacy', `/ROOT=${target}`], { timeout: 15_000 })
      expect(upgrade.error).toBeUndefined()
      expect(upgrade.status).toBe(0)
      await expect(readFile(join(target, 'JiangBot.exe'), 'utf8')).resolves.toBe('new binary')
      await expect(readFile(join(target, 'DSH Desktop.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(temp, 'legacy-desktop.lnk'))).rejects.toMatchObject({ code: 'ENOENT' })
      for (const file of ['new-desktop.lnk', 'legacy-menu.lnk', 'user-data.txt']) {
        await expect(readFile(join(temp, file), 'utf8')).resolves.toBe('preserved outside the application directory')
      }

      for (const scenario of ['staging', 'extract', 'backup', 'promote', 'rollback']) {
        const target = join(temp, scenario)
        if (scenario === 'staging' || scenario === 'promote') {
          await writeFile(target, 'preserved')
        } else if (scenario === 'rollback') {
          await mkdir(`${target}.old`)
          await writeFile(join(`${target}.old`, 'old.txt'), 'preserved')
        } else {
          await mkdir(target)
          await writeFile(join(target, 'old.txt'), 'preserved')
        }
        if (scenario === 'backup' || scenario === 'promote') {
          await mkdir(`${target}.new`)
          await writeFile(join(`${target}.new`, 'new.txt'), 'new')
        }
        if (scenario === 'backup') {
          // A nonempty backup destination forces Rename to fail.
          await mkdir(`${target}.old`)
          await writeFile(join(`${target}.old`, 'occupied.txt'), 'occupied')
        }
        const result = spawnSync(executable, ['/S', `/CASE=${scenario}`, `/ROOT=${target}`], { timeout: 15_000 })
        expect(result.error, scenario).toBeUndefined()
        expect(result.status, scenario).toBe(2)
        const preserved = scenario === 'staging' || scenario === 'promote' ? target : join(target, 'old.txt')
        expect(await readFile(preserved, 'utf8'), scenario).toBe('preserved')
      }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
