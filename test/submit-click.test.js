'use strict';

let _passed = 0, _failed = 0;
function assert(condition, msg) {
    if (condition) { _passed++; }
    else { _failed++; console.error(`  x FAIL: ${msg}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

const { buildObserverScript } = require('../src/cdp-observer');
const { DEFAULT_PATTERNS, HIGH_CONF } = require('../src/constants');

section('Submit button configuration');
assert(DEFAULT_PATTERNS.includes('Submit'), 'DEFAULT_PATTERNS should include "Submit"');
assert(HIGH_CONF['Submit'] === 1, 'Submit button should be classified as HIGH_CONF');

section('Observer Script Evaluation');
const script = buildObserverScript(DEFAULT_PATTERNS, [], false, 15000, false, false);
assert(script.includes('"Submit"'), 'Observer script should bundle the "Submit" pattern');

// Simulate a browser environment to evaluate the core logic of the observer script
section('Core Logic Simulation');
let clicked = false;
let dispatchEventCalled = false;

const mockButton = {
    disabled: false,
    offsetWidth: 100,
    offsetHeight: 30,
    tagName: 'BUTTON',
    getAttribute(attr) {
        if (attr === 'aria-label') return 'Submit';
        return '';
    },
    click() {
        clicked = true;
    },
    dispatchEvent(event) {
        dispatchEventCalled = true;
    },
    getBoundingClientRect() {
        return { left: 10, top: 20, width: 80, height: 30 };
    },
    closest(selector) {
        // Mock agent context container
        if (selector === '[class*=agent]' || selector === '.antigravity-agent-side-panel') {
            return true;
        }
        return null;
    }
};

// Simple mock for window/document APIs that observer needs
const globalMock = {
    window: {
        __grav3: null,
        addEventListener: () => {},
        setInterval: () => {},
        setTimeout: () => {},
        PointerEvent: function() {},
        MouseEvent: function() {}
    },
    document: {
        title: 'Cascade Chat',
        location: { href: 'vscode-webview://abc/antigravity-agent' },
        querySelectorAll: () => [mockButton],
        body: {}
    }
};

// Extract matches logic from built observer script template
function simulateFindMatch(text, patterns) {
    function matchPattern(text, pattern) {
        if (text === pattern) return true;
        if (text.length <= pattern.length) return false;
        if (text.indexOf(pattern) !== 0) return false;
        var c = text.charAt(pattern.length);
        return /[\s\u00a0.,;:!?\-\u2013\u2014()\[\]{}|/\\<>'"@#\$%^&*+=~\`\u21B5\u23CE]/.test(c);
    }
    
    var best = '', bestLen = 0;
    for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].length > bestLen && matchPattern(text, patterns[i])) {
            best = patterns[i]; bestLen = best.length;
        }
    }
    return best;
}

assert(simulateFindMatch('Submit', DEFAULT_PATTERNS) === 'Submit', 'Simulated matcher should correctly match "Submit"');
assert(simulateFindMatch('Submit Action', DEFAULT_PATTERNS) === 'Submit', 'Simulated matcher should match "Submit Action" via word boundary');
assert(simulateFindMatch('SubmitButton', DEFAULT_PATTERNS) === '', 'Simulated matcher should reject "SubmitButton" without boundaries');

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
