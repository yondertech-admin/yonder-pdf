import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OpenedFile, Platform, YonderAPI } from '@shared/api'

const EVENT_CHANNELS = new Set(['menu', 'open-files', 'close-request', 'update-status', 'fullscreen'])

const api: YonderAPI = {
  platform: process.platform as Platform,
  version: process.argv.find((a) => a.startsWith('--yonder-version='))?.slice('--yonder-version='.length) ?? '0.0.0',
  isPackaged: !process.env['ELECTRON_RENDERER_URL'],
  doc: {
    openDialog: (multiple) => ipcRenderer.invoke('doc:openDialog', multiple === true),
    openRecent: (id) => ipcRenderer.invoke('doc:openRecent', id),
    openDropped: async (file) => {
      // The path never reaches renderer code; it goes preload -> main only.
      let path = ''
      try {
        path = webUtils.getPathForFile(file)
      } catch {
        return null
      }
      if (!path) return null
      return (await ipcRenderer.invoke('doc:openPath', path)) as OpenedFile | null
    },
    save: (handle, bytes) => ipcRenderer.invoke('doc:save', handle, bytes),
    saveAs: (handle, bytes, suggestedName) => ipcRenderer.invoke('doc:saveAs', handle, bytes, suggestedName),
    exportFile: (bytes, suggestedName, filter) => ipcRenderer.invoke('doc:exportFile', bytes, suggestedName, filter),
    exportMany: (files) => ipcRenderer.invoke('doc:exportMany', files),
    importDialog: (filter, multiple) => ipcRenderer.invoke('doc:importDialog', filter, multiple === true),
    recent: () => ipcRenderer.invoke('doc:recent'),
    clearRecent: () => ipcRenderer.invoke('doc:clearRecent'),
    confirmDiscard: (names) => ipcRenderer.invoke('doc:confirmDiscard', names),
    confirm: (opts) => ipcRenderer.invoke('doc:confirm', opts),
    showError: (title, message) => ipcRenderer.invoke('doc:showError', title, message)
  },
  print: {
    begin: () => ipcRenderer.invoke('print:begin'),
    addPage: (job, page) => ipcRenderer.invoke('print:addPage', job, page),
    end: (job) => ipcRenderer.invoke('print:end', job),
    cancel: (job) => ipcRenderer.invoke('print:cancel', job)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
  },
  signatures: {
    list: () => ipcRenderer.invoke('signatures:list'),
    add: (sig) => ipcRenderer.invoke('signatures:add', sig),
    remove: (id) => ipcRenderer.invoke('signatures:remove', id)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openPdfLink: (url) => ipcRenderer.invoke('shell:openPdfLink', url)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install')
  },
  window: {
    ready: () => ipcRenderer.send('renderer:ready'),
    setTitle: (title, edited) => ipcRenderer.send('window:setTitle', title, edited),
    closeConfirmed: () => ipcRenderer.send('window:closeConfirmed'),
    isFullScreen: () => ipcRenderer.invoke('window:isFullScreen')
  },
  on: ((channel: string, cb: (...args: unknown[]) => void) => {
    if (!EVENT_CHANNELS.has(channel)) throw new Error('Unknown channel')
    const listener = (_e: unknown, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }) as YonderAPI['on']
}

contextBridge.exposeInMainWorld('yonder', api)
