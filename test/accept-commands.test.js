'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function eq(a, b, msg) {
    assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function section(name) { console.log(`\n── ${name} ──`); }

const {
    deriveDynamicAcceptCommands,
    isBlindAcceptCommand,
    partitionAcceptCommands,
    shouldExecuteAcceptCommand,
} = require('../src/accept-commands');

section('Discovery');
const discovered = deriveDynamicAcceptCommands([
    'antigravity.accept',
    'workbench.action.chat.applyAll',
    'extension.manage',
    'inlineChat.accept',
]);
assert(discovered.includes('antigravity.accept'), 'includes antigravity.accept');
assert(discovered.includes('workbench.action.chat.applyAll'), 'includes applyAll');
assert(discovered.includes('inlineChat.accept'), 'includes inlineChat.accept');
assert(!discovered.includes('extension.manage'), 'skips unrelated command');

section('Blind accept classification');
assert(isBlindAcceptCommand('antigravity.accept'), 'antigravity.accept is blind');
assert(isBlindAcceptCommand('workbench.action.chat.accept'), 'workbench.action.chat.accept is blind');
assert(!isBlindAcceptCommand('workbench.action.chat.applyAll'), 'applyAll is safe');
assert(!isBlindAcceptCommand('inlineChat.accept'), 'inlineChat.accept is safe');

section('Execution policy');
assert(!shouldExecuteAcceptCommand('antigravity.accept', { skipTerminalAccept: true, skipBrowserAgent: false }), 'skipTerminalAccept blocks blind native accept');
assert(!shouldExecuteAcceptCommand('antigravity.accept', { skipTerminalAccept: false, skipBrowserAgent: true }), 'skipBrowserAgent also blocks blind native accept');
assert(shouldExecuteAcceptCommand('inlineChat.accept', { skipTerminalAccept: true, skipBrowserAgent: true }), 'safe native accept still allowed');

section('Partition');
const partitioned = partitionAcceptCommands([
    'antigravity.accept',
    'workbench.action.chat.applyAll',
    'inlineChat.accept',
], { skipTerminalAccept: true, skipBrowserAgent: false });
eq(partitioned.allowed, ['workbench.action.chat.applyAll', 'inlineChat.accept'], 'allowed commands filtered correctly');
eq(partitioned.filtered, ['antigravity.accept'], 'filtered commands tracked');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
