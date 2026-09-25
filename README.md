# ferc-eqr

Who sells wholesale power to whom: FERC Electric Quarterly Report (EQR)
filers, and the contracts between sellers and their counterparties.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

Not the same thing as `ferc-elibrary`: that pack is FERC's docket/document
search (filings, orders, opinions). This pack is the underlying filer and
contract data — a different question entirely ("who sells to whom" vs. "what
did FERC file").

## Tools

| Tool | Answers |
|---|---|
| `eqr_seller_lookup` | Resolve a company name or FERC company id (e.g. "C000740") to its EQR filer record(s) — per-quarter filings and whether the filer reported transactions to an index price publisher. Company-level identity only, no filer contact details. |
| `eqr_contracts_search` | Search contracts by seller, counterparty and/or product, with a quarter range. Returns contract-level rate-period line items — quantity, rate, delivery/receipt points, term dates. |
| `eqr_counterparty_sellers` | "Who sells power to X" — sellers aggregated for a counterparty name match, with contract counts and the quarter range they appear in. |
| `eqr_coverage` | Row counts per table, the quarter range currently covered, and when it was last refreshed. Call this before treating an empty result as a negative answer. |

## Auth

None. No key, no account.

## No personal data

The upstream source also carries filer CONTACT fields per company — a named
individual's name, title, address, phone and email. **None of that is
loaded or returned by any tool.** Only company-level identity
(`company_id_ferc`, `filer_unique_id`, `company_name`) is kept.

## Coverage is not automatically "everything since 2013"

The upstream data spans 2013q3 through the present, but this pack's coverage
is loaded incrementally rather than all at once. **Call `eqr_coverage` for
the quarter range actually covered before treating an empty result as "no
such contract"** — a result outside the covered range is a coverage gap, not
a negative answer. Every tool's response says this too.

## Data source, licence, attribution

FERC itself publishes Electric Quarterly Reports only as quarterly nested ZIP
files, with no query interface of its own. [Catalyst Cooperative's PUDL
project](https://catalyst.coop/pudl/) — a widely-used open energy-data
project — normalizes EQR into structured per-quarter tables and republishes
them publicly.

**Licence: "Copyright 2016-2026, Catalyst Cooperative, CC-BY-4.0"**
(<https://docs.catalyst.coop/pudl/en/latest/LICENSE.html>) — explicit on the
DATA (their processing *code* carries a separate MIT licence, which is a
different thing and does not govern the data). CC-BY-4.0 permits
redistribution with attribution. **Every tool response carries an
`attribution` field; do not remove it if you touch this pack.**

## Refreshing

```bash
node scripts/ingest-ferc-eqr.mjs --since <yyyyqN>
```

Re-runnable and safe: rows upsert on a content hash of every loaded column,
so loading an already-covered quarter again is a no-op rather than a
duplicate. `node scripts/ingest-ferc-eqr.mjs --dry-run [--since <q> | --all]`
parses without writing anything, useful for checking a new quarter's row
counts before committing to a load. `listQuarters()` discovers what's
published live each run, so a newly published quarter needs no code change —
just a wider `--since`.

## Phase 1 vs Phase 2

**Phase 1 (this pack): filer identity, index-price-publisher reporting, and
contract terms** — one row per contract RATE-PERIOD line item, not one row
per contract (a single contract can carry several rows for different rate
periods over its life). A quantity or rate returned here comes from the
CONTRACT's stated terms, not from a settled trade.

**Phase 2 (not built): the actual settled trade-level price/volume data** —
what a contract's *terms* say vs. what was *actually transacted*. By far the
most valuable data for a "what did seller X actually sell at what price"
question, and by a wide margin the hardest: the upstream source for it is
roughly two orders of magnitude larger than everything Phase 1 covers, and a
single recent quarter alone is larger than this pack's entire current
coverage. It needs a different loading strategy than Phase 1's — most likely
a narrower rolling window rather than full history, or a different storage
shape entirely. Not filed as a task; scope it separately once real demand for
Phase 1 is measured (does anyone actually call `eqr_contracts_search` /
`eqr_counterparty_sellers`), because its infrastructure cost is substantial
enough to want that evidence first.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ferc-eqr": {
      "url": "https://gateway.pipeworx.io/ferc-eqr/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ferc-eqr/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/eqr_seller_lookup \
  -H 'Content-Type: application/json' \
  -d '{"query":"NextEra"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/eqr_seller_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ferc-eqr": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ferc-eqr"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ferc-eqr
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ferc Eqr data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
