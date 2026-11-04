import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { statSync } from 'node:fs'
import { basename, extname, normalize } from 'node:path'
import { z } from 'zod'
import { IPC } from '../shared/ipc'
import type { ExportKind, ModelKind, ProviderId } from '../shared/types'
import { isAudioPath } from '../shared/languages'
import { copyTextToClipboard } from './services/clipboard'
import { verifyHfToken } from './services/hf'
import type { HistoryStore } from './services/history'
import type { JobService } from './services/jobs'
import { MOCK, getPaths, isWithinRoot } from './services/paths'
import type { ProvidersService } from './services/providers'
import type { SettingsStore } from './services/settings'
import type { SetupService } from './services/setup'

const providerIds: ProviderId[] = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'qwen',
  'moonshot',
  'zhipu',
  'openrouter',
  'xai',
  'together',
  'fireworks',
  'ollama',
  'ollama-cloud',
  'lmstudio',
  'llamacpp',
  'vllm',
  'custom'
]

const providerSchema = z.enum(providerIds as [ProviderId, ...ProviderId[]])
const modelKind = z.enum(['jais', 'diarizer'])

/** Exported for the unit tests that pin the accepted request shapes. */
export const settingsPatchSchema = z
  .object({
    language: z.enum(['ar', 'en']).optional(),
    dialect: z.string().min(1).max(8).optional(),
    enhance: z.boolean().optional(),
    summarizer: z
      .object({
        provider: z.enum(['none', ...providerIds] as [string, ...string[]]).optional(),
        model: z.string().max(200).optional(),
        baseUrl: z.string().max(300).optional(),
        temperature: z.number().min(0).max(1.5).optional(),
        maxTokens: z.number().int().min(256).max(16000).optional()
      })
      .optional(),
    providers: z
      .record(
        z.string(),
        z.object({
          baseUrl: z.string().max(300).optional(),
          model: z.string().max(200).optional()
        })
      )
      .optional()
  })
  .strict()

const sessionSummarizerSchema = z
  .object({
    provider: z.enum(
      ['none', ...providerIds] as [ProviderId | 'none', ...(ProviderId | 'none')[]]
    ),
    model: z.string().max(200).optional()
  })
  .strict()

/** Exported for the unit tests that pin the accepted request shapes. */
export const startSchema = z
  .object({
    filePath: z.string().min(3).max(2048),
    language: z.string().min(1).max(8),
    enhance: z.boolean(),
    summarizer: sessionSummarizerSchema.optional()
  })
  .strict()

const providerQuerySchema = z
  .object({
    provider: providerSchema,
    baseUrl: z.string().max(300).optional(),
    apiKey: z.string().max(500).optional()
  })
  .strict()

const providerTestSchema = providerQuerySchema.extend({
  model: z.string().max(200).optional()
})

/** Speaker letters are assigned A..H by the pipeline; anything else is noise. */
export const speakerNamesSchema = z.record(
  z.string().regex(/^[A-Ha-h]$/),
  z.string().trim().max(40)
)

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error('طلب غير صالح: ' + result.error.issues.map((i) => i.message).join(', '))
  }
  return result.data
}

