import { Context, Next } from 'hono'
import { getClientIp } from '../utils/clientIp'

const ipRequests = new Map<string, { count: number; resetTime: number }>()

const limitEnv = process.env.RATE_LIMIT
const LIMIT = limitEnv && !isNaN(parseInt(limitEnv, 10)) ? parseInt(limitEnv, 10) : 100
const WINDOW = 60 * 1000

export async function rateLimit(c: Context, next: Next) {
  const ip = getClientIp(c)

  const now = Date.now()
  let record = ipRequests.get(ip)

  if (!record || record.resetTime < now) {
    record = { count: 0, resetTime: now + WINDOW }
  }

  record.count++
  ipRequests.set(ip, record)

  if (record.count > LIMIT) {
    return c.text('Too Many Requests', 429)
  }

  await next()
}
