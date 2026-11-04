import type { JobTranscript, Settings } from '../../shared/types'
import { providerInfo, type ProvidersService } from './providers'

export interface Moment {
  t: number
  label: string
}

export interface SummaryResult {
  markdown: string
  provider: string
  model: string
  moments: Moment[]
  chunks: number
}

const MAX_CHARS = 42_000
// A local Ollama run gets an 8192-token window (ollama.ts LOCAL_CONTEXT) and
// the final answer can take 2500 of them. Arabic costs ~3 characters per
// token, so a 42k-character chunk plus the template overflows and the daemon
// silently drops the system prompt, which is why a 41-minute feedback session
// came back as free-form prose with no timestamps. Keep local chunks small
// enough that the instructions, the notes and the answer all fit.
const MAX_CHARS_LOCAL = 12_000
const MAP_TOKENS = 900
// Total map notes must leave room for the template and the final answer.
const LOCAL_NOTES_TOKENS = 3_500

function stamp(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function transcriptToText(transcript: JobTranscript): string {
  const lines = transcript.lines
    .filter((line) => line.text.trim())
    .map((line) => `[${stamp(line.start)}] ${line.speaker}: ${line.text.trim()}`)
  const header = `عنوان التسجيل: ${(transcript as JobTranscript & { title?: string }).title ?? 'تسجيل'} | المدة: ${stamp(transcript.duration)} | المتحدثون: ${transcript.speakers.join('، ')}`
  return `${header}\n\n${lines.join('\n')}`
}

function splitTranscript(text: string, maxChars = MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text]
  const lines = text.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length > maxChars && current.length > 4) {
      chunks.push(current.join('\n'))
      current = current.slice(-2)
      size = current.join('\n').length
    }
    current.push(line)
    size += line.length + 1
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks
}

const MAP_SYSTEM =
  'أنت محرر تفريغ صوتي عربي محترف ودقيق. تكتب بالعربية الفصحى المبسطة. لا تخترع معلومات غير موجودة في التفريغ، وإن كان اسم أو رقم غير واضح فاذكره بين قوسين مع [غير واضح]. اتبع تعليمات المستخدم حرفيًا، ولا تكتب مقدمة ولا خاتمة.'

/**
 * The final pass is where small local models drift: gemma:e4b kept inventing
 * its own `### 1.` outline and dropping timestamps, which left the key-moments
 * rail empty and forced the transcript fallback. The template and the moment
 * criteria therefore live in the system prompt, which these models weight more
 * strongly than a paragraph buried in the user message.
 */
const FINAL_SYSTEM = `أنت محرر تفريغ صوتي عربي محترف ودقيق. تكتب بالعربية الفصحى المبسطة. لا تخترع معلومات غير موجودة في التفريغ، وإن كان اسم أو رقم غير واضح فاذكره بين قوسين مع [غير واضح].

اكتب الملخص بالقالب التالي حرفيًا، بهذا الترتيب وبنفس الغامق، واستبدل كل … بمحتوى فعلي:
**نظرة عامة:** فقرة من سطرين إلى أربعة تصف التسجيل ومن يتحدث فيه وموضوعه.
**أهم النقاط:**
**عنوان الموضوع الأول (mm:ss–mm:ss):**
- نقطة واحدة أو أكثر، كل نقطة في سطر واحد مع توقيتها (mm:ss).
**عنوان الموضوع الثاني (mm:ss–mm:ss):**
- نقطة (mm:ss).
**بنود التنفيذ / Action points:**
- [ ] مهمة محددة، مع المسؤول والموعد إن ذُكرا.
- [x] مهمة ورد أنها أُنجزت.
قواعد صارمة:
1. لا تستخدم عناوين ### أو ####، ولا ترقيمًا مثل "1." أو "2."، ولا أي عنوان لا ينتهي بمدة زمنية (mm:ss–mm:ss).
2. اجمع النقاط المترابطة تحت عنوان واحد: من نقطتين إلى أربع نقاط تحت كل عنوان، ولا تجعل كل نقطة عنوانًا مستقلًا.
3. كل عنوان موضوعي يحتوي مدة مأخوذة من توقيتات النص، مرتبة تصاعديًا، ومدة الموضوع بين دقيقة وست دقائق، بلا تداخل بين موضوعين.
4. لا تكتب عنوانًا بلا نقط تحته، ولا تكرر الموضوع نفسه مرتين.
5. غطِّ التسجيل كله: يبدأ أول عنوان من بداية التسجيل ويصل آخر عنوان إلى نهايته، بما في ذلك الثلث الأخير. لا تبدأ من منتصف التسجيل.
6. في بنود التنفيذ اذكر المهام الفعلية فقط: من سيفعل ماذا ومتى. لا تكرر فيها نقاط الملخص، واستخرج كل التزام أو طلب أو مهمة مهما كان عددها؛ وإن لم توجد فاكتب سطرًا واحدًا يوضح ذلك.
7. لا تضف قسمًا ولا جملة ختامية خارج هذا القالب.

اللحظة المفتاحية هي العنوان الموضوعي. اعتبرها لحظة فقط إذا حقق المقطع واحدًا مما يلي:
- نقد أو ملاحظة محددة على العمل، مع سببها.
- قرار أو موافقة أو رفض.
- تكليف أو طلب أو مهمة يجب تنفيذها.
- توصية أو حل أو منهج عمل مقترح.
- تعريف مصطلح أو معيار أو إطار يحكم بقية النقاش.
- رقم أو موعد أو مسؤول حاسم.
- انتقال واضح من موضوع إلى موضوع آخر.
ولا تُعد لحظات: الترحيب والمجاملات والكلام التمهيدي، وإعادة صياغة كلام سابق، والأسئلة بلا إجابة، والأمثلة التوضيحية العابرة.

قواعد عنوان اللحظة:
- من ثلاث إلى ثماني كلمات، عبارة اسمية تصف الموضوع أو القرار.
- بلا فعل في البداية مثل "تحدث عن" أو "ما قام به" أو "قال إن".
- بلا نقطة ولا علامة سؤال ولا نقاط حذف، وبلا اسم المتحدث.
- أبقِ المصطلح الإنجليزي بالحروف اللاتينية كما ورد.
أمثلة صحيحة:
**غموض العلاقة بين التحكم والانتماء (21:55–23:20):**
**توصية بتبسيط النظرية وتطبيقها على أمثلة محددة (28:55–30:20):**
**الفرق بين العمارة والأنظمة التقنية (06:55–08:10):**
مثال خاطئ: **ما قام به المتحدث في البداية (00:00–03:00):**

عدد اللحظات من ثلاث إلى ثماني لحظات فقط، موزعة على التسجيل كله.`

