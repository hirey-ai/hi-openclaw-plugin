---
name: hi-repair
description: Use Hirey Hi Product Signal and Repair Case workflows for a bounded bug report, repair, reviewable pull request, and reporter verification.
---

# Repair a Hirey Hi problem

Use only the Product Signal and Repair Case operations currently returned by
`workspace_workflows({"action":"catalog"})`.

1. Record or find the exact Product Signal without broadening its scope.
2. Gather evidence and identify the smallest reproducible failure.
3. Change only the authorized repository and behavior. Keep data migration, deployment, merge, and
   destructive cleanup outside scope unless the user separately authorizes them.
4. Run targeted tests, then the repository's relevant broader checks.
5. Produce a reviewable PR and attach its evidence to the repair case when the catalog provides the
   corresponding operation.
6. Mark verification complete only after the reporter or an equivalent production check confirms
   the repaired behavior.

Do not infer production success from a passing local test, merged PR, or successful deployment job.
