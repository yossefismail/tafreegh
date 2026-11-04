/**
 * Electron prefixes every rejection from `ipcRenderer.invoke` with
 * `Error invoking remote method '<channel>': Error: `. The renderer shows
 * `error.message` verbatim, so strip the transport wrapper while keeping the
 * real cause reported by the main process.
 */
export function ipcErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error ?? '')
  for (let pass = 0; pass < 3; pass++) {
    const next = message
      .replace(/^\s*Error invoking remote method '[^']*':\s*/i, '')
      .replace(/^\s*Error:\s*/i, '')
    if (next === message) break
    message = next
  }
  return message.trim() || 'حدث خطأ غير متوقع'
}