function mapPrompt(chunk: string, index: number, total: number): string {
  return `هذا الجزء ${index} من ${total} من تفريغ تسجيل صوتي. اكتب خلاصة عربية مركّزة له في ست إلى اثنتي عشرة نقطة، كل نقطة في سطر واحد يبدأ بمدى زمني (mm:ss–mm:ss) مأخوذ من الطوابع الموجودة في النص. لا تنسخ جملًا من التفريغ ولا تذكر أسماء المتحدثين؛ اختصر الفكرة واحفظ الاسم أو الرقم أو القرار أو الطلب أو الموعد كما ورد. لا تكتب مقدمة ولا خاتمة ولا عناوين.

التفريغ:
${chunk}`
}

function finalPrompt(transcriptText: string, notes?: string): string {
  if (notes) {
    return `هذه ملاحظات مرقّمة بالتوقيت جُمعت من أجزاء تسجيل طويل. اكتب منها الملخص النهائي وفق القالب والقواعد في تعليمات النظام، دون إضافة أي معلومة غير موجودة فيها، وغطِّ التسجيل من أوله لآخره.

ملاحظات الأجزاء:
${notes}`
  }
  return `هذا تفريغ كامل لتسجيل صوتي. اكتب منه الملخص النهائي وفق القالب والقواعد في تعليمات النظام، وغطِّ التسجيل من أوله لآخره.

التفريغ:
${transcriptText}`
}

