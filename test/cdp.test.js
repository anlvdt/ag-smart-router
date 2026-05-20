'use strict';

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
        workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
        window: { showWarningMessage: async () => null },
    },
    children: [],
    paths: [],
};

const { isAgentTarget } = require('../src/cdp');

section('Workbench targets');
assert(isAgentTarget({ type: 'page', url: 'file:///Applications/Antigravity/workbench.html', title: 'workspace' }), 'main workbench accepted');

section('Blocked targets');
assert(!isAgentTarget({ type: 'iframe', url: 'vscode-webview://abc/settings', title: 'Settings' }), 'settings webview rejected');
assert(!isAgentTarget({ type: 'webview', url: 'vscode-webview://abc/simple-browser', title: 'Browser' }), 'browser webview rejected');
assert(!isAgentTarget({ type: 'iframe', url: 'vscode-webview://abc/marketplace', title: 'Extensions' }), 'extensions webview rejected');

section('Agent targets');
assert(isAgentTarget({ type: 'iframe', url: 'vscode-webview://abc/antigravity-agent', title: 'Agent Chat' }), 'agent webview accepted');
assert(isAgentTarget({ type: 'other', url: '', title: 'Cascade approval' }), 'blank-url approval target accepted via title');

section('Unknown webviews');
assert(!isAgentTarget({ type: 'page', url: 'vscode-webview://abc/random-panel', title: 'Random Panel' }), 'unknown non-iframe webview rejected');
assert(!isAgentTarget({ type: 'iframe', url: 'https://example.com', title: 'External' }), 'external iframe rejected');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
