import { s } from '../schema'
import { requireDoc, type Command, type Outcome } from './context'

export const flatten: Command = {
  name: 'export.flatten',
  group: 'export',
  description: 'Write a flattened copy: session annotations drawn into page content (--annotations, default) and/or form fields flattened (--forms). Annotations that were already in the file stay as annotations.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ annotations: s.bool('Flatten session annotations (default true)'), forms: s.bool('Flatten form fields (default true)') }),
  examples: ['yonder-pdf export.flatten --in a.pdf --out a-flat.pdf'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const annotations = p.annotations !== false
    const forms = p.forms !== false
    doc.commitOptions.flattenAnnotations = annotations
    doc.commitOptions.flattenForms = forms
    return { result: { flattenAnnotations: annotations, flattenForms: forms } }
  }
}

export const exportCommands: Command[] = [flatten]
