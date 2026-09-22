import { s } from '../schema'
import { requireDoc, type Command, type Outcome } from './context'

export const flatten: Command = {
  name: 'export.flatten',
  group: 'export',
  description: 'Flatten now: session annotations are drawn into page content (--annotations, default true) and/or form fields are flattened (--forms, default true). Applies at this point of a batch; annotations added later stay annotations. Annotations that were already in the file are unchanged.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ annotations: s.bool('Flatten session annotations (default true)'), forms: s.bool('Flatten form fields (default true)') }),
  examples: ['yonder-pdf export.flatten --in a.pdf --out a-flat.pdf', 'yonder-pdf apply --in a.pdf --out b.pdf --ops \'[{"command":"annotate.highlight","params":{"text":"Total"}},{"command":"export.flatten","params":{}}]\''],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const annotations = p.annotations !== false
    const forms = p.forms !== false
    const flattened = annotations ? doc.annotations.length : 0
    await doc.materialize({ flattenAnnotations: annotations, flattenForms: forms })
    return { result: { flattenedAnnotations: flattened, flattenedForms: forms } }
  }
}

export const exportCommands: Command[] = [flatten]
