// ===========================================================
// AG Autopilot v7.1.0 — Lean & Reliable
//
// WHAT IT DOES:
//   1. Auto-click Allow/Run/Accept via Layer 0 (workbench main frame)
//   2. Auto-accept agent steps via VS Code commands (webview buttons)
//   3. Auto-scroll chat to bottom
//   4. Auto-approve ALL terminal commands (including curl/wget)
//   5. Notify user when quota exhausted (no auto-switch)
//   6. Monitor quota via Language Server API
//
// WHAT IT DOESN'T DO (by design):
//   - Auto-switch model (no reliable method exists)
// ===========================================================
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const http = require('http');

const TAG_START = '<!-- AG-AUTOPILOT-START -->';
const TAG_END = '<!-- AG-AUTOPILOT-END -->';
const OLD_TAGS = [
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->', '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->', '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->', '<!-- AG-TOOLKIT-END -->']
];

let statusBarItem, statusBarScroll, statusBarClicks, _settingsPanel = null;
let _autoAcceptEnabled = true, _httpScrollEnabled = true, _httpClickPatterns = [];
let _httpScrollConfig = { pauseScrollMs: 5000, scrollIntervalMs: 500, clickIntervalMs: 2000 };
let _clickStats = {}, _clickLog = [], _totalClicks = 0, _resetStatsRequested = false;
let _extensionContext = null, _httpServer = null, _actualPort = 0, _autoAcceptInterval = null;
const AG_HTTP_PORT_START = 48787, AG_HTTP_PORT_END = 48850;

const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion'
];

let _lsPort = 0, _lsCsrf = '', _lsConnected = false;
let _lastQuotaNotify = 0;

// =============================================================
// UTILITIES
// =============================================================
function writeFileElevated(fp, content) {
    try { fs.writeFileSync(fp, content, 'utf8'); } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
        const tmp = path.join(os.tmpdir(), 'ag-autopilot-' + Date.now() + '.tmp');
        fs.writeFileSync(tmp, content, 'utf8');
        try {
            if (process.platform === 'linux') execSync('pkexec bash -c "cp \'' + tmp + '\' \'' + fp + '\' && chmod 644 \'' + fp + '\'"', { timeout: 30000 });
            else if (process.platform === 'darwin') execSync('osascript -e \'do shell script "cp \'' + tmp + '\' \'' + fp + '\' && chmod 644 \'' + fp + '\'" with administrator privileges\'', { timeout: 30000 });
            else throw err;
        } catch (_) { try { fs.unlinkSync(tmp); } catch (__) {} throw new Error('Permission denied. Restart as Admin.'); }
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}
function getWorkbenchPath() {
    const r = vscode.env.appRoot;
    for (const p of [
        path.join(r,'out','vs','code','electron-browser','workbench','workbench.html'),
        path.join(r,'out','vs','code','electron-sandbox','workbench','workbench.html'),
        path.join(r,'out','vs','workbench','workbench.html'),
        path.join(r,'out','vs','code','browser','workbench','workbench.html'),
        path.join(r,'out','vs','code','electron-main','workbench','workbench.html'),
    ]) { if (fs.existsSync(p)) return p; }
    return findRec(path.join(r, 'out'), 'workbench.html', 6);
}
function findRec(dir, name, depth) {
    if (depth <= 0) return null;
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isFile() && e.name === name) return f;
        if (e.isDirectory()) { const r = findRec(f, name, depth - 1); if (r) return r; }
    }} catch (_) {} return null;
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =============================================================
// LANGUAGE SERVER API — quota monitoring
// =============================================================
function discoverLanguageServer() {
    try {
        const cmd = process.platform === 'win32'
            ? 'wmic process where "name like \'%language_server%\'" get CommandLine /format:list 2>nul'
            : 'ps aux | grep language_server_macos | grep -v grep | grep -v enable_lsp';
        const stdout = execSync(cmd, { timeout: 5000 }).toString();
        if (!stdout) return false;
        const csrfMatch = stdout.match(/--csrf_token\s+([a-f0-9-]+)/);
        if (!csrfMatch) return false;
        _lsCsrf = csrfMatch[1];
        const pidMatch = stdout.match(/^\S+\s+(\d+)/m);
        if (!pidMatch) return false;
        const portsCmd = process.platform === 'win32'
            ? 'netstat -ano | findstr ' + pidMatch[1] + ' | findstr LISTENING'
            : 'lsof -p ' + pidMatch[1] + ' -iTCP -sTCP:LISTEN -P -n 2>/dev/null';
        const portsOut = execSync(portsCmd, { timeout: 5000 }).toString();
        const ports = [...portsOut.matchAll(/127\.0\.0\.1:(\d+)/g)].map(m => parseInt(m[1]));
        for (const port of ports) {
            try {
                const ok = execSync(
                    'curl -sk --connect-timeout 2 -X POST -H "Content-Type: application/json" -H "X-Codeium-Csrf-Token: ' + _lsCsrf + '" -H "Connect-Protocol-Version: 1" "https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/GetUnleashData" -d \'{"wrapper_data":{}}\'',
                    { timeout: 5000 }
                ).toString();
                if (ok && ok.startsWith('{')) { _lsPort = port; _lsConnected = true; console.log('[AG] LS connected: port=' + port); return true; }
            } catch (_) {}
        }
        return false;
    } catch (e) { console.log('[AG] LS discovery failed:', e.message); return false; }
}

