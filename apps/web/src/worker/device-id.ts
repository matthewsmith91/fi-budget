import { isDeviceId, newDeviceId } from '@budget-fi/core'

const FILE = 'budget-fi-device-id'

/**
 * This browser's id, stamped on every change it makes. It lives in its own OPFS file,
 * outside the budget database, so restoring a backup onto a second device never gives
 * two devices the same id. Without OPFS the id lasts only as long as the page.
 */
export async function loadDeviceId(): Promise<string> {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(FILE, { create: true })
    const stored = (await (await handle.getFile()).text()).trim()
    if (isDeviceId(stored)) return stored
    const id = newDeviceId()
    const writable = await handle.createWritable()
    await writable.write(id)
    await writable.close()
    return id
  } catch (err) {
    console.warn('Could not persist the device id; using one for this session', err)
    return newDeviceId()
  }
}