export interface IpcContext {
  history: HistoryStore
  settings: SettingsStore
  providers: ProvidersService
  setup: SetupService
  jobs: JobService
  broadcast: (channel: string, payload: unknown) => void
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    mock: MOCK,
    dataRoot: getPaths().root
  }))

  ipcMain.handle(IPC.appPickAudio, async () => {
    const result = await dialog.showOpenDialog({
      title: 'اختر تسجيلًا صوتيًا',
      properties: ['openFile'],
      filters: [
        {
          name: 'ملفات صوتية وفيديو',
          extensions: [
            'm4a',
            'mp3',
            'wav',
            'ogg',
            'opus',
            'mp4',
            'aac',
            'flac',
            'wma',
            'webm',
            'mov',
            'mkv'
          ]
        },
        { name: 'كل الملفات', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.appOpenExternal, async (_event, value: unknown) => {
    const url = parse(z.string().url().max(2048), value)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('رابط غير مسموح')
    }
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC.appFileInfo, (_event, value: unknown) => {
    const filePath = parse(z.string().min(3).max(2048), value)
    try {
      const stat = statSync(filePath)
      if (!stat.isFile() || !isAudioPath(filePath)) return null
      return {
        path: filePath,
        name: basename(filePath),
        size: stat.size,
        ext: extname(filePath).replace('.', '').toLowerCase()
      }
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.appCopyText, (_event, value: unknown) => {
    // 500k characters is far beyond a long transcript; anything bigger is a
    // renderer bug, not a user action.
    const text = parse(z.string().max(500_000), value)
    copyTextToClipboard(text)
  })

  ipcMain.handle(IPC.appRevealPath, (_event, value: unknown) => {
    const target = normalize(parse(z.string().min(1).max(2048), value))
    if (!isWithinRoot(getPaths().root, target)) {
      throw new Error('مسار غير مسموح')
    }
    shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC.setupStatus, () => ctx.setup.status())
  ipcMain.handle(IPC.setupStart, () => ctx.setup.start())
  ipcMain.handle(IPC.setupCancel, () => ctx.setup.cancel())
  ipcMain.handle(IPC.setupPickModelDir, async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(window, {
      title: 'اختر مجلد نموذج Jais-ASR',
      buttonLabel: 'استخدام هذا المجلد',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle(IPC.setupUseExistingModel, (_event, value: unknown) => {
    return ctx.setup.useExistingModel(parse(z.string().min(3).max(2048), value))
  })
  ipcMain.handle(IPC.setupRemoveModels, async () => {
    const status = await ctx.setup.status()
    if (status.running) throw new Error('أوقف التهيئة أولًا')
    await ctx.setup.removeModels()
  })
  ipcMain.handle(IPC.setupDownloadModel, (_event, value: unknown) => {
    return ctx.setup.downloadModel(parse(modelKind, value))
  })
  ipcMain.handle(IPC.setupPickModelPath, async (_event, value: unknown) => {
    const kind = parse(modelKind, value)
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const titles: Record<ModelKind, string> = {
      jais: 'اختر مجلد نموذج Jais-ASR',
      diarizer: 'اختر مجلد نموذج تمييز المتحدثين'
    }
    const result = await dialog.showOpenDialog(window, {
      title: titles[kind],
      buttonLabel: 'استخدام هذا المجلد',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return ctx.setup.setModelPath(kind, result.filePaths[0])
  })

  ipcMain.handle(IPC.jobsList, () => ctx.jobs.list())
  ipcMain.handle(IPC.jobsStart, (_event, input: unknown) => {
    const data = parse(startSchema, input)
    return ctx.jobs.start(data)
  })
  ipcMain.handle(IPC.jobsCancel, (_event, id: unknown) => {
    return ctx.jobs.cancel(parse(z.string().min(4).max(64), id))
  })
  ipcMain.handle(IPC.jobsRemove, (_event, id: unknown) => {
    ctx.jobs.remove(parse(z.string().min(4).max(64), id))
  })
  ipcMain.handle(IPC.jobsRetrySummary, (_event, id: unknown) => {
    return ctx.jobs.retrySummary(parse(z.string().min(4).max(64), id))
  })
  ipcMain.handle(IPC.jobsRenameSpeakers, (_event, id: unknown, names: unknown) => {
    return ctx.jobs.renameSpeakers(
      parse(z.string().min(4).max(64), id),
      parse(speakerNamesSchema, names)
    )
  })
  ipcMain.handle(IPC.jobsOpenOutput, (_event, id: unknown) => {
    return ctx.jobs.openOutput(parse(z.string().min(4).max(64), id))
  })
  ipcMain.handle(IPC.jobsReveal, (_event, id: unknown) => {
    ctx.jobs.reveal(parse(z.string().min(4).max(64), id))
  })
  ipcMain.handle(IPC.jobsExport, (_event, id: unknown, kind: unknown) => {
    return ctx.jobs.export(
      parse(z.string().min(4).max(64), id),
      parse(z.enum(['audio', 'txt', 'html', 'summary'] as [ExportKind, ...ExportKind[]]), kind)
    )
  })

  ipcMain.handle(IPC.settingsGet, () => ctx.settings.get())
  ipcMain.handle(IPC.settingsUpdate, (_event, patch: unknown) => {
    const data = parse(settingsPatchSchema, patch) as Parameters<SettingsStore['update']>[0]
    return ctx.settings.update(data)
  })
  ipcMain.handle(IPC.settingsSetKey, (_event, provider: unknown, key: unknown) => {
    return ctx.settings.setApiKey(
      parse(providerSchema, provider),
      parse(z.string().max(500), key)
    )
  })
  ipcMain.handle(IPC.settingsClearKey, (_event, provider: unknown) => {
    return ctx.settings.clearApiKey(parse(providerSchema, provider))
  })

  ipcMain.handle(IPC.settingsSetHfToken, async (_event, token: unknown) => {
    const value = parse(z.string().trim().min(8).max(200), token)
    const check = await verifyHfToken(value)
    if (check.status === 'invalid') {
      throw new Error('رمز Hugging Face غير صالح. تأكّد من نسخه كاملًا من إعدادات حسابك.')
    }
    return ctx.settings.setHfToken(value)
  })

  ipcMain.handle(IPC.settingsClearHfToken, () => ctx.settings.clearHfToken())

  ipcMain.handle(IPC.providersList, () => ctx.providers.infos())
  ipcMain.handle(IPC.providersModels, (_event, query: unknown) => {
    return ctx.providers.listModels(parse(providerQuerySchema, query))
  })
  ipcMain.handle(IPC.providersTest, (_event, query: unknown) => {
    return ctx.providers.test(parse(providerTestSchema, query))
  })

  void ctx.broadcast
}
