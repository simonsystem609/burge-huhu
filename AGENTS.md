# Agent Safety Rules

## File Operations
- **NEVER delete files or directories** — this includes `rm`, `rm -rf`, `Remove-Item`, `del`, `rmdir`, etc.
- **Instead**: Move unwanted files to a `trash/` folder in the workspace root.
  - Create `trash/` if it doesn't exist.
  - Use `mv` (bash) or `Move-Item` (PowerShell) to move files there.
  - Preserve directory structure inside `trash/` (e.g., `trash/old-config.json`, `trash/legacy/src/`).
- **No recursive deletes** — even on folders. Move the entire folder to `trash/`.

## Git Operations
- Never force-push (`git push --force` / `--force-with-lease`) without explicit user confirmation.
- Never rewrite history (rebase, amend, reset --hard) on shared branches without asking.

## System Operations
- Never run commands that modify system state outside the workspace (registry, services, global npm packages, etc.).
- Never write files outside the workspace root.

## Network/Secrets
- Never commit secrets, keys, tokens, or `.env` files.
- Never make outbound network requests to unknown destinations.

## If Unsure
- Ask the user before any destructive or irreversible action.
- Prefer read-only exploration first.