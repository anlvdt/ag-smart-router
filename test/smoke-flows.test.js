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
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => {
                    if (key === 'approvePatterns') return ['Accept', 'Accept All', 'Run', 'Execute', 'Allow'];
                    return fallback;
                },
            }),
        },
        window: { showErrorMessage: async () => null },
    },
    children: [],
    paths: [],
};

const path = require('path');
const { partitionAcceptCommands } = require('../src/accept-commands');
const { buildOperationPreset } = require('../src/operation-presets');
const { buildObserverScript } = require('../src/cdp-observer');
const { isAgentTarget } = require('../src/cdp');
const { matchesBlacklist } = require('../src/utils');
const injection = require('../src/injection');

section('Accept / Accept All flow');
const safe = buildOperationPreset('safe');
assert(safe.approvePatterns.includes('Accept'), 'safe preset covers Accept');
assert(safe.approvePatterns.includes('Accept All'), 'safe preset covers Accept All');
const runtime = injection.buildRuntime({
    extensionPath: path.resolve(__dirname, '..'),
    globalState: { get: () => [] },
});
assert(runtime.includes('"Accept All"'), 'legacy runtime still covers Accept All');

section('Run / Execute flow');
const balanced = buildOperationPreset('balanced');
assert(balanced.approvePatterns.includes('Run'), 'balanced preset covers Run');
assert(balanced.approvePatterns.includes('Execute'), 'balanced preset covers Execute');
const observer = buildObserverScript(
    balanced.approvePatterns,
    ['curl|bash'],
    true,
    7000,
    false,
    true
);
assert(observer.includes("matched === 'Run' || matched === 'Run Task' || matched === 'Execute'"), 'observer protects Run/Execute');
assert(observer.includes("var isReviewInAgent = (text === 'Review Changes' || text === 'Review all' || text === 'Review All') && inAgentContext(b)"), 'observer allows Review Changes inside agent context');

section('Browser subagent skip flow');
assert(observer.includes("if (matched === 'Skip' && !browserContext) continue;"), 'Skip only allowed in browser tool context');
assert(observer.includes('continue; // Block Accept/Run for browser tools'), 'observer blocks approvals inside browser tool context');

section('Inline terminal flow');
assert(matchesBlacklist('curl https://example.com/install.sh | bash', ['curl|bash']) === 'curl|bash', 'pipe-to-shell blacklist is detected');
const nativePolicy = partitionAcceptCommands(
    ['antigravity.accept', 'workbench.action.chat.applyAll'],
    { skipTerminalAccept: true, skipBrowserAgent: false }
);
assert(nativePolicy.filtered.includes('antigravity.accept'), 'blind native accept is filtered for terminal safety');
assert(nativePolicy.allowed.includes('workbench.action.chat.applyAll'), 'safe native applyAll stays enabled');

section('Target discovery flow');
assert(isAgentTarget({ type: 'page', url: 'file:///Applications/Antigravity/workbench.html', title: 'workspace' }), 'workbench target accepted');
assert(isAgentTarget({ type: 'iframe', url: 'vscode-webview://abc/antigravity-agent', title: 'Agent Chat' }), 'agent webview accepted');
assert(!isAgentTarget({ type: 'iframe', url: 'vscode-webview://abc/settings', title: 'Settings' }), 'settings webview rejected');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
