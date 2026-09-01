#!/usr/bin/env bash
# One-command setup: deps, build, Playwright browser, MCP config snippet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Installing dependencies..."
npm install

echo "==> Building TypeScript..."
npm run build

echo "==> Installing Playwright Chromium (for search & apply)..."
npx playwright install chromium

echo ""
echo "✓ waas-mcp is ready at: $ROOT"
echo ""
echo "Add this to ~/.cursor/mcp.json (or Claude Desktop MCP config):"
echo ""
cat <<EOF
{
  "mcpServers": {
    "waas": {
      "command": "node",
      "args": ["$ROOT/dist/index.js"]
    }
  }
}
EOF
echo ""
echo "Then sign in once (opens a browser — use your YC / Work at a Startup account):"
echo "  cd \"$ROOT\" && npm run login"
echo ""
echo "Reload MCP in Cursor, then try: waas_search with role=eng and remote=true"
