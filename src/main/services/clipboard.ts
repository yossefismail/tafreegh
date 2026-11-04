import { clipboard } from 'electron'

type ClipboardWriter = { writeText: (value: string) => void }

/**
 * Best-effort clipboard write from the main process.
 *
 * `clipboard` can be missing or throw (headless sessions, locked clipboard on
 * Windows). The renderer treats a rejection as "use the textarea fallback", so
 * translate the failure into an actionable Arabic message instead of leaking a
 * native error, and never write an empty string (that silently wipes whatever
 * the user had on the clipboard).
 */
export function copyTextToClipboard(
  text: string,
  writer: ClipboardWriter | undefined = clipboard
): void {
  if (!text) return
  try {
    if (!writer || typeof writer.writeText !== 'function') {
      throw new Error('clipboard unavailable')
    }
    writer.writeText(text)
  } catch (error) {
    console.warn('[Tafreegh] clipboard write failed:', error)
    throw new Error('تعذّر النسخ إلى الحافظة. حدّد النص وانسخه يدويًا.')
  }
}
