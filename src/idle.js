'use strict';

const vscode = require('vscode');

// Idle detection: pause auto-accept when user is actively typing,
// resume after idle period. Prevents clicking buttons while user
// is in the middle of editing.

const IDLE_THRESHOLD_MS = 3000; // 3s of no typing = idle
let _lastTypeMs = 0;
let _isIdle = true;
let _timer = null;
let _onIdleChange = null;
let _disposables = [];

function init(ctx, opts = {}) {
    _onIdleChange = opts.onIdleChange || null;
    _lastTypeMs = Date.now();
    _isIdle = true;

    // Listen to text document changes (user typing)
    _disposables.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            // Only count user-initiated changes (not programmatic)
            if (e.contentChanges.length > 0) {
                _lastTypeMs = Date.now();
                if (_isIdle) {
                    _isIdle = false;
                    if (_onIdleChange) _onIdleChange(false);
                }
            }
        })
    );

    // Listen to selection changes (cursor movement)
    _disposables.push(
        vscode.window.onDidChangeTextEditorSelection(() => {
            _lastTypeMs = Date.now();
        })
    );

    // Poll for idle state
    _timer = setInterval(() => {
        const now = Date.now();
        const wasIdle = _isIdle;
        _isIdle = (now - _lastTypeMs) >= IDLE_THRESHOLD_MS;
        if (_isIdle !== wasIdle && _onIdleChange) {
            _onIdleChange(_isIdle);
        }
    }, 1000);

    ctx.subscriptions.push({ dispose: () => stop() });
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
    for (const d of _disposables) try { d.dispose(); } catch (_) { /* cleanup */ }
    _disposables = [];
}

function isIdle() { return _isIdle; }
function getLastTypeMs() { return _lastTypeMs; }

module.exports = { init, stop, isIdle, getLastTypeMs };