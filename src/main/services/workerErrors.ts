/**
 * Turns raw worker stderr into the one sentence a user can act on.
 *
 * The Python worker writes JSONL on stdout; everything on stderr is diagnostic
 * noise (argparse usage banners, tracebacks, library warnings). Showing that
 * text verbatim in the renderer produced the worst failure mode we had: a
 * stale `--choices` list in the installed engine printed a two-page `usage:`
 * block inside the setup error card. Keep the *cause*, drop the transport.
 */

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

const TRACEBACK_NOISE = [
  /^Traceback \(most recent call last\):?$/i,
  /^\s+File "/,
  /^\s+\^+\s*$/,
  /^During handling of the above exception/i,
  /^The above exception was the direct cause/i
]

export interface WorkerFailureInput {
  code?: number | null
  stderrTail?: string
  /** The runner was killed because it exceeded its deadline. */
  timedOut?: boolean
}

function cleanLines(text?: string): string[] {
  return (text ?? '')
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

function clip(text: string, max = 300): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

function exitLabel(code?: number | null): string {
  return code === null || code === undefined ? '?' : String(code)
}

/**
 * argparse prints
 *   usage: tafreegh-worker [-h] ...
 *   tafreegh-worker: error: argument --variant: invalid choice: 'gguf' ...
 * The first half is noise, the second half names the option we have to fix.
 */
function describeArgumentFailure(lines: string[]): string {
  const detail = lines
    .map((line) => line.trim())
    .find((line) => !/^usage:/i.test(line) && /\berror:\s+\S/i.test(line))
  const message = detail?.replace(/^.*?\berror:\s*/i, '') ?? ''
  const argument = message.match(/(?:arguments?\s+|required:\s*)(--?[\w-]+)/i)?.[1]

  if (
    /invalid choice/i.test(message) ||
    /unrecognized arguments?/i.test(message) ||
    /not allowed with argument/i.test(message)
  ) {
    return argument
      ? `نسخة محرك التفريغ المثبّتة لا تدعم الخيار ${argument}. حدّث التطبيق أو أعد تثبيته ثم أعد المحاولة.`
      : 'نسخة محرك التفريغ المثبّتة لا تدعم أحد الخيارات المطلوبة. حدّث التطبيق أو أعد تثبيته ثم أعد المحاولة.'
  }
  if (/required/i.test(message)) {
    return `تعذّر تشغيل محرك التفريغ: خيار مطلوب ناقص${argument ? ` (${argument})` : ''}. أعد تثبيت التطبيق ثم أعد المحاولة.`
  }
  return 'تعذّر تشغيل محرك التفريغ بسبب خيارات غير صحيحة. أعد تثبيت التطبيق ثم أعد المحاولة.'
}

function meaningfulLine(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (TRACEBACK_NOISE.some((pattern) => pattern.test(line))) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    return trimmed
  }
  return undefined
}

export function describeWorkerFailure(input: WorkerFailureInput): string {
  if (input.timedOut) {
    return 'توقّف محرك التفريغ لأنه تجاوز المدة المسموح بها. تحقّق من الاتصال بالإنترنت ومن المساحة الحرة ثم أعد المحاولة.'
  }

  const lines = cleanLines(input.stderrTail)
  if (lines.some((line) => /^usage:\s/i.test(line))) {
    return describeArgumentFailure(lines)
  }

  const text = lines.join('\n')
  const missingModule = text.match(/ModuleNotFoundError: No module named '?([^'\s]+)'?/i)?.[1]
  if (missingModule) {
    return `مكتبات المحرك ناقصة (${missingModule}). أعد تهيئة المحرك من الإعدادات ثم أعد المحاولة.`
  }
  if (/out of memory|OutOfMemoryError|CUDA error: out of memory/i.test(text)) {
    return 'نفدت ذاكرة بطاقة الرسوميات أثناء التشغيل. أغلق التطبيقات التي تستخدم البطاقة ثم أعد المحاولة.'
  }
  if (/No space left on device|Errno 28|disk quota exceeded/i.test(text)) {
    return 'المساحة الحرة على القرص غير كافية. أفرغ مساحة ثم أعد المحاولة.'
  }
  if (
    /ConnectionError|Max retries exceeded|Temporary failure in name resolution|ProxyError|SSLError|ConnectTimeout|ReadTimeout/i.test(
      text
    )
  ) {
    return 'تعذّر الاتصال بالإنترنت أثناء تجهيز المكونات. تحقّق من الاتصال ثم أعد المحاولة.'
  }
  if (/PermissionError|Errno 13|Access is denied/i.test(text)) {
    return 'تعذّر الوصول إلى أحد ملفات التطبيق. أغلق أي برنامج يستخدم مجلد البيانات أو أعد تشغيل التطبيق.'
  }

  const detail = meaningfulLine(lines)
  return detail
    ? `فشل محرك التفريغ (${exitLabel(input.code)}): ${clip(detail)}`
    : `فشل محرك التفريغ (${exitLabel(input.code)}) دون تفاصيل. راجع سجل التطبيق في مجلد البيانات.`
}
