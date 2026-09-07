import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useStore } from '@/store/app'

export function FindBar(): ReactNode {
  const find = useStore((s) => s.find)
  const setFind = useStore((s) => s.setFind)
  const runSearch = useStore((s) => s.runSearch)
  const findNext = useStore((s) => s.findNext)
  const activeId = useStore((s) => s.activeId)
  const reloadToken = useStore((s) => s.docs.find((d) => d.id === s.activeId)?.reloadToken ?? 0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (find.open) {
      input.current?.focus()
      input.current?.select()
    }
  }, [find.open])

  // Debounced search-as-you-type.
  useEffect(() => {
    if (!find.open) return
    const t = setTimeout(() => void runSearch(), 250)
    return () => clearTimeout(t)
  }, [find.query, find.caseSensitive, find.open, activeId, reloadToken, runSearch])

  if (!find.open) return null
  const close = (): void => setFind({ open: false, matches: [], current: -1 })
  return (
    <div className="findbar">
      <input
        ref={input}
        type="text"
        placeholder="Find in document"
        value={find.query}
        onChange={(e) => setFind({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') findNext(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') close()
        }}
      />
      <span className="count">
        {find.searching ? 'Searching…' : find.matches.length ? `${find.current + 1} of ${find.matches.length}` : find.query ? 'No results' : ''}
      </span>
      <button className="tbtn" title="Previous (⇧↩)" onClick={() => findNext(-1)} disabled={!find.matches.length}>
        <ChevronUp />
      </button>
      <button className="tbtn" title="Next (↩)" onClick={() => findNext(1)} disabled={!find.matches.length}>
        <ChevronDown />
      </button>
      <label className="opt">
        <input type="checkbox" checked={find.caseSensitive} onChange={(e) => setFind({ caseSensitive: e.target.checked })} /> Aa
      </label>
      <button className="tbtn" title="Close (Esc)" onClick={close}>
        <X />
      </button>
    </div>
  )
}
