// ═══════════════════════════════════════════════════════════════
//  Grav — HTTP bridge (runtime <-> host communication)
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const http   = require('http');
const url    = require('url');
const { state } = require('./state');
const { PORT_START, PORT_END } = require('./constants');
const { cfg } = require('./utils');
const { evaluateCommand } = require('./terminal');
const { wikiQuery, recordCommandAction } = require('./learning');

function refreshBar() {
    // Import lazily to avoid circular deps at load time
    const { refreshBar: refresh } = require('./extension');
    refresh();
}

/**
 * Validate the bridge auth token from request headers.
 * Returns true if the token matches or if no token is configured.
 */
function validateToken(req) {
    if (!state.bridgeToken) return true;
    const token = req.headers['x-grav-token'] || '';
    return token === state.bridgeToken;
}

function startBridge() {
    if (state.httpServer) return;

    state.httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', 'vscode-webview://*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Grav-Token');
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        // Auth check — allow GET config without token for bridge discovery
        const u = url.parse(req.url, true);
        const isConfigPoll = req.method === 'GET' && !u.pathname.startsWith('/api/');
        if (!isConfigPoll && !validateToken(req)) {
            res.writeHead(403); res.end('{"error":"unauthorized"}'); return;
        }

        // Ingest click stats from runtime
        if (u.query && u.query.stats) {
            if (!validateToken(req)) { res.writeHead(403); res.end('{"error":"unauthorized"}'); return; }
            try {
                const inc = JSON.parse(decodeURIComponent(u.query.stats));
                for (const k in inc) { state.stats[k] = (state.stats[k] || 0) + inc[k]; }
                state.totalClicks = Object.values(state.stats).reduce((a, b) => a + b, 0);
                try { refreshBar(); } catch (_) {}
                if (state.ctx) { state.ctx.globalState.update('stats', state.stats); state.ctx.globalState.update('totalClicks', state.totalClicks); }
            } catch (_) {}
        }

        // Click log
        if (u.pathname === '/api/click-log' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const now = new Date();
                    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
                        .map(n => n < 10 ? '0' + n : n).join(':');
                    state.log.unshift({ time: ts, pattern: d.pattern || 'click', button: (d.button || '').substring(0, 80) });
                    if (state.log.length > 50) state.log.pop();
                    if (state.ctx) state.ctx.globalState.update('clickLog', state.log);

                    if (cfg('learnEnabled', true) && d.button) {
                        const btn = d.button.trim();
                        const cmdMatch = btn.match(/[`']([^`']+)[`']/) || btn.match(/^(?:Run|Allow|Execute)\s+(.+)/i);
                        if (cmdMatch) {
                            recordCommandAction(cmdMatch[1].trim(), 'approve', {
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                            });
                        }
                    }
                } catch (_) {}
                res.writeHead(200); res.end('{"ok":true}');
            });
            return;
        }

        // Terminal command evaluation
        if (u.pathname === '/api/eval-command' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const result = evaluateCommand(d.command || '');
                    res.writeHead(200); res.end(JSON.stringify(result));
                } catch (_) { res.writeHead(400); res.end('{"error":"bad request"}'); }
            });
            return;
        }

        // Wiki query
        if (u.pathname === '/api/wiki-query' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const result = d.command ? wikiQuery(d.command) : null;
                    res.writeHead(200); res.end(JSON.stringify(result || { error: 'not found' }));
                } catch (_) { res.writeHead(400); res.end('{"error":"bad request"}'); }
            });
            return;
        }

        // Wiki status
        if (u.pathname === '/api/wiki-status') {
            const status = {
                pages: Object.keys(state.wiki.index).length,
                concepts: Object.keys(state.wiki.concepts).length,
                contradictions: state.wiki.contradictions.filter(c => !c.resolved).length,
                synthesis: Object.keys(state.wiki.synthesis).length,
                logEntries: state.wiki.log.length,
                lastLint: state.wiki.lastLint,
            };
            res.writeHead(200); res.end(JSON.stringify(status));
            return;
        }

        // Terminal command learning feedback
        if (u.pathname === '/api/learn-command' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    if (cfg('learnEnabled', true) && d.command && d.action) {
                        recordCommandAction(d.command, d.action, {
                            exitCode: d.exitCode,
                            project: d.project || (vscode.workspace.workspaceFolders?.[0]?.name),
                            duration: d.duration,
                        });
                    }
                    res.writeHead(200); res.end('{"ok":true}');
                } catch (_) { res.writeHead(400); res.end('{"error":"bad request"}'); }
            });
            return;
        }

        // Quota detected
        if (u.pathname === '/api/quota-detected' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                if (Date.now() - state.lastQuotaMs > 60000) {
                    state.lastQuotaMs = Date.now();
                    console.log('[Grav] Quota exhaustion detected');
                }
                res.writeHead(200); res.end('{"notified":true}');
            });
            return;
        }

        // Default: serve config (includes bridge token for runtime validation)
        const dp = state.ctx ? state.ctx.globalState.get('disabledPatterns', []) : [];
        const pats = cfg('approvePatterns', ['Run','Allow','Always Allow','Keep Waiting','Continue','Retry'])
            .filter(p => !dp.includes(p) && p !== 'Accept');
        res.writeHead(200);
        res.end(JSON.stringify({
            enabled: state.enabled,
            scrollEnabled: state.scrollOn,
            patterns: pats,
            acceptInChatOnly: cfg('approvePatterns', []).includes('Accept') && !dp.includes('Accept'),
            pauseMs: cfg('scrollPauseMs', 7000),
            scrollMs: cfg('scrollIntervalMs', 500),
            approveMs: cfg('approveIntervalMs', 1000),
            bridgeToken: state.bridgeToken,
        }));
    });

    function tryPort(port) {
        if (port > PORT_END) return;
        state.httpServer.removeAllListeners('error');
        state.httpServer.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
        state.httpServer.listen(port, '127.0.0.1', () => { state.httpPort = port; });
    }
    tryPort(PORT_START);
}

module.exports = { startBridge };