function fetchQuotaFromLS() {
    if (!_lsConnected) return Promise.resolve(null);
    return new Promise(resolve => {
        try {
            const result = execSync(
                'curl -sk --connect-timeout 3 -X POST -H "Content-Type: application/json" -H "X-Codeium-Csrf-Token: ' + _lsCsrf + '" -H "Connect-Protocol-Version: 1" "https://127.0.0.1:' + _lsPort + '/exa.language_server_pb.LanguageServerService/GetUserStatus" -d \'{"metadata":{"ideName":"antigravity"}}\'',
                { timeout: 8000 }
            ).toString();
            const d = JSON.parse(result);
            const credits = d.userStatus?.planStatus?.availablePromptCredits || 0;
            resolve({ credits });
        } catch (_) { _lsConnected = false; resolve(null); }
    });
}

// =============================================================
// ACCEPT LOOP
// =============================================================
function startAcceptLoop() {
    const c = vscode.workspace.getConfiguration('ag-auto');
    _autoAcceptEnabled = c.get('enabled', true);
    const ms = c.get('clickIntervalMs', 2000);
    if (_autoAcceptInterval) clearInterval(_autoAcceptInterval);
    _autoAcceptInterval = setInterval(() => {
        if (!_autoAcceptEnabled) return;
        // Fire all accept commands silently
        for (const cmd of ACCEPT_COMMANDS) {
            vscode.commands.executeCommand(cmd).catch(() => {});
        }
    }, ms);
}

