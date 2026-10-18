/** Never log request headers/bodies, credential objects, or unfiltered response objects. */
export function redactDiagnostic(value: string, token = ''): string {
  let result = value
  if (token) {
    for (const secret of [token, encodeURIComponent(token)])
      result = result.split(secret).join('[REDACTED]')
  }
  return result
    .replace(/(?:gh[pousr]_|github_pat_)[a-zA-Z0-9_]+/g, '[REDACTED]')
    .replace(/\b(Bearer|token)\s+[^\s,;"}]+/gi, '$1 [REDACTED]')
    .replace(
      /((?:access_token|client_secret|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 2000)
}

export interface GitHubDiagnostic {
  operationId?: string
  filePath?: string
  fileSize?: number
  total?: number
  completed?: number
  skipped?: number
  sha?: string
  target: string
  method: string
  branch: string
  attempt: number
  status: number | null
  kind: 'http' | 'authorization' | 'network' | 'timeout' | 'response'
  tokenPresent: boolean
  message: string
  requestId?: string
  oauthScopes?: string
  acceptedScopes?: string
  rateLimitRemaining?: string
  ssoRequired?: boolean
}
export type GitHubLogger = (entry: GitHubDiagnostic) => void
