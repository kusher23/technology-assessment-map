import 'dotenv/config'
import express from 'express'
import cors from 'cors'

const PORT = process.env.PORT || 3001
const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 4000

if (!API_KEY) {
  console.error('\n  ANTHROPIC_API_KEY is missing. Copy .env.example to .env and add your key.\n')
  process.exit(1)
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// The only route. The browser posts {system?, messages}; model and max_tokens are
// fixed here so the client can never override them, and the key never leaves this process.
app.post('/api/claude', async (req, res) => {
  const { system, messages } = req.body ?? {}

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

    res.json(data)
  } catch (err) {
    console.error('Proxy request failed:', err)
    res.status(502).json({
      error: { type: 'proxy_error', message: 'Could not reach the Anthropic API.' },
    })
  }
})

app.listen(PORT, () => {
  console.log(`  proxy   http://localhost:${PORT}  →  ${MODEL}, max_tokens ${MAX_TOKENS}`)
})