// =============================================================
// SCRIPT BUILD & INJECT
// =============================================================
function buildScriptContent(ctx) {
    const c = vscode.workspace.getConfiguration('ag-auto');
    const dp = ctx.globalState.get('disabledClickPatterns', []);
    const pats = c.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept all','Accept']).filter(p => !dp.includes(p) && p !== 'Accept');
    const tpl = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'autoScript.js'), 'utf8');
    const wb = getWorkbenchPath();
    const cfgPath = wb ? path.join(path.dirname(wb), 'ag-auto-config.json').replace(/\\/g, '/') : '';
    let s = tpl;
    s = s.replace(/\/\*\{\{PAUSE_SCROLL_MS\}\}\*\/\d+/, String(c.get('scrollPauseMs', 7000)));
    s = s.replace(/\/\*\{\{SCROLL_INTERVAL_MS\}\}\*\/\d+/, String(c.get('scrollIntervalMs', 500)));
    s = s.replace(/\/\*\{\{CLICK_INTERVAL_MS\}\}\*\/\d+/, String(c.get('clickIntervalMs', 1000)));
    s = s.replace(/\/\*\{\{CLICK_PATTERNS\}\}\*\/\[.*?\]/, JSON.stringify(pats));
    s = s.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/, String(c.get('enabled', true)));
    s = s.replace(/\/\*\{\{CONFIG_PATH\}\}\*\//, cfgPath);
    s = s.replace(/\/\*\{\{SMART_ROUTER\}\}\*\/\w+/, 'false');
    s = s.replace(/\/\*\{\{QUOTA_FALLBACK\}\}\*\/\w+/, 'false');
    return s;
}
function writeConfigJson(ctx) {
    try {
        const wb = getWorkbenchPath(); if (!wb) return;
        const c = vscode.workspace.getConfiguration('ag-auto');
        const dp = ctx.globalState.get('disabledClickPatterns', []);
        const ap = c.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept']).filter(p => !dp.includes(p) && p !== 'Accept');
        writeFileElevated(path.join(path.dirname(wb), 'ag-auto-config.json'), JSON.stringify({
            enabled: c.get('enabled', true), clickPatterns: ap,
            acceptInChatOnly: c.get('clickPatterns', []).includes('Accept') && !dp.includes('Accept'),
            pauseScrollMs: c.get('scrollPauseMs', 7000), scrollIntervalMs: c.get('scrollIntervalMs', 500),
            clickIntervalMs: c.get('clickIntervalMs', 1000)
        }));
    } catch (e) { console.error('[AG] Config JSON error:', e.message); }
}
function installScript(ctx) {
    const wb = getWorkbenchPath();
    if (!wb) { vscode.window.showErrorMessage('[AG Autopilot] workbench.html not found!'); return false; }
    const dir = path.dirname(wb), sc = buildScriptContent(ctx);
    const JS_S = '/* AG-AUTO-CLICK-SCROLL-JS-START */', JS_E = '/* AG-AUTO-CLICK-SCROLL-JS-END */';
    try {
        const html = fs.readFileSync(wb, 'utf8');
        const sm = html.match(/src="([^"]*\.js)"/g) || [];
        const jsf = new Set();
        for (const m of sm) { const mm = m.match(/src="([^"]*\.js)"/); if (mm) { const n = path.basename(mm[1].split('?')[0]); if (n === 'ag-auto-script.js' || n === 'ag-modelswitch-client.js') continue; const s = path.join(dir, n); if (fs.existsSync(s)) jsf.add(s); } }
        for (const jp of jsf) { let jc = fs.readFileSync(jp, 'utf8'); const jr = new RegExp(escapeRegex(JS_S)+'[\\s\\S]*?'+escapeRegex(JS_E), 'g'); if (jr.test(jc)) { jc = jc.replace(jr, ''); writeFileElevated(jp, jc); } }
    } catch (e) { console.error('[AG] Cleanup error:', e.message); }
    try {
        let h = fs.readFileSync(wb, 'utf8');
        for (const [s, e] of [[TAG_START, TAG_END], ...OLD_TAGS]) h = h.replace(new RegExp(escapeRegex(s)+'[\\s\\S]*?'+escapeRegex(e), 'g'), '');
        for (const f of ['ag-modelswitch-client.js','ag-auto-script.js']) { const p = path.join(dir, f); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {} }
        writeFileElevated(path.join(dir, 'ag-auto-script.js'), sc);
        h = h.replace('</html>', '\n'+TAG_START+'\n<script src="ag-auto-script.js?v='+Date.now()+'"></script>\n'+TAG_END+'\n</html>');
        writeFileElevated(wb, h);
    } catch (e) { console.error('[AG] Inject error:', e.message); return false; }
    return true;
}
function updateChecksums() {
    try {
        let pjp = null;
        if (process.resourcesPath) { const c = path.join(process.resourcesPath,'app','product.json'); if (fs.existsSync(c)) pjp = c; }
        if (!pjp) { const w = getWorkbenchPath(); if (!w) return; let d = path.dirname(w); for (let i = 0; i < 8; i++) { const c = path.join(d,'product.json'); if (fs.existsSync(c)) { pjp = c; break; } d = path.dirname(d); } }
        if (!pjp) return;
        const pj = JSON.parse(fs.readFileSync(pjp, 'utf8')); if (!pj.checksums) return;
        const ar = path.dirname(pjp), od = path.join(ar, 'out'); let upd = false;
        for (const rp in pj.checksums) { const np = rp.split('/').join(path.sep); let fp = path.join(od, np); if (!fs.existsSync(fp)) fp = path.join(ar, np); if (fs.existsSync(fp)) { const h = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('base64').replace(/=+$/, ''); if (pj.checksums[rp] !== h) { pj.checksums[rp] = h; upd = true; } } }
        if (upd) writeFileElevated(pjp, JSON.stringify(pj, null, '\t'));
    } catch (_) {}
}
function clearCache() {
    try {
        let d;
        if (process.platform === 'win32') d = path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'), 'Antigravity','Code Cache','js');
        else if (process.platform === 'darwin') d = path.join(os.homedir(),'Library','Application Support','Antigravity','Code Cache','js');
        else d = path.join(os.homedir(),'.config','Antigravity','Code Cache','js');
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
}
function uninstallScript() {
    const wb = getWorkbenchPath(); if (!wb) return false;
    const dir = path.dirname(wb);
    try {
        let h = fs.readFileSync(wb, 'utf8');
        for (const [s, e] of [[TAG_START, TAG_END], ...OLD_TAGS]) h = h.replace(new RegExp(escapeRegex(s)+'[\\s\\S]*?'+escapeRegex(e), 'g'), '');
        writeFileElevated(wb, h);
        for (const f of ['ag-auto-script.js','ag-modelswitch-client.js']) { const p = path.join(dir, f); if (fs.existsSync(p)) fs.unlinkSync(p); }
        return true;
    } catch (e) { vscode.window.showErrorMessage('[AG] Uninstall failed: ' + e.message); return false; }
}
function isInjected() { try { const w = getWorkbenchPath(); return w ? fs.readFileSync(w, 'utf8').includes(TAG_START) : false; } catch (_) { return false; } }

// =============================================================
// SETTINGS PANEL
// =============================================================
function openSettingsPanel(ctx) {
    if (_settingsPanel) { _settingsPanel.dispose(); _settingsPanel = null; return; }
    const panel = vscode.window.createWebviewPanel('agAutoSettings', 'AG Autopilot - Settings', vscode.ViewColumn.One, { enableScripts: true });
    _settingsPanel = panel;
    panel.onDidDispose(() => { _settingsPanel = null; });
    const c = vscode.workspace.getConfiguration('ag-auto');
    panel.webview.html = getSettingsHtml({
        enabled: c.get('enabled', true), scrollEnabled: c.get('scrollEnabled', true),
        smartRouter: false, quotaFallback: false,
        scrollPauseMs: c.get('scrollPauseMs', 7000), scrollIntervalMs: c.get('scrollIntervalMs', 500),
        clickIntervalMs: c.get('clickIntervalMs', 1000),
        clickPatterns: c.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept']),
        disabledClickPatterns: ctx.globalState.get('disabledClickPatterns', []),
        language: c.get('language', 'vi'), clickStats: _clickStats, totalClicks: _totalClicks
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
        const cfg = vscode.workspace.getConfiguration('ag-auto');
        if (msg.command === 'changeLang') { await cfg.update('language', msg.lang, vscode.ConfigurationTarget.Global); panel.webview.html = getSettingsHtml({ enabled: cfg.get('enabled', true), scrollEnabled: cfg.get('scrollEnabled', true), smartRouter: false, quotaFallback: false, scrollPauseMs: cfg.get('scrollPauseMs', 7000), scrollIntervalMs: cfg.get('scrollIntervalMs', 500), clickIntervalMs: cfg.get('clickIntervalMs', 1000), clickPatterns: cfg.get('clickPatterns', ['Run','Allow','Always Allow','Keep Waiting','Accept']), disabledClickPatterns: ctx.globalState.get('disabledClickPatterns', []), language: msg.lang, clickStats: _clickStats, totalClicks: _totalClicks }); }
        if (msg.command === 'toggle') { _autoAcceptEnabled = msg.enabled; await cfg.update('enabled', msg.enabled, vscode.ConfigurationTarget.Global); writeConfigJson(ctx); updateStatusBar(); }
        if (msg.command === 'scrollToggle') { _httpScrollEnabled = msg.enabled; await cfg.update('scrollEnabled', msg.enabled, vscode.ConfigurationTarget.Global); writeConfigJson(ctx); updateStatusBar(); }
        if (msg.command === 'save') {
            const d = msg.data;
            await cfg.update('enabled', d.enabled, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollEnabled', d.scrollEnabled, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollPauseMs', d.scrollPauseMs, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollIntervalMs', d.scrollIntervalMs, vscode.ConfigurationTarget.Global);
            await cfg.update('clickIntervalMs', d.clickIntervalMs, vscode.ConfigurationTarget.Global);
            await cfg.update('clickPatterns', d.clickPatterns, vscode.ConfigurationTarget.Global);
            await ctx.globalState.update('disabledClickPatterns', d.disabledClickPatterns);
            _autoAcceptEnabled = d.enabled; _httpScrollEnabled = d.scrollEnabled !== false;
            _httpClickPatterns = d.clickPatterns.filter(p => !d.disabledClickPatterns.includes(p));
            writeConfigJson(ctx); updateStatusBar();
        }
        if (msg.command === 'reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
        if (msg.command === 'resetStats') { _clickStats = {}; _totalClicks = 0; ctx.globalState.update('clickStats', {}); ctx.globalState.update('totalClicks', 0); panel.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 }); }
        if (msg.command === 'clearClickLog') { _clickLog = []; if (_extensionContext) _extensionContext.globalState.update('clickLog', []); panel.webview.postMessage({ command: 'clickLogUpdate', log: [] }); }
        if (msg.command === 'getClickLog') panel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
        if (msg.command === 'getStats') panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
    }, undefined, ctx.subscriptions);
    const st = setInterval(() => { try { panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks }); } catch (_) { clearInterval(st); } }, 2000);
    panel.onDidDispose(() => clearInterval(st));
}
function getSettingsHtml(cfg) {
    const lang = cfg.language || 'vi';
    let h = fs.readFileSync(path.join(__dirname, '..', 'media', 'settings.html'), 'utf8');
    h = h.replace(/\{\{LANG\}\}/g, lang); h = h.replace('{{TOTAL_CLICKS}}', String(cfg.totalClicks || 0));
    h = h.replace('{{ENABLED_CHK}}', cfg.enabled ? 'checked' : ''); h = h.replace('{{SCROLL_CHK}}', cfg.scrollEnabled !== false ? 'checked' : '');
    h = h.replace('{{ROUTER_CHK}}', ''); h = h.replace('{{QUOTA_CHK}}', '');
    h = h.replace(/\{\{CLICK_MS\}\}/g, String(cfg.clickIntervalMs || 1000)); h = h.replace(/\{\{SCROLL_MS\}\}/g, String(cfg.scrollIntervalMs || 500));
    h = h.replace(/\{\{PAUSE_MS\}\}/g, String(cfg.scrollPauseMs || 7000));
    h = h.replace('{{LANG_VI}}', lang === 'vi' ? 'selected' : ''); h = h.replace('{{LANG_EN}}', lang === 'en' ? 'selected' : ''); h = h.replace('{{LANG_ZH}}', lang === 'zh' ? 'selected' : '');
    h = h.replace('{{PATTERNS_JSON}}', JSON.stringify(cfg.clickPatterns)); h = h.replace('{{DISABLED_JSON}}', JSON.stringify(cfg.disabledClickPatterns));
    h = h.replace('{{STATS_JSON}}', JSON.stringify(cfg.clickStats || {}));
    return h;
}

