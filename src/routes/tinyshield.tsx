import { Hono } from 'hono'
import { getTinyShieldScript, tinyShieldStatus } from '../utils/tinyshield'

export const tinyshieldRoute = new Hono()

/**
 * Serve the Ad-Shield bypass userscript (tinyShield) from first-party /bf/*
 * so Future plc sites can load it early without going through /asset.
 */
tinyshieldRoute.get('/bf/tinyshield.js', async (c) => {
  const script = await getTinyShieldScript()
  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-BrowseFreely-TinyShield': tinyShieldStatus().ready ? 'ready' : 'fallback',
    },
  })
})

tinyshieldRoute.get('/bf/tinyshield/status', (c) => {
  return c.json(tinyShieldStatus())
})
