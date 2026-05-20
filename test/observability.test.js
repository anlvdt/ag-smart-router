'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const { createObservabilityState } = require('../src/observability');

section('Decision trace');
const obs = createObservabilityState();
const blocked = obs.push({ source: 'cdp', action: 'blocked', cmd: 'rm -rf /tmp', reason: 'rm -rf /' });
const clicked = obs.push({ source: 'cdp', action: 'clicked', label: 'Accept All', pattern: 'Accept All' });
const snap = obs.snapshot();
assert(snap.trace.length === 2, 'trace stores pushed events');
assert(snap.lastBlocked && snap.lastBlocked.id === blocked.id, 'lastBlocked tracks latest blocked event');
assert(snap.lastClicked && snap.lastClicked.id === clicked.id, 'lastClicked tracks latest successful click');

section('Feedback recording');
obs.recordFeedback('falsePositive', { reason: 'manual feedback' });
obs.recordFeedback('falseNegative', { reason: 'manual feedback' });
const afterFeedback = obs.snapshot();
assert(afterFeedback.feedback.falsePositive === 1, 'false positive count increments');
assert(afterFeedback.feedback.falseNegative === 1, 'false negative count increments');
assert(afterFeedback.trace[0].source === 'feedback', 'feedback is also visible in trace');

section('Persistence shape');
const exported = obs.exportState();
assert(Array.isArray(exported.trace), 'exported trace is array');
assert(exported.feedback && typeof exported.feedback.falsePositive === 'number', 'feedback summary is exported');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