// =============================================================
// STATUS BAR
// =============================================================
function createStatusBar(ctx) {
    if (statusBarItem) statusBarItem.dispose();
    if (statusBarClicks) statusBarClicks.dispose();
    if (statusBarScroll) statusBarScroll.dispose();
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    statusBarItem.command = 'ag-auto.openSettings'; ctx.subscriptions.push(statusBarItem);
    statusBarClicks = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    statusBarClicks.command = 'ag-auto.openSettings'; statusBarClicks.color = '#f9e2af'; ctx.subscriptions.push(statusBarClicks);
    statusBarScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    statusBarScroll.command = 'ag-auto.openSettings'; ctx.subscriptions.push(statusBarScroll);
    updateStatusBar(); statusBarItem.show(); statusBarClicks.show(); statusBarScroll.show();
}
function updateStatusBar() {
    if (!statusBarItem) return;
    statusBarItem.text = _autoAcceptEnabled ? '$(check) AG ON' : '$(circle-slash) AG OFF';
    statusBarItem.color = _autoAcceptEnabled ? '#4EC9B0' : '#F44747';
    statusBarItem.backgroundColor = _autoAcceptEnabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    if (statusBarScroll) { statusBarScroll.text = _httpScrollEnabled ? '$(fold-down) Scroll' : '$(circle-slash) Scroll'; statusBarScroll.color = _httpScrollEnabled ? '#4EC9B0' : '#F44747'; }
    if (statusBarClicks) statusBarClicks.text = '$(target) ' + _totalClicks;
}

