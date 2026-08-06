// Serverless twin of server/index.js, for Vercel.
//
// Vercel maps files in /api to routes, so this file serves /api/claude — the same
// path the Express proxy serves locally, which is why the client needs no change.
// server/index.js stays as-is for `npm run dev`; the two must be kept in step.
//
// The browser posts {system?, messages}; model and max_tokens are fixed here so the
// client can never override them, and the key never leaves this function.

const MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 4000

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY

  // The Express version exits at startup without a key. A function has no startup to
  // fail at, so the check moves here.
  if (!API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in the environment.')
    return res.status(500).json({
      error: { type: 'proxy_error', message: 'Server is missing its API key.' },
    })
  }

  // Vercel parses JSON bodies, but tolerate a raw string in case the content-type
  // arrives without it.
  let body = req.body ?? {}
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }

  const { system, messages } = body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' })
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        ...(system ? { system } : {}),
        messages,
      }),
    })

    const data = await upstream.json()

    if (!upstream.ok) {
      // Pass the API's own error through — its messages are more useful than anything
      // we'd invent, and none of them contain the key.
      console.error(`Anthropic API ${upstream.status}:`, data?.error?.message ?? data)
      return res.status(upstream.status).json(data)
    }

    return res.json(data)
  } catch (err) {
    console.error('Proxy request failed:', err)
    return res.status(502).json({
      error: { type: 'proxy_error', message: 'Could not reach the Anthropic API.' },
    })
  }
}
