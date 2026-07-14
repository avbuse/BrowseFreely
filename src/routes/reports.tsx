import { Hono } from 'hono'
import { Layout } from '../components/Layout'
import { listBrokenSiteReports } from '../utils/reports'

export const reportsRoute = new Hono()

reportsRoute.get('/reports', async (c) => {
  const reports = await listBrokenSiteReports()
  const justReported = c.req.query('logged') === '1'
  const reportedUrl = c.req.query('url') || ''

  return c.html(
    <Layout>
      <main style={{ maxWidth: '900px', margin: '0 auto', padding: '48px 24px', width: '100%' }}>
        <div style={{ marginBottom: '32px' }}>
          <a href="/" style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            ← Back home
          </a>
          <h1 style={{ fontSize: '28px', margin: '16px 0 8px', letterSpacing: '-0.02em' }}>
            Broken site reports
          </h1>
          <p style={{ color: 'var(--text-muted)', margin: 0, lineHeight: 1.5, fontSize: '14px' }}>
            Logged when you hit <strong style={{ color: 'var(--text-main)' }}>Site broken?</strong> in
            the proxy bar. Stored locally in <code style={{ color: 'var(--text-main)' }}>data/broken-sites.jsonl</code>.
            Ask Cursor to investigate open reports when you want fixes.
          </p>
        </div>

        {justReported ? (
          <div
            style={{
              marginBottom: '24px',
              padding: '14px 16px',
              borderRadius: '10px',
              border: '1px solid rgba(16, 185, 129, 0.35)',
              background: 'rgba(16, 185, 129, 0.1)',
              color: '#6ee7b7',
              fontSize: '14px',
            }}
          >
            Logged. Thanks — this site is on the list
            {reportedUrl ? (
              <>
                : <code style={{ color: '#a7f3d0' }}>{reportedUrl}</code>
              </>
            ) : null}
            .
            {reportedUrl ? (
              <>
                {' '}
                <a
                  href={`/browse?url=${encodeURIComponent(reportedUrl)}`}
                  style={{ color: '#a7f3d0', textDecoration: 'underline' }}
                >
                  Back to page
                </a>
              </>
            ) : null}
          </div>
        ) : null}

        {reports.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
            No reports yet. When a page shows an adblock wall or breaks, use the button in the top bar.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {reports.map((r) => (
              <article
                key={r.id}
                style={{
                  padding: '16px 18px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: '12px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                    marginBottom: '8px',
                  }}
                >
                  <strong style={{ fontSize: '15px' }}>{r.hostname}</strong>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: r.status === 'open' ? '#fbbf24' : 'var(--text-muted)',
                    }}
                  >
                    {r.status}
                  </span>
                </div>
                <a
                  href={`/browse?url=${encodeURIComponent(r.url)}`}
                  style={{ fontSize: '13px', color: 'var(--accent)', wordBreak: 'break-all' }}
                >
                  {r.url}
                </a>
                <div
                  style={{
                    marginTop: '10px',
                    fontSize: '12px',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px 16px',
                  }}
                >
                  <span>{new Date(r.reportedAt).toLocaleString()}</span>
                  <span>JS {r.settings.disableJs ? 'off' : 'on'}</span>
                  <span>Bypass {r.settings.bypassAdblockDetection ? 'on' : 'off'}</span>
                </div>
                {r.note ? (
                  <p style={{ margin: '10px 0 0', fontSize: '13px', color: 'var(--text-main)' }}>
                    {r.note}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </main>
    </Layout>
  )
})
