import type { ReactNode } from 'react'
import { Lock, ShieldAlert } from 'lucide-react'
import { useActiveDoc } from '@/store/app'

export function Banners(): ReactNode {
  const doc = useActiveDoc()
  if (!doc) return null
  return (
    <>
      {doc.readOnly && (
        <div className="banner">
          <Lock size={14} />
          <span>This PDF is password protected. It is open in read-only mode: you can view, search and print, but not edit.</span>
        </div>
      )}
      {doc.hasSignatureFields && !doc.readOnly && (
        <div className="banner">
          <ShieldAlert size={14} />
          <span>This document contains digital signature fields. Saving will rewrite the file and break existing digital signatures. Use Save As to keep the original.</span>
        </div>
      )}
    </>
  )
}
