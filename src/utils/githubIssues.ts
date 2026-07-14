import type { BrokenSiteReport } from './reports'

export type GitHubIssueResult =
  | { ok: true; url: string; number: number }
  | { ok: false; reason: string }

function repoSlug(): string | null {
  const fromEnv = process.env.GITHUB_REPO?.trim()
  if (fromEnv) return fromEnv.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  // Sensible default for this project; override with GITHUB_REPO if forked
  return 'avbuse/BrowseFreely'
}

function token(): string | null {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || null
}

function labels(): string[] {
  const raw = process.env.GITHUB_ISSUE_LABELS || 'broken-site,anti-adblock'
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function githubIssuesConfigured(): boolean {
  return Boolean(token() && repoSlug())
}

export async function createBrokenSiteIssue(
  report: BrokenSiteReport
): Promise<GitHubIssueResult> {
  const auth = token()
  const repo = repoSlug()
  if (!auth) {
    return {
      ok: false,
      reason: 'GITHUB_TOKEN not set — local log only. Add a PAT with Issues: write.',
    }
  }
  if (!repo) {
    return { ok: false, reason: 'GITHUB_REPO not set' }
  }

  const title = `[broken-site] ${report.hostname}`
  const body = [
    '## Broken site report',
    '',
    'Logged from BrowseFreely **Site broken?** button for anti-adblock / proxy investigation.',
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| URL | ${report.url} |`,
    `| Hostname | \`${report.hostname}\` |`,
    `| Reported at | ${report.reportedAt} |`,
    `| Report ID | \`${report.id}\` |`,
    `| JS disabled | ${report.settings.disableJs} |`,
    `| Bypass adblock detection | ${report.settings.bypassAdblockDetection} |`,
    `| Spoofed UA | \`${report.settings.userAgent}\` |`,
    '',
    report.note ? `### Note\n\n${report.note}\n` : '### Note\n\n_(none)_\n',
    '### Ask Cursor',
    '',
    'Please investigate why this site fails through BrowseFreely (anti-adblock wall, blank page, broken layout) and propose a filter/stub/workaround.',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
  ].join('\n')

  const payload: Record<string, unknown> = {
    title,
    body,
  }
  const labs = labels()
  if (labs.length) payload.labels = labs

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${auth}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'BrowseFreely-BrokenSiteReporter',
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const text = await res.text()
      // Common: labels don't exist yet — retry without labels
      if (res.status === 422 && payload.labels) {
        delete payload.labels
        const retry = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${auth}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'BrowseFreely-BrokenSiteReporter',
          },
          body: JSON.stringify(payload),
        })
        if (retry.ok) {
          const data = (await retry.json()) as { html_url: string; number: number }
          return { ok: true, url: data.html_url, number: data.number }
        }
        const retryText = await retry.text()
        return {
          ok: false,
          reason: `GitHub API ${retry.status}: ${retryText.slice(0, 300)}`,
        }
      }
      return { ok: false, reason: `GitHub API ${res.status}: ${text.slice(0, 300)}` }
    }

    const data = (await res.json()) as { html_url: string; number: number }
    return { ok: true, url: data.html_url, number: data.number }
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'GitHub request failed' }
  }
}
