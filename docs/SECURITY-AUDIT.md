# Security audit: v0.9.10 release preparation

Date: 2026-11-04. Scope: every file `git add -A` would stage, plus
`dist/win-unpacked/resources/app.asar` and the rest of `dist/win-unpacked/resources/`.

## Patterns checked

`hf_[A-Za-z0-9]{20,}`, `sk-[A-Za-z0-9_-]{20,}`, `sk-ant-[A-Za-z0-9_-]{20,}`, `AIza[0-9A-Za-z_-]{30,}`,
`ghp_[A-Za-z0-9]{20,}`, `github_pat_`, `xox[baprs]-`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY`,
`eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.`, `(api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"']{12,}["']`,
plus absolute user paths (`C:\Users\<name>`, `/Users/<name>`), email addresses and phone numbers.

## Findings

1. `tests/e2e/full.spec.ts:906` uses the deliberate fake token `hf_notarealtokenbutlongenough` to exercise the
   Hugging Face token field. Matched by shape only; it is not a credential.
2. `src/main/services/settings.ts:28` is the secure-storage key name `@huggingface`; `src/shared/ipc.ts:35-36`
   match only because IPC channel names contain the word "token".
3. `package-lock.json:3351` quotes an upstream npm maintainer address inside a dependency deprecation message.
   Registry metadata, not project data.
4. Absolute developer paths (a `C:\Users\` home directory) appeared in `scripts/check-cancel-cleanup.mjs`,
   `scripts/check-ollama-models.mjs` and `tests/unit/paths.test.ts`. They were replaced with the
   `C:\Users\demo` placeholder before the release commit, so the public tree carries no developer account name.
5. `C:\Users\demo` and `C:\Users\me` in the e2e screenshots and `tests/unit/languages.test.ts` are placeholders.

No API key, bearer token, private key, password or `.env` file exists in the tracked tree; `.env` and `.env.*`
are gitignored.

## Shipped bundle

`app.asar` (830 entries) contains only `out/` (compiled main, preload, renderer), `package.json` and runtime
`node_modules`. No settings file, secrets file or `.env` is packaged; `resources/` holds only the bundled
llama.cpp binaries, licences and `backend.txt`. A rescan of the extracted asar (510 text files) returned two
JWT-shaped hits in `node_modules/zod/src/v4/mini/tests/string.test.ts`: the public jwt.io example token used by
zod's own unit tests. No credentials and no user paths ship in the installers.

## Re-running the scan

```powershell
Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\(node_modules|out|dist|\.git)\\' } | Select-String -Pattern 'hf_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|C:\\Users\\'
```

For the installed build, extract `dist/win-unpacked/resources/app.asar` with
`node -e "require('@electron/asar').extractAll('dist/win-unpacked/resources/app.asar','%TEMP%/asar-audit')"`, then
run the same pipeline against the extracted folder. No credentials and no user paths ship in the installers.
