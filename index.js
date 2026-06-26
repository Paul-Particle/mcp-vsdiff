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
 * Builds a unified-diff-style string from the vscode-diff result.
 * Each hunk shows a few lines of context around each change.
 * Moved blocks are annotated with a comment header.
 */
function formatDiff(originalLines, modifiedLines, result) {
  const { changes, moves, hitTimeout } = result;

  // Build a set of original line numbers that are part of a "move source",
  // keyed by a move index so we can annotate them.
  const moveSourceMap = new Map(); // origLineIdx (0-based) -> moveIndex
  const moveDestMap = new Map();   // modLineIdx  (0-based) -> moveIndex
  moves.forEach((move, i) => {
    const { original, modified } = move.lineRangeMapping;
    for (let l = original.startLineNumber; l < original.endLineNumberExclusive; l++) {
      moveSourceMap.set(l - 1, i);
    }
    for (let l = modified.startLineNumber; l < modified.endLineNumberExclusive; l++) {
      moveDestMap.set(l - 1, i);
    }
  });

  if (changes.length === 0 && moves.length === 0) {
    return hitTimeout
      ? "⚠️  Diff timed out — files may be identical or too large to compare fully."
      : "Files are identical.";
  }

  const lines = [];

  if (hitTimeout) {
    lines.push("⚠️  Warning: diff computation timed out; result may be approximate.\n");
  }

  // Collect hunk regions: [origStart, origEnd, modStart, modEnd] (inclusive, 0-based)
  const hunks = changes.map((change) => {
    const origStart = change.original.startLineNumber - 1;
    const origEnd = change.original.endLineNumberExclusive - 1;   // exclusive
    const modStart = change.modified.startLineNumber - 1;
    const modEnd = change.modified.endLineNumberExclusive - 1;    // exclusive
    return { origStart, origEnd, modStart, modEnd };
  });

  // Expand hunks with context and merge overlapping ones
  const merged = [];
  for (const h of hunks) {
    const ctxOrigStart = Math.max(0, h.origStart - CONTEXT_LINES);
    const ctxOrigEnd = Math.min(originalLines.length, h.origEnd + CONTEXT_LINES);
    const ctxModStart = Math.max(0, h.modStart - CONTEXT_LINES);
    const ctxModEnd = Math.min(modifiedLines.length, h.modEnd + CONTEXT_LINES);

    if (
      merged.length > 0 &&
      ctxOrigStart <= merged[merged.length - 1].ctxOrigEnd
    ) {
      // Merge with previous hunk
      const prev = merged[merged.length - 1];
      prev.ctxOrigEnd = ctxOrigEnd;
      prev.ctxModEnd = ctxModEnd;
      prev.inner.push(h);
    } else {
      merged.push({ ctxOrigStart, ctxOrigEnd, ctxModStart, ctxModEnd, inner: [h] });
    }
  }

  for (const region of merged) {
    // Hunk header (unified diff style)
    const origLen = region.ctxOrigEnd - region.ctxOrigStart;
    const modLen = region.ctxModEnd - region.ctxModStart;
    lines.push(
      `@@ -${region.ctxOrigStart + 1},${origLen} +${region.ctxModStart + 1},${modLen} @@`
    );

    // Walk original context + deletions, then insertions
    let origCursor = region.ctxOrigStart;
    let modCursor = region.ctxModStart;

    for (const h of region.inner) {
      // Context before this change
      while (origCursor < h.origStart) {
        lines.push(` ${originalLines[origCursor]}`);
        origCursor++;
        modCursor++;
      }
      // Deleted lines
      for (let i = h.origStart; i < h.origEnd; i++) {
        const moveIdx = moveSourceMap.get(i);
        const annotation = moveIdx !== undefined ? ` {moved to block #${moveIdx + 1}}` : "";
        lines.push(`-${originalLines[i]}${annotation}`);
        origCursor++;
      }
      // Inserted lines
      for (let i = h.modStart; i < h.modEnd; i++) {
        const moveIdx = moveDestMap.get(i);
        const annotation = moveIdx !== undefined ? ` {moved from block #${moveIdx + 1}}` : "";
        lines.push(`+${modifiedLines[i]}${annotation}`);
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
  }

  // Summary footer
  const totalDeletions = changes.reduce((s, c) => s + (c.original.endLineNumberExclusive - c.original.startLineNumber), 0);
  const totalInsertions = changes.reduce((s, c) => s + (c.modified.endLineNumberExclusive - c.modified.startLineNumber), 0);
  lines.push(
    `--- Summary: ${changes.length} changed region(s), ` +
    `+${totalInsertions} insertion(s), -${totalDeletions} deletion(s)` +
    (moves.length > 0 ? `, ${moves.length} moved block(s)` : "")
  );

  return lines.join("\n");
}

// ─── MCP Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "compute_diff",
        description:
          "Computes a highly accurate diff with move detection using the VS Code advanced diff algorithm. " +
          "Returns a human-readable unified diff string with context lines, move annotations, and a summary.",
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
              description:
                "If true, leading/trailing whitespace differences on each line are ignored. Defaults to false.",
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

  const { originalText, modifiedText, ignoreTrimWhitespace = false } =
    request.params.arguments;

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

  const text = formatDiff(originalLines, modifiedLines, result);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
});

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VS Code Diff MCP Server running on stdio");
}

main().catch(console.error);
