// ═══════════════════════════════════════════════════════════════
//  Grav — Constants & Configuration
// ═══════════════════════════════════════════════════════════════
'use strict';

const TAG = Object.freeze({
    open: '<!-- GRAV-RUNTIME-START -->',
    close: '<!-- GRAV-RUNTIME-END -->',
});

const LEGACY_TAGS = Object.freeze([
    ['<!-- AG-AUTOPILOT-START -->', '<!-- AG-AUTOPILOT-END -->'],
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->', '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->', '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->', '<!-- AG-TOOLKIT-END -->'],
]);

const LEGACY_SCRIPTS = Object.freeze(['ag-auto-script.js', 'ag-modelswitch-client.js']);
const RUNTIME_FILE = 'grav-runtime.js';
const CONFIG_FILE = 'grav-config.json';
const PORT_START = 48787;
const PORT_END = 48850;

const DEFAULT_PATTERNS = Object.freeze([
    // ── Antigravity Agent Panel — Button Labels ──
    // Source: YazanBaker priority matching + cotamatcotam iframe scan + Antigravity UI decompile
    //
    // Priority order (higher = matched first when multiple buttons visible):
    //   Run > Accept > Always Allow > Allow > Proceed
    //
    // === SAFE: File edits — accept code changes, revertible ===
    'Accept', 'Accept All', 'Accept all',
    // === SAFE: Agent flow — continue/retry execution ===
    'Retry', 'Proceed',
    // === CAUTION: Per-request permissions (Safety Guard protects Run) ===
    'Run Task', 'Run',
    // === Antigravity-specific: Agent Manager / Cortex step buttons ===
    'Approve', 'Expand', 'Allow in Workspace', 'Allow', 'Allow Once', 'Always Allow',
]);

const PRESET_PATTERNS = Object.freeze({
    '1.19.6': [
        'Accept all', 'Accept All', 'Accept', 'Retry', 'Proceed', 'Run', 'Approve', 'Expand', 'Allow in Workspace',
    ],
    '1.23.2': [
        'Accept All', 'Accept', 'Retry', 'Run', 'Approve', 'Allow This Workspace', 'Allow in Workspace',
    ],
    '1.24+': [
        'Accept', 'Accept All', 'Accept all', 'ACCEPT ALL', 'Retry', 'Run Task', 'Run', 'Approve', 'Allow in Workspace', 'Allow', 'Allow Once', 'Always Allow',
    ],
});

// Patterns disabled by default — irreversible, billing, or permanent permissions
const RISKY_PATTERNS = Object.freeze([
    'Continue',                         // can loop when AG needs user input
    'Resume Conversation',              // can loop when AG needs user input
    'Always Allow',                     // permanent — never asks again
    'Allow in this Workspace',          // permanent for workspace
    'Allow for this Workspace',         // Cursor variant
    'Allow This Conversation',          // session-scoped
    'Allow this Conversation',          // lowercase variant
    'Allow Once',                       // one-time permission
    'Allow once',                       // lowercase variant
    'Always Allow Without Review',      // permanent + no review
    'Allow and Skip Reviewing Result',  // skips tool output review
    'Trust',                            // trusts workspace — security risk
    'OK',                               // too generic
    'Confirm',                          // too generic
    'Enable Overages',                  // BILLING: auto-agrees to pay AI credits
]);

// UI Display Names — maps variants to a single display name
// Key = display name shown in UI, Value = array of all variants (including display name)
const PATTERN_GROUPS = Object.freeze({
    'Accept all': ['Accept all', 'Accept All', 'ACCEPT ALL'],
    'Allow This Conversation': ['Allow This Conversation', 'Allow this Conversation'],
    'Allow Once': ['Allow Once', 'Allow once'],
});

// Reverse mapping: variant → display name
const PATTERN_DISPLAY = Object.freeze(
    Object.entries(PATTERN_GROUPS).reduce((acc, [display, variants]) => {
        variants.forEach(v => { acc[v] = display; });
        return acc;
    }, {})
);

