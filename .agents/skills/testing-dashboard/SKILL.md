# Testing Grav Dashboard

## Overview
Grav is a VS Code extension whose dashboard is a WebView panel rendered from `media/dashboard.html`. Since it runs inside VS Code's WebView API, full integration testing requires VS Code + the Antigravity IDE. However, most visual and DOM-level testing can be done in a browser.

## Browser Preview Testing

### Creating a Preview HTML
The dashboard HTML uses `{{TEMPLATE}}` variables that VS Code substitutes at runtime. To render in a browser:

1. Copy `media/dashboard.html` and substitute all template variables:
   - `{{LANG}}` → `en` (or `vi`, `zh`)
   - `{{VERSION}}` → `3.6.1`
   - `{{TOTAL}}` → any number
   - `{{ENABLED_CHK}}` → `checked` or empty
   - `{{SCROLL_CHK}}` → `checked` or empty
   - `{{DRYRUN_CHK}}` → `checked` or empty
   - `{{APPROVE_MS}}`, `{{SCROLL_MS}}`, `{{PAUSE_MS}}` → millisecond values
   - `{{LEARN_EPOCH}}`, `{{LEARN_TRACKING}}`, `{{LEARN_COUNT}}` → numbers
   - `{{WHITE_COUNT}}`, `{{BLACK_COUNT}}` → numbers
   - `{{WIKI_PAGES}}`, `{{WIKI_CONCEPTS}}` → numbers
   - `{{PATTERNS_JSON}}` → JSON array of pattern strings
   - `{{DISABLED_JSON}}` → JSON array of disabled pattern strings
   - `{{STATS_JSON}}` → JSON object of pattern→count
   - `{{ALL_PATTERNS_JSON}}` → JSON array of all patterns
   - `{{PATTERN_GROUPS_JSON}}` → JSON object of pattern groups
   - `{{CONCEPTS_JSON}}` → `{}`
   - `{{WIKI_LOG_JSON}}` → JSON array of log entries
   - `{{PROJECT_PATTERNS_JSON}}` → `[]`
   - `{{DRYRUN_VAL}}` → `false`

2. Replace the vscode API call:
   ```js
   // Replace: const vscode=acquireVsCodeApi();
   // With:
   const vscode={postMessage:function(m){console.log('[vscode.postMessage]',JSON.stringify(m))}};
   ```

3. Optionally add a test bar for i18n switching:
   ```html
   <button onclick="_lang='vi';applyI18n()">VI</button>
   <button onclick="_lang='zh';applyI18n()">ZH</button>
   <button onclick="_lang='en';applyI18n()">EN</button>
   ```

### What CAN Be Tested in Browser
- Color contrast (computed styles via `getComputedStyle`)
- i18n switching (all 3 languages: en, vi, zh)
- Focus-visible styles (Tab through elements)
- Toggle input accessibility (check computed `display`, `opacity`)
- Auto-save slider behavior (verify `postMessage` fires on slider `change` event)
- Toast ARIA attributes (`role`, `aria-live`)
- Reduced motion media query (CSS rule existence)
- CSS layout and responsive behavior

### What CANNOT Be Tested in Browser
- `vscode.postMessage()` round-trip communication
- VS Code settings persistence (`grav.*` config)
- Keyboard shortcuts (registered in `package.json`, handled by VS Code)
- Command palette commands
- Status bar integration
- Terminal monitoring (`terminal.js`)

## Key Files
- `media/dashboard.html` — Main dashboard WebView (HTML + CSS + JS in single file)
- `src/dashboard.js` — Extension-side dashboard manager, builds HTML from template
- `src/extension.js` — Main extension entry point
- `package.json` — Extension manifest with keybindings, commands, settings

## i18n System
The dashboard uses a `data-i18n` attribute system with inline translations:
- `_i18n` object contains `en`, `vi`, `zh` translation maps
- `applyI18n()` function applies translations based on `_lang` variable
- Language is set via `grav.language` VS Code setting (default: `vi`)

## No Devin Secrets Needed
This extension runs locally and does not require external API keys or credentials for testing.
