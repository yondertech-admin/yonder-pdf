import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { installCli, uninstallCli } from './cli-install'
import type { MenuCommand } from '@shared/api'

type Send = (command: MenuCommand) => void

export function buildMenu(send: Send): Menu {
  const isMac = process.platform === 'darwin'
  const cmd = (label: string, command: MenuCommand, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(command),
    ...extra
  })

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            cmd('About Yonder PDF', 'help:about'),
            cmd('Check for Updates…', 'help:checkUpdates'),
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      ]
    : []

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        cmd('Open…', 'file:open', 'CmdOrCtrl+O'),
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        cmd('Save', 'file:save', 'CmdOrCtrl+S'),
        cmd('Save As…', 'file:saveAs', 'Shift+CmdOrCtrl+S'),
        cmd('Close Document', 'file:close', 'CmdOrCtrl+W'),
        { type: 'separator' },
        cmd('Merge PDFs…', 'file:merge'),
        cmd('Export Pages as Images…', 'file:exportImages'),
        cmd('Export Flattened Copy (forms + new annotations)…', 'file:flatten'),
        { type: 'separator' },
        cmd('Print…', 'file:print', 'CmdOrCtrl+P'),
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        cmd('Undo', 'edit:undo', 'CmdOrCtrl+Z'),
        cmd('Redo', 'edit:redo', 'Shift+CmdOrCtrl+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        cmd('Delete Selection', 'edit:deleteSelection'),
        { type: 'separator' },
        cmd('Find…', 'edit:find', 'CmdOrCtrl+F')
      ]
    },
    {
      label: 'View',
      submenu: [
        cmd('Zoom In', 'view:zoomIn', 'CmdOrCtrl+='),
        cmd('Zoom Out', 'view:zoomOut', 'CmdOrCtrl+-'),
        cmd('Fit Width', 'view:fitWidth', 'CmdOrCtrl+0'),
        cmd('Fit Page', 'view:fitPage', 'CmdOrCtrl+9'),
        cmd('Actual Size', 'view:actualSize', 'CmdOrCtrl+1'),
        { type: 'separator' },
        cmd('Rotate View Clockwise', 'view:rotateCw', 'CmdOrCtrl+R'),
        cmd('Rotate View Counterclockwise', 'view:rotateCcw', 'Shift+CmdOrCtrl+R'),
        { type: 'separator' },
        cmd('Toggle Sidebar', 'view:toggleSidebar', 'CmdOrCtrl+Shift+L'),
        cmd('Thumbnails', 'view:thumbnails', 'Alt+CmdOrCtrl+1'),
        cmd('Outline', 'view:outline', 'Alt+CmdOrCtrl+2'),
        cmd('Annotations', 'view:annotations', 'Alt+CmdOrCtrl+3'),
        { type: 'separator' },
        cmd('Next Page', 'view:nextPage', 'CmdOrCtrl+Down'),
        cmd('Previous Page', 'view:prevPage', 'CmdOrCtrl+Up'),
        cmd('First Page', 'view:firstPage', 'Home'),
        cmd('Last Page', 'view:lastPage', 'End'),
        cmd('Go to Page…', 'view:goToPage', 'CmdOrCtrl+G'),
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: [
            cmd('System', 'view:theme:system'),
            cmd('Light', 'view:theme:light'),
            cmd('Dark', 'view:theme:dark')
          ]
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'toggleDevTools' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Annotate',
      submenu: [
        cmd('Select', 'tool:select', 'V'),
        cmd('Hand', 'tool:hand', 'H'),
        { type: 'separator' },
        cmd('Highlight', 'tool:highlight', '1'),
        cmd('Underline', 'tool:underline', '2'),
        cmd('Strikethrough', 'tool:strikeout', '3'),
        cmd('Pen', 'tool:ink', '4'),
        { type: 'separator' },
        cmd('Rectangle', 'tool:rect', '5'),
        cmd('Ellipse', 'tool:ellipse', '6'),
        cmd('Line', 'tool:line', '7'),
        cmd('Arrow', 'tool:arrow', '8'),
        { type: 'separator' },
        cmd('Text Box', 'tool:text', 'T'),
        cmd('Sticky Note', 'tool:note', 'N')
      ]
    },
    {
      label: 'Sign',
      submenu: [
        cmd('Add Signature…', 'sign:signature', 'CmdOrCtrl+Shift+G'),
        cmd('Add Initials…', 'sign:initials'),
        cmd('Add Date', 'sign:date'),
        { type: 'separator' },
        cmd('Stamp…', 'sign:stamp', 'CmdOrCtrl+Shift+M')
      ]
    },
    {
      label: 'Page',
      submenu: [
        cmd('Rotate Page Clockwise', 'page:rotateCw', 'CmdOrCtrl+]'),
        cmd('Rotate Page Counterclockwise', 'page:rotateCcw', 'CmdOrCtrl+['),
        { type: 'separator' },
        cmd('Insert Blank Page', 'page:insertBlank'),
        cmd('Insert Pages from File…', 'page:insertFromFile'),
        cmd('Extract Pages…', 'page:extract'),
        cmd('Split Document…', 'page:split'),
        { type: 'separator' },
        cmd('Delete Page', 'page:delete')
      ]
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }]
    },
    {
      role: 'help',
      submenu: [
        cmd('Keyboard Shortcuts', 'help:shortcuts', 'CmdOrCtrl+/'),
        cmd('Privacy & Ads', 'help:privacy'),
        { type: 'separator' },
        { label: 'Source Code on GitHub', click: () => void shell.openExternal('https://github.com/yondertech-admin/yonder-pdf') },
        { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/yondertech-admin/yonder-pdf/issues') },
        { type: 'separator' },
        { label: 'Install Command Line Tool…', click: () => void installCli(BrowserWindow.getFocusedWindow()) },
        { label: 'Uninstall Command Line Tool', click: () => void uninstallCli(BrowserWindow.getFocusedWindow()) },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, cmd('Check for Updates…', 'help:checkUpdates'), cmd('About Yonder PDF', 'help:about')])
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