// =============================================================
// HTTP SERVER
// =============================================================
function startHttpServer() {
    if (_httpServer) return;
    const cfg = vscode.workspace.getConfiguration('ag-auto');
    _httpClickPatterns = cfg.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept']);
    ['Run','Allow','Accept','Always Allow','Keep Waiting','Retry','Continue','Allow Once','Allow This Con'].forEach(p => { if (!_httpClickPatterns.includes(p)) _httpClickPatterns.push(p); });
    _httpScrollEnabled = cfg.get('scrollEnabled', true);
    _httpScrollConfig = { pauseScrollMs: cfg.get('scrollPauseMs', 5000), scrollIntervalMs: cfg.get('scrollIntervalMs', 500), clickIntervalMs: cfg.get('clickIntervalMs', 2000) };
    try {
        const url = require('url');
        _httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
            const parsed = url.parse(req.url, true);
            if (parsed.query && parsed.query.stats) {
                try { const inc = JSON.parse(decodeURIComponent(parsed.query.stats)); for (const k in inc) { if (!_clickStats[k]) _clickStats[k] = 0; _clickStats[k] += inc[k]; } let t = 0; for (const k in _clickStats) t += _clickStats[k]; _totalClicks = t; if (statusBarClicks) statusBarClicks.text = '$(target) ' + _totalClicks; if (_extensionContext) { _extensionContext.globalState.update('clickStats', _clickStats); _extensionContext.globalState.update('totalClicks', _totalClicks); } } catch (_) {}
            }
            if (parsed.pathname === '/api/click-log' && req.method === 'POST') {
                let body = ''; req.on('data', c => body += c);
                req.on('end', () => {
                    try { const d = JSON.parse(body); const now = new Date(); const ts = [now.getHours(),now.getMinutes(),now.getSeconds()].map(n=>n<10?'0'+n:n).join(':')+' '+[now.getDate(),now.getMonth()+1].map(n=>n<10?'0'+n:n).join('/'); _clickLog.unshift({ time: ts, pattern: d.pattern || 'click', button: (d.button || '').substring(0, 80) }); if (_clickLog.length > 50) _clickLog.pop(); if (_extensionContext) _extensionContext.globalState.update('clickLog', _clickLog); res.writeHead(200); res.end('{"ok":true}'); } catch (_) { res.writeHead(200); res.end('{}'); }
                }); return;
            }
            if (parsed.pathname === '/api/quota-detected' && req.method === 'POST') {
                let body = ''; req.on('data', c => body += c);
                req.on('end', () => {
                    // Just notify user — no auto-switch
                    if (Date.now() - _lastQuotaNotify > 60000) {
                        _lastQuotaNotify = Date.now();
                        vscode.window.showWarningMessage('Quota exhausted — switch model manually', 'OK');
                    }
                    res.writeHead(200); res.end('{"notified":true}');
                }); return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({
                enabled: _autoAcceptEnabled, scrollEnabled: _httpScrollEnabled,
                clickPatterns: _httpClickPatterns.filter(p => p !== 'Accept'),
                acceptInChatOnly: _httpClickPatterns.includes('Accept'),
                pauseScrollMs: _httpScrollConfig.pauseScrollMs, scrollIntervalMs: _httpScrollConfig.scrollIntervalMs,
                clickIntervalMs: _httpScrollConfig.clickIntervalMs,
                clickStats: _clickStats, totalClicks: _totalClicks
            }));
        });
        function tryPort(port) {
            if (port > AG_HTTP_PORT_END) return;
            _httpServer.removeAllListeners('error');
            _httpServer.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
            _httpServer.listen(port, '127.0.0.1', () => { _actualPort = port; console.log('[AG] HTTP port ' + port); });
        }
        tryPort(AG_HTTP_PORT_START);
    } catch (e) { console.log('[AG] HTTP failed:', e.message); }
}