const SAFE_TERMINAL_CMDS = Object.freeze([
    'ls', 'dir', 'cat', 'echo', 'pwd', 'cd', 'mkdir', 'cp', 'mv', 'touch',
    'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'node', 'python', 'python3', 'pip', 'pip3',
    'git', 'which', 'where', 'type', 'file', 'stat', 'readlink',
    'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'grep', 'find', 'xargs',
    'sed', 'awk', 'tr', 'cut', 'tee', 'date', 'whoami', 'id',
    'env', 'printenv', 'uname', 'hostname', 'df', 'du', 'free',
    // NOTE: kill/killall/pkill removed from safe list — potentially destructive
    // They are still learnable via the adaptive engine
    'ps', 'top', 'htop', 'lsof', 'netstat', 'ss', 'ping', 'dig', 'nslookup', 'host',
    'cargo', 'rustc', 'go', 'java', 'javac', 'mvn', 'gradle',
    'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'ansible',
    'make', 'cmake', 'gcc', 'g++', 'clang',
    'jq', 'yq', 'base64', 'md5', 'sha256sum', 'openssl',
    'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz',
    'curl', 'wget', 'http', 'httpie',
    'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'snap',
    'sqlite3', 'psql', 'mysql', 'mongosh', 'redis-cli',
    'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'playwright',
    'sass', 'postcss', 'webpack', 'vite', 'esbuild', 'rollup', 'turbo', 'vsce',
    'uvx', 'uv', 'pipx', 'poetry', 'pdm', 'ruff', 'black', 'mypy',
    'code', 'antigravity',
]);

const DEFAULT_BLACKLIST = Object.freeze([
    // Filesystem destruction (multi-word — specific enough)
    'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -rf .', 'rm -rf .git',
    'rmdir /s /q c:\\', 'rmdir /s /q d:\\', 'rd /s /q c:\\',
    'del /f /s /q c:\\', 'del /f /s /q d:\\',
    'remove-item -recurse -force c:\\', 'remove-item -recurse -force d:\\',
    // Disk/partition destruction
    'dd if=/dev/zero', 'dd if=/dev/urandom',
    // Fork bomb / system-wide kill
    ':(){:|:&};:',
    'kill -9 -1',
    // Permission escalation on root
    'chmod -R 777 /', 'chown -r root /',
    // Remote code execution (piped to shell)
    'wget|sh', 'curl|sh', 'curl|bash', 'wget|bash',
    '| bash', '| sh', '| zsh', '| pwsh',
    'invoke-expression', 'iex (', 'set-executionpolicy bypass',
    '> /dev/sda',
    // Git destructive
    'git push --force', 'git push -f',
    'git clean -fdx',
    // Database destructive
    'drop database', 'drop table', 'truncate table',
    'db.dropdatabase()',
    // Docker destructive
    'docker system prune -a --volumes',
    // Windows registry
    'reg delete hk',
    'vssadmin delete shadows',
    // Privileged escalation to another user (interactive shell — deadlocks agent)
    // NOTE: 'sudo ' removed — Antigravity agent legitimately runs sudo commands
    'su -', 'su root',
    // Destructive Git resets
    'git reset --hard',
]);

const LEARN = Object.freeze({
    ALPHA: 0.15,
    MOMENTUM: 0.9,
    GAMMA: 0.97,
    PROMOTE_THRESH: 0.75,
    DEMOTE_THRESH: -0.50,
    OBSERVE_MIN: 5,
    MAX_ENTRIES: 1000,
    MAX_HISTORY: 50,
    CONTEXT_WEIGHT: 0.1,
    GENERALIZE_MIN: 3,
    BATCH_SIZE: 10,
});

// ═══════════════════════════════════════════════════════════════
//  Shared Observer Constants (used by both runtime.js and cdp.js)
// ═══════════════════════════════════════════════════════════════

// HIGH_CONF: Patterns auto-clicked WITHOUT requiring reject-sibling validation
// These only appear in agent approval contexts
const HIGH_CONF = Object.freeze({
    'Accept All': 1, 'Accept all': 1, 'ACCEPT ALL': 1, 'Accept': 1,
    'Approve': 1, 'Approved': 1, 'Expand': 1,
    'Run': 1, 'Run Task': 1, 'Execute': 1,
    'Retry': 1, 'Proceed': 1, 'Go': 1,
    'Allow': 1, 'Allow Once': 1, 'Always Allow': 1, 'Allow in Workspace': 1,
});

// Cooldown durations (ms) — time to wait before clicking same pattern again
const COOLDOWN = Object.freeze({
    'Run': 5000,                    // 5s - terminal commands need time
    'Accept': 1500,                 // 1.5s - file changes
    'Accept all': 1500,
    'Accept All': 1500,
    'Approve': 2000,                // 2s
    'Allow Once': 3000,             // 3s - permission dialogs
    'Allow This Conversation': 3000,
    'Continue': 15000,              // 15s - prevent rapid loop when AG needs input
    'Resume Conversation': 15000,
    DEFAULT: 1000,                  // 1s default
    GLOBAL: 500,                    // 500ms minimum between ANY clicks
});

