'use strict';

const fs = require('fs');
const path = require('path');

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard-v2.html'), 'utf8');

section('Version placeholder');
assert(html.includes('v{{VERSION}}'), 'dashboard header uses template version');

section('Safe render helpers');
assert(html.includes('function clearNode(node)'), 'clearNode helper exists');
assert(html.includes('function makeEl(tag, className, text)'), 'makeEl helper exists');

section('No raw innerHTML with untrusted values');
assert(!html.includes("row.innerHTML = '<span class=\"bar-k\""), 'stats rows no longer use raw innerHTML');
assert(!html.includes("el.innerHTML = '<div class=\"cpt-top\""), 'concept rows no longer use raw innerHTML');
assert(!html.includes("row.innerHTML = '<span class=\"feed-ts\""), 'log rows no longer use raw innerHTML');
assert(!html.includes("div.innerHTML = '<span class=\"metric-label\""), 'tool breakdown no longer uses raw innerHTML');

section('Text nodes used for dynamic content');
assert(html.includes("makeEl('span', 'feed-cmd', l.cmd || '')"), 'log command uses textContent path');
assert(html.includes("makeEl('span', 'bar-k', k)"), 'stats label uses textContent path');
assert(html.includes("makeEl('span', 'cpt-name', ck)"), 'concept name uses textContent path');

section('Consistent staged-save model');
assert(html.includes('Changes stay local until you click Save Changes.'), 'dashboard explains staged-save behavior');
assert(html.includes('id="btnSave"'), 'save button is explicit');
assert(html.includes('function currentSettingsSnapshot()'), 'dashboard tracks saved snapshot');
assert(html.includes('function markDirty(reason)'), 'dashboard marks unsaved changes');
assert(!html.includes("vscode.postMessage({ command: 'scrollToggle'"), 'scroll toggle no longer auto-commits');
assert(!html.includes("vscode.postMessage({ command: 'toggleSkipBrowser'"), 'skip-browser toggle no longer auto-commits');

section('Tool activity heading is preserved');
assert(html.includes('function renderToolBreakdown(toolBreakdown)'), 'tool breakdown render helper exists');
assert(html.includes("tb.appendChild(makeEl('div', 'box-title', 'Tool Activity'))"), 'tool breakdown re-renders heading');

section('Insight sections are visible');
assert(html.includes('id="conceptMap"'), 'concept map container exists');
assert(html.includes('id="brainEpoch"'), 'brain epoch metric exists');
assert(html.includes('id="brainTracking"'), 'brain tracking metric exists');
assert(html.includes('id="brainPromoted"'), 'brain promoted metric exists');
assert(html.includes('id="roiDaily"'), 'daily ROI metric exists');
assert(html.includes('id="roiLifeClicks"'), 'lifetime clicks metric exists');
assert(html.includes('id="roiLifeSessions"'), 'lifetime sessions metric exists');

section('Preset and diagnostics UI');
assert(html.includes('id="presetBar"'), 'operation preset bar exists');
assert(html.includes('id="presetDesc"'), 'preset description exists');
assert(html.includes('id="traceFeed"'), 'decision trace feed exists');
assert(html.includes('id="diagLastBlocked"'), 'last blocked diagnostics exists');
assert(html.includes('id="selLogFilter"'), 'activity log filter exists');
assert(html.includes('id="chkSkipTerminal"'), 'native accept guard toggle exists');
assert(html.includes('function renderTrace()'), 'trace renderer exists');
assert(html.includes('function renderOperationPresets()'), 'preset renderer exists');

section('Accessible toggles');
assert(!html.includes('.tog input { display: none; }'), 'toggle inputs are not removed from keyboard flow');
assert(html.includes('.tog input:focus-visible + .tog-track'), 'toggle has visible focus state');
assert(html.includes('role="switch"'), 'toggle inputs expose switch role');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
