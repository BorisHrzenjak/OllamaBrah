# Project Notes

1. **This is an Electron-based desktop app** — not a browser extension or web app. No need to work around browser-reserved shortcuts or browser-specific constraints.

2. **The app name is OllamaBrah** — not OllamaBro. This applies everywhere it appears: the UI header, the window title, and any user-facing text.

3. **Bump the version in `package.json` after adding a new feature or significant change** — no need to bump after every minor tweak or cosmetic fix. Current version lives at `"version"` in `package.json`.

4. **Update `README.md` when adding a new feature or significant change** — add the feature under the relevant section in the Features list, and update the "What's New" block at the top to reflect the new version and what changed. Keep the What's New block to the current version only (replace the previous entry, don't stack multiple versions).

5. **When editing GitHub Actions YAML with PowerShell `run: |` blocks, avoid PowerShell here-strings (`@" ... "@`) inside the workflow** — they can break YAML parsing in `.github/workflows/*.yml`. Build multi-line strings with arrays plus `-join "`n"` or regular string concatenation instead.

6. **Every new GitHub release must include the Windows executable as a release asset** — a release is not complete unless the built `.exe` installer is attached on the GitHub release page, not just the tag or source archives.