export function cleanSummary(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()
  text = text.replace(/^(بالتأكيد|حسنًا|حسنا)[،,!.\s]*/i, '').trim()
  text = text.replace(/^إليك (الملخص|ملخص)[^\n]*\n+/i, '').trim()
  text = text.replace(/\r\n/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function timeToSeconds(value: string): number {
  const parts = value.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/**
 * Transcript lines are tagged with the detected dialect (`[EG]`) and carry
 * bidi marks. A moment label must never surface either of them in the rail.
 */
function cleanLabel(value: string): string {
  return value
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^\s*\[[A-Za-z]{2,8}(?:-[A-Za-z]+)*\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const SKIP_LABEL = /نظرة عامة|أهم النقاط|بنود التنفيذ|action points|الملخص/i

export function deriveMoments(summary: string, transcript: JobTranscript): Moment[] {
  const found: Moment[] = []
  const headingRe =
    /\*\*([^*\n]{2,90}?)\s*[\(（]\s*(\d{1,3}:\d{2}(?::\d{2})?)(?:\s*[–—\-]\s*(\d{1,3}:\d{2}(?::\d{2})?))?\s*[\)）]\s*:?\*\*/g
  let match: RegExpExecArray | null
  while ((match = headingRe.exec(summary)) !== null) {
    const label = cleanLabel(match[1]).replace(/[:：]$/, '')
    if (!label || SKIP_LABEL.test(label)) continue
    const t = timeToSeconds(match[2])
    found.push({ t, label })
  }

  if (found.length < 2) {
    const lineRe = /^[-*]\s*[\(（]?(\d{1,3}:\d{2}(?::\d{2})?)[\)）]?\s*[-–—:]?\s*(.+)$/gm
    while ((match = lineRe.exec(summary)) !== null) {
      const label = cleanLabel(match[2]).replace(/\*\*/g, '').slice(0, 60)
      if (label) found.push({ t: timeToSeconds(match[1]), label })
    }
  }

  const unique: Moment[] = []
  for (const moment of found.sort((a, b) => a.t - b.t)) {
    if (unique.some((m) => Math.abs(m.t - moment.t) < 15)) continue
    unique.push(moment)
    if (unique.length >= 12) break
  }
  if (unique.length >= 1) return unique

  const lines = transcript.lines.filter((line) => line.text.trim())
  if (!lines.length) return unique
  const count = Math.min(8, Math.max(2, Math.round(transcript.duration / 180)))
  const step = Math.max(1, Math.floor(lines.length / count))
  const fallback: Moment[] = []
  for (const line of lines.filter((_, index) => index % step === 0).slice(0, count)) {
    const text = cleanLabel(line.text)
    const words = text.split(/\s+/).slice(0, 6).join(' ')
    fallback.push({ t: line.start, label: words + (text.length > 40 ? '…' : '') })
  }
  return fallback
}

export async function summarizeTranscript(
  providers: ProvidersService,
  settings: Settings,
  transcript: JobTranscript,
  options: { maxMoments?: number; onStatus?: (message: string) => void } = {}
): Promise<SummaryResult> {
  if (process.env.TAFREEGH_MOCK === '1') {
    const markdown = `**نظرة عامة:** اجتماع فريق المنتج لمناقشة خطة الربع القادم وأولويات الإطلاق، بحضور فريقين.

**أهم النقاط:**
- مراجعة خطة الربع القادم وتحديد أولويات الإطلاق (00:00–00:20).
- تجهيز خطة اختبار مع فريق الجودة قبل نهاية الشهر (00:31–00:43).
- الموافقة على ميزانية إضافية للبنية السحابية مقابل تقرير أسبوعي (00:43–00:55).

**بنود التنفيذ / Action points:**
- [ ] التواصل مع سارة وإرسال ملاحظات التصميم اليوم.
- [ ] كتابة التقرير الأسبوعي ومشاركته يوم الخميس.
- [ ] إرسال ملخص الاجتماع على البريد الإلكتروني.
- [x] الاتفاق على موعد الاجتماع القادم.`
    return {
      markdown,
      provider: 'ollama',
      model: 'qwen3:14b',
      moments: deriveMoments(markdown, transcript).slice(0, options.maxMoments ?? 12),
      chunks: 1
    }
  }
  const config = settings.summarizer
  if (!config.provider || config.provider === 'none') {
    throw new Error('لم يتم اختيار مزود للملخص')
  }
  const info = providerInfo(config.provider)
  let model = config.model.trim()
  if (!model) {
    model = info.models[0] ?? ''
  }
  if (!model) throw new Error('اختر نموذجًا للملخص من الإعدادات')

  const transcriptText = transcriptToText(transcript)
  const local = info.kind === 'local'
  const chunks = splitTranscript(transcriptText, local ? MAX_CHARS_LOCAL : MAX_CHARS)
  const mapTokens = local
    ? Math.max(300, Math.min(MAP_TOKENS, Math.floor(LOCAL_NOTES_TOKENS / chunks.length)))
    : MAP_TOKENS
  let notes: string | undefined

  try {
    if (chunks.length > 1) {
      const parts: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const raw = await providers.complete({
          provider: config.provider,
          baseUrl: config.baseUrl,
          model,
          system: MAP_SYSTEM,
          user: mapPrompt(chunks[i], i + 1, chunks.length),
          maxTokens: mapTokens,
          temperature: Math.min(0.3, config.temperature),
          retries: 1,
          onStatus: options.onStatus
        })
        parts.push(`[الجزء ${i + 1}]\n${cleanSummary(raw)}`)
      }
      notes = parts.join('\n\n')
    }

    const raw = await providers.complete({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model,
      system: FINAL_SYSTEM,
      user: finalPrompt(transcriptText, notes),
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      retries: 2,
      onStatus: options.onStatus
    })
    const markdown = cleanSummary(raw)
    if (!markdown) throw new Error('الملخص الناتج فارغ')
    return {
      markdown,
      provider: config.provider,
      model,
      moments: deriveMoments(markdown, transcript).slice(0, options.maxMoments ?? 12),
      chunks: chunks.length
    }
  } finally {
    // Free the GPU as soon as the summary is done, so the next transcription
    // is not competing with a model that is still resident in VRAM.
    try {
      await providers.release({ provider: config.provider, baseUrl: config.baseUrl, model })
    } catch {
      // best effort: Ollama also unloads on its own idle timer
    }
  }
}
