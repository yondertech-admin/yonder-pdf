import { useEffect } from 'react'
import type { MenuCommand } from '@shared/api'
import { useStore } from '@/store/app'
import { newId } from '@/pdf/types'
import { todayString } from '@/pdf/signature'
import { applySelectionMarkup } from '@/components/PageView'

export function runCommand(cmd: MenuCommand): void {
  const s = useStore.getState()
  const doc = s.docs.find((d) => d.id === s.activeId) ?? null
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
    case 'sign:date': {
      if (!doc || doc.readOnly) return
      const p = doc.pages[doc.currentPage]
      const w = 110,
        h = 18
      const id = newId()
      s.addAnnotation({ id, page: doc.currentPage, createdAt: Date.now(), kind: 'text', rect: { x: p.width - w - 36, y: p.height - 36 - h, width: w, height: h }, text: todayString(), fontSize: 11, color: '#1a1a1a' })
      s.setTool('select')
      s.select([id])
      s.showToast('Date added at the top-right of the page. Drag it into position.')
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
