import React, { useState, useRef, useEffect } from "react";

/* ExcelJS is roughly two thirds of the bundle and nothing needs it until someone
   clicks Download, so it loads on demand. Memoised, so a second export reuses the
   chunk already fetched. */
let excelJsPromise;
const loadExcelJS = () =>
  (excelJsPromise ??= import("exceljs").then((m) => m.default ?? m));

/* ---------------------------------------------------------------------------
   Technology Assessment Map
   Topic in -> proposed structure -> your weights -> scored map -> Excel out.
   Every generated cell carries a confidence mark. Nothing is asserted silently.
--------------------------------------------------------------------------- */

const C = {
  paper: "#F7F6F2",
  ink: "#16181D",
  rule: "#DBD8CF",
  ruleSoft: "#E8E5DD",
  pine: "#2F5D50",
  pineLight: "#5C8578",
  amber: "#B67A2B",
  rust: "#9A4B33",
  muted: "#75736B",
};

const CONF = {
  high: { label: "verified-shape", color: C.pine, bar: 3 },
  medium: { label: "check", color: C.amber, bar: 2 },
  low: { label: "verify first", color: C.rust, bar: 1 },
};

/* Excel wants ARGB with no hash, so the palette is restated here rather than
   converted at every call site. */
const argb = (hex) => "FF" + hex.replace("#", "").toUpperCase();

const X = {
  pine: argb(C.pine),
  paper: argb(C.paper),
  rule: argb(C.rule),
  ink: argb(C.ink),
  amber: argb(C.amber),
  rust: argb(C.rust),
  white: "FFFFFFFF",
};

// Score fills step from lightest pine at 1 to full pine at 5, with the text
// flipping to white once the ground gets too dark to read ink against.
const SCORE_X = {
  1: { fill: argb("#E4EBE8"), text: X.ink },
  2: { fill: argb("#C4D3CD"), text: X.ink },
  3: { fill: argb("#9DB8AF"), text: X.ink },
  4: { fill: argb(C.pineLight), text: X.white },
  5: { fill: argb(C.pine), text: X.white },
};

const CONF_X = {
  high: { text: X.pine, fill: argb("#E9EFEC") },
  medium: { text: X.amber, fill: argb("#FAF2E6") },
  low: { text: X.rust, fill: argb("#F7EAE6") },
};

/* A response cut off by the token ceiling is still valid JSON up to the point it
   stopped. Walk it, find the last element that closed cleanly inside an array,
   drop everything after it, and close whatever brackets are still open. Returns
   null when there is no complete element to fall back to.                      */
function repairTruncatedJson(src) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let cutStack = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      // Closing back out into an array means a whole element just finished —
      // the safest place to cut, since arrays tolerate being short.
      if (stack[stack.length - 1] === "[") {
        cut = i + 1;
        cutStack = [...stack];
      }
    }
  }

  if (cut === -1 || !cutStack) return null;
  const closers = cutStack
    .reverse()
    .map((ch) => (ch === "{" ? "}" : "]"))
    .join("");
  return src.slice(0, cut) + closers;
}

async function askClaude(prompt) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");

  // Truncated responses usually lose their closing brace, so both failure paths
  // dump the raw text — the message alone never says which one it was.
  if (start === -1 || end === -1) {
    console.error("askClaude: no JSON object in response. Raw text:\n", text);
  } else {
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch (err) {
      console.error("askClaude: JSON.parse failed —", err.message, "\nRaw text:\n", text);
    }
  }

  // Both failures look the same from here: the response ran out mid-structure.
  // Repair from the full remainder rather than the lastIndexOf slice, which may
  // itself have cut at a brace in the middle of the object.
  if (start !== -1) {
    const repaired = repairTruncatedJson(clean.slice(start));
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        console.warn(
          "askClaude: response was truncated — recovered the complete prefix, later items were lost."
        );
        return parsed;
      } catch (err) {
        console.error("askClaude: repair attempt also failed —", err.message);
      }
    }
  }

  throw new Error("Response was not usable JSON");
}

/* ------------------------------- primitives ------------------------------ */

function Rule({ heavy }) {
  return (
    <div
      style={{
        height: heavy ? 2 : 1,
        background: heavy ? C.ink : C.rule,
        width: "100%",
      }}
    />
  );
}

function Eyebrow({ children, n }) {
  return (
    <div
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.muted,
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        marginBottom: 10,
      }}
    >
      {n != null && <span style={{ color: C.pine }}>{String(n).padStart(2, "0")}</span>}
      {children}
    </div>
  );
}

/* Small caps run-in heading for the blocks inside a field's helper text. */
function HelpLabel({ children, tone }) {
  return (
    <div
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: tone || C.muted,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function Arrow() {
  return <span style={{ color: C.rule, margin: "0 4px" }}>→</span>;
}

function Btn({ children, onClick, disabled, kind = "solid" }) {
  const solid = kind === "solid";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontSize: 14,
        fontWeight: 500,
        padding: "11px 20px",
        border: `1px solid ${solid ? C.pine : C.rule}`,
        background: disabled ? "#CFCDC6" : solid ? C.pine : "transparent",
        color: solid ? (disabled ? "#F2F1ED" : C.paper) : C.ink,
        borderColor: disabled ? "#CFCDC6" : solid ? C.pine : C.rule,
        cursor: disabled ? "not-allowed" : "pointer",
        borderRadius: 2,
        transition: "opacity .15s",
      }}
    >
      {children}
    </button>
  );
}

/* The signature element: a row's sub-scores drawn as a profile, so the shape
   of a row is legible before its composite number is.                        */
function Profile({ scores, cols }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 26 }}>
      {cols.map((c) => {
        const v = scores?.[c.name] ?? 0;
        return (
          <div
            key={c.name}
            title={`${c.name}: ${v}`}
            style={{
              width: 7,
              height: `${(v / 5) * 100}%`,
              minHeight: 2,
              background: v >= 4 ? C.pine : v >= 3 ? C.pineLight : C.rule,
            }}
          />
        );
      })}
    </div>
  );
}

