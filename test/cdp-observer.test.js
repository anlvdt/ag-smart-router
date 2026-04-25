// ═══════════════════════════════════════════════════════════════
//  Grav — Unit Tests for cdp-observer.js
//  Run: node test/cdp-observer.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const { buildObserverScript } = require('../src/cdp-observer');
const C = require('../src/constants');

section('buildObserverScript basic');
const script = buildObserverScript(
    C.DEFAULT_PATTERNS,
    C.DEFAULT_BLACKLIST,
    true,  // scrollEnabled
    7000,  // scrollPauseMs
    false  // dryRun
);

assert(typeof script === 'string', 'returns a string');
assert(script.length > 1000, 'script is substantial (>1000 chars)');
assert(script.startsWith('(function()'), 'starts with IIFE');
assert(script.endsWith('})();'), 'ends with IIFE close');

section('Injected patterns');
assert(script.includes('"Accept all"'), 'contains Accept all pattern');
assert(script.includes('"Run"'), 'contains Run pattern');
assert(script.includes('"Retry"'), 'contains Retry pattern');

section('Injected constants');
assert(script.includes('REJECT_WORDS'), 'contains REJECT_WORDS');
assert(script.includes('EDITOR_SKIP'), 'contains EDITOR_SKIP');
assert(script.includes('SUPPRESS_KEYWORDS'), 'contains SUPPRESS_KEYWORDS');
assert(script.includes('HIGH_CONF'), 'contains HIGH_CONF');
assert(script.includes('COOLDOWN'), 'contains COOLDOWN');

section('Injected config values');
assert(script.includes('SCROLL_ON = true'), 'SCROLL_ON injected');
assert(script.includes('DRY_RUN = false'), 'DRY_RUN injected');

section('Security - blacklist included');
assert(script.includes('rm -rf /'), 'blacklist contains rm -rf /');
assert(script.includes('fork bomb') || script.includes(':(){:|:&};:'), 'blacklist contains fork bomb');

section('Version guard');
assert(script.includes('window.__grav3'), 'has version guard');
assert(script.includes("if (window.__grav3 === "), 'checks version before running');

section('Core functions present');
assert(script.includes('function report('), 'has report function');
assert(script.includes('function matchPattern('), 'has matchPattern function');
assert(script.includes('function labelOf('), 'has labelOf function');
assert(script.includes('function scanAndClick('), 'has scanAndClick function');
assert(script.includes('function executeClick('), 'has executeClick function');

section('Dry run mode');
const dryScript = buildObserverScript(
    C.DEFAULT_PATTERNS,
    C.DEFAULT_BLACKLIST,
    false, // scrollEnabled
    5000,  // scrollPauseMs
    true   // dryRun
);
assert(dryScript.includes('DRY_RUN = true'), 'DRY_RUN true when enabled');
assert(dryScript.includes('SCROLL_ON = false'), 'SCROLL_ON false when disabled');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
