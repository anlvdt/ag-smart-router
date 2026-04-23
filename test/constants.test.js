// ═══════════════════════════════════════════════════════════════
//  Grav — Unit Tests for constants.js
//  Run: node test/constants.test.js
// ═══════════════════════════════════════════════════════════════
'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const C = require('../src/constants');

section('Immutability');
assert(Object.isFrozen(C.TAG), 'TAG is frozen');
assert(Object.isFrozen(C.DEFAULT_PATTERNS), 'DEFAULT_PATTERNS is frozen');
assert(Object.isFrozen(C.SAFE_TERMINAL_CMDS), 'SAFE_TERMINAL_CMDS is frozen');
assert(Object.isFrozen(C.DEFAULT_BLACKLIST), 'DEFAULT_BLACKLIST is frozen');
assert(Object.isFrozen(C.LEARN), 'LEARN is frozen');
assert(Object.isFrozen(C.COMMAND_CATEGORIES), 'COMMAND_CATEGORIES is frozen');

// Verify mutation throws
try { C.DEFAULT_PATTERNS.push('test'); assert(false, 'push should throw'); }
catch (_) { assert(true, 'push throws on frozen array'); }

section('Pattern completeness');
assert(C.DEFAULT_PATTERNS.includes('Accept all'), 'has Accept all');
assert(C.DEFAULT_PATTERNS.includes('Retry'), 'has Retry');
assert(C.DEFAULT_PATTERNS.includes('Proceed'), 'has Proceed');
assert(C.DEFAULT_PATTERNS.includes('Approve'), 'has Approve');
assert(C.DEFAULT_PATTERNS.includes('Expand'), 'has Expand');

// No duplicates
const uniquePatterns = new Set(C.DEFAULT_PATTERNS);
assert(uniquePatterns.size === C.DEFAULT_PATTERNS.length, `no duplicate patterns (${uniquePatterns.size} unique vs ${C.DEFAULT_PATTERNS.length} total)`);

section('LEARN hyperparameters');
assert(C.LEARN.ALPHA > 0 && C.LEARN.ALPHA < 1, 'ALPHA in (0,1)');
assert(C.LEARN.MOMENTUM > 0 && C.LEARN.MOMENTUM < 1, 'MOMENTUM in (0,1)');
assert(C.LEARN.GAMMA > 0 && C.LEARN.GAMMA < 1, 'GAMMA in (0,1)');
assert(C.LEARN.PROMOTE_THRESH > C.LEARN.DEMOTE_THRESH, 'PROMOTE > DEMOTE threshold');
assert(C.LEARN.OBSERVE_MIN >= 1, 'OBSERVE_MIN >= 1');
assert(C.LEARN.MAX_ENTRIES >= 100, 'MAX_ENTRIES >= 100');

section('Port range');
assert(C.PORT_START < C.PORT_END, 'PORT_START < PORT_END');
assert(C.PORT_END - C.PORT_START >= 10, 'at least 10 ports in range');

section('Blacklist safety');
assert(C.DEFAULT_BLACKLIST.includes('rm -rf /'), 'blocks rm -rf /');
assert(C.DEFAULT_BLACKLIST.includes(':(){:|:&};:'), 'blocks fork bomb');
assert(C.DEFAULT_BLACKLIST.includes('kill -9 -1'), 'blocks kill all processes');
assert(C.DEFAULT_BLACKLIST.includes('dd if=/dev/zero'), 'blocks disk wipe');

section('Command categories');
const allCategorized = Object.values(C.COMMAND_CATEGORIES).flat();
assert(allCategorized.includes('npm'), 'npm categorized');
assert(allCategorized.includes('git'), 'git categorized');
assert(allCategorized.includes('docker'), 'docker categorized');
assert(allCategorized.includes('python3'), 'python3 categorized');

// No duplicates across categories
const catSet = new Set(allCategorized);
assert(catSet.size === allCategorized.length, `no cross-category duplicates (${catSet.size} unique vs ${allCategorized.length} total)`);

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
