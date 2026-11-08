# dsh-secrets

DeepSeek Harness plugin: the agent requests credentials through a secure form; values go to a 0600 dotenv file and never reach the model.

- `request_secret` tool + `secrets` skill
- Form rendered in the tool row; values travel only over authenticated `/api/dsh-secrets.*` routes (not the session log)
- L1 guard: denies `read`/`edit`/`write`/`grep`/shell reads of managed files
- L2 redaction: every tool result, incl. base64 / URL / JSON / hex variants → `[REDACTED:NAME]`; fails closed
- L3 approval: shell commands combining a managed variable with `curl`/`echo`/`printenv`… ask the user
- Settings → Secrets: list, stop managing, delete from file

Known limits: an agent writing its own program to transform and send a value can evade L1–L3; use in trusted workspaces. Not available in `run_code` (PTC) mode or to subagents. Values shorter than 6 characters cannot be redacted.

Design: `docs/api-findings.md`. Tests: `npm test`.
