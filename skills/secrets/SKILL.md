---
name: secrets
description: "Use when a task needs an API key, password, token, or connection string: request it securely with request_secret instead of asking the user to paste it."
---

# Request credentials securely

Call the `request_secret` tool whenever the work needs a credential. Never ask the user to paste a secret into chat. If the user already pasted one, tell them it is now in the conversation history, suggest rotating it, and use `request_secret` for the new value.

1. Find the variable names first: read `.env.example`, `README`, config files, or code that reads `process.env` / `os.environ`. Do not read real env files.
2. Request every known variable in ONE call:

   ```json
   {
     "names": ["OPENAI_API_KEY", "DATABASE_URL"],
     "purpose": "Run the app locally against OpenAI and the dev database",
     "descriptions": { "OPENAI_API_KEY": "Server-side OpenAI key", "DATABASE_URL": "Postgres connection string for dev" },
     "env_file": ".env.local"
   }
   ```

   `env_file` must be inside the working directory. Prefer the file the project already loads (`.env.local`, `.env`).
3. The call blocks until the user saves or cancels. On `provided`, trust the returned path, names, and counts. Do not `cat`, `grep`, `read`, `source`, copy, or otherwise verify the file — dsh-secrets denies those calls. Make the program load the file itself (dotenv, `--env-file`, framework defaults).
4. On `cancelled`, do not ask again for the same names in this turn. Continue without them or ask the user how to proceed.

## What you will see

- Tool output that contains a managed value shows `[REDACTED:NAME]` instead. That is expected; do not try to recover the value.
- A shell command that combines a managed variable with `curl`, `echo`, `printenv`, or similar needs the user's approval. Only run such commands when the task truly requires sending the credential to its intended service.
- Never try to bypass these policies (encoding, splitting, writing helper scripts that print values). If a policy blocks needed work, explain what you need and let the user decide.
