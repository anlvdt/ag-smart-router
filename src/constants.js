// ═══════════════════════════════════════════════════════════════
//  Grav — Constants & Configuration
// ═══════════════════════════════════════════════════════════════
'use strict';

const TAG = Object.freeze({
    open:  '<!-- GRAV-RUNTIME-START -->',
    close: '<!-- GRAV-RUNTIME-END -->',
});

const LEGACY_TAGS = Object.freeze([
    ['<!-- AG-AUTOPILOT-START -->',          '<!-- AG-AUTOPILOT-END -->'],
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->',  '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->',       '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->',            '<!-- AG-TOOLKIT-END -->'],
]);

const LEGACY_SCRIPTS = Object.freeze(['ag-auto-script.js', 'ag-modelswitch-client.js']);
const RUNTIME_FILE   = 'grav-runtime.js';
const CONFIG_FILE    = 'grav-config.json';
const PORT_START     = 48787;
const PORT_END       = 48850;

const ACCEPT_CMDS = Object.freeze([
    'antigravity.agent.acceptAgentStep',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion',
]);

const DEFAULT_PATTERNS = Object.freeze([
    // === SAFE: File edits — accept code changes, revertible ===
    'Accept all', 'Accept All', 'Accept', 'Accept & Run',
    'Keep All Edits', 'Keep All', 'Keep & Continue', 'Keep',
    // === SAFE: Agent flow — continue/retry execution ===
    'Continue', 'Retry', 'Keep Waiting', 'Proceed', 'Run Task',
    // === CAUTION: Per-request permissions (Safety Guard protects Run) ===
    'Run', 'Allow', 'Allow Once',
    'Allow in this Session', 'Allow this conversation',
    'Allow and Review', 'Approve Tool Result', 'Approve all',
    // === RISKY: Permanent/billing — disabled by default ===
    'Always Allow', 'Allow in this Workspace',
    'Always Allow Without Review', 'Allow and Skip Reviewing Result',
    'Trust', 'OK', 'Confirm', 'Enable Overages',
]);

// Patterns disabled by default — irreversible, billing, or permanent permissions
const RISKY_PATTERNS = Object.freeze([
    'Always Allow',                     // permanent — never asks again
    'Allow in this Workspace',          // permanent for workspace
    'Always Allow Without Review',      // permanent + no review
    'Allow and Skip Reviewing Result',  // skips tool output review
    'Trust',                            // trusts workspace — security risk
    'OK',                               // too generic
    'Confirm',                          // too generic — could confirm billing/delete
    'Enable Overages',                  // BILLING: auto-agrees to pay AI credits
]);

const SAFE_TERMINAL_CMDS = Object.freeze([
    'ls','dir','cat','echo','pwd','cd','mkdir','cp','mv','touch',
    'npm','npx','yarn','pnpm','bun','deno','node','python','python3','pip','pip3',
    'git','which','where','type','file','stat','readlink',
    'head','tail','wc','sort','uniq','diff','grep','find','xargs',
    'sed','awk','tr','cut','tee','date','whoami','id',
    'env','printenv','uname','hostname','df','du','free',
    'ps','top','htop','lsof','netstat','ss','ping','dig','nslookup','host',
    'cargo','rustc','go','java','javac','mvn','gradle',
    'docker','docker-compose','podman','kubectl','helm','terraform','ansible',
    'make','cmake','gcc','g++','clang',
    'jq','yq','base64','md5','sha256sum','openssl',
    'tar','zip','unzip','gzip','gunzip','bzip2','xz',
    'curl','wget','http','httpie',
    'brew','apt','apt-get','yum','dnf','pacman','snap',
    'sqlite3','psql','mysql','mongosh','redis-cli',
    'tsc','eslint','prettier','jest','vitest','mocha','playwright',
    'sass','postcss','webpack','vite','esbuild','rollup','turbo',
    'uvx','uv','pipx','poetry','pdm','ruff','black','mypy',
    'code','antigravity',
]);

const DEFAULT_BLACKLIST = Object.freeze([
    // Filesystem destruction
    'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -rf .', 'rm -rf .git',
    'rmdir /s /q c:\\', 'rmdir /s /q d:\\', 'rd /s /q c:\\',
    'del /f /s /q c:\\', 'del /f /s /q d:\\',
    'remove-item -recurse -force c:\\', 'remove-item -recurse -force d:\\',
    // Disk/partition destruction
    'mkfs', 'dd if=/dev/zero', 'dd if=/dev/urandom', 'dd if=',
    'wipefs', 'diskpart', 'format-volume', 'clear-disk',
    'format c:', 'format d:',
    // Fork bomb / system kill
    ':(){:|:&};:', 'shutdown', 'reboot', 'init 0', 'init 6',
    'kill -9 -1', 'killall', 'stop-computer',
    // Permission escalation
    'chmod -R 777 /', 'chown -r root /',
    'sudo su', 'su -',
    // Remote code execution
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
    'docker volume prune', 'docker volume rm',
    // Windows registry
    'reg delete hk',
    'vssadmin delete shadows',
    // npm destructive
    'npm publish',
    // Shred
    'shred ',
]);

const LEARN = Object.freeze({
    ALPHA:           0.15,
    MOMENTUM:        0.9,
    GAMMA:           0.97,
    PROMOTE_THRESH:  0.75,
    DEMOTE_THRESH:  -0.50,
    OBSERVE_MIN:     5,
    MAX_ENTRIES:     1000,
    MAX_HISTORY:     50,
    CONTEXT_WEIGHT:  0.1,
    GENERALIZE_MIN:  3,
    BATCH_SIZE:      10,
});

// Semantic command categories for wiki classification
const COMMAND_CATEGORIES = Object.freeze({
    'package-manager':   ['npm','npx','yarn','pnpm','bun','pip','pip3','cargo','go','mvn','gradle','brew','apt','apt-get','yum','dnf','pacman','snap','uvx','uv','pipx','poetry','pdm'],
    'version-control':   ['git'],
    'container-ops':     ['docker','docker-compose','podman','kubectl','helm'],
    'build-tool':        ['make','cmake','gcc','g++','clang','tsc','webpack','vite','esbuild','rollup','turbo'],
    'test-runner':       ['jest','vitest','mocha','playwright','pytest','unittest'],
    'linter-formatter':  ['eslint','prettier','ruff','black','mypy','pylint','flake8'],
    'file-ops':          ['ls','dir','cat','cp','mv','touch','mkdir','rm','find','head','tail','wc','sort','uniq','diff','tar','zip','unzip','gzip','chmod','chown'],
    'network':           ['curl','wget','ping','dig','nslookup','host','netstat','ss','ssh','scp','rsync'],
    'system-info':       ['ps','top','htop','lsof','df','du','free','uname','hostname','whoami','id','env','printenv','date'],
    'text-processing':   ['grep','sed','awk','tr','cut','tee','xargs','jq','yq'],
    'database':          ['sqlite3','psql','mysql','mongosh','redis-cli'],
    'language-runtime':  ['node','python','python3','deno','java','javac','rustc','ruby','perl','php','lua'],
    'infra':             ['terraform','ansible','pulumi','cdk'],
    'crypto-encoding':   ['base64','md5','sha256sum','openssl'],
    'shell-script':      ['bash','sh','zsh'],
});

module.exports = {
    TAG, LEGACY_TAGS, LEGACY_SCRIPTS, RUNTIME_FILE, CONFIG_FILE,
    PORT_START, PORT_END, ACCEPT_CMDS, DEFAULT_PATTERNS, RISKY_PATTERNS,
    SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, LEARN, COMMAND_CATEGORIES,
};
