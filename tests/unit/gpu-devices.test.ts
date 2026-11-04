import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { parseDeviceList } from '../../src/main/services/setup'

const SAMPLE = [
  'Available devices:',
  '  Vulkan0: AMD Radeon 740M Graphics (8330 MiB, 7913 MiB free)',
  '  Vulkan1: NVIDIA GeForce RTX 4050 Laptop GPU (5920 MiB, 5152 MiB free)',
  ''
].join('\n')

describe('parseDeviceList', () => {
  it('reads id, name and total VRAM from the llama.cpp device table', () => {
    expect(parseDeviceList(SAMPLE)).toEqual([
      { id: 'Vulkan0', name: 'AMD Radeon 740M Graphics', vramMb: 8330 },
      { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 4050 Laptop GPU', vramMb: 5920 }
    ])
  })

  it('handles a device without a memory line', () => {
    expect(parseDeviceList('  Vulkan0: Some GPU\n')).toEqual([
      { id: 'Vulkan0', name: 'Some GPU', vramMb: undefined }
    ])
  })

  it('ignores the header and blank lines', () => {
    expect(parseDeviceList('Available devices:\n\n')).toEqual([])
    expect(parseDeviceList('')).toEqual([])
  })
})
