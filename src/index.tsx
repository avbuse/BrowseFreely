import { Hono } from 'hono'
import { jsxRenderer } from 'hono/jsx-renderer'
import { homeRoute } from './routes/home'
import { browseRoute } from './routes/browse'
import { assetRoute } from './routes/asset'
import { apiRoute } from './routes/api'
import { reportsRoute } from './routes/reports'
import { getAdblocker } from './utils/adblocker'
import { rateLimit } from './middleware/rateLimit'

const app = new Hono()

app.use('*', rateLimit)

app.use(
  '*',
  jsxRenderer(({ children }) => {
    return (
      <html>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>BrowseFreely</title>
        </head>
        <body>{children}</body>
      </html>
    )
  })
)

app.use('*', async (c, next) => {
  await next()
  if (!c.req.path.startsWith('/asset') && !c.req.path.startsWith('/browse')) {
    c.res.headers.set('X-Frame-Options', 'DENY')
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com;"
    )
  }
})

app.route('/', homeRoute)
app.route('/', browseRoute)
app.route('/', assetRoute)
app.route('/', apiRoute)
app.route('/', reportsRoute)

app.get('*', (c) => {
  const referer = c.req.header('referer')
  if (referer && referer.includes('/browse?url=')) {
    try {
      const urlParam = new URL(referer).searchParams.get('url')
      if (urlParam) {
        let intendedUrl = new URL(c.req.path, urlParam).href
        const reqUrl = new URL(c.req.url)
        if (reqUrl.search) {
          // Preserve query string from the breakout request (/search?q=cats)
          const intended = new URL(intendedUrl)
          for (const [k, v] of reqUrl.searchParams.entries()) {
            intended.searchParams.append(k, v)
          }
          intendedUrl = intended.href
        }

        const dest = (c.req.header('sec-fetch-dest') || '').toLowerCase()
        const accept = (c.req.header('accept') || '').toLowerCase()
        const isDocument =
          dest === 'document' ||
          ((dest === '' || dest === 'empty') && accept.includes('text/html'))

        // HTML navigations must go through /browse (rewrites + TopBar).
        // Subresources go through /asset.
        const path = isDocument ? '/browse' : '/asset'
        return c.redirect(`${path}?url=${encodeURIComponent(intendedUrl)}`)
      }
    } catch {
      // Ignore URL parsing errors
    }
  }
  return c.text('Not Found', 404)
})

// Relative form POSTs that escape rewriting (e.g. action="/search")
app.post('*', async (c) => {
  if (c.req.path.startsWith('/api/') || c.req.path === '/browse') {
    return c.text('Not Found', 404)
  }
  const referer = c.req.header('referer')
  if (referer && referer.includes('/browse?url=')) {
    try {
      const urlParam = new URL(referer).searchParams.get('url')
      if (urlParam) {
        const intendedUrl = new URL(c.req.path, urlParam).href
        // Rebuild as GET-style browse POST by forwarding to /browse?url=
        const browseUrl = `/browse?url=${encodeURIComponent(intendedUrl)}`
        const body = await c.req.arrayBuffer()
        const headers = new Headers(c.req.raw.headers)
        headers.delete('host')
        // Internal re-dispatch
        const internal = new Request(new URL(browseUrl, c.req.url).href, {
          method: 'POST',
          headers,
          body,
        })
        return app.fetch(internal)
      }
    } catch {
      // ignore
    }
  }
  return c.text('Not Found', 404)
})

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000

console.log(`Starting BrowseFreely server on port ${PORT}...`)

getAdblocker().catch(console.error)

try {
  Bun.serve({
    port: PORT,
    fetch(req, server) {
      // Inject real peer IP for session binding / rate limits (overwrites any client header)
      const headers = new Headers(req.headers)
      const peer = server.requestIP(req)
      if (peer?.address) {
        headers.set('x-bf-client-ip', peer.address)
      } else {
        headers.delete('x-bf-client-ip')
      }
      return app.fetch(new Request(req, { headers }))
    },
  })
  console.log(`✅ Server successfully bound to port ${PORT} and is listening!`)
} catch (e) {
  console.error(`❌ FATAL: Could not bind to port ${PORT}. Is it already in use?`, e)
  process.exit(1)
}
