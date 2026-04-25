// ═══════════════════════════════════════════════════════════════
//  Grav — Constants
// ═══════════════════════════════════════════════════════════════

const TAG = { open: '<!-- GRAV-RUNTIME-START -->', close: '<!-- GRAV-RUNTIME-END -->' };

const LEGACY_TAGS = [
    ['<!-- AG-AUTOPILOT-START -->',          '<!-- AG-AUTOPILOT-END -->'],
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->',  '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->',       '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->',            '<!-- AG-TOOLKIT-END -->'],
];

const LEGACY_SCRIPTS = ['ag-auto-script.js', 'ag-modelswitch-client.js'];
const RUNTIME_FILE   = 'grav-runtime.js';
const CONFIG_FILE    = 'grav-config.json';
const PORT_START     = 48787;
const PORT_END       = 48850;

const ACCEPT_CMDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion',
];

const SAFE_TERMINAL_CMDS = [
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
];

const DEFAULT_BLACKLIST = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'chmod -R 777 /',
    'wget|sh',
    'curl|sh',
    'curl|bash',
    'wget|bash',
    '> /dev/sda',
    'shutdown',
    'reboot',
    'init 0',
    'init 6',
    'kill -9 -1',
    'killall',
    'format c:',
];

// Karpathy-inspired adaptive learning hyperparameters
const LEARN = {
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
    MAX_LOG:         200,
    MAX_SOURCES:     20,
    MAX_EVIDENCE:    50,
    MAX_CONTRADICTIONS: 100,
    MAX_LINKS:       20,
    TRIM_LINKS:      15,
    MAX_REGEX_LEN:   200,
};

module.exports = {
    TAG, LEGACY_TAGS, LEGACY_SCRIPTS, RUNTIME_FILE, CONFIG_FILE,
    PORT_START, PORT_END, ACCEPT_CMDS, SAFE_TERMINAL_CMDS,
    DEFAULT_BLACKLIST, LEARN,
};
