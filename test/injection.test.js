'use strict';

const path = require('path');

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};
require.cache.vscode = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: {
        env: { appRoot: '/mock' },
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => {
                    if (key === 'approvePatterns') return ['Accept', 'Run', 'Execute', 'Allow', 'Accept All'];
                    return fallback;
                },
            }),
        },
        window: { showErrorMessage: async () => null },
    },
    children: [],
    paths: [],
};

const injection = require('../src/injection');

section('Legacy runtime pattern filtering');
const runtime = injection.buildRuntime({
    extensionPath: path.resolve(__dirname, '..'),
    globalState: { get: () => [] },
});
const patternMatch = runtime.match(/var PATTERNS = .*?(\[[^\n]+\]);/);
const patterns = patternMatch ? JSON.parse(patternMatch[1]) : [];
assert(patterns.includes('Accept'), 'safe Accept kept');
assert(patterns.includes('Accept All'), 'safe Accept All kept');
assert(!patterns.includes('Run'), 'Run removed from legacy runtime patterns');
assert(!patterns.includes('Execute'), 'Execute removed from legacy runtime patterns');
assert(!patterns.includes('Allow'), 'Allow removed from legacy runtime patterns');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