// =============================================================
// AUTO-APPROVE ALL COMMANDS
// =============================================================
function configureAutoApprove() {
    try {
        const cfg = vscode.workspace.getConfiguration();
        // Get current rules and force ALL false → true
        const rules = cfg.get('chat.tools.terminal.autoApprove') || {};
        if (typeof rules === 'object') {
            for (const key in rules) {
                if (rules[key] === false) rules[key] = true;
                if (typeof rules[key] === 'object' && rules[key].approve === false) rules[key].approve = true;
            }
            // Ensure critical commands are approved
            for (const cmd of ['curl','wget','rm','rmdir','chmod','chown','kill','dd','eval','jq','top','xargs']) rules[cmd] = true;
            rules['/^/'] = true;
            rules['/.*/s'] = true;
            cfg.update('chat.tools.terminal.autoApprove', rules, vscode.ConfigurationTarget.Global).catch(() => {});
        }
        cfg.update('chat.tools.terminal.enableAutoApprove', true, vscode.ConfigurationTarget.Global).catch(() => {});
        cfg.update('chat.tools.terminal.ignoreDefaultAutoApproveRules', true, vscode.ConfigurationTarget.Global).catch(() => {});
        cfg.update('chat.tools.terminal.autoReplyToPrompts', true, vscode.ConfigurationTarget.Global).catch(() => {});
        cfg.update('chat.tools.edits.autoApprove', true, vscode.ConfigurationTarget.Global).catch(() => {});
        cfg.update('chat.agent.terminal.autoApprove', true, vscode.ConfigurationTarget.Global).catch(() => {});
        console.log('[AG] Auto-approve configured');
    } catch (e) { console.log('[AG] Auto-approve error:', e.message); }
}

