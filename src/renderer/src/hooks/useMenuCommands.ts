import { useEffect } from 'react'
import type { MenuCommand } from '@shared/api'
import { useStore } from '@/store/app'
import { newId } from '@core/types'
import { todayString } from '@/pdf/signature'
import { applySelectionMarkup } from '@/components/PageView'

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
}

const ALWAYS = new Set<MenuCommand>(['help:about', 'help:privacy', 'help:shortcuts', 'help:checkUpdates', 'view:theme:system', 'view:theme:light', 'view:theme:dark'])

export function runCommand(cmd: MenuCommand): void {
  const s = useStore.getState()
  const doc = s.docs.find((d) => d.id === s.activeId) ?? null
  // Native accelerators bypass the renderer's focus checks (finding 25): text inputs keep
  // their own undo/redo, and nothing runs while a long operation or modal is active.
  if (isTyping() && (cmd === 'edit:undo' || cmd === 'edit:redo' || cmd === 'edit:selectAll' || cmd === 'edit:deleteSelection')) {
    document.execCommand(cmd === 'edit:undo' ? 'undo' : cmd === 'edit:redo' ? 'redo' : cmd === 'edit:selectAll' ? 'selectAll' : 'delete')
    return
  }
  if (!ALWAYS.has(cmd) && (s.busy || (s.dialog && s.dialog.type !== 'note'))) return
  if (cmd.startsWith('file:') || cmd.startsWith('page:')) (document.activeElement as HTMLElement | null)?.blur?.()
  switch (cmd) {
    case 'file:open':
      return void s.openDialog()
    case 'file:save':
      return void s.save()
    case 'file:saveAs':
      return void s.saveAs()
    case 'file:close':
      return void (doc && s.closeDoc(doc.id))
    case 'file:print':
      return void s.print()
    case 'file:merge':
      return void s.merge()
    case 'file:exportImages':
      return void s.exportImages()
    case 'file:flatten':
      return void s.exportFlattened()
    case 'edit:undo':
      return void s.undo()
    case 'edit:redo':
      return void s.redo()
    case 'edit:find':
      return s.setFind({ open: true })
    case 'edit:selectAll':
      return void (doc && s.select(doc.annotations.filter((a) => a.page === doc.currentPage).map((a) => a.id)))
    case 'edit:deleteSelection':
      return void (doc && s.removeAnnotations(doc.selectedIds))
    case 'view:zoomIn':
      return s.zoomIn()
    case 'view:zoomOut':
      return s.zoomOut()
    case 'view:fitWidth':
      return s.setZoom(doc?.zoom ?? 1, 'fit-width')
    case 'view:fitPage':
      return s.setZoom(doc?.zoom ?? 1, 'fit-page')
    case 'view:actualSize':
      return s.setZoom(1, 'custom')
    case 'view:rotateCw':
      return s.rotateView(90)
    case 'view:rotateCcw':
      return s.rotateView(-90)
    case 'view:toggleSidebar':
      return s.setSidebar(!s.sidebarOpen)
    case 'view:thumbnails':
      return s.setSidebar(true, 'thumbnails')
    case 'view:outline':
      return s.setSidebar(true, 'outline')
    case 'view:annotations':
      return s.setSidebar(true, 'annotations')
    case 'view:nextPage':
      return void (doc && s.goToPage(doc.currentPage + 1))
    case 'view:prevPage':
      return void (doc && s.goToPage(doc.currentPage - 1))
    case 'view:firstPage':
      return s.goToPage(0)
    case 'view:lastPage':
      return void (doc && s.goToPage(doc.pages.length - 1))
    case 'view:goToPage':
      return void (doc && s.setDialog({ type: 'goToPage' }))
    case 'view:theme:system':
      return s.setTheme('system')
    case 'view:theme:light':
      return s.setTheme('light')
    case 'view:theme:dark':
      return s.setTheme('dark')
    case 'tool:select':
    case 'tool:hand':
    case 'tool:highlight':
    case 'tool:underline':
    case 'tool:strikeout':
    case 'tool:ink':
    case 'tool:rect':
    case 'tool:ellipse':
    case 'tool:line':
    case 'tool:arrow':
    case 'tool:text':
    case 'tool:note': {
      const tool = cmd.slice(5) as Parameters<typeof s.setTool>[0]
      // With text already selected, a markup shortcut applies immediately.
      if ((tool === 'highlight' || tool === 'underline' || tool === 'strikeout') && applySelectionMarkup(tool)) return
      return s.setTool(tool)
    }
    case 'sign:signature':
      return void (doc && !doc.readOnly && s.setDialog({ type: 'signature', kind: 'signature' }))
    case 'sign:initials':
      return void (doc && !doc.readOnly && s.setDialog({ type: 'signature', kind: 'initials' }))
    case 'sign:stamp':
      return void (doc && !doc.readOnly && s.setDialog({ type: 'stamp' }))
    case 'sign:date': {
      if (!doc || doc.readOnly) return
      // Build the box in display space (top-right corner) and map it back through the page
      // viewport so CropBox offsets and /Rotate are honoured (finding 28).
      void doc.pdf.getPage(doc.currentPage + 1).then((page) => {
        const vp = page.getViewport({ scale: 1 })
        const w = 110,
          h = 18,
          m = 36
        const [x1, y1] = vp.convertToPdfPoint(vp.width - m - w, m)
        const [x2, y2] = vp.convertToPdfPoint(vp.width - m, m + h)
        const id = newId()
        useStore.getState().addAnnotation({
          id,
          page: doc.currentPage,
          createdAt: Date.now(),
          kind: 'text',
          rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) },
          text: todayString(),
          fontSize: 11,
          color: '#1a1a1a',
          rotate: page.rotate
        })
        useStore.getState().setTool('select')
        useStore.getState().select([id])
        useStore.getState().showToast('Date added at the top-right of the page. Drag it into position.')
      })
      return
    }
    case 'page:rotateCw':
      return void s.rotatePages(null, 90)
    case 'page:rotateCcw':
      return void s.rotatePages(null, -90)
    case 'page:delete':
      return void s.deletePages(null)
    case 'page:insertBlank':
      return void s.insertBlank(null)
    case 'page:insertFromFile':
      return void s.insertFromFile(null)
    case 'page:extract':
      return void (doc && s.setDialog({ type: 'extract' }))
    case 'page:split':
      return void (doc && s.setDialog({ type: 'split' }))
    case 'help:shortcuts':
      return s.setDialog({ type: 'shortcuts' })
    case 'help:privacy':
      return s.setDialog({ type: 'privacy' })
    case 'help:about':
      return s.setDialog({ type: 'about' })
    case 'help:checkUpdates':
      s.setUpdateStatus({ state: 'checking' })
      void window.yonder.update.check()
      return
  }
}

export function useMenuCommands(): void {
  useEffect(() => {
    const off = window.yonder.on('menu', runCommand)
    const onCustom = (e: Event): void => runCommand((e as CustomEvent<MenuCommand>).detail)
    window.addEventListener('yonder:menu', onCustom)
    return () => {
      off()
      window.removeEventListener('yonder:menu', onCustom)
    }
  }, [])
}
