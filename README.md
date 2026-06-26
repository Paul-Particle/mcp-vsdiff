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
| `ignoreTrimWhitespace` | boolean | | Ignore leading/trailing whitespace differences (default: `false`) |

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
