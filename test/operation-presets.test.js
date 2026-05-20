'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const {
    buildOperationPreset,
    getOperationPresets,
    normalizeOperationMode,
} = require('../src/operation-presets');

section('Preset catalog');
const presets = getOperationPresets();
assert(presets.length === 3, 'three operation presets exposed');
assert(presets.some((preset) => preset.id === 'safe'), 'safe preset listed');
assert(presets.some((preset) => preset.id === 'balanced'), 'balanced preset listed');
assert(presets.some((preset) => preset.id === 'fast'), 'fast preset listed');

section('Safe preset');
const safe = buildOperationPreset('safe');
assert(!!safe, 'safe preset resolves');
assert(safe.skipBrowserAgent === true, 'safe keeps browser skip on');
assert(safe.skipTerminalAccept === true, 'safe keeps native accept guard on');
assert(!safe.approvePatterns.includes('Run'), 'safe excludes Run');
assert(!safe.approvePatterns.includes('Execute'), 'safe excludes Execute');

section('Balanced preset');
const balanced = buildOperationPreset('balanced');
assert(!!balanced, 'balanced preset resolves');
assert(balanced.approvePatterns.includes('Run'), 'balanced includes Run');
assert(balanced.approvePatterns.includes('Execute'), 'balanced includes Execute');
assert(balanced.skipBrowserAgent === true, 'balanced keeps browser skip on');
assert(balanced.skipTerminalAccept === true, 'balanced keeps native accept guard on');

section('Fast preset');
const fast = buildOperationPreset('fast');
assert(!!fast, 'fast preset resolves');
assert(fast.approvePatterns.includes('Allow'), 'fast includes Allow');
assert(fast.approvePatterns.includes('Allow Once'), 'fast includes Allow Once');
assert(fast.skipBrowserAgent === false, 'fast disables browser skip');
assert(fast.skipTerminalAccept === false, 'fast disables native accept guard');

section('Mode normalization');
assert(normalizeOperationMode('balanced') === 'balanced', 'known mode stays intact');
assert(normalizeOperationMode('unknown') === 'custom', 'unknown mode falls back to custom');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
