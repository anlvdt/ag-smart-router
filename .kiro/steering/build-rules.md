---
inclusion: auto
---

# Build Rules — Grav Extension

## CRITICAL: VSIX Packaging

**NEVER use `--no-dependencies` when building the VSIX.**

This extension depends on the `ws` (WebSocket) npm module for CDP communication.
Using `--no-dependencies` excludes `node_modules/ws/` from the package, causing
the extension to silently crash on activation (`Cannot find module 'ws'`).

### Correct build command:
```bash
npx vsce package
```

### WRONG (will break the extension):
```bash
npx vsce package --no-dependencies   # ❌ NEVER USE THIS
```

## Pre-build Checklist

Before every build:
1. Run `node test/run-all.js` — all tests must pass
2. Run `node --check src/extension.js src/cdp.js src/cdp-observer.js` — syntax OK
3. Build with `npx vsce package` (NO flags)
4. Verify output includes `node_modules/ws/` in the file list
5. Verify file count is 40+ (not 24) — if only ~24 files, ws is missing

## Version Bumping

When adding new features, bump the patch version in `package.json` to avoid
IDE caching issues with same-version reinstalls.
