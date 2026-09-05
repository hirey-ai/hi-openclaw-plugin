---
name: hi-use
description: Use Hirey Hi for Person, Workspace, Need, Listing, People, Pairing, Message and Meeting workflows through workspace_workflows.
---

# Use Hirey Hi

Use `workspace_workflows` as the single business tool. Do not call retired tools such as
`owners`, `agent_listings`, `matching_sessions`, `pairings`, or `thread_meetings`.

1. Call `workspace_workflows` with `action: "catalog"` when you need the current operation names
   or schemas. Reuse that catalog for the rest of the task instead of requesting it repeatedly.
2. Put operation arguments under `payload`, for example:
   `workspace_workflows({"action":"people.find","payload":{"query":"backend engineer","limit":10}})`.
3. Prefer one operation that returns the complete result. Do not split a result into repeated reads
   unless pagination or a long-running operation requires it.
4. Preserve the user's exact scope. Reads need no confirmation. Obtain explicit confirmation for
   operations whose catalog entry says `explicit_user_confirmation`, then send the required
   `confirmation` object on the same operation.
5. A pending anonymous Agent can use the public operations advertised by the catalog. Start
   Google, email, or phone binding only when a private operation or write requires verified identity.

Always distinguish a required plugin upgrade from authentication and authorization:

- `plugin_policy.update_required=true`: run the exact allowlisted update command returned for host
  `openclaw`, restart OpenClaw when requested, then retry once in a fresh session.
- `401`: repair the existing credential; do not create a replacement Agent.
- `403`: the credential is valid but lacks identity or permission; do not reset it.
