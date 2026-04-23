// ═══════════════════════════════════════════════════════════════
//  Grav — Unit Tests for utils.js
//  Run: node test/utils.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

// Minimal test runner (zero dependencies)
let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function section(name) { console.log(`\n── ${name} ──`); }

// Mock vscode for require — must be set before requiring any src modules
const path = require('path');
const mockVscode = {
    env: { appRoot: '/mock' },
    workspace: { getConfiguration: () => ({ get: (k, f) => f }) },
};
// Pre-populate require cache so `require('vscode')` returns our mock
const vscodeId = 'vscode';
require.cache[vscodeId] = { id: vscodeId, filename: vscodeId, loaded: true, exports: mockVscode, children: [], paths: [] };
// Also handle resolution by patching Module._resolveFilename
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return vscodeId;
    return origResolve.call(this, request, parent, isMain, options);
};

const { escapeRegex, isPathSafe, extractCommands, matchesBlacklist } = require('../src/utils');

// ── escapeRegex ──────────────────────────────────────────────
section('escapeRegex');
eq(escapeRegex('hello'), 'hello', 'plain string unchanged');
eq(escapeRegex('a.b'), 'a\\.b', 'dot escaped');
eq(escapeRegex('a*b+c?'), 'a\\*b\\+c\\?', 'wildcards escaped');
eq(escapeRegex('(a|b)'), '\\(a\\|b\\)', 'parens and pipe escaped');
eq(escapeRegex('[a]'), '\\[a\\]', 'brackets escaped');
eq(escapeRegex('a\\b'), 'a\\\\b', 'backslash escaped');
eq(escapeRegex('$100'), '\\$100', 'dollar escaped');
eq(escapeRegex('^start'), '\\^start', 'caret escaped');
eq(escapeRegex('a{1,2}'), 'a\\{1,2\\}', 'braces escaped');

// Verify escaped string works as regex
const tag = '<!-- GRAV-RUNTIME-START -->';
const escaped = escapeRegex(tag);
const re = new RegExp(escaped);
assert(re.test(tag), 'escaped tag matches original');
assert(!re.test('<!-- GRAV-RUNTIME-START-EXTRA -->'), 'escaped tag does not match extra');

// ── isPathSafe ───────────────────────────────────────────────
section('isPathSafe');
assert(isPathSafe('/usr/local/bin/file.txt'), 'absolute path OK');
assert(isPathSafe('relative/path.js'), 'relative path OK');
assert(!isPathSafe(null), 'null rejected');
assert(!isPathSafe(''), 'empty rejected');
assert(!isPathSafe('path/with\0null'), 'null byte rejected');
assert(!isPathSafe('../../../etc/passwd'), 'traversal rejected');
assert(!isPathSafe('foo/../../bar'), 'nested traversal rejected');

// ── extractCommands ──────────────────────────────────────────
section('extractCommands');
eq(extractCommands('npm install'), ['npm'], 'simple command');
eq(extractCommands('npm install && git push'), ['npm', 'git'], 'chain');
eq(extractCommands('cat file | grep pattern'), ['cat', 'grep'], 'pipe');
eq(extractCommands('sudo npm install'), ['npm'], 'sudo stripped');
eq(extractCommands('FOO=bar npm run build'), ['npm'], 'env var stripped');
eq(extractCommands('/usr/bin/git status'), ['git'], 'path stripped');
eq(extractCommands(''), [], 'empty string');
eq(extractCommands(null), [], 'null');
eq(extractCommands(123), [], 'non-string');
eq(extractCommands('nohup time nice npm start'), ['npm'], 'multiple prefixes stripped');

// ── matchesBlacklist ─────────────────────────────────────────
section('matchesBlacklist');
eq(matchesBlacklist('rm -rf /', ['rm -rf /']), 'rm -rf /', 'exact multi-word match');
eq(matchesBlacklist('sudo rm -rf /', ['rm -rf /']), 'rm -rf /', 'multi-word substring match');
eq(matchesBlacklist('npm install', ['rm -rf /']), null, 'no match');
eq(matchesBlacklist('npm install', []), null, 'empty blacklist');
eq(matchesBlacklist('eval bad code', ['/eval.*code/']), '/eval.*code/', 'regex match');
eq(matchesBlacklist('safe command', ['/eval.*code/']), null, 'regex no match');
// Word-boundary matching for single-word patterns
eq(matchesBlacklist('shutdown', ['shutdown']), 'shutdown', 'single-word exact');
eq(matchesBlacklist('shutdown -h now', ['shutdown']), 'shutdown', 'single-word at start');
eq(matchesBlacklist('shutdown-handler.js', ['shutdown']), null, 'single-word no false positive on hyphenated');
eq(matchesBlacklist('myshutdown', ['shutdown']), null, 'single-word no false positive on prefix');
eq(matchesBlacklist('kill -9 -1', ['kill -9 -1']), 'kill -9 -1', 'multi-word destructive match');
eq(matchesBlacklist('kill -9 1234', ['kill -9 -1']), null, 'kill specific PID not blocked');
eq(matchesBlacklist('killall python', ['killall']), 'killall', 'killall with args matches word-boundary');
eq(matchesBlacklist('mykillall', ['killall']), null, 'killall no false positive on prefix');

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
