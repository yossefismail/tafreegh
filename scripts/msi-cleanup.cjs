'use strict'

/**
 * electron-builder hook: give the MSI the same uninstall cleanup the NSIS
 * installer gets from build/installer.nsh.
 *
 * The MSI target has no "delete app data" option, but it does emit the WiX
 * project to disk and fire `msiProjectCreated` before candle runs, so we add
 * one deferred action there:
 *
 *   cmd /c rmdir /s /q "%LOCALAPPDATA%\Tafreegh"
 *
 * guarded by `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND NOT REINSTALL`, so
 * a repair (`REINSTALL=ALL` also sets `REMOVE=ALL`) or a major upgrade (which
 * uninstalls the old product first) never touches the models, and
 * `Return="ignore"` so a locked file cannot fail an uninstall.
 */

const fs = require('node:fs')

const ACTION_ID = 'TafreeghRemoveData'
const SET_ID = 'TafreeghSetDataDir'
const MARKER = `Id="${ACTION_ID}"`

const ACTIONS = `
    <!-- Tafreegh: %LOCALAPPDATA%\\Tafreegh holds every downloaded model, the
         Python runtime and the jobs. Remove it on uninstall only. -->
    <Property Id="TAFREEGH_DATA" Secure="yes"/>
    <CustomAction Id="${SET_ID}" Property="TAFREEGH_DATA"
                  Value="[LocalAppDataFolder]Tafreegh" Execute="immediate"/>
    <CustomAction Id="${ACTION_ID}" Directory="TARGETDIR"
                  ExeCommand='[SystemFolder]cmd.exe /c rmdir /s /q "[TAFREEGH_DATA]"'
                  Execute="deferred" Impersonate="yes" Return="ignore"/>`

const SEQUENCE_ENTRIES = `    <Custom Action="${SET_ID}" After="CostFinalize">1</Custom>
      <Custom Action="${ACTION_ID}" After="RemoveFiles">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND NOT REINSTALL AND NOT WIX_UPGRADE_DETECTED</Custom>`

module.exports = async function msiProjectCreated(projectFile) {
  let xml = fs.readFileSync(projectFile, 'utf8')
  if (xml.includes(MARKER)) return

  // Reuse the template's execute sequence when it emitted one (the assisted
  // template does when runAfterFinish is on), otherwise create it.
  if (xml.includes('<InstallExecuteSequence>')) {
    xml = xml.replace(
      '<InstallExecuteSequence>',
      `<InstallExecuteSequence>\n${SEQUENCE_ENTRIES}`
    )
  } else {
    xml = xml.replace(
      '</Product>',
      `  <InstallExecuteSequence>\n${SEQUENCE_ENTRIES}\n    </InstallExecuteSequence>\n  </Product>`
    )
  }

  xml = xml.replace('</Product>', `${ACTIONS}  </Product>`)
  fs.writeFileSync(projectFile, xml, 'utf8')
}
