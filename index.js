import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DefaultLinesDiffComputer } from "vscode-diff";

const server = new Server(
  {
    name: "vscode-diff-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const diffComputer = new DefaultLinesDiffComputer();

// ─── Output Formatting ────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;

/**
 * Builds a unified-diff-style string from the vscode-diff result, and returns
 * structured metrics alongside it.
 *
 * Metrics exclude moved blocks from changedLines so the agent's cost model
 * matches what VS Code actually highlights as "real" changes.
 *
 * @returns {{ text: string, metrics: object }}
 */
function formatDiff(originalLines, modifiedLines, result, verboseMetrics = false) {
  const { changes, moves, hitTimeout } = result;

  // ── Move maps ──────────────────────────────────────────────────────────────
  // origLineIdx (0-based) -> moveIndex
  const moveSourceMap = new Map();
  // modLineIdx  (0-based) -> moveIndex
  const moveDestMap = new Map();

  let movedSourceLines = 0;
  let movedDestLines = 0;

  moves.forEach((move, i) => {
    const { original, modified } = move.lineRangeMapping;
    for (let l = original.startLineNumber; l < original.endLineNumberExclusive; l++) {
      moveSourceMap.set(l - 1, i);
    }
    for (let l = modified.startLineNumber; l < modified.endLineNumberExclusive; l++) {
      moveDestMap.set(l - 1, i);
    }
    movedSourceLines += original.endLineNumberExclusive - original.startLineNumber;
    movedDestLines += modified.endLineNumberExclusive - modified.startLineNumber;
  });

  // ── Aggregate line counts ──────────────────────────────────────────────────
  const totalDeletions = changes.reduce(
    (s, c) => s + (c.original.endLineNumberExclusive - c.original.startLineNumber), 0
  );
  const totalInsertions = changes.reduce(
    (s, c) => s + (c.modified.endLineNumberExclusive - c.modified.startLineNumber), 0
  );
  // VS Code shows moved blocks with a distinct visual (not as red/green lines),
  // so we exclude them from the "real" changed-line count.
  const changedLines =
    (totalDeletions - movedSourceLines) + (totalInsertions - movedDestLines);

  // ── Early-exit for identical files ────────────────────────────────────────
  if (changes.length === 0 && moves.length === 0) {
    const metrics = {
      hunkCount: 0,
      changedLines: 0,
      // deletionWeight: counts deletions twice — losing lines is more alarming
      // to a reviewer than gaining them, so this tracks psychological cost better.
      deletionWeight: 0,
      realInsertions: 0,
      realDeletions: 0,
      movedBlocks: 0,
      movedLines: 0,
      hitTimeout: Boolean(hitTimeout),
    };
    const text = hitTimeout
      ? "⚠️  Diff timed out — files may be identical or too large to compare fully."
      : "Files are identical.";
    return { text, metrics };
  }

  const lines = [];

  if (hitTimeout) {
    lines.push("⚠️  Warning: diff computation timed out; result may be approximate.\n");
  }

  // ── Hunk collection ────────────────────────────────────────────────────────
  const hunks = changes.map((change) => ({
    origStart: change.original.startLineNumber - 1,
    origEnd:   change.original.endLineNumberExclusive - 1,
    modStart:  change.modified.startLineNumber - 1,
    modEnd:    change.modified.endLineNumberExclusive - 1,
  }));

  // Expand hunks with context and merge overlapping ones.
  // FIX: check overlap on BOTH original and modified sides — a large insertion
  // can create modified-side overlap that the original side doesn't reveal.
  const merged = [];
  for (const h of hunks) {
    const ctxOrigStart = Math.max(0, h.origStart - CONTEXT_LINES);
    const ctxOrigEnd   = Math.min(originalLines.length, h.origEnd + CONTEXT_LINES);
    const ctxModStart  = Math.max(0, h.modStart - CONTEXT_LINES);
    const ctxModEnd    = Math.min(modifiedLines.length, h.modEnd + CONTEXT_LINES);

    const prev = merged[merged.length - 1];
    if (
      prev &&
      (ctxOrigStart <= prev.ctxOrigEnd || ctxModStart <= prev.ctxModEnd)
    ) {
      prev.ctxOrigEnd = Math.max(prev.ctxOrigEnd, ctxOrigEnd);
      prev.ctxModEnd  = Math.max(prev.ctxModEnd,  ctxModEnd);
      prev.inner.push(h);
    } else {
      merged.push({ ctxOrigStart, ctxOrigEnd, ctxModStart, ctxModEnd, inner: [h] });
    }
  }

  // ── Render hunks ───────────────────────────────────────────────────────────
  const hunkDetails = [];

  for (const region of merged) {
    const origLen = region.ctxOrigEnd - region.ctxOrigStart;
    const modLen  = region.ctxModEnd  - region.ctxModStart;
    lines.push(
      `@@ -${region.ctxOrigStart + 1},${origLen} +${region.ctxModStart + 1},${modLen} @@`
    );

    let origCursor = region.ctxOrigStart;
    let modCursor  = region.ctxModStart;
    let hunkDeletions  = 0;
    let hunkInsertions = 0;

    for (const h of region.inner) {
      // Context before this change
      while (origCursor < h.origStart) {
        lines.push(` ${originalLines[origCursor]}`);
        origCursor++;
        modCursor++;
      }
      // Deleted lines (moved lines annotated; not counted as real deletions)
      for (let i = h.origStart; i < h.origEnd; i++) {
        const moveIdx = moveSourceMap.get(i);
        const annotation = moveIdx !== undefined ? ` {moved to block #${moveIdx + 1}}` : "";
        lines.push(`-${originalLines[i]}${annotation}`);
        if (moveIdx === undefined) hunkDeletions++;
        origCursor++;
      }
      // Inserted lines (moved lines annotated; not counted as real insertions)
      for (let i = h.modStart; i < h.modEnd; i++) {
        const moveIdx = moveDestMap.get(i);
        const annotation = moveIdx !== undefined ? ` {moved from block #${moveIdx + 1}}` : "";
        lines.push(`+${modifiedLines[i]}${annotation}`);
        if (moveIdx === undefined) hunkInsertions++;
        modCursor++;
      }
    }

    // Trailing context
    while (origCursor < region.ctxOrigEnd) {
      lines.push(` ${originalLines[origCursor]}`);
      origCursor++;
      modCursor++;
    }

    lines.push(""); // blank line between hunks

    if (verboseMetrics) {
      hunkDetails.push({
        origRange:  [region.ctxOrigStart + 1, region.ctxOrigEnd],
        modRange:   [region.ctxModStart + 1,  region.ctxModEnd],
        insertions: hunkInsertions,
        deletions:  hunkDeletions,
      });
    }
  }

  // ── Moved blocks section ───────────────────────────────────────────────────
  // Rendered separately so the agent (and reader) clearly distinguishes them
  // from real insertions/deletions — VS Code's diff view treats them differently.
  if (moves.length > 0) {
    lines.push("── Moved Blocks (low visual cost in VS Code) ──");
    moves.forEach((move, i) => {
      const { original, modified } = move.lineRangeMapping;
      const srcStart = original.startLineNumber;
      const srcEnd   = original.endLineNumberExclusive - 1;
      const dstStart = modified.startLineNumber;
      const dstEnd   = modified.endLineNumberExclusive - 1;
      lines.push(`  Block #${i + 1}: orig lines ${srcStart}–${srcEnd} → mod lines ${dstStart}–${dstEnd}`);
    });
    lines.push("");
  }

  // ── Summary footer ─────────────────────────────────────────────────────────
  lines.push(
    `--- Summary: ${merged.length} hunk(s), ` +
    `+${totalInsertions - movedDestLines} real insertion(s), ` +
    `-${totalDeletions - movedSourceLines} real deletion(s)` +
    (moves.length > 0
      ? `, ${moves.length} moved block(s) (shown separately above)`
      : "")
  );

  // ── Metrics object ─────────────────────────────────────────────────────────
  const realIns = totalInsertions - movedDestLines;
  const realDel = totalDeletions  - movedSourceLines;
  const metrics = {
    // Primary scalar the agent should minimise:
    hunkCount:       merged.length,
    changedLines,                        // real changes only, moves excluded
    // deletionWeight: counts deletions twice — losing lines is more alarming
    // to a reviewer than gaining them, so this tracks psychological cost better.
    deletionWeight:  realDel * 2 + realIns,
    // Breakdown:
    realInsertions:  realIns,
    realDeletions:   realDel,
    movedBlocks:     moves.length,
    movedLines:      movedSourceLines,   // lines involved in moves
    hitTimeout:      Boolean(hitTimeout),
    ...(verboseMetrics ? { hunks: hunkDetails } : {}),
  };

  return { text: lines.join("\n"), metrics };
}

// ─── MCP Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "compute_diff",
        description:
          "Computes a highly accurate diff using VS Code's advanced diff algorithm. " +
          "Returns a unified diff string with move annotations plus a structured metrics block. " +
          "Moved blocks are reported separately from real insertions/deletions because " +
          "VS Code renders them with a distinct, low-noise visual — the agent should treat " +
          "hunkCount and changedLines as the primary signals to minimise.",
        inputSchema: {
          type: "object",
          properties: {
            originalText: {
              type: "string",
              description: "The original complete text.",
            },
            modifiedText: {
              type: "string",
              description: "The modified complete text.",
            },
            ignoreTrimWhitespace: {
              type: "boolean",
              default: true,
              description:
                "If true, leading/trailing whitespace differences on each line are ignored. " +
                "Defaults to true — matching VS Code's diff editor default. " +
                "Gotcha: a line whose only change is indentation depth (e.g. code moved " +
                "into a deeper block) will appear as unchanged context with this flag on, " +
                "making the diff look cleaner than a plain `git diff` would. " +
                "Set to false if indentation changes should be visible.",
            },
            includeMetrics: {
              type: "boolean",
              default: true,
              description:
                "If true (default), appends a JSON metrics block after the diff text. " +
                "Contains hunkCount, changedLines, and related counts the agent can parse " +
                "directly to compare candidate edits without string-parsing the diff.",
            },
            verboseMetrics: {
              type: "boolean",
              default: false,
              description:
                "If true, the metrics block also includes a per-hunk breakdown " +
                "(origRange, modRange, insertions, deletions for each hunk). " +
                "Defaults to false. Only meaningful when includeMetrics is true.",
            },
            metricsOnly: {
              type: "boolean",
              default: false,
              description:
                "If true, suppresses the diff text and returns only the metrics block. " +
                "Useful for large files (>~200 lines) where the full unified diff would " +
                "flood the context window. includeMetrics is implicitly true when this is set.",
            },
          },
          required: ["originalText", "modifiedText"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "compute_diff") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Unknown tool: "${request.params.name}"`,
        },
      ],
    };
  }

  try {
    const {
      originalText,
      modifiedText,
      // Default true: matches VS Code editor's ignoreTrimWhitespace default so
      // whitespace-only differences are invisible to the user and not flagged here.
      ignoreTrimWhitespace = true,
      includeMetrics = true,
      verboseMetrics = false,
      // metricsOnly: skip the diff text entirely; handy for large files.
      metricsOnly = false,
    } = request.params.arguments ?? {};

    if (typeof originalText !== "string" || typeof modifiedText !== "string") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "originalText and modifiedText must be strings.",
          },
        ],
      };
    }

    const originalLines = originalText.split(/\r?\n/);
    const modifiedLines = modifiedText.split(/\r?\n/);

    const result = diffComputer.computeDiff(originalLines, modifiedLines, {
      ignoreTrimWhitespace: Boolean(ignoreTrimWhitespace),
      computeMoves: true,
      maxComputationTimeMs: 5000,
    });

    const { text, metrics } = formatDiff(
      originalLines,
      modifiedLines,
      result,
      Boolean(verboseMetrics)
    );

    const content = [];

    if (!metricsOnly) {
      content.push({ type: "text", text });
    }

    if (metricsOnly || includeMetrics) {
      content.push({
        type: "text",
        text: "```json\n" + JSON.stringify(metrics, null, 2) + "\n```",
      });
    }

    return { content };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VS Code Diff MCP Server running on stdio");
}

main().catch(console.error);
