import { Hono } from 'hono'
import { jsxRenderer } from 'hono/jsx-renderer'
import { homeRoute } from './routes/home'
import { browseRoute } from './routes/browse'
import { assetRoute } from './routes/asset'
import { apiRoute } from './routes/api'
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

app.get('*', (c) => {
  const referer = c.req.header('referer')
  if (referer && referer.includes('/browse?url=')) {
    try {
      const urlParam = new URL(referer).searchParams.get('url')
      if (urlParam) {
        let intendedUrl = new URL(c.req.path, urlParam).href
        if (c.req.query()) {
          const qs = new URLSearchParams(c.req.query()).toString()
          if (qs) {
            intendedUrl += '?' + qs
          }
        }
        return c.redirect(`/asset?url=${encodeURIComponent(intendedUrl)}`)
      }
    } catch {
      // Ignore URL parsing errors
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