// =============================================================
// ACTIVATE / DEACTIVATE
// =============================================================
function activate(ctx) {
    console.log('[AG] v7.1.0 activating');
    _extensionContext = ctx;
    _clickStats = ctx.globalState.get('clickStats', {});
    _totalClicks = ctx.globalState.get('totalClicks', 0);
    _clickLog = ctx.globalState.get('clickLog', []) || [];

    // Inject Layer 0
    const ver = (ctx.extension && ctx.extension.packageJSON) ? ctx.extension.packageJSON.version : '0';
    const lastVer = ctx.globalState.get('ag-injected-version', '0');
    if (!isInjected() || ver !== lastVer) {
        try { installScript(ctx); ctx.globalState.update('ag-injected-version', ver); clearCache(); updateChecksums(); setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000); } catch (e) { console.error('[AG] Inject error:', e.message); }
    } else {
        try { const wb = getWorkbenchPath(); if (wb) writeFileElevated(path.join(path.dirname(wb), 'ag-auto-script.js'), buildScriptContent(ctx)); } catch (_) {}
        updateChecksums();
    }

    startHttpServer();
    startAcceptLoop();
    writeConfigJson(ctx);
    configureAutoApprove();

    // LS discovery
    setTimeout(() => { discoverLanguageServer(); }, 8000);
    setInterval(() => { if (!_lsConnected) discoverLanguageServer(); }, 60000);

    // Win32 Keep Waiting
    if (process.platform === 'win32') {
        const { execFile } = require('child_process');
        const ps = 'Add-Type @"\nusing System;using System.Text;using System.Runtime.InteropServices;\npublic class AgWin32{\npublic delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr hwnd,EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr w,IntPtr l);\n}\n"@\n$global:clicked=$false\n[AgWin32]::EnumWindows({param($hWnd,$lp)\nif(-not [AgWin32]::IsWindowVisible($hWnd)){return $true}\nif($global:clicked){return $false}\n[AgWin32]::EnumChildWindows($hWnd,{param($ch,$lp2)\n$cls=New-Object System.Text.StringBuilder 64\n[AgWin32]::GetClassName($ch,$cls,64)|Out-Null\nif($cls.ToString() -eq \'Button\'){$txt=New-Object System.Text.StringBuilder 256\n[AgWin32]::GetWindowText($ch,$txt,256)|Out-Null\nif($txt.ToString() -match \'Keep Waiting\'){[AgWin32]::PostMessage($ch,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$global:clicked=$true}}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){return $false}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){Write-Output \'CLICKED\'}';
        const kwi = setInterval(() => {
            if (!_autoAcceptEnabled) return;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') { _totalClicks++; if (statusBarClicks) statusBarClicks.text = '$(target) ' + _totalClicks; }
            });
        }, 3000);
        ctx.subscriptions.push({ dispose: () => clearInterval(kwi) });
    }

    createStatusBar(ctx);
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ag-auto')) updateStatusBar(); }));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.enable', async () => {
        if (installScript(ctx)) { const c = await vscode.window.showInformationMessage('[AG] Injected! Reload?', 'Reload'); if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    }));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.disable', async () => {
        if (uninstallScript()) { const c = await vscode.window.showInformationMessage('[AG] Removed! Reload?', 'Reload'); if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    }));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.openSettings', () => openSettingsPanel(ctx)));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.switchModel', () => {
        vscode.window.showInformationMessage('Use Cmd+Shift+, in chat input to switch model');
    }));
}

function deactivate() {
    if (statusBarItem) { statusBarItem.dispose(); statusBarItem = null; }
    if (statusBarClicks) { statusBarClicks.dispose(); statusBarClicks = null; }
    if (statusBarScroll) { statusBarScroll.dispose(); statusBarScroll = null; }
    if (_autoAcceptInterval) { clearInterval(_autoAcceptInterval); _autoAcceptInterval = null; }
    if (_httpServer) { try { _httpServer.close(); } catch (_) {} _httpServer = null; }
}

module.exports = { activate, deactivate };
