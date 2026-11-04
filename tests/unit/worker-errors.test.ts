import { describe, expect, it } from 'vitest'
import { describeWorkerFailure } from '../../src/main/services/workerErrors'

/**
 * Regression for the setup failure where a stale argparse `choices` list in
 * the installed worker rejected `--variant gguf` and the renderer showed the
 * whole `usage:` banner inside its error card.
 */
const ARGPARSE_CHOICE = [
  'usage: tafreegh-worker [-h] {probe,models-status,setup-models,setup-jais,run,render} ...',
  'tafreegh-worker: error: argument --variant: invalid choice: \'gguf\' (choose from',
  "'gguf', 'gguf-q8')"
].join('\n')

describe('describeWorkerFailure', () => {
  it('turns an argparse usage banner into one actionable sentence', () => {
    const message = describeWorkerFailure({ code: 2, stderrTail: ARGPARSE_CHOICE })
    expect(message).toContain('--variant')
    expect(message).toContain('حدّث التطبيق')
    expect(message).not.toContain('usage:')
    expect(message).not.toContain('invalid choice')
    expect(message).not.toContain('choose from')
    expect(message).not.toMatch(/tafreegh-worker:/)
  })

  it('reports a timeout instead of a bare exit code', () => {
    const message = describeWorkerFailure({
      code: 1,
      timedOut: true,
      stderrTail: 'Traceback (most recent call last):\n  File "x.py", line 1'
    })
    expect(message).toContain('المدة المسموح')
    expect(message).not.toContain('Traceback')
  })

  it('names the missing Python module', () => {
    const message = describeWorkerFailure({
      code: 1,
      stderrTail:
        'Traceback (most recent call last):\n  File "worker.py", line 3, in <module>\nModuleNotFoundError: No module named \'noisereduce\''
    })
    expect(message).toContain('noisereduce')
    expect(message).toContain('أعد تهيئة المحرك')
    expect(message).not.toContain('Traceback')
  })

  it('explains GPU out-of-memory failures', () => {
    const message = describeWorkerFailure({
      code: 1,
      stderrTail: 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 4.00 GiB'
    })
    expect(message).toContain('بطاقة الرسوميات')
  })

  it('explains a dropped connection during setup', () => {
    const message = describeWorkerFailure({
      code: 1,
      stderrTail: 'requests.exceptions.ConnectionError: Max retries exceeded with url'
    })
    expect(message).toContain('الاتصال')
  })

  it('keeps the last exception line and drops traceback frames', () => {
    const message = describeWorkerFailure({
      code: 1,
      stderrTail: [
        'Traceback (most recent call last):',
        '  File "tafreegh/setup_models.py", line 195, in download_jais',
        '    raise RuntimeError("snapshot incomplete")',
        '  File "tafreegh/pipeline.py", line 12, in check',
        '    ^^^^^',
        'RuntimeError: downloaded weights while gguf was requested'
      ].join('\n')
    })
    expect(message).toContain('RuntimeError: downloaded weights while gguf was requested')
    expect(message).not.toContain('Traceback')
    expect(message).not.toContain('File "')
    expect(message).toContain('(1)')
  })

  it('still says something useful when stderr is empty', () => {
    const message = describeWorkerFailure({ code: 0, stderrTail: '' })
    expect(message).toContain('دون تفاصيل')
    expect(message).toContain('(0)')
  })

  it('translates a missing required argument', () => {
    const message = describeWorkerFailure({
      code: 2,
      stderrTail:
        'usage: tafreegh-worker setup-jais [-h] --models-dir MODELS_DIR\ntafreegh-worker: error: the following arguments are required: --models-dir'
    })
    expect(message).toContain('--models-dir')
    expect(message).toContain('خيار مطلوب ناقص')
  })
})
