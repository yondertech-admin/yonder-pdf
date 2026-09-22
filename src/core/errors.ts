// Structured errors shared by the CLI, the local API and MCP (design §14.5).
// `code` is stable; `hint` tells an agent what to do next.
export type ErrorCode =
  | 'YP_USAGE'
  | 'YP_INVALID_INPUT'
  | 'YP_NOT_FOUND'
  | 'YP_PAGE_RANGE'
  | 'YP_NO_MATCH'
  | 'YP_AMBIGUOUS_ANCHOR'
  | 'YP_UNSUPPORTED'
  | 'YP_ENCRYPTED_READ_ONLY'
  | 'YP_NEEDS_PASSWORD'
  | 'YP_SIGNATURES_PRESENT'
  | 'YP_OUTPUT_EXISTS'
  | 'YP_SAME_FILE'
  | 'YP_FILE_OPEN_IN_APP'
  | 'YP_REV_MISMATCH'
  | 'YP_APP_NOT_RUNNING'
  | 'YP_NEEDS_INPUT'
  | 'YP_INTERNAL'

/** CLI exit codes: 1 failed, 2 usage/validation, 3 app not running, 4 conflict. */
export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case 'YP_USAGE':
    case 'YP_INVALID_INPUT':
    case 'YP_PAGE_RANGE':
    case 'YP_NO_MATCH':
    case 'YP_AMBIGUOUS_ANCHOR':
      return 2
    case 'YP_APP_NOT_RUNNING':
      return 3
    case 'YP_OUTPUT_EXISTS':
    case 'YP_SAME_FILE':
    case 'YP_FILE_OPEN_IN_APP':
    case 'YP_REV_MISMATCH':
      return 4
    default:
      return 1
  }
}

export class YonderError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public details?: unknown
  ) {
    super(message)
    this.name = 'YonderError'
  }
  toJSON(): { code: ErrorCode; message: string; hint?: string; details?: unknown } {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}), ...(this.details !== undefined ? { details: this.details } : {}) }
  }
}

export function toYonderError(err: unknown): YonderError {
  if (err instanceof YonderError) return err
  const msg = err instanceof Error ? err.message : String(err)
  if (/does not exist \(document has/.test(msg) || /must be between 1 and/.test(msg) || /Invalid range/.test(msg)) return new YonderError('YP_PAGE_RANGE', msg)
  if (/at least one page|Invalid page order|out of range/.test(msg)) return new YonderError('YP_INVALID_INPUT', msg)
  return new YonderError('YP_INTERNAL', msg)
}
