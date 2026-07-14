import { mkdir, appendFile, readFile, access } from 'fs/promises'
import { dirname, join } from 'path'

export type BrokenSiteReport = {
  id: string
  reportedAt: string
  url: string
  hostname: string
  note: string
  settings: {
    disableJs: boolean
    bypassAdblockDetection: boolean
    userAgent: string
  }
  client: {
    userAgent: string
    ip: string
  }
  status: 'open' | 'investigating' | 'fixed' | 'wontfix'
  githubIssueUrl?: string
  githubIssueNumber?: number
  githubError?: string
}

export function reportsPath(): string {
  return process.env.REPORTS_PATH || join(process.cwd(), 'data', 'broken-sites.jsonl')
}

async function ensureParentDir(filePath: string) {
  await mkdir(dirname(filePath), { recursive: true })
}

export function buildBrokenSiteReport(
  report: Omit<BrokenSiteReport, 'id' | 'reportedAt' | 'status' | 'hostname'> & {
    url: string
  }
): BrokenSiteReport {
  let hostname = ''
  try {
    hostname = new URL(report.url).hostname
  } catch {
    hostname = report.url
  }

  return {
    id: crypto.randomUUID(),
    reportedAt: new Date().toISOString(),
    url: report.url,
    hostname,
    note: report.note || '',
    settings: report.settings,
    client: report.client,
    status: 'open',
  }
}

export async function saveBrokenSiteReport(report: BrokenSiteReport): Promise<void> {
  const path = reportsPath()
  await ensureParentDir(path)
  await appendFile(path, JSON.stringify(report) + '\n', 'utf8')
  console.log(`[REPORT] Broken site logged: ${report.hostname} (${report.id})`)
}

/** @deprecated prefer buildBrokenSiteReport + saveBrokenSiteReport */
export async function appendBrokenSiteReport(
  report: Omit<BrokenSiteReport, 'id' | 'reportedAt' | 'status' | 'hostname'> & {
    url: string
  }
): Promise<BrokenSiteReport> {
  const full = buildBrokenSiteReport(report)
  await saveBrokenSiteReport(full)
  return full
}

export async function listBrokenSiteReports(): Promise<BrokenSiteReport[]> {
  const path = reportsPath()
  try {
    await access(path)
  } catch {
    return []
  }

  const raw = await readFile(path, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  const reports: BrokenSiteReport[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as BrokenSiteReport & { kind?: string }
      if (parsed.kind === 'github-result') continue
      reports.push(parsed)
    } catch {
      // skip corrupt lines
    }
  }
  // Newest first
  return reports.reverse()
}