// Reject button labels — if found nearby, confirms this is an approval dialog
const REJECT_WORDS = Object.freeze([
    'Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Always Deny',
    'Decline', 'Reject all', 'Reject All', 'No', 'Disallow',
    'Stop', 'Abort', 'Skip',
]);

// Editor-specific patterns to skip (merge conflict buttons, diff review, etc.)
const EDITOR_SKIP = Object.freeze([
    'Accept Changes', 'Accept Incoming', 'Accept Current',
    'Accept Both', 'Accept Combination', 'Accept Line',
    'Accept Word', 'Accept Suggestion',
    'Review Changes', 'Review All', 'View Changes', 'View Diff',
]);

// Notification keywords to suppress
// NOTE: Do NOT add 'requires input' / 'waiting for user input' here —
// those are Antigravity tool approval prompts that Grav needs to click.
const SUPPRESS_KEYWORDS = Object.freeze([
    'corrupt', 'reinstall',
]);

// Numeric limits — replaces magic numbers
const LIMITS = Object.freeze({
    BUTTON_LABEL_MIN: 2,            // min chars for valid button label
    BUTTON_LABEL_MAX: 60,           // max chars for valid button label
    CLICK_DEDUP_TIMEOUT: 30000,     // 30s - cleanup old click tracking entries
    SCAN_DEBUG_INTERVAL: 20,        // emit debug every N scans
    EXPAND_RECLICK_DELAY: 5000,     // 5s - allow re-expand after this delay
    SHADOW_ROOT_MAX: 200,           // max shadow roots to track
    DEBUG_LOG_MAX: 20,              // max debug log entries
    POLL_STANDARD_MS: 1500,         // standard polling interval
    POLL_SLOW_MS: 5000,             // slow safety net polling
    SCROLL_BOTTOM_THRESHOLD: 150,   // pixels from bottom = "at bottom"
});

// Semantic command categories for wiki classification
const COMMAND_CATEGORIES = Object.freeze({
    'package-manager': ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'pip', 'pip3', 'cargo', 'go', 'mvn', 'gradle', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'snap', 'uvx', 'uv', 'pipx', 'poetry', 'pdm'],
    'version-control': ['git'],
    'container-ops': ['docker', 'docker-compose', 'podman', 'kubectl', 'helm'],
    'build-tool': ['make', 'cmake', 'gcc', 'g++', 'clang', 'tsc', 'webpack', 'vite', 'esbuild', 'rollup', 'turbo'],
    'test-runner': ['jest', 'vitest', 'mocha', 'playwright', 'pytest', 'unittest'],
    'linter-formatter': ['eslint', 'prettier', 'ruff', 'black', 'mypy', 'pylint', 'flake8'],
    'file-ops': ['ls', 'dir', 'cat', 'cp', 'mv', 'touch', 'mkdir', 'rm', 'find', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'tar', 'zip', 'unzip', 'gzip', 'chmod', 'chown'],
    'network': ['curl', 'wget', 'ping', 'dig', 'nslookup', 'host', 'netstat', 'ss', 'ssh', 'scp', 'rsync'],
    'system-info': ['ps', 'top', 'htop', 'lsof', 'df', 'du', 'free', 'uname', 'hostname', 'whoami', 'id', 'env', 'printenv', 'date'],
    'text-processing': ['grep', 'sed', 'awk', 'tr', 'cut', 'tee', 'xargs', 'jq', 'yq'],
    'database': ['sqlite3', 'psql', 'mysql', 'mongosh', 'redis-cli'],
    'language-runtime': ['node', 'python', 'python3', 'deno', 'java', 'javac', 'rustc', 'ruby', 'perl', 'php', 'lua'],
    'infra': ['terraform', 'ansible', 'pulumi', 'cdk'],
    'crypto-encoding': ['base64', 'md5', 'sha256sum', 'openssl'],
    'shell-script': ['bash', 'sh', 'zsh'],
});

module.exports = {
    TAG, LEGACY_TAGS, LEGACY_SCRIPTS, RUNTIME_FILE, CONFIG_FILE,
    PORT_START, PORT_END, DEFAULT_PATTERNS, RISKY_PATTERNS, PRESET_PATTERNS,
    SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, LEARN, COMMAND_CATEGORIES,
    PATTERN_GROUPS, PATTERN_DISPLAY,
    // Shared observer constants
    HIGH_CONF, COOLDOWN, REJECT_WORDS, EDITOR_SKIP, SUPPRESS_KEYWORDS, LIMITS,
};
