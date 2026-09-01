# WaaS MCP

MCP server for [Work at a Startup](https://www.workatastartup.com) — YC's job board (**WaaS**). Search jobs, read listings, inspect what each application needs, and submit with dry-run safety by default.

> `waas.com` is a parked domain. This targets **workatastartup.com**.

## Quick start

**Requirements:** Node.js 20+, a [Work at a Startup](https://www.workatastartup.com) / YC account (for applying).

```bash
git clone https://github.com/Thespaceblade/waas-mcp.git
cd waas-mcp
./scripts/install.sh
```

`install.sh` installs dependencies, builds, downloads the Playwright browser, and prints an MCP config snippet for your machine.

**Sign in once** (opens a browser window):

```bash
npm run login
```

Reload MCP in Cursor (or restart Claude Desktop), then ask your assistant:

> Search WaaS for remote engineering jobs and inspect one at random.

## Cursor / Claude MCP config

Merge into `~/.cursor/mcp.json` (or Claude Desktop config). Use the **absolute path** where you cloned the repo:

```json
{
  "mcpServers": {
    "waas": {
      "command": "node",
      "args": ["/path/to/waas-mcp/dist/index.js"]
    }
  }
}
```

See [`mcp.json.example`](mcp.json.example). Session is stored at `~/.waas-mcp/storage-state.json` after `npm run login`.

### Claude Desktop (.mcpb)

One-click bundle (build from a clone):

```bash
npm run pack:mcpb
```

Install `waas-mcp.mcpb` via Claude Desktop → Settings → Extensions. Then run `npm run login` from the extension folder once (see Claude's extension install path).

## What it does

| Step | Tool |
|------|------|
| Set filters | `waas_search` — role, remote, visa, keywords, etc. |
| Read job | `waas_get_job` |
| Read company | `waas_get_company` |
| Inspect apply form | `waas_inspect_application` — `applicationType`, `fields[]`, external links |
| Submit | `waas_submit_application` — answer map, **`dry_run=true` default** |
| Track | `waas_list_applied` |
| Check login | `waas_auth_status` |

### Application types (`waas_inspect_application`)

| Type | Meaning |
|------|---------|
| `custom_questions` | Resume URL, multiple choice, text questions |
| `in_app_message` | Default "message the founder" textarea |
| `external` | Greenhouse, email, etc. — **won't auto-submit** |
| `already_applied` | Skip |
| `needs_login` | Run `npm run login` |

## Example workflow

```
waas_search { "role": "eng", "remote": true, "limit": 10 }
waas_inspect_application { "job_id": "99221" }
waas_submit_application {
  "job_id": "99221",
  "answers": { "question_1981": "Your drafted answer..." },
  "dry_run": true
}
```

Only set `dry_run: false` after you explicitly approve.

## Manual install

If you prefer not to use `install.sh`:

```bash
npm install          # runs build + Playwright chromium via lifecycle scripts
npm run login
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Run MCP server (stdio) |
| `npm run login` | One-time YC / WaaS sign-in |
| `npm test` | Unit tests |
| `npm run test:live` | Live smoke test against workatastartup.com |
| `npm run pack:mcpb` | Build Claude Desktop `.mcpb` bundle |

## Credits

Parsing adapted from [workatastartup-mcp](https://github.com/moutasem-isentemiz/workatastartup-mcp) (MIT).

## License

MIT — see [LICENSE](LICENSE).
