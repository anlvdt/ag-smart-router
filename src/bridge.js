// ═══════════════════════════════════════════════════════════════
//  Grav — HTTP Bridge (runtime ↔ host communication)
//
//  Handles all HTTP endpoints for runtime sync, click logging,
//  command evaluation, wiki queries, session tracking, etc.
//  Input validation on all POST endpoints.
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const http   = require('http');
const url    = require('url');

const { PORT_START, PORT_END, DEFAULT_PATTERNS } = require('./constants');
const { cfg } = require('./utils');

// ── State ────────────────────────────────────────────────────
let _server    = null;
let _port      = 0;
let _ctx       = null;
let _deps      = null;  // { learning, wiki, injection, getState, setState }

const MAX_BODY = 64 * 1024; // 64KB max POST body

/** Read POST body with size limit. */
function readBody(req, cb) {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        body += chunk;
    });
    req.on('end', () => cb(body));
}

/** Safe JSON parse — returns null on failure. */
function parseJSON(str) {
    try { return JSON.parse(str); } catch (_) { return null; }
}

/** Validate string field. */
function isStr(v, maxLen = 500) {
    return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

/**
 * Initialize and start the HTTP bridge.
 * @param {vscode.ExtensionContext} ctx
 * @param {object} deps - module references
 */
function start(ctx, deps) {
    if (_server) return;
    _ctx  = ctx;
    _deps = deps;

    _server = http.createServer(handleRequest);

    function tryPort(port) {
        if (port > PORT_END) return;
        _server.removeAllListeners('error');
        _server.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
        _server.listen(port, '127.0.0.1', () => { _port = port; });
    }
    tryPort(PORT_START);
}

function stop() {
    if (_server) try { _server.close(); } catch (_) {}
    _server = null;
    _port = 0;
}

function getPort() { return _port; }

// ── Request Handler ──────────────────────────────────────────
function handleRequest(req, res) {
    // Security: only accept requests from localhost
    const origin = req.headers.origin || '';
    const isLocal = !origin || origin.startsWith('vscode-webview://') || origin === 'http://127.0.0.1' || origin.startsWith('http://127.0.0.1:');
    res.setHeader('Access-Control-Allow-Origin', isLocal ? (origin || '*') : 'null');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!isLocal && origin) { res.writeHead(403); res.end('{"error":"forbidden"}'); return; }

    const u = url.parse(req.url, true);
    const state = _deps.getState();

    // ── Ingest click stats from runtime (via query string) ──
    if (u.query && u.query.stats) {
        try {
            const inc = parseJSON(decodeURIComponent(u.query.stats));
            if (inc && typeof inc === 'object') {
                for (const k in inc) {
                    if (typeof inc[k] === 'number') state.stats[k] = (state.stats[k] || 0) + inc[k];
                }
                state.totalClicks = Object.values(state.stats).reduce((a, b) => a + b, 0);
                _deps.onStatsUpdated();
            }
        } catch (_) {}
    }

    // ── Route: Click log ──
    if (u.pathname === '/api/click-log' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d) { res.writeHead(400); res.end('{"error":"invalid json"}'); return; }

            const now = new Date();
            const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
                .map(n => n < 10 ? '0' + n : n).join(':');
            const pattern = isStr(d.pattern, 60) ? d.pattern : 'click';
            const button = isStr(d.button, 80) ? d.button.substring(0, 80) : '';

            state.log.unshift({ time: ts, pattern, button });
            if (state.log.length > 50) state.log.pop();

            if (d.source === 'grav') state.session.approveCount++;

            _deps.onClickLogged(d);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // ── Route: Command evaluation ──
    if (u.pathname === '/api/eval-command' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.command)) { res.writeHead(400); res.end('{"error":"missing command"}'); return; }
            const result = _deps.learning.evaluateCommand(d.command);
            res.writeHead(200); res.end(JSON.stringify(result));
        });
        return;
    }

    // ── Route: Wiki query ──
    if (u.pathname === '/api/wiki-query' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.command)) { res.writeHead(400); res.end('{"error":"missing command"}'); return; }
            const result = _deps.wiki.query(d.command);
            res.writeHead(200); res.end(JSON.stringify(result || { error: 'not found' }));
        });
        return;
    }

    // ── Route: Wiki status ──
    if (u.pathname === '/api/wiki-status') {
        const w = _deps.wiki.getWiki();
        res.writeHead(200); res.end(JSON.stringify({
            pages: Object.keys(w.index).length,
            concepts: Object.keys(w.concepts).length,
            contradictions: _deps.wiki.getContradictions().length,
        }));
        return;
    }

    // ── Route: Learn command ──
    if (u.pathname === '/api/learn-command' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.command) || !isStr(d.action, 10)) {
                res.writeHead(400); res.end('{"error":"missing command/action"}'); return;
            }
            if (d.action !== 'approve' && d.action !== 'reject') {
                res.writeHead(400); res.end('{"error":"action must be approve or reject"}'); return;
            }
            _deps.learning.recordAction(d.command, d.action, {
                exitCode: typeof d.exitCode === 'number' ? d.exitCode : undefined,
                project: isStr(d.project, 100) ? d.project : (vscode.workspace.workspaceFolders?.[0]?.name),
            });
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // ── Route: Quota detected ──
    if (u.pathname === '/api/quota-detected' && req.method === 'POST') {
        readBody(req, () => {
            _deps.onQuotaDetected();
            res.writeHead(200); res.end('{"notified":true}');
        });
        return;
    }

    // ── Route: Chat event (session intelligence) ──
    if (u.pathname === '/api/chat-event' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.type, 30)) { res.writeHead(200); res.end('{"ok":true}'); return; }
            _deps.onChatEvent(d);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // ── Route: Terminal event (UI-scan capture) ──
    if (u.pathname === '/api/terminal-event' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.cmd)) { res.writeHead(200); res.end('{"ok":true}'); return; }
            _deps.onTerminalEvent(d);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // ── Route: Command blocked (Safety Guard) ──
    if (u.pathname === '/api/command-blocked' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (d && isStr(d.cmd) && isStr(d.reason, 100)) {
                _deps.onCommandBlocked(d.cmd, d.reason);
            }
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // ── Route: Pattern discovery (GEPA) ──
    if (u.pathname === '/api/pattern-discovered' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !Array.isArray(d.patterns)) { res.writeHead(200); res.end('{"ok":true}'); return; }
            // Validate each pattern is a safe string
            const safe = d.patterns.filter(p => isStr(p, 60)).slice(0, 20);
            if (safe.length > 0) _deps.onPatternsDiscovered(safe);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // ── Route: Behavior stats ──
    if (u.pathname === '/api/behavior-stats') {
        res.writeHead(200); res.end(JSON.stringify(_deps.getSessionSafe()));
        return;
    }

    // ── Default: Status response (for bridge discovery) ──
    const dp = _ctx ? _ctx.globalState.get('disabledPatterns', []) : [];
    const pats = cfg('approvePatterns', DEFAULT_PATTERNS).filter(p => !dp.includes(p));
    res.writeHead(200);
    res.end(JSON.stringify({
        enabled: state.enabled,
        scrollEnabled: state.scrollOn,
        patterns: pats,
        acceptInChatOnly: cfg('approvePatterns', []).includes('Accept') && !dp.includes('Accept'),
        pauseMs: cfg('scrollPauseMs', 7000),
        scrollMs: cfg('scrollIntervalMs', 500),
        approveMs: cfg('approveIntervalMs', 1000),
    }));
}

module.exports = { start, stop, getPort };
