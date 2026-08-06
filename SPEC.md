# Opportunity Map Builder — spec

A local web app that builds structured opportunity maps for any domain. The user
describes what they are comparing and what winning looks like; the app proposes a way
to slice the space, derives evaluation criteria from the objective, generates and
scores the options, and exports the result to Excel.

React + Vite, single page. A minimal Express proxy on port 3001 holds the Anthropic
API key server-side; the browser never sees it. No database and no persistence — state
lives in React for the length of the session, and the Excel download is the artifact
that leaves.

## Core concept

An opportunity map is a table. Rows are options — distinct configurations within a
space. Columns are evaluation criteria applied uniformly to every row. Rows are about
identity: why this deserves separate treatment. Columns are about evaluation. These
must never mix; nothing used to justify a row's existence may also be a column.

## The five phases

The phases render as a single scrolling page. Each one appears once the previous has
produced something, so the page grows downward as the map is built rather than
replacing itself screen by screen.

**01 Frame.** Collect two things: what the user is comparing, and what winning looks
like. The objective is the load-bearing input — every column downstream is derived from
it, so a vague objective produces criteria that cannot rank anything. Three worked
examples (carbon capture, grid storage, coffee expansion) load both fields at once.

**02 Sharpen it.** Critique the framing before any map is built. The topic is judged as
`good | broad | not-a-space`, the objective as `good | vague | not-measurable`, each
with a plain-language note. Anything judged imperfect comes with rewrites the user can
apply with a tap. A "You haven't said" list names things the user has not specified that
would change which criteria come back. All of it is advisory — nothing blocks.

**03 Pick the dimension.** Propose four genuinely different axes of variation. The same
space sliced two ways produces two different maps, both internally consistent, only one
useful — so this choice is surfaced rather than made silently. Each candidate axis shows
what it reveals, what it hides, and two sample rows so the user can see what the map
would actually contain. The user may also name their own axis, or reject all four and
ask for four more; rejected framings are passed back into the next request so it reaches
for different angles instead of rephrasing.

**04 Criteria and weights.** Derive five evaluation columns from the objective, then let
the user edit them and set weights. See "Method" below.

**05 The map.** Generate the rows, score them, and render the table: rank, option,
profile, composite, and one scored cell with a note per criterion. Sorted by composite
descending. Exports to Excel.

## Method

### Choosing rows: the four merge tests

Options are deliberately over-generated — 25 or more candidates, including
near-duplicates — and then collapsed. The collapse applies four tests in order:

- **Swap.** Could an approach built for A drop into B unchanged? If yes, merge.
- **Action.** Would the decision-maker do anything different about A than B? If no, merge.
- **New constraint.** Does A introduce a constraint no other candidate has? Strong reason
  to keep it separate.
- **Dominance.** Does A beat B on every dimension? Then B is a worse version of A, not a
  separate option. Merge.

Row count is an output, not a setting. Whatever genuinely survives is what gets returned,
up to a ceiling of 14; there is no target to pad toward.

### Deriving columns: the Prize/Pull/Distance/Resistance/Fit scaffold

Five columns are derived from the objective, renamed to fit the topic:

- **Prize** — size of the win.
- **Pull** — what force drags someone toward this.
- **Distance** — how far from working.
- **Resistance** — what is in the way. Inverted, so 5 means fewest obstacles.
- **Fit** — can this particular actor win it.

Any inverted column is labeled as inverted in the UI and marked `(inv)` in the export,
because a column where high means fewer problems reads backwards otherwise.

The user can remove any column, add their own, or ask for more. Suggestions are appended
to the list rather than replacing it — the criteria that survive are the user's, not a
regenerated set. Each suggested criterion must pass two tests: it varies across options,
and that variation would change the decision.

### Gates are not columns

Alongside the columns, the app derives two gates: disqualifying pass/fail conditions.
A gate filters rows; it is never averaged into a score. Treating a gate as a weighted
column turns a disqualification into a mild penalty, which is backwards.

Gates are surfaced in the criteria panel and carried into the export as a separate
block. Applying them is the user's judgment call — the app states them, it does not
automatically drop rows.

### Weights are set before scoring

The weights panel comes before the "Build the map" button, so weights are set before any
score is visible. Tuning weights after seeing results, until a favorite wins, is the main
way these tables become decoration for a decision already made. The ordering and the
on-screen note are what enforce this; the fields are not locked, and rebuilding with
changed weights is one button.

Weights are relative and need not total 100. Composite is the weighted average of the
1–5 sub-scores.

### Profiles over composites

Each row's sub-score vector is drawn as a small bar profile, shown in the table beside
the composite. A row that is small on Prize but tall on Fit is a beachhead, not a weak
option, and the single number destroys exactly that distinction.

### Confidence marks

Cells are generated, not researched, and the app says so rather than presenting the
output as findings. Every row carries one confidence value:

- `high` → **verified-shape** — rests on well-established general knowledge.
- `medium` → **check** — involves specifics that shift over time.
- `low` → **verify first** — involves named organizations, figures, or fast-moving facts
  that were not verified.

The mark appears under the option name, and a standing banner above the table explains
that anything marked "verify first" needs checking before the map reaches anyone.

## Request handling

All model calls go through `askClaude`, which posts to `/api/claude` and extracts JSON
from the response.

Long list responses can be cut off by the token ceiling. Prompts are capped to stay well
inside it — 14 rows maximum, descriptions of 12 words or fewer, scoring notes of 10 words
or fewer, and an explicit whole-response word budget on the rows call. When a response is
truncated anyway, the parser attempts recovery: it walks the JSON tracking bracket depth
and string state, trims back to the last element that closed cleanly inside an array,
closes whatever brackets remain open, and re-parses. A recovered response logs a warning
that later items were lost. Only when recovery also fails does the call throw, and the
raw response text is logged first so the failure is diagnosable.

Map generation is split across several calls so no single response has to carry the whole
map:

1. **Rows** — the surviving options only. The candidate list and the merge working are
   explicitly kept out of the response.
2. **Merge log** — the near-duplicates that would have been folded in, capped at four.
   This call is wrapped in its own handler: if it fails the map still builds, because the
   merge log is commentary and the map is the point. Since it runs as a separate,
   stateless call, it reconstructs plausible merges from the survivors rather than
   reporting what the rows call actually discarded — the UI says so.
3. **Scoring** — the rows in chunks of four, so a long map streams into the table as it
   completes rather than arriving all at once.

Errors surface in an inline panel with the actual message rather than a blank screen.

## Export

Excel, via SheetJS, as two sheets:

- **Map** — rank, option, description, one note column per criterion, one score column
  per criterion, composite, confidence.
- **Method** — topic, objective, the chosen axis and why, the criteria with weights and
  definitions, the gates, and a short "before this goes to anyone" checklist covering the
  confidence marks and the read-the-profile-not-the-composite point.

The method sheet travels with the map deliberately. A scored table with no record of how
its columns were chosen or what its weights were is not auditable by whoever receives it.

## Layout

```
index.html
vite.config.js         dev server on 5173, proxies /api -> 3001
server/index.js        Express proxy; holds the key, pins model and max_tokens
src/main.jsx           React entry
src/index.css          Tailwind import and body styling
src/App.jsx            the entire app — phases, prompts, scoring, table, export
```

`App.jsx` is deliberately one file. The phases share a single piece of state and read
each other's output constantly; splitting them into per-phase components meant threading
that state through props for no gain in clarity. Component styling is inline rather than
Tailwind classes; Tailwind is loaded but only styles the body.
