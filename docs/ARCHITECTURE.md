# Architecture

Code Intelligence is a BB server plugin. It registers native agent tools for
exact discovery, bounded exploration, structural context, and conservative
change checks. It has no frontend bundle, panel, or settings screen.

## Workspace and host routing

The current thread environment is the source of truth. The plugin resolves the
thread's project/environment context and reads workspace files through BB's
host-file APIs when that environment is remote. It must never silently read a
same-named path on the BB server.

An explicit server-local root is a deliberate escape hatch. Only that path
uses a local ripgrep process and Node filesystem reads. The response names the
engine used so callers can distinguish host-file snapshots from local scans.

## Native tool contract

| Tool | Responsibility |
| --- | --- |
| `instant_grep` | Exact literal or regex search with glob, context, count, and paging modes. |
| `codebase_query` | Bounded exploratory discovery with exact-hit evidence and ranked entry points. |
| `repository_context` | Project orientation and declared verification candidates. |
| `symbol_lookup` | Definitions, direct callers, and test references for known targets. |
| `code_graph_context` | Structural context, callers, tests, and declared graph limits. |
| `prechange_impact` | Impact evidence before an implementation edit. |
| `verify_change` | Scoped verification evidence after an edit. |

Native tool names are technical API identifiers. The product name is always
Code Intelligence.

## Persistent state

The plugin owns a SQLite database in its BB plugin data directory. It stores
index snapshots and feedback summaries. Storage migrations are append-only:
never edit or reorder an already shipped statement. A plugin-id rename is a
fresh-install boundary and does not silently merge previous local state.

## Analysis limits

The graph is static and partial by design. Dynamic dispatch, reflection,
generated code, runtime registration, and unparsed language constructs can
hide dependencies. Tool results report these limits; a missing edge is not
proof that no runtime dependency exists.
