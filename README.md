# mcp-vsdiff

An MCP server that exposes VS Code's advanced diff algorithm as a tool.

## What it does

Provides a single MCP tool, `compute_diff`, that computes a highly accurate unified diff between two strings using the same algorithm VS Code uses internally. Features include:

- **Move detection** — identifies blocks of code that were moved, not just deleted/inserted
- **Unified diff output** — standard `@@`-style hunks with 3 lines of context
- **Move annotations** — deleted lines show `{moved to block #N}` and inserted lines show `{moved from block #N}`
- **Summary footer** — total insertions, deletions, and moved blocks at the end

## Usage

### Install

```bash
npm install
```

### Run

```bash
npm start
```

The server communicates over stdio and is compatible with any MCP client.

### Tool: `compute_diff`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `originalText` | string | ✅ | The original text |
| `modifiedText` | string | ✅ | The modified text |
| `ignoreTrimWhitespace` | boolean | | Ignore leading/trailing whitespace differences per line (default: `true`) |
| `includeMetrics` | boolean | | Append a JSON metrics block to the response (default: `true`) |
| `verboseMetrics` | boolean | | Add per-hunk breakdown to the metrics block (default: `false`) |
| `metricsOnly` | boolean | | Return only the metrics block, no diff text — useful for large files (default: `false`) |
| `maxDiffLines` | number | | Truncate the diff text if it exceeds this number of lines (default: `500`). Set to `0` to disable. |
| `skipDiffLines` | number | | Number of diff text lines to skip from the beginning. Combine with `maxDiffLines` to paginate through very large diffs (default: `0`). |

### Metrics fields

| Field | Description |
|---|---|
| `hunkCount` | Number of separate change regions (lower = easier to review) |
| `changedLines` | Real insertions + real deletions, excluding moved lines |
| `realInsertions` | Lines added, excluding moved lines |
| `realDeletions` | Lines removed, excluding moved lines |
| `movedBlocks` | Number of detected move operations |
| `movedLines` | Total lines involved in moves |
| `hitTimeout` | Whether the diff computation hit the 5 s time limit |

> **`ignoreTrimWhitespace` gotcha:** with the default `true`, a line whose only change is indentation (e.g. code moved into a deeper `if` block) will appear as **unchanged context**, making the diff look cleaner than a plain `git diff` would. Set to `false` if indentation changes need to be visible.

### MCP config example

```json
{
  "mcpServers": {
    "vsdiff": {
      "command": "node",
      "args": ["/path/to/mcp-diff/index.js"]
    }
  }
}
```

## Dependencies

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [`vscode-diff`](https://www.npmjs.com/package/vscode-diff) — VS Code's diff algorithm, extracted as a standalone package