/* --------------------------------- app ---------------------------------- */

export default function OpportunityMapBuilder() {
  const [phase, setPhase] = useState("frame");
  const [topic, setTopic] = useState("");
  const [objective, setObjective] = useState("");
  const [review, setReview] = useState(null);
  const [axes, setAxes] = useState([]);
  const [merges, setMerges] = useState([]);
  const [ownAxis, setOwnAxis] = useState("");
  const [newCol, setNewCol] = useState("");
  const [newColDesc, setNewColDesc] = useState("");
  const [newColInv, setNewColInv] = useState(false);
  const [rejected, setRejected] = useState([]);
  const [countNote, setCountNote] = useState("");
  const [structure, setStructure] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (phase === "map" && mapRef.current) {
      mapRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [phase]);

  const EXAMPLES = [
    {
      label: "Carbon capture",
      topic: "Ways electrochemical carbon capture can be deployed",
      objective:
        "Reach a first paying customer within 24 months at under $200 per tonne captured",
    },
    {
      label: "Grid storage",
      topic: "Ways to store energy on an electrical grid",
      objective:
        "Deliver four hours of storage below $100 per kWh installed by 2032",
    },
    {
      label: "Green hydrogen",
      topic: "Pathways for producing green hydrogen",
      objective:
        "Produce hydrogen below $2 per kg at commercial scale by 2030",
    },
  ];

  const loadExample = (ex) => {
    setTopic(ex.topic);
    setObjective(ex.objective);
    setReview(null);
    setAxes([]);
    setRejected([]);
    setOwnAxis("");
    setStructure(null);
    setRows([]);
    setPhase("frame");
  };

  async function reviewFraming() {
    setBusy(true);
    setError(null);
    setStatus("Reading what you wrote");
    try {
      const r = await askClaude(
        `Someone is about to build a technology assessment map. Critique their framing before they start.

WHAT THEY WANT TO COMPARE: ${topic}
WHAT WINNING LOOKS LIKE: ${objective}

Judge two things.

TOPIC: is it a space of several options, or a yes/no question, or so broad no single dimension could slice it?
OBJECTIVE: is it measurable? Vague objectives produce criteria that cannot rank anything. A good objective names a threshold, a deadline, or a countable outcome.

Be direct and specific. If something is already good, say so plainly rather than inventing a problem.

Return ONLY this JSON:
{"topicVerdict":"good|broad|not-a-space","topicNote":"one or two sentences, plain language","objectiveVerdict":"good|vague|not-measurable","objectiveNote":"one or two sentences, plain language","missing":["a thing they have not said that would change the columns","another"],"topicRewrites":["a sharper version of their topic","another"],"objectiveRewrites":["a sharper measurable version of their objective","another"]}

Rewrites must stay true to what they actually want. Do not substitute a different goal.`
      );
      setReview(r);
      setPhase("review");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function proposeAxes(avoid = []) {
    setBusy(true);
    setError(null);
    setStatus("Finding ways to slice this");
    try {
      const a = await askClaude(
        `Someone wants to compare options within a space.

WHAT THEY'RE COMPARING: ${topic}
WHAT WINNING LOOKS LIKE: ${objective}

Before listing options, the dimension has to be chosen. The same space can be sliced several ways, and the choice determines everything downstream.

${avoid.length ? `The person has already seen and rejected these framings, so do not repeat them or offer near-variants: ${avoid.join("; ")}. Reach for genuinely different angles.` : ""}

Propose 4 genuinely different axes of variation. Make them meaningfully distinct from each other, not four phrasings of one idea. For each, give two example rows so the person can see what the map would actually contain, and say plainly what that framing is good for and what it hides.

Return ONLY this JSON:
{"axes":[{"axis":"short phrase","good":"what this framing reveals, one sentence","blind":"what it hides or flattens, one sentence","samples":["example row","another example row"]}]}`
      );
      setAxes(a.axes || []);
      setStructure(null);
      setPhase("axis");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function deriveColumns(chosen) {
    setBusy(true);
    setError(null);
    setStatus("Deriving criteria from your objective");
    try {
      const s = await askClaude(
        `A person is building a technology assessment map.

TOPIC: ${topic}
OBJECTIVE: ${objective}
AXIS OF VARIATION: ${chosen.axis}

Derive 5 evaluation columns from the OBJECTIVE specifically, using this scaffold, renamed to fit the topic: Prize (size of the win), Pull (what force drags someone toward this), Distance (how far from working), Resistance (what is in the way, inverted so 5 means fewest obstacles), Fit (can this particular actor win it).

Also list 2 gates: disqualifying pass/fail conditions that must filter rows rather than be averaged into a score.

Return ONLY this JSON:
{"columns":[{"name":"short name","desc":"one line on what it measures","inverted":false,"weight":20}],"gates":[{"name":"short name","desc":"one line"}]}

Weights are integers summing to 100. Column names under 4 words.`
      );
      setStructure({ ...s, axis: chosen.axis, why: chosen.good, blind: chosen.blind });
      setPhase("structure");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function generateMap() {
    setBusy(true);
    setError(null);
    setRows([]);
    setMerges([]);
    try {
      setStatus("Over-generating, then merging the duplicates");
      const listed = await askClaude(
        `TOPIC: ${topic}
AXIS OF VARIATION: ${structure.axis}

Step 1: privately generate 25 or more candidate options along this axis. Over-generate deliberately, including near-duplicates.

Step 2: collapse them using these tests, applied in order.
- Swap: could an approach built for A drop into B unchanged? If yes, merge.
- Action: would the decision-maker actually do anything different about A than B? If no, merge.
- New constraint: does A introduce a constraint no other candidate has? Strong reason to keep it separate.
- Dominance: does A beat B on every dimension? Then B is a worse version of A, not a separate option. Merge.

Do the candidate generation and the collapsing privately. Do NOT output the candidate list, the merges, or any working — only the options that survived.

Return however many genuinely survive, up to a maximum of 14 rows. Do not pad to reach a number. If more than 14 survive, keep the 14 most distinct from each other. Most spaces land somewhere between 7 and 14.

Keep the whole response under 250 words. Each desc must be 12 words or fewer.

Return ONLY this JSON:
{"rows":[{"name":"short label under 8 words","desc":"12 words or fewer"}]}`
      );

      const all = listed.rows.slice(0, 20);

      // The merge log is commentary on a map that already exists. If this call fails
      // the map is still fine, so it never takes the run down with it.
      setStatus("Reconstructing the near-duplicates");
      try {
        const log = await askClaude(
          `TOPIC: ${topic}
AXIS OF VARIATION: ${structure.axis}

These options survived a collapse pass over a much longer candidate list:
${all.map((r) => `- ${r.name}`).join("\n")}

Name the near-duplicate candidates a careful person would have considered along this axis, and say which survivor absorbs each one and why. Give the reason as one of these tests.
- Swap: an approach built for one drops into the other unchanged.
- Action: the decision-maker would do nothing different about the two.
- Dominance: one beats the other on every dimension, so the loser is a worse version rather than a separate option.

Also say in one sentence why this many options survived rather than more or fewer.

Return ONLY this JSON:
{"merges":[{"kept":"the surviving option name","absorbed":["candidate that was folded in"],"test":"swap|action|dominance","why":"under 15 words"}],"count":"one sentence on why this many survived rather than more or fewer"}

Include at most 4 merges — the most instructive ones. Every "kept" must be one of the surviving names above, spelled exactly.`
        );
        setMerges(log.merges || []);
        setCountNote(log.count || "");
      } catch (e) {
        console.error("Merge log unavailable, continuing to scoring:", e);
        setMerges([]);
        setCountNote("");
      }

      const colNames = structure.columns.map((c) => c.name);
      const chunks = [];
      for (let i = 0; i < all.length; i += 4) chunks.push(all.slice(i, i + 4));

      let done = [];
      for (let i = 0; i < chunks.length; i++) {
        setStatus(`Scoring ${done.length + 1}–${done.length + chunks[i].length} of ${all.length}`);
        const res = await askClaude(
          `TOPIC: ${topic}
OBJECTIVE: ${objective}

Score these options on each criterion.

OPTIONS:
${chunks[i].map((r) => `- ${r.name}: ${r.desc}`).join("\n")}

CRITERIA:
${structure.columns
  .map((c) => `- ${c.name}${c.inverted ? " (INVERTED: 5 = fewest obstacles)" : ""}: ${c.desc}`)
  .join("\n")}

For each option give a score 1-5 per criterion, a note of at most 10 words per criterion, and one confidence value for the whole row: "high" if this rests on well-established general knowledge, "medium" if it involves specifics that shift over time, "low" if it involves named organizations, figures, or fast-moving facts you cannot verify.

Return ONLY this JSON:
{"cells":[{"name":"exact option name","conf":"high|medium|low","scores":{${colNames
            .map((n) => `"${n}":3`)
            .join(",")}},"notes":{${colNames.map((n) => `"${n}":"note"`).join(",")}}}]}`
        );
        const merged = res.cells.map((c) => {
          const src = chunks[i].find((r) => r.name === c.name) || chunks[i][0];
          return { ...c, desc: src.desc };
        });
        done = [...done, ...merged];
        setRows([...done]);
      }
      setPhase("map");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  const totalW = structure?.columns.reduce((a, c) => a + Number(c.weight || 0), 0) || 1;

  const composite = (r) =>
    structure.columns.reduce(
      (a, c) => a + (r.scores?.[c.name] ?? 0) * Number(c.weight || 0),
      0
    ) / totalW;

  const sorted = [...rows].sort((a, b) => composite(b) - composite(a));

  function removeColumn(i) {
    setStructure({
      ...structure,
      columns: structure.columns.filter((_, j) => j !== i),
    });
  }

  function addOwnColumn() {
    if (!newCol.trim()) return;
    setStructure({
      ...structure,
      columns: [
        ...structure.columns,
        { name: newCol.trim(), desc: newColDesc.trim() || "Added by you.", inverted: newColInv, weight: 15 },
      ],
    });
    setNewCol("");
    setNewColDesc("");
    setNewColInv(false);
  }

  async function suggestMoreColumns() {
    setBusy(true);
    setError(null);
    setStatus("Looking for criteria you haven't got");
    try {
      const r = await askClaude(
        `TOPIC: ${topic}
OBJECTIVE: ${objective}
AXIS: ${structure.axis}

These criteria are already in use, and are being kept:
${structure.columns.map((c) => `- ${c.name}: ${c.desc}`).join("\n")}

Propose 3 ADDITIONAL criteria that are not covered by the ones above and not near-duplicates of them. Each must pass two tests: it varies across options, and that variation would change the decision. Prefer criteria that come from the OBJECTIVE and are currently missing.

Return ONLY this JSON:
{"columns":[{"name":"short name under 4 words","desc":"one line on what it measures","inverted":false,"weight":15}]}`
      );
      const existing = structure.columns.map((c) => c.name.toLowerCase());
      const fresh = (r.columns || []).filter((c) => !existing.includes(c.name.toLowerCase()));
      setStructure({ ...structure, columns: [...structure.columns, ...fresh] });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  function setWeight(i, v) {
    const cols = [...structure.columns];
    cols[i] = { ...cols[i], weight: Math.max(0, Math.min(100, Number(v) || 0)) };
    setStructure({ ...structure, columns: cols });
  }

  // The export chunk is fetched on click, so a failure here can be a network problem
  // rather than a bug in the sheet building. Reported next to the button, since the
  // banner at the top of the page is a long way from where the click happened.
  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      await exportXlsx();
    } catch (e) {
      console.error("Export failed:", e);
      setExportError(`Export failed — ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  async function exportXlsx() {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "Technology Assessment Map";

    const cols = structure.columns;
    const hair = { style: "thin", color: { argb: X.rule } };
    const border = { top: hair, left: hair, bottom: hair, right: hair };
    const paperFill = { type: "pattern", pattern: "solid", fgColor: { argb: X.paper } };

    const headerCell = (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: X.pine } };
      cell.font = { bold: true, size: 11, color: { argb: X.white } };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = border;
    };

    /* ------------------------------- Map sheet ------------------------------ */
    // Column order mirrors the on-screen table: identity, then the headline
    // numbers, then each criterion's score sitting next to its own note.
    const ws = wb.addWorksheet("Map", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "Rank", width: 7 },
      { header: "Option", width: 30 },
      { header: "Description", width: 44 },
      { header: "Composite", width: 12 },
      { header: "Confidence", width: 15 },
      ...cols.flatMap((c) => [
        { header: `${c.name}${c.inverted ? " (inv)" : ""}`, width: 9 },
        { header: `${c.name} — note`, width: 34 },
      ]),
    ];

    sorted.forEach((r, i) => {
      ws.addRow([
        i + 1,
        r.name,
        r.desc || "",
        Number(composite(r).toFixed(2)),
        CONF[r.conf]?.label || r.conf,
        ...cols.flatMap((c) => [r.scores?.[c.name] ?? "", r.notes?.[c.name] || ""]),
      ]);
    });

    const headRow = ws.getRow(1);
    headRow.height = 30;
    headRow.eachCell(headerCell);

    sorted.forEach((r, i) => {
      const row = ws.getRow(i + 2);
      row.height = 30;

      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = paperFill;
        cell.border = border;
        cell.font = { size: 10.5, color: { argb: X.ink } };
        cell.alignment = { vertical: "top", wrapText: false };
      });

      row.getCell(1).alignment = { vertical: "top", horizontal: "center" };
      row.getCell(2).font = { size: 10.5, bold: true, color: { argb: X.ink } };
      row.getCell(3).alignment = { vertical: "top", wrapText: true };

      // Composite carries the ranking, so it gets the weight on the row.
      const comp = row.getCell(4);
      comp.font = { size: 12, bold: true, color: { argb: X.ink } };
      comp.alignment = { vertical: "top", horizontal: "center" };
      comp.numFmt = "0.00";

      const conf = row.getCell(5);
      conf.font = { size: 10.5, bold: true, color: { argb: CONF_X[r.conf]?.text || X.ink } };
      conf.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: CONF_X[r.conf]?.fill || X.paper },
      };
      conf.alignment = { vertical: "top", horizontal: "center" };

      cols.forEach((c, k) => {
        const scoreCell = row.getCell(6 + k * 2);
        const noteCell = row.getCell(7 + k * 2);
        const v = r.scores?.[c.name];
        const band = SCORE_X[v];
        if (band) {
          scoreCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: band.fill } };
          scoreCell.font = { size: 11, bold: true, color: { argb: band.text } };
        }
        scoreCell.alignment = { vertical: "top", horizontal: "center" };
        noteCell.alignment = { vertical: "top", wrapText: true };
      });
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };

    /* ----------------------------- Method sheet ----------------------------- */
    const meta = wb.addWorksheet("Method");
    meta.columns = [{ width: 24 }, { width: 12 }, { width: 68 }, { width: 10 }];

    const sectionRow = (label) => {
      const row = meta.addRow([label]);
      meta.mergeCells(row.number, 1, row.number, 4);
      const cell = row.getCell(1);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: X.pine } };
      cell.font = { bold: true, size: 11, color: { argb: X.white } };
      cell.alignment = { vertical: "middle" };
      row.height = 24;
      return row;
    };

    const bodyRow = (values, { wrapLast = true } = {}) => {
      const row = meta.addRow(values);
      row.eachCell({ includeEmpty: true }, (cell, n) => {
        cell.fill = paperFill;
        cell.border = border;
        cell.font = { size: 10.5, color: { argb: X.ink } };
        cell.alignment = { vertical: "top", wrapText: wrapLast && n >= 3 };
      });
      row.getCell(1).font = { size: 10.5, bold: true, color: { argb: X.ink } };
      return row;
    };

    const title = meta.addRow(["Technology Assessment Map"]);
    title.getCell(1).font = { bold: true, size: 16, color: { argb: X.pine } };
    title.height = 26;
    meta.addRow([]);

    sectionRow("Framing");
    bodyRow(["Topic", "", topic]);
    bodyRow(["Objective", "", objective]);
    bodyRow(["Axis of variation", "", structure.axis]);
    bodyRow(["Why this axis", "", structure.why]);
    meta.addRow([]);

    sectionRow("Criteria and weights");
    const critHead = meta.addRow(["Criterion", "Weight %", "What it measures", "Inverted"]);
    critHead.eachCell(headerCell);
    cols.forEach((c) => {
      const row = bodyRow([c.name, c.weight, c.desc, c.inverted ? "yes" : ""]);
      row.getCell(2).alignment = { vertical: "top", horizontal: "center" };
      if (c.inverted) {
        row.getCell(4).font = { size: 10.5, bold: true, color: { argb: X.amber } };
      }
    });
    meta.addRow([]);

    sectionRow("Gates — pass/fail, filter rows before scoring, never averaged");
    (structure.gates ?? []).forEach((g) => {
      const row = bodyRow([g.name, "", g.desc]);
      row.getCell(1).font = { size: 10.5, bold: true, color: { argb: X.rust } };
    });
    meta.addRow([]);

    sectionRow("Before this goes to anyone");
    [
      "Scores are a starting point. They encode judgment that should be yours.",
      "Rows marked 'verify first' contain specifics that were not researched. Check them.",
      "Set weights before reading scores. Tuning them afterward makes the map decoration.",
      "Read the profile, not just the composite. A low-Prize, high-Fit row is a beachhead.",
    ].forEach((line) => bodyRow(["", "", line]));

    /* -------------------------------- download ------------------------------ */
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `technology-assessment-${Date.now()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* -------------------------------- render ------------------------------- */

  return (
    <div
      style={{
        background: C.paper,
        color: C.ink,
        minHeight: "100vh",
        fontFamily: "'IBM Plex Sans', sans-serif",
        padding: "0 0 80px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap');
        * { box-sizing: border-box; }
        input, textarea { font-family: 'IBM Plex Sans', sans-serif; }
        input:focus, textarea:focus { outline: 2px solid ${C.pine}; outline-offset: 1px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 28px" }}>
        {/* masthead */}
        <header style={{ paddingTop: 56, paddingBottom: 26 }}>
          <div
            style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: 54,
              lineHeight: 1.02,
              letterSpacing: "-0.015em",
            }}
          >
            Technology Assessment Map
          </div>
          <div
            style={{
              maxWidth: 640,
              marginTop: 14,
              fontSize: 16,
              lineHeight: 1.55,
              color: C.muted,
            }}
          >
            Name a technology and a goal. Get every viable configuration, ranked against
            what winning looks like.
          </div>
        </header>
        <Rule heavy />

        {/* frame */}
        <section style={{ paddingTop: 34 }}>
          <Eyebrow n={1}>Frame</Eyebrow>
          <div style={{ display: "grid", gap: 22, maxWidth: 720 }}>
            {/* The guidance here is long enough that wrapping it in the <label> would
                drag all of it into the field's accessible name, so this one field uses
                htmlFor + aria-describedby instead. */}
            <div>
              <label
                htmlFor="topic-input"
                style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 3 }}
              >
                What technology are you assessing?
              </label>

              <div
                id="topic-help"
                style={{ fontSize: 12.5, color: C.muted, marginBottom: 10, lineHeight: 1.55 }}
              >
                <p style={{ margin: "0 0 9px" }}>
                  Describe a technology area where multiple designs, configurations, or
                  deployment strategies could compete. Think a family of options, not a
                  single product.
                </p>

                <div style={{ marginBottom: 9 }}>
                  <HelpLabel>Phrase it like</HelpLabel>
                  <div
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 11.5,
                      color: C.pine,
                      lineHeight: 1.7,
                    }}
                  >
                    Ways to… · Configurations for… · Strategies to deploy… · Pathways
                    for…
                  </div>
                </div>

                <div style={{ marginBottom: 9 }}>
                  <HelpLabel>Good examples</HelpLabel>
                  <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                    <li>Ways to store energy on an electrical grid</li>
                    <li>Strategies to deploy electrochemical carbon capture</li>
                    <li>Pathways for producing green hydrogen</li>
                    <li>Methods for recycling lithium-ion batteries</li>
                  </ul>
                </div>

                <div style={{ marginBottom: 9 }}>
                  <HelpLabel tone={C.rust}>Avoid</HelpLabel>
                  <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                    <li>
                      a specific solution <Arrow /> “Build a battery farm”
                    </li>
                    <li>
                      a vague complaint <Arrow /> “Energy is too expensive”
                    </li>
                    <li>
                      a binary choice <Arrow /> “Batteries vs. pumped hydro?”
                    </li>
                  </ul>
                </div>

                <p
                  style={{
                    margin: 0,
                    paddingTop: 8,
                    borderTop: `1px solid ${C.ruleSoft}`,
                    fontStyle: "italic",
                  }}
                >
                  Once you name a technology, the tool lays out its distinct configurations
                  and scores each against criteria derived from your goal, narrowing to the
                  few worth deeper analysis.
                </p>
              </div>

              <textarea
                id="topic-input"
                aria-describedby="topic-help"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Ways to store energy on an electrical grid"
                rows={2}
                style={{
                  width: "100%",
                  padding: "11px 13px",
                  fontSize: 15,
                  border: `1px solid ${C.rule}`,
                  background: "#FFFDF9",
                  borderRadius: 2,
                  resize: "vertical",
                  color: C.ink,
                }}
              />
            </div>

            <label>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>
                What winning looks like
              </div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 9 }}>
                Make it measurable — a number, a threshold, a deadline. Something you
                could later check you hit. Vague goals produce criteria that cannot rank
                anything.
              </div>
              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Deliver four hours of storage below $100 per kWh installed by 2032"
                rows={2}
                style={{
                  width: "100%",
                  padding: "11px 13px",
                  fontSize: 15,
                  border: `1px solid ${C.rule}`,
                  background: "#FFFDF9",
                  borderRadius: 2,
                  resize: "vertical",
                  color: C.ink,
                }}
              />
            </label>

            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <Btn onClick={reviewFraming} disabled={!topic.trim() || !objective.trim() || busy}>
                {busy && phase === "frame" ? "Working…" : "Check my framing"}
              </Btn>
              {EXAMPLES.map((ex) => (
                <Btn key={ex.label} kind="ghost" onClick={() => loadExample(ex)}>
                  {ex.label}
                </Btn>
              ))}
              {status && phase === "frame" && (
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 12,
                    color: C.muted,
                  }}
                >
                  {status}
                </span>
              )}
            </div>

            {error && (
              <div
                style={{
                  border: `1px solid ${C.rust}`,
                  padding: "12px 14px",
                  fontSize: 14,
                  background: "#FBF2EF",
                }}
              >
                <strong>{error}</strong>
                <div style={{ color: C.muted, marginTop: 4 }}>
                  Try again, or edit the topic and resubmit.
                </div>
              </div>
            )}
          </div>
        </section>

        {/* review */}
        {review && (
          <>
            <div style={{ height: 44 }} />
            <Rule />
            <section style={{ paddingTop: 30 }}>
              <Eyebrow n={2}>Sharpen it</Eyebrow>
              <div
                style={{
                  fontSize: 14.5,
                  color: C.muted,
                  maxWidth: 700,
                  marginBottom: 24,
                  lineHeight: 1.55,
                }}
              >
                Nothing here is required. But the columns you get in the next step are
                built from these two sentences, so it is worth a minute.
              </div>

              {[
                {
                  head: "What you're comparing",
                  verdict: review.topicVerdict,
                  note: review.topicNote,
                  rewrites: review.topicRewrites,
                  apply: setTopic,
                  current: topic,
                },
                {
                  head: "What winning looks like",
                  verdict: review.objectiveVerdict,
                  note: review.objectiveNote,
                  rewrites: review.objectiveRewrites,
                  apply: setObjective,
                  current: objective,
                },
              ].map((b, bi) => {
                const ok = b.verdict === "good";
                return (
                  <div
                    key={bi}
                    style={{
                      border: `1px solid ${C.rule}`,
                      background: "#FFFDF9",
                      padding: "18px 20px",
                      marginBottom: 16,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 12,
                        marginBottom: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{b.head}</div>
                      <div
                        style={{
                          fontFamily: "'IBM Plex Mono', monospace",
                          fontSize: 10.5,
                          letterSpacing: "0.09em",
                          textTransform: "uppercase",
                          color: ok ? C.pine : C.amber,
                        }}
                      >
                        {ok ? "reads well" : b.verdict}
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 13.5,
                        color: C.muted,
                        fontStyle: "italic",
                        marginBottom: 10,
                        paddingLeft: 12,
                        borderLeft: `2px solid ${C.ruleSoft}`,
                      }}
                    >
                      {b.current}
                    </div>

                    <div style={{ fontSize: 14.5, lineHeight: 1.55, marginBottom: 14 }}>
                      {b.note}
                    </div>

                    {!ok && b.rewrites?.length > 0 && (
                      <>
                        <div
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 10.5,
                            letterSpacing: "0.09em",
                            textTransform: "uppercase",
                            color: C.muted,
                            marginBottom: 8,
                          }}
                        >
                          Tap to use
                        </div>
                        <div style={{ display: "grid", gap: 8 }}>
                          {b.rewrites.map((rw, ri) => (
                            <button
                              key={ri}
                              onClick={() => b.apply(rw)}
                              style={{
                                textAlign: "left",
                                fontFamily: "'IBM Plex Sans', sans-serif",
                                fontSize: 14,
                                lineHeight: 1.45,
                                padding: "10px 13px",
                                border: `1px solid ${C.rule}`,
                                background: C.paper,
                                color: C.ink,
                                cursor: "pointer",
                                borderRadius: 2,
                              }}
                            >
                              {rw}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}

              {review.missing?.length > 0 && (
                <div
                  style={{
                    border: `1px solid ${C.amber}`,
                    background: "#FCF7EE",
                    padding: "16px 20px",
                    marginBottom: 20,
                  }}
                >
                  <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 8 }}>
                    You haven't said
                  </div>
                  <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 10 }}>
                    Each of these would change which criteria come back. Add them to
                    either box above if they matter to you.
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
                    {review.missing.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <Btn onClick={proposeAxes} disabled={busy}>
                  {busy ? "Working…" : "Break this down"}
                </Btn>
                <Btn kind="ghost" onClick={reviewFraming} disabled={busy}>
                  Check again
                </Btn>
                {status && (
                  <span
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 12,
                      color: C.muted,
                    }}
                  >
                    {status}
                  </span>
                )}
              </div>
            </section>
          </>
        )}

        {/* axis */}
        {axes.length > 0 && (
          <>
            <div style={{ height: 44 }} />
            <Rule />
            <section style={{ paddingTop: 30 }}>
              <Eyebrow n={3}>Pick the dimension</Eyebrow>
              <div style={{ fontSize: 14.5, color: C.muted, maxWidth: 700, marginBottom: 24, lineHeight: 1.55 }}>
                This is the decision that matters most, and the one usually skipped. The
                same space sliced two ways produces two different maps, both internally
                consistent, only one of them useful to you.
              </div>

              <div style={{ display: "grid", gap: 14 }}>
                {axes.map((a, i) => {
                  const picked = structure?.axis === a.axis;
                  return (
                    <div
                      key={i}
                      style={{
                        border: `1px solid ${picked ? C.pine : C.rule}`,
                        borderLeft: `3px solid ${picked ? C.pine : C.rule}`,
                        background: "#FFFDF9",
                        padding: "18px 20px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div style={{ flex: "1 1 380px" }}>
                          <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 25, lineHeight: 1.15, marginBottom: 10 }}>
                            {a.axis}
                          </div>
                          <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 6 }}>{a.good}</div>
                          <div style={{ fontSize: 13.5, lineHeight: 1.5, color: C.amber }}>
                            Hides: {a.blind}
                          </div>
                          {a.samples?.length > 0 && (
                            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: C.muted, marginTop: 11, lineHeight: 1.7 }}>
                              rows would look like<br />
                              {a.samples.map((sm, si) => (<span key={si}>· {sm}<br /></span>))}
                            </div>
                          )}
                        </div>
                        <Btn onClick={() => deriveColumns(a)} disabled={busy}>
                          {picked ? "Chosen" : "Slice by this"}
                        </Btn>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  marginTop: 20,
                  border: `1px dashed ${C.rule}`,
                  padding: "18px 20px",
                  background: "transparent",
                }}
              >
                <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>
                  None of these fit
                </div>
                <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 13, lineHeight: 1.5 }}>
                  Reasonable. You know the space better than a generated list does. Name
                  your own dimension, or ask for four different ones.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    value={ownAxis}
                    onChange={(e) => setOwnAxis(e.target.value)}
                    placeholder="e.g. how close the role sits to the customer"
                    style={{
                      flex: "1 1 320px",
                      padding: "10px 13px",
                      fontSize: 14.5,
                      border: `1px solid ${C.rule}`,
                      background: "#FFFDF9",
                      borderRadius: 2,
                      color: C.ink,
                    }}
                  />
                  <Btn
                    onClick={() =>
                      deriveColumns({
                        axis: ownAxis.trim(),
                        good: "Chosen by you rather than proposed.",
                        blind: "",
                      })
                    }
                    disabled={!ownAxis.trim() || busy}
                  >
                    Use mine
                  </Btn>
                  <Btn
                    kind="ghost"
                    onClick={() => {
                      const seen = [...rejected, ...axes.map((a) => a.axis)];
                      setRejected(seen);
                      proposeAxes(seen);
                    }}
                    disabled={busy}
                  >
                    Show me four different ones
                  </Btn>
                </div>
                {rejected.length > 0 && (
                  <div
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 11,
                      color: C.muted,
                      marginTop: 11,
                      lineHeight: 1.6,
                    }}
                  >
                    ruled out: {rejected.join(" · ")}
                  </div>
                )}
              </div>

              {status && phase === "axis" && (
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.muted, marginTop: 14 }}>
                  {status}
                </div>
              )}
            </section>
          </>
        )}

        {/* structure */}
        {structure && (
          <>
            <div style={{ height: 44 }} />
            <Rule />
            <section style={{ paddingTop: 30 }}>
              <Eyebrow n={4}>Criteria and weights</Eyebrow>

              <div style={{ display: "flex", gap: 40, flexWrap: "wrap", marginBottom: 30 }}>
                <div style={{ flex: "1 1 340px", minWidth: 300 }}>
                  <div style={{ fontSize: 13, color: C.muted, marginBottom: 5 }}>
                    Slicing by
                  </div>
                  <div
                    style={{
                      fontFamily: "'Instrument Serif', Georgia, serif",
                      fontSize: 30,
                      lineHeight: 1.15,
                      marginBottom: 10,
                    }}
                  >
                    {structure.axis}
                  </div>
                  <div style={{ fontSize: 14.5, lineHeight: 1.55, color: C.muted }}>
                    {structure.why}
                  </div>
                </div>

                <div style={{ flex: "1 1 300px", minWidth: 280 }}>
                  <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
                    Gates — pass/fail. These filter rows out. They are never scored,
                    because a disqualification averaged into a number becomes a mild
                    penalty instead.
                  </div>
                  {structure.gates?.map((g, i) => (
                    <div key={i} style={{ marginTop: 10, paddingLeft: 12, borderLeft: `2px solid ${C.rust}` }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{g.name}</div>
                      <div style={{ fontSize: 13.5, color: C.muted }}>{g.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
                Set the weights now, before you see any scores. Adjusting them afterward
                until a favorite wins is how these tables become decoration.
              </div>

              <div style={{ border: `1px solid ${C.rule}`, background: "#FFFDF9" }}>
                {structure.columns.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(140px,200px) 1fr 130px 30px",
                      gap: 16,
                      alignItems: "center",
                      padding: "13px 16px",
                      borderTop: i ? `1px solid ${C.ruleSoft}` : "none",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14.5, fontWeight: 600 }}>{c.name}</div>
                      {c.inverted && (
                        <div
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 10.5,
                            letterSpacing: "0.08em",
                            color: C.amber,
                            textTransform: "uppercase",
                          }}
                        >
                          inverted · 5 = fewest
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.45 }}>
                      {c.desc}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="range"
                        min="0"
                        max="50"
                        value={c.weight}
                        onChange={(e) => setWeight(i, e.target.value)}
                        style={{ width: 80, accentColor: C.pine }}
                      />
                      <span
                        style={{
                          fontFamily: "'IBM Plex Mono', monospace",
                          fontSize: 13,
                          width: 34,
                          textAlign: "right",
                        }}
                      >
                        {c.weight}%
                      </span>
                    </div>
                    <button
                      onClick={() => removeColumn(i)}
                      title="Remove this criterion"
                      aria-label={`Remove ${c.name}`}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: C.muted,
                        cursor: "pointer",
                        fontSize: 17,
                        lineHeight: 1,
                        padding: 4,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 12,
                  color: totalW === 100 ? C.muted : C.amber,
                  marginTop: 8,
                }}
              >
                total {totalW}% {totalW !== 100 && "— fine, weights are relative"}
              </div>

              <div
                style={{
                  marginTop: 18,
                  border: `1px dashed ${C.rule}`,
                  padding: "16px 18px",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                  Add a criterion
                </div>
                <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                  Keep what works, remove what doesn't with the ×, and add your own. Asking
                  for suggestions adds to this list rather than replacing it.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    value={newCol}
                    onChange={(e) => setNewCol(e.target.value)}
                    placeholder="Name"
                    style={{
                      flex: "0 1 170px",
                      padding: "9px 12px",
                      fontSize: 14,
                      border: `1px solid ${C.rule}`,
                      background: "#FFFDF9",
                      borderRadius: 2,
                      color: C.ink,
                    }}
                  />
                  <input
                    value={newColDesc}
                    onChange={(e) => setNewColDesc(e.target.value)}
                    placeholder="What it measures"
                    style={{
                      flex: "1 1 240px",
                      padding: "9px 12px",
                      fontSize: 14,
                      border: `1px solid ${C.rule}`,
                      background: "#FFFDF9",
                      borderRadius: 2,
                      color: C.ink,
                    }}
                  />
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                      color: C.muted,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={newColInv}
                      onChange={(e) => setNewColInv(e.target.checked)}
                      style={{ accentColor: C.pine }}
                    />
                    inverted
                  </label>
                  <Btn onClick={addOwnColumn} disabled={!newCol.trim()}>
                    Add
                  </Btn>
                  <Btn kind="ghost" onClick={suggestMoreColumns} disabled={busy}>
                    Suggest more
                  </Btn>
                </div>
              </div>

              <div style={{ marginTop: 22, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <Btn onClick={generateMap} disabled={busy}>
                  {busy ? "Building…" : "Build the map"}
                </Btn>
                {status && (
                  <span
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 12,
                      color: C.muted,
                    }}
                  >
                    {status}
                  </span>
                )}
              </div>
            </section>
          </>
        )}

        {/* map */}
        {rows.length > 0 && (
          <>
            <div style={{ height: 44 }} ref={mapRef} />
            <Rule />
            <section style={{ paddingTop: 30 }}>
              <Eyebrow n={5}>The map</Eyebrow>

              <div
                style={{
                  border: `1px solid ${C.amber}`,
                  background: "#FCF7EE",
                  padding: "13px 16px",
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  marginBottom: 22,
                  maxWidth: 760,
                }}
              >
                Cells were generated, not researched. Anything marked{" "}
                <strong style={{ color: C.rust }}>verify first</strong> rests on named
                organisations or figures that move — check those before this reaches
                anyone. The scores are a starting position for your judgment, not a
                finding.
              </div>

              {(merges.length > 0 || countNote) && (
                <div style={{ marginBottom: 24, maxWidth: 860 }}>
                  <div
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 10.5,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: C.muted,
                      marginBottom: 8,
                    }}
                  >
                    {rows.length} survived · near-duplicates a careful person would have
                    considered
                  </div>
                  {countNote && (
                    <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 14, color: C.ink }}>
                      {countNote}
                    </div>
                  )}
                  <div style={{ border: `1px solid ${C.rule}`, background: "#FFFDF9" }}>
                    {merges.map((m, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "11px 15px",
                          borderTop: i ? `1px solid ${C.ruleSoft}` : "none",
                          fontSize: 13.5,
                          lineHeight: 1.5,
                          display: "flex",
                          gap: 14,
                          flexWrap: "wrap",
                          alignItems: "baseline",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 10.5,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            color: C.pine,
                            minWidth: 74,
                          }}
                        >
                          {m.test}
                        </span>
                        <span style={{ flex: "1 1 300px" }}>
                          <span style={{ color: C.muted, textDecoration: "line-through" }}>
                            {(m.absorbed || []).join(", ")}
                          </span>
                          <span style={{ color: C.muted }}> → </span>
                          <strong>{m.kept}</strong>
                          <span style={{ color: C.muted }}> — {m.why}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                    These merges were reconstructed from the surviving options, not
                    recorded as the collapse happened — they show the kind of thing that
                    would have been folded in, not what actually was. Row count is still
                    an output rather than a setting: options were over-generated and then
                    collapsed, and a fixed target would have forced padding or truncation.
                  </div>
                </div>
              )}

              <div style={{ overflowX: "auto", border: `1px solid ${C.rule}`, background: "#FFFDF9" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
                  <thead>
                    <tr>
                      {["", "Option", "Profile", "Score", ...structure.columns.map((c) => c.name)].map(
                        (h, i) => (
                          <th
                            key={i}
                            style={{
                              textAlign: "left",
                              padding: "11px 12px",
                              fontFamily: "'IBM Plex Mono', monospace",
                              fontSize: 10.5,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              color: C.muted,
                              borderBottom: `2px solid ${C.ink}`,
                              whiteSpace: "nowrap",
                              background: C.paper,
                            }}
                          >
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.ruleSoft}` }}>
                        <td
                          style={{
                            padding: "13px 12px",
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 12,
                            color: C.muted,
                            verticalAlign: "top",
                          }}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </td>
                        <td style={{ padding: "13px 12px", verticalAlign: "top", minWidth: 190 }}>
                          <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.3 }}>
                            {r.name}
                          </div>
                          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.4 }}>
                            {r.desc}
                          </div>
                          <div
                            style={{
                              fontFamily: "'IBM Plex Mono', monospace",
                              fontSize: 10,
                              letterSpacing: "0.07em",
                              textTransform: "uppercase",
                              color: CONF[r.conf]?.color || C.muted,
                              marginTop: 6,
                            }}
                          >
                            {CONF[r.conf]?.label || r.conf}
                          </div>
                        </td>
                        <td style={{ padding: "13px 12px", verticalAlign: "top" }}>
                          <Profile scores={r.scores} cols={structure.columns} />
                        </td>
                        <td style={{ padding: "13px 12px", verticalAlign: "top" }}>
                          <span
                            style={{
                              fontFamily: "'IBM Plex Mono', monospace",
                              fontSize: 19,
                              fontWeight: 500,
                            }}
                          >
                            {composite(r).toFixed(2)}
                          </span>
                        </td>
                        {structure.columns.map((c) => (
                          <td
                            key={c.name}
                            style={{
                              padding: "13px 12px",
                              verticalAlign: "top",
                              fontSize: 13,
                              lineHeight: 1.45,
                              minWidth: 165,
                              color: C.ink,
                            }}
                          >
                            <span
                              style={{
                                fontFamily: "'IBM Plex Mono', monospace",
                                fontSize: 12,
                                color: C.pine,
                                marginRight: 7,
                              }}
                            >
                              {r.scores?.[c.name]}
                            </span>
                            {r.notes?.[c.name]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 22, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <Btn onClick={handleExport} disabled={exporting}>
                  {exporting ? "Preparing…" : "Download as Excel"}
                </Btn>
                <Btn kind="ghost" onClick={() => { setPhase("structure"); setRows([]); }}>
                  Change weights and rebuild
                </Btn>
                {exportError && (
                  <span style={{ fontSize: 13, color: C.rust }}>{exportError}</span>
                )}
              </div>

              <div
                style={{
                  fontSize: 13,
                  color: C.muted,
                  marginTop: 18,
                  maxWidth: 700,
                  lineHeight: 1.55,
                }}
              >
                Read the profile bars before the composite. A row that is small on the
                first criterion but tall on the last is a beachhead, not a weak option —
                the single number flattens exactly that distinction.
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
