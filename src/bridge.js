'use strict';

const vscode = require('vscode');
const http = require('http');
const url = require('url');

const { PORT_START, PORT_END, DEFAULT_PATTERNS } = require('./constants');
const { cfg } = require('./utils');

let _server = null, _port = 0, _ctx = null, _deps = null;
const MAX_BODY = 64 * 1024;

// Rate limiting: max requests per IP per window
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX = 120;         // 120 requests per minute
const _rateLimits = new Map();      // ip → { count, resetAt }

function isRateLimited(ip) {
    const now = Date.now();
    let entry = _rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    }
    entry.count++;
    _rateLimits.set(ip, entry);
    // Prune stale entries periodically
    if (_rateLimits.size > 50) {
        for (const [k, v] of _rateLimits) { if (now > v.resetAt) _rateLimits.delete(k); }
    }
    return entry.count > RATE_LIMIT_MAX;
}

const readBody = (req, cb) => {
    let body = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { req.destroy(); return; } body += chunk; });
    req.on('end', () => cb(body));
};

const parseJSON = (str) => { try { return JSON.parse(str); } catch (_) { return null; } };
const isStr = (v, maxLen = 500) => typeof v === 'string' && v.length > 0 && v.length <= maxLen;

function start(ctx, deps) {
    if (_server) return;
    _ctx = ctx;
    _deps = deps;
    _server = http.createServer(handleRequest);

    const tryPort = (port) => {
        if (port > PORT_END) return;
        _server.removeAllListeners('error');
        _server.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
        _server.listen(port, '127.0.0.1', () => { _port = port; });
    };
    tryPort(PORT_START);
}

function stop() { if (_server) try { _server.close(); } catch (_) { /* cleanup */ } _server = null; _port = 0; }
function getPort() { return _port; }

function handleRequest(req, res) {
    // Rate limiting
    const clientIp = req.socket.remoteAddress || '127.0.0.1';
    if (isRateLimited(clientIp)) {
        res.writeHead(429);
        res.end('{"error":"rate limited"}');
        return;
    }

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

    // Stats from runtime
    if (u.query && u.query.stats) {
        try { const inc = parseJSON(decodeURIComponent(u.query.stats)); if (inc && typeof inc === 'object') { for (const k in inc) { if (typeof inc[k] === 'number') state.stats[k] = (state.stats[k] || 0) + inc[k]; } state.totalClicks = Object.values(state.stats).reduce((a, b) => a + b, 0); _deps.onStatsUpdated(); } } catch (_) { /* non-critical */ }
    }

    // Click log
    if (u.pathname === '/api/click-log' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d) { res.writeHead(400); res.end('{"error":"invalid json"}'); return; }
            const now = new Date();
            const ts = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => n < 10 ? '0' + n : n).join(':');
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

    // Command evaluation
    if (u.pathname === '/api/eval-command' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.command)) { res.writeHead(400); res.end('{"error":"missing command"}'); return; }
            const result = _deps.learning.evaluateCommand(d.command);
            res.writeHead(200); res.end(JSON.stringify(result));
        });
        return;
    }

    // Wiki query
    if (u.pathname === '/api/wiki-query' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.command)) { res.writeHead(400); res.end('{"error":"missing command"}'); return; }
            const result = _deps.wiki.query(d.command);
            res.writeHead(200); res.end(JSON.stringify(result || { error: 'not found' }));
        });
        return;
    }

    // Wiki status
    if (u.pathname === '/api/wiki-status') {
        const w = _deps.wiki.getWiki();
        res.writeHead(200); res.end(JSON.stringify({ pages: Object.keys(w.index).length, concepts: Object.keys(w.concepts).length, contradictions: _deps.wiki.getContradictions().length }));
        return;
    }

    // Learn command
    if (u.pathname === '/api/learn-command' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.command) || !isStr(d.action, 10)) { res.writeHead(400); res.end('{"error":"missing command/action"}'); return; }
            if (d.action !== 'approve' && d.action !== 'reject') { res.writeHead(400); res.end('{"error":"action must be approve or reject"}'); return; }
            _deps.learning.recordAction(d.command, d.action, { exitCode: typeof d.exitCode === 'number' ? d.exitCode : undefined, project: isStr(d.project, 100) ? d.project : (vscode.workspace.workspaceFolders?.[0]?.name) });
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // Chat event
    if (u.pathname === '/api/chat-event' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.type, 30)) { res.writeHead(200); res.end('{"ok":true}'); return; }
            _deps.onChatEvent(d);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // Terminal event
    if (u.pathname === '/api/terminal-event' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !isStr(d.cmd)) { res.writeHead(200); res.end('{"ok":true}'); return; }
            _deps.onTerminalEvent(d);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // Command blocked
    if (u.pathname === '/api/command-blocked' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (d && isStr(d.cmd) && isStr(d.reason, 100)) _deps.onCommandBlocked(d.cmd, d.reason);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // Pattern discovered
    if (u.pathname === '/api/pattern-discovered' && req.method === 'POST') {
        readBody(req, body => {
            const d = parseJSON(body);
            if (!d || !Array.isArray(d.patterns)) { res.writeHead(200); res.end('{"ok":true}'); return; }
            const safe = d.patterns.filter(p => isStr(p, 60)).slice(0, 20);
            if (safe.length > 0) _deps.onPatternsDiscovered(safe);
            res.writeHead(200); res.end('{"ok":true}');
        });
        return;
    }

    // Behavior stats
    if (u.pathname === '/api/behavior-stats') {
        res.writeHead(200); res.end(JSON.stringify(_deps.getSessionSafe()));
        return;
    }

    // Status
    const dp = _ctx ? _ctx.globalState.get('disabledPatterns', []) : [];
    const pats = cfg('approvePatterns', DEFAULT_PATTERNS).filter(p => !dp.includes(p));
    res.writeHead(200);
    res.end(JSON.stringify({ enabled: state.enabled, scrollEnabled: state.scrollOn, patterns: pats, acceptInChatOnly: cfg('approvePatterns', []).includes('Accept') && !dp.includes('Accept'), pauseMs: cfg('scrollPauseMs', 7000), scrollMs: cfg('scrollIntervalMs', 500), approveMs: cfg('approveIntervalMs', 1000) }));
}

module.exports = { start, stop, getPort };