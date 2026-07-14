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
}

function reportsPath(): string {
  return process.env.REPORTS_PATH || join(process.cwd(), 'data', 'broken-sites.jsonl')
}

async function ensureParentDir(filePath: string) {
  await mkdir(dirname(filePath), { recursive: true })
}

export async function appendBrokenSiteReport(
  report: Omit<BrokenSiteReport, 'id' | 'reportedAt' | 'status' | 'hostname'> & {
    url: string
  }
): Promise<BrokenSiteReport> {
  let hostname = ''
  try {
    hostname = new URL(report.url).hostname
  } catch {
    hostname = report.url
  }

  const full: BrokenSiteReport = {
    id: crypto.randomUUID(),
    reportedAt: new Date().toISOString(),
    url: report.url,
    hostname,
    note: report.note || '',
    settings: report.settings,
    client: report.client,
    status: 'open',
  }

  const path = reportsPath()
  await ensureParentDir(path)
  await appendFile(path, JSON.stringify(full) + '\n', 'utf8')
  console.log(`[REPORT] Broken site logged: ${full.hostname} (${full.id})`)
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
      reports.push(JSON.parse(line) as BrokenSiteReport)
    } catch {
      // skip corrupt lines
    }
  }
  // Newest first
  return reports.reverse()
}
