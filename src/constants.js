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

// Accept commands are now discovered DYNAMICALLY at runtime
// via vscode.commands.getCommands() — see extension.js discoverAcceptCommands()
// This ensures compatibility across all Antigravity versions.
const ACCEPT_CMDS = Object.freeze([]);

const DEFAULT_PATTERNS = Object.freeze([
    // ── Antigravity Agent Panel — Button Labels ──
    // Source: YazanBaker priority matching + cotamatcotam iframe scan + Antigravity UI decompile
    //
    // Priority order (higher = matched first when multiple buttons visible):
    //   Run > Accept > Always Allow > Allow > Continue > Retry
    //
    // === SAFE: File edits — accept code changes, revertible ===
    'Accept all', 'Accept All', 'Accept',
    // === SAFE: Agent flow — continue/retry execution ===
    'Retry', 'Proceed',
    // === CAUTION: Per-request permissions (Safety Guard protects Run) ===
    // "Run" button appears above terminal code blocks in Antigravity agent panel
    // Safety Guard reads the command text from the <code> block before clicking
    'Run',
    // === Antigravity-specific: Agent Manager / Cortex step buttons ===
    'Approve', 'Expand',
    // === Connection Recovery — auto-click when connection fails ===
    'Resume', 'Try Again', 'Reconnect',
    // === Conversation limit recovery ===
    'Resume Conversation', 'Continue',
]);

// Patterns disabled by default — irreversible, billing, or permanent permissions
const RISKY_PATTERNS = Object.freeze([
    'Always Allow',                     // permanent — never asks again
    'Allow in this Workspace',          // permanent for workspace
    'Allow This Conversation',          // session-scoped — safer than Always Allow
    'Allow this Conversation',          // lowercase variant
    'Allow Once',                       // one-time permission
    'Allow once',                       // lowercase variant
    'Always Allow Without Review',      // permanent + no review
    'Allow and Skip Reviewing Result',  // skips tool output review
    'Trust',                            // trusts workspace — security risk
    'OK',                               // too generic
    'Confirm',                          // too generic — could confirm billing/delete
    'Enable Overages',                  // BILLING: auto-agrees to pay AI credits
]);

// UI Display Names — maps variants to a single display name
// Key = display name shown in UI, Value = array of all variants (including display name)
const PATTERN_GROUPS = Object.freeze({
    'Accept all': ['Accept all', 'Accept All'],
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
    'kill', 'killall', 'pkill',
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
    'sass', 'postcss', 'webpack', 'vite', 'esbuild', 'rollup', 'turbo',
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
    PORT_START, PORT_END, ACCEPT_CMDS, DEFAULT_PATTERNS, RISKY_PATTERNS,
    SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, LEARN, COMMAND_CATEGORIES,
    PATTERN_GROUPS, PATTERN_DISPLAY,
};
