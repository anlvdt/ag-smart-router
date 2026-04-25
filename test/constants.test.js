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

section('Shared Observer Constants');
assert(Object.isFrozen(C.HIGH_CONF), 'HIGH_CONF is frozen');
assert(Object.isFrozen(C.COOLDOWN), 'COOLDOWN is frozen');
assert(Object.isFrozen(C.REJECT_WORDS), 'REJECT_WORDS is frozen');
assert(Object.isFrozen(C.EDITOR_SKIP), 'EDITOR_SKIP is frozen');
assert(Object.isFrozen(C.SUPPRESS_KEYWORDS), 'SUPPRESS_KEYWORDS is frozen');
assert(Object.isFrozen(C.LIMITS), 'LIMITS is frozen');

section('HIGH_CONF patterns');
assert(C.HIGH_CONF['Accept All'] === 1, 'Accept All in HIGH_CONF');
assert(C.HIGH_CONF['Run'] === 1, 'Run in HIGH_CONF');
assert(!C.HIGH_CONF['Continue'], 'Continue NOT in HIGH_CONF');
assert(!C.HIGH_CONF['Resume Conversation'], 'Resume Conversation NOT in HIGH_CONF');

section('COOLDOWN values');
assert(C.COOLDOWN['Run'] === 5000, 'Run cooldown 5s');
assert(C.COOLDOWN['Continue'] === 15000, 'Continue cooldown 15s');
assert(C.COOLDOWN['Resume Conversation'] === 15000, 'Resume Conversation cooldown 15s');
assert(C.COOLDOWN.DEFAULT === 1000, 'DEFAULT cooldown 1s');
assert(C.COOLDOWN.GLOBAL === 500, 'GLOBAL cooldown 500ms');

section('RISKY_PATTERNS protection');
assert(C.RISKY_PATTERNS.includes('Continue'), 'Continue in RISKY_PATTERNS');
assert(C.RISKY_PATTERNS.includes('Resume Conversation'), 'Resume Conversation in RISKY_PATTERNS');
assert(!C.DEFAULT_PATTERNS.includes('Continue'), 'Continue NOT in DEFAULT_PATTERNS');
assert(!C.DEFAULT_PATTERNS.includes('Resume Conversation'), 'Resume Conversation NOT in DEFAULT_PATTERNS');

section('LIMITS numeric values');
assert(C.LIMITS.BUTTON_LABEL_MIN === 2, 'BUTTON_LABEL_MIN is 2');
assert(C.LIMITS.BUTTON_LABEL_MAX === 60, 'BUTTON_LABEL_MAX is 60');
assert(C.LIMITS.CLICK_DEDUP_TIMEOUT === 30000, 'CLICK_DEDUP_TIMEOUT is 30s');
assert(C.LIMITS.POLL_STANDARD_MS === 1500, 'POLL_STANDARD_MS is 1.5s');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
