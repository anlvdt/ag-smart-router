// ═══════════════════════════════════════════════════════════════
//  Grav — Unit Tests for learning.js
//  Run: node test/learning.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

// Mock vscode
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};
require.cache['vscode'] = {
    id: 'vscode', filename: 'vscode', loaded: true, exports: {
        env: { appRoot: '/mock' },
        workspace: {
            getConfiguration: () => ({
                get: (k, f) => f,
                update: async () => { },
            }),
            workspaceFolders: [{ name: 'test-project' }],
        },
        window: {
            showInformationMessage: async () => null,
            showWarningMessage: async () => null,
        },
        ConfigurationTarget: { Global: 1 },
    }, children: [], paths: [],
};

const _store = {};
const mockCtx = {
    globalState: {
        get: (k, d) => _store[k] !== undefined ? _store[k] : d,
        update: (k, v) => { _store[k] = v; return Promise.resolve(); },
    },
};

// Mock wiki
const mockWiki = {
    ingest: () => { },
    query: () => null,
    getSequences: () => ({}),
};

const learning = require('../src/learning');

section('Init');
learning.init(mockCtx, mockWiki);
assert(learning.getEpoch() === 0, 'epoch starts at 0');
assert(Object.keys(learning.getData()).length === 0, 'empty learn data');

section('Record action');
learning.recordAction('npm install', 'approve', { project: 'test' });
assert(learning.getEpoch() === 1, 'epoch incremented');
const data = learning.getData();
assert(data['npm'] !== undefined, 'npm tracked');
assert(data['npm'].obs === 1, 'obs = 1');
assert(data['npm'].conf > 0, 'confidence positive after approve');

section('Multiple approves increase confidence');
const confBefore = data['npm'].conf;
learning.recordAction('npm test', 'approve', { project: 'test' });
learning.recordAction('npm run build', 'approve', { project: 'test' });
assert(data['npm'].conf > confBefore, 'confidence increased');
assert(data['npm'].obs === 3, 'obs = 3');

section('Reject affects confidence');
// Record a fresh command with only rejects
learning.recordAction('dangerous-cmd', 'reject', { project: 'test' });
learning.recordAction('dangerous-cmd', 'reject', { project: 'test' });
learning.recordAction('dangerous-cmd', 'reject', { project: 'test' });
const dangerData = data['dangerous-cmd'];
assert(dangerData !== undefined, 'dangerous-cmd tracked');
assert(dangerData.conf <= 0, 'confidence negative after only rejects');

section('Exit code affects reward');
learning.recordAction('git status', 'approve', { exitCode: 0, project: 'test' });
const gitData = data['git'];
assert(gitData !== undefined, 'git tracked');
assert(gitData.conf > 0, 'git confidence positive with exit 0');

section('Evaluate command');
// npm should be whitelisted (in SAFE_TERMINAL_CMDS)
const result1 = learning.evaluateCommand('npm install');
assert(result1.allowed === true, 'npm allowed (whitelisted)');

const result2 = learning.evaluateCommand('rm -rf /');
assert(result2.allowed === false, 'rm -rf / blocked');

const result3 = learning.evaluateCommand('unknowncmd123');
assert(result3.allowed === false, 'unknown command blocked by default');
assert(result3.confidence <= 0.3, 'unknown command has low confidence');

section('Compound command evaluation');
const result4 = learning.evaluateCommand('npm install && git push');
assert(result4.allowed === true, 'npm && git allowed');

const result5 = learning.evaluateCommand('npm install && rm -rf /');
assert(result5.allowed === false, 'npm && rm -rf / blocked');

section('Stats');
const stats = learning.getStats();
assert(stats.epoch > 0, 'stats has epoch');
assert(stats.totalTracked > 0, 'stats has tracked commands');
assert(Array.isArray(stats.commands), 'stats has commands array');

section('Promoted commands');
// With only a few observations, nothing should be promoted yet
const promoted = learning.getPromotedCommands();
assert(Array.isArray(promoted), 'promoted is array');

section('Flush');
learning.flush();
assert(_store['learnData'] !== undefined, 'learnData persisted');
assert(_store['learnEpoch'] !== undefined, 'learnEpoch persisted');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
