# Opportunity Map Builder

Tell it what you're comparing and what winning looks like, and it builds a scored
comparison table: it proposes ways to slice the space, derives evaluation criteria from
your objective, generates and scores the options, and exports the result to Excel. Every
generated cell carries a confidence mark, because the scores are a starting position for
your judgment rather than researched findings.

## Running it locally

Requires Node 18 or newer and an Anthropic API key.

```bash
npm install
cp .env.example .env     # then paste your key into .env
npm run dev
```

Open http://localhost:5173.

`npm run dev` starts both halves: the Express proxy on port 3001 and the Vite dev server
on 5173, which forwards `/api` to the proxy. If either port is already taken, Vite will
pick another and print it, and the proxy will fail to bind — check the startup output.

Other scripts: `npm run build` for a production bundle, `npm run preview` to serve it,
and `npm run dev:server` / `npm run dev:web` to run either half alone.

## What goes in .env

```
ANTHROPIC_API_KEY=sk-ant-...    # required; the proxy exits at startup without it
PORT=3001                       # optional, defaults to 3001
```

`.env` is gitignored. The key lives only in the Express process — the browser posts to
`/api/claude` on its own origin and never holds a credential. The proxy also pins the
model and token ceiling server-side, so the client cannot override them.

## How it works

**The axis choice comes first.** Before listing any options, the app asks how the space
should be sliced, and offers four genuinely different axes with what each one reveals and
what it hides. This is the decision that determines everything downstream and the one
usually skipped: the same space sliced two ways produces two different maps, both
internally consistent, only one of them useful to you. You can also name your own axis,
or reject all four and ask for four more.

**Options are over-generated, then merged.** The app generates 25 or more candidates
along your axis and collapses them with four tests: **swap** (could an approach built for
A drop into B unchanged?), **action** (would you actually do anything different about A
than B?), **new constraint** (does A introduce a constraint nothing else has? — a reason
to keep it separate), and **dominance** (does A beat B on everything? then B is a worse
version of A, not an option). Whatever genuinely survives is what you get. The row count
is an output, not a setting, so it is never padded to hit a number.

**Cells carry confidence marks.** Nothing in the table was researched — it was generated,
and the app marks how far each row can be trusted rather than presenting all of it with
equal authority. **verified-shape** rests on well-established general knowledge. **check**
involves specifics that shift over time. **verify first** involves named organizations or
figures that move, and needs checking before the map goes to anyone. The distinction is
the point: a scored table that hides which of its rows are guesses is worse than no table.

Two more things worth knowing while reading a map. Weights are set before any scores are
visible, because tuning them afterward until a favorite wins is how these tables become
decoration. And each row's sub-scores are drawn as a small bar profile next to the
composite — a row that is small on Prize but tall on Fit is a beachhead, and the single
number flattens exactly that.

The Excel export carries a second sheet recording the axis, the criteria and their
weights, the gates, and what to check before sharing.

See [SPEC.md](SPEC.md) for the full design.
