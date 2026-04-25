// ═══════════════════════════════════════════════════════════════
//  Grav v1.0.0 — Autopilot for Antigravity
//
//  Architecture:
//    Runtime (injected into workbench.html)
//      → Auto-approve buttons in main DOM
//      → Stick-to-bottom scroll
//      → Quota radar (detect exhaustion banners)
//      → Corrupt-banner suppression
//
//    Host (this file, runs in extension process)
//      → Accept loop via VS Code command API
//      → HTTP bridge for runtime ↔ host sync
//      → Safe terminal auto-approve (whitelist/blacklist)
//      → Dashboard (webview)
//      → AI Learning Engine (Karpathy-inspired)
//      → Language Server quota monitoring
//      → Win32 native button handler
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const os     = require('os');
const crypto = require('crypto');
const { execSync, execFile } = require('child_process');

const { state, createEmptyWiki } = require('./state');
const { ACCEPT_CMDS, SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, LEARN } = require('./constants');
const { cfg } = require('./utils');
const { inject, eject, isInjected, patchChecksums, clearCodeCache, writeRuntimeConfig } = require('./inject');
const { loadLearnData, getPromotedCommands, getLearnStats, wikiQuery, wikiLint } = require('./learning');
const { extractCommands, evaluateCommand, setupSafeApprove, setupTerminalListener } = require('./terminal');
const { startBridge } = require('./bridge');
const { openDashboard } = require('./dashboard');

// ── Status bar ───────────────────────────────────────────────

function createBar() {
    state.sbMain   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    state.sbClicks = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    state.sbScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    state.sbMain.command   = 'grav.dashboard';
    state.sbClicks.command = 'grav.dashboard';
    state.sbScroll.command = 'grav.dashboard';
    state.sbClicks.color   = '#f9e2af';
    state.ctx.subscriptions.push(state.sbMain, state.sbClicks, state.sbScroll);
    refreshBar();
    state.sbMain.show(); state.sbClicks.show(); state.sbScroll.show();
}

function refreshBar() {
    if (!state.sbMain) return;
    state.sbMain.text  = state.enabled ? '$(rocket) Grav' : '$(circle-slash) Grav';
    state.sbMain.color = state.enabled ? '#94e2d5' : '#f38ba8';
    state.sbMain.backgroundColor = state.enabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    if (state.sbScroll) {
        state.sbScroll.text  = state.scrollOn ? '$(fold-down) Scroll' : '$(circle-slash) Scroll';
        state.sbScroll.color = state.scrollOn ? '#94e2d5' : '#f38ba8';
    }
    if (state.sbClicks) state.sbClicks.text = '$(target) ' + state.totalClicks;
}

// ── Language Server quota monitoring ─────────────────────────

function discoverLS() {
    try {
        const cmd = process.platform === 'win32'
            ? 'wmic process where "name like \'%language_server%\'" get CommandLine /format:list 2>nul'
            : 'ps aux | grep language_server_macos | grep -v grep | grep -v enable_lsp';
        const out = execSync(cmd, { timeout: 5000 }).toString();
        if (!out) return false;
        const csrf = out.match(/--csrf_token\s+([a-f0-9-]+)/);
        if (!csrf) return false;
        state.lsCsrf = csrf[1];
        const pid = out.match(/^\S+\s+(\d+)/m);
        if (!pid) return false;
        const portsCmd = process.platform === 'win32'
            ? 'netstat -ano | findstr ' + pid[1] + ' | findstr LISTENING'
            : 'lsof -p ' + pid[1] + ' -iTCP -sTCP:LISTEN -P -n 2>/dev/null';
        const portsOut = execSync(portsCmd, { timeout: 5000 }).toString();
        const ports = [...portsOut.matchAll(/127\.0\.0\.1:(\d+)/g)].map(m => parseInt(m[1]));
        for (const port of ports) {
            try {
                const ok = execSync(
                    `curl -sk --connect-timeout 2 -X POST -H "Content-Type: application/json" -H "X-Codeium-Csrf-Token: ${state.lsCsrf}" -H "Connect-Protocol-Version: 1" "https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUnleashData" -d '{"wrapper_data":{}}'`,
                    { timeout: 5000 }
                ).toString();
                if (ok && ok.startsWith('{')) { state.lsPort = port; state.lsOk = true; return true; }
            } catch (_) {}
        }
    } catch (_) {}
    return false;
}

// ── Accept loop ──────────────────────────────────────────────

function startAcceptLoop() {
    if (state.acceptTimer) clearInterval(state.acceptTimer);
    const ms = cfg('approveIntervalMs', 2000);
    state.acceptTimer = setInterval(() => {
        if (!state.enabled) return;
        for (const cmd of ACCEPT_CMDS) vscode.commands.executeCommand(cmd).catch(() => {});
    }, ms);
}

// ═════════════════════════════════════════════════════════════
//  Activate / Deactivate
// ═════════════════════════════════════════════════════════════

function activate(ctx) {
    state.ctx = ctx;
    state.stats       = ctx.globalState.get('stats', {});
    state.totalClicks = ctx.globalState.get('totalClicks', 0);
    state.log         = ctx.globalState.get('clickLog', []) || [];
    state.enabled     = cfg('enabled', true);
    state.scrollOn    = cfg('autoScroll', true);

    // Generate auth token for HTTP bridge security
    state.bridgeToken = crypto.randomBytes(16).toString('hex');

    // Inject runtime
    const ver     = ctx.extension?.packageJSON?.version || '0';
    const lastVer = ctx.globalState.get('grav-version', '0');
    if (!isInjected() || ver !== lastVer) {
        try {
            inject();
            ctx.globalState.update('grav-version', ver);
            clearCodeCache();
            patchChecksums();
            setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000);
        } catch (e) { console.error('[Grav] inject:', e.message); }
    } else {
        try {
            const { buildRuntime } = require('./inject');
            const { workbenchPath, elevatedWrite } = require('./utils');
            const path = require('path');
            const wb = workbenchPath();
            if (wb) elevatedWrite(path.join(path.dirname(wb), 'grav-runtime.js'), buildRuntime());
        } catch (_) {}
        patchChecksums();
    }

    startBridge();
    startAcceptLoop();
    writeRuntimeConfig();
    loadLearnData();
    setupSafeApprove();

    // LS discovery
    setTimeout(() => discoverLS(), 8000);
    setInterval(() => { if (!state.lsOk) discoverLS(); }, 60000);

    // Win32 native "Keep Waiting" handler
    if (process.platform === 'win32') {
        const ps = 'Add-Type @"\nusing System;using System.Text;using System.Runtime.InteropServices;\npublic class GravWin32{\npublic delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr hwnd,EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr w,IntPtr l);\n}\n"@\n$global:clicked=$false\n[GravWin32]::EnumWindows({param($hWnd,$lp)\nif(-not [GravWin32]::IsWindowVisible($hWnd)){return $true}\nif($global:clicked){return $false}\n[GravWin32]::EnumChildWindows($hWnd,{param($ch,$lp2)\n$cls=New-Object System.Text.StringBuilder 64\n[GravWin32]::GetClassName($ch,$cls,64)|Out-Null\nif($cls.ToString() -eq \'Button\'){$txt=New-Object System.Text.StringBuilder 256\n[GravWin32]::GetWindowText($ch,$txt,256)|Out-Null\nif($txt.ToString() -match \'Keep Waiting\'){[GravWin32]::PostMessage($ch,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$global:clicked=$true}}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){return $false}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){Write-Output \'CLICKED\'}';
        const kwi = setInterval(() => {
            if (!state.enabled) return;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') { state.totalClicks++; refreshBar(); }
            });
        }, 3000);
        ctx.subscriptions.push({ dispose: () => clearInterval(kwi) });
    }

    createBar();
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) { state.enabled = cfg('enabled', true); state.scrollOn = cfg('autoScroll', true); refreshBar(); }
    }));

    // Terminal Activity Listener
    setupTerminalListener(ctx);

    // ── Commands ──────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand('grav.inject', async () => {
            if (inject()) {
                const c = await vscode.window.showInformationMessage('[Grav] Runtime injected. Reload?', 'Reload');
                if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
        vscode.commands.registerCommand('grav.eject', async () => {
            if (eject()) {
                const c = await vscode.window.showInformationMessage('[Grav] Runtime removed. Reload?', 'Reload');
                if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
        vscode.commands.registerCommand('grav.dashboard', () => openDashboard()),
        vscode.commands.registerCommand('grav.diagnostics', async () => {
            const promoted = getPromotedCommands();
            const stats = getLearnStats();
            const lines = [
                `Grav v1.0.0`,
                `Platform: ${process.platform} (${os.arch()})`,
                `HTTP bridge: ${state.httpPort || 'not started'}`,
                `Enabled: ${state.enabled}  Scroll: ${state.scrollOn}`,
                `Total clicks: ${state.totalClicks}`,
                `LS: ${state.lsOk ? 'port ' + state.lsPort : 'disconnected'}`,
                ``,
                `\u2500\u2500 Terminal Command Management \u2500\u2500`,
                `Built-in whitelist: ${SAFE_TERMINAL_CMDS.length} commands`,
                `User whitelist: ${state.userWhitelist.length} (${state.userWhitelist.join(', ') || 'none'})`,
                `User blacklist: ${state.userBlacklist.length} (${state.userBlacklist.join(', ') || 'none'})`,
                ``,
                `\u2500\u2500 Karpathy Learning Engine \u2500\u2500`,
                `Epoch: ${stats.epoch}`,
                `Tracking: ${stats.totalTracked} commands`,
                `Promoted (conf \u2265 ${LEARN.PROMOTE_THRESH}): ${promoted.length} (${promoted.join(', ') || 'none'})`,
                `Generalized patterns: ${stats.patterns} (${state.patternCache.join(', ') || 'none'})`,
                `Learning rate (\u03b1): ${LEARN.ALPHA}`,
                `Momentum: ${LEARN.MOMENTUM}`,
                `Decay (\u03b3): ${LEARN.GAMMA}`,
                `Learning enabled: ${cfg('learnEnabled', true)}`,
            ];
            const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('grav.manageTerminal', async () => {
            const actions = [
                { label: '$(add) Th\u00eam v\u00e0o Whitelist', description: 'Add command to whitelist', action: 'addWhite' },
                { label: '$(remove) X\u00f3a kh\u1ecfi Whitelist', description: 'Remove from whitelist', action: 'removeWhite' },
                { label: '$(shield) Th\u00eam v\u00e0o Blacklist', description: 'Block a command', action: 'addBlack' },
                { label: '$(trash) X\u00f3a kh\u1ecfi Blacklist', description: 'Unblock a command', action: 'removeBlack' },
                { label: '$(search) Ki\u1ec3m tra l\u1ec7nh', description: 'Test if a command would be allowed', action: 'test' },
                { label: '$(book) Xem t\u1ea5t c\u1ea3', description: 'View all whitelist/blacklist', action: 'viewAll' },
                { label: '$(graph) Learning Stats', description: 'View adaptive learning data', action: 'learnStats' },
                { label: '$(notebook) Second Brain Wiki', description: 'View compiled knowledge wiki', action: 'viewWiki' },
                { label: '$(warning) Contradictions', description: 'View detected contradictions', action: 'viewContradictions' },
                { label: '$(checklist) Lint Wiki', description: 'Health-check the knowledge base', action: 'lintWiki' },
                { label: '$(clear-all) Reset Learning', description: 'Clear all learned data', action: 'resetLearn' },
            ];
            const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'Qu\u1ea3n l\u00fd Terminal Commands' });
            if (!pick) return;
            const c = vscode.workspace.getConfiguration('grav');

            switch (pick.action) {
                case 'addWhite': {
                    const cmd = await vscode.window.showInputBox({ prompt: 'Nh\u1eadp t\u00ean l\u1ec7nh (vd: terraform, ansible-playbook)', placeHolder: 'command-name' });
                    if (!cmd) return;
                    const name = cmd.trim().toLowerCase();
                    if (state.userWhitelist.includes(name)) { vscode.window.showInformationMessage(`"${name}" \u0111\u00e3 c\u00f3 trong whitelist`); return; }
                    state.userWhitelist.push(name);
                    await c.update('terminalWhitelist', state.userWhitelist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] \u2713 "${name}" \u2192 whitelist`);
                    break;
                }
                case 'removeWhite': {
                    if (state.userWhitelist.length === 0) { vscode.window.showInformationMessage('Whitelist tr\u1ed1ng'); return; }
                    const items = state.userWhitelist.map(w => ({ label: w }));
                    const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Ch\u1ecdn l\u1ec7nh \u0111\u1ec3 x\u00f3a', canPickMany: true });
                    if (!sel || sel.length === 0) return;
                    const toRemove = sel.map(s => s.label);
                    state.userWhitelist = state.userWhitelist.filter(w => !toRemove.includes(w));
                    await c.update('terminalWhitelist', state.userWhitelist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] \u0110\u00e3 x\u00f3a ${toRemove.join(', ')} kh\u1ecfi whitelist`);
                    break;
                }
                case 'addBlack': {
                    const cmd = await vscode.window.showInputBox({ prompt: 'Nh\u1eadp l\u1ec7nh/pattern c\u1ea7n ch\u1eb7n (vd: rm -rf, /eval.*/, sudo su)', placeHolder: 'command or /regex/' });
                    if (!cmd) return;
                    const pattern = cmd.trim();
                    if (state.userBlacklist.includes(pattern)) { vscode.window.showInformationMessage(`"${pattern}" \u0111\u00e3 c\u00f3 trong blacklist`); return; }
                    state.userBlacklist.push(pattern);
                    await c.update('terminalBlacklist', state.userBlacklist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] \u2717 "${pattern}" \u2192 blacklist`);
                    break;
                }
                case 'removeBlack': {
                    if (state.userBlacklist.length === 0) { vscode.window.showInformationMessage('Blacklist tr\u1ed1ng'); return; }
                    const items = state.userBlacklist.map(b => ({ label: b }));
                    const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Ch\u1ecdn pattern \u0111\u1ec3 x\u00f3a', canPickMany: true });
                    if (!sel || sel.length === 0) return;
                    const toRemove = sel.map(s => s.label);
                    state.userBlacklist = state.userBlacklist.filter(b => !toRemove.includes(b));
                    await c.update('terminalBlacklist', state.userBlacklist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] \u0110\u00e3 x\u00f3a ${toRemove.join(', ')} kh\u1ecfi blacklist`);
                    break;
                }
                case 'test': {
                    const cmd = await vscode.window.showInputBox({ prompt: 'Nh\u1eadp l\u1ec7nh \u0111\u1ea7y \u0111\u1ee7 \u0111\u1ec3 ki\u1ec3m tra', placeHolder: 'npm run build && docker push myapp' });
                    if (!cmd) return;
                    const result = evaluateCommand(cmd);
                    const icon = result.allowed ? '\u2713' : '\u2717';
                    const lines = [
                        `${icon} ${result.allowed ? 'ALLOWED' : 'BLOCKED'}`,
                        `Reason: ${result.reason}`,
                        `Commands found: ${result.commands.join(', ') || 'none'}`,
                        ``, `Full command: ${cmd}`,
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'viewAll': {
                    const promoted = getPromotedCommands();
                    const lines = [
                        '\u2550\u2550\u2550 WHITELIST (Built-in) \u2550\u2550\u2550',
                        SAFE_TERMINAL_CMDS.join(', '), '',
                        '\u2550\u2550\u2550 WHITELIST (User) \u2550\u2550\u2550',
                        state.userWhitelist.join(', ') || '(tr\u1ed1ng)', '',
                        '\u2550\u2550\u2550 WHITELIST (Learned \u2014 promoted by AI) \u2550\u2550\u2550',
                        promoted.join(', ') || '(ch\u01b0a c\u00f3)', '',
                        '\u2550\u2550\u2550 GENERALIZED PATTERNS \u2550\u2550\u2550',
                        state.patternCache.join(', ') || '(ch\u01b0a c\u00f3)', '',
                        '\u2550\u2550\u2550 BLACKLIST (Built-in) \u2550\u2550\u2550',
                        DEFAULT_BLACKLIST.join('\n'), '',
                        '\u2550\u2550\u2550 BLACKLIST (User) \u2550\u2550\u2550',
                        state.userBlacklist.join('\n') || '(tr\u1ed1ng)',
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'learnStats': {
                    const stats = getLearnStats();
                    if (stats.commands.length === 0) { vscode.window.showInformationMessage('[Grav] Ch\u01b0a c\u00f3 d\u1eef li\u1ec7u h\u1ecdc'); return; }
                    const hdr = 'Command'.padEnd(22) + 'Conf'.padEnd(8) + 'Vel'.padEnd(8) + 'Obs'.padEnd(6) + 'Status'.padEnd(12) + 'Context'.padEnd(14) + 'Last Seen';
                    const sep = '\u2500'.repeat(80);
                    const rows = stats.commands.map(s => {
                        return s.cmd.padEnd(22)
                            + (s.conf >= 0 ? '+' : '') + String(s.conf).padEnd(7)
                            + String(s.velocity).padEnd(8)
                            + String(s.obs).padEnd(6)
                            + s.status.padEnd(12)
                            + (s.topContext || '-').padEnd(14)
                            + s.lastSeen;
                    });
                    const footer = [
                        '',
                        `Epoch: ${stats.epoch} | Tracking: ${stats.totalTracked} | Promoted: ${stats.promoted} | Patterns: ${stats.patterns}`,
                        `Hyperparams: \u03b1=${LEARN.ALPHA} momentum=${LEARN.MOMENTUM} \u03b3=${LEARN.GAMMA} promote\u2265${LEARN.PROMOTE_THRESH} demote\u2264${LEARN.DEMOTE_THRESH}`,
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: [hdr, sep, ...rows, ...footer].join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'viewWiki': {
                    const pages = Object.entries(state.wiki.index)
                        .sort((a, b) => b[1].totalEvents - a[1].totalEvents);
                    if (pages.length === 0) { vscode.window.showInformationMessage('[Grav] Wiki tr\u1ed1ng \u2014 ch\u01b0a c\u00f3 d\u1eef li\u1ec7u'); return; }
                    const lines = [
                        '\u2550\u2550\u2550 SECOND BRAIN \u2014 KNOWLEDGE WIKI \u2550\u2550\u2550',
                        `Pages: ${pages.length} | Concepts: ${Object.keys(state.wiki.concepts).length} | Contradictions: ${state.wiki.contradictions.filter(c => !c.resolved).length}`,
                        '',
                        '\u2500\u2500 INDEX (sorted by activity) \u2500\u2500',
                        'Command'.padEnd(20) + 'Events'.padEnd(8) + 'Conf'.padEnd(8) + 'Risk'.padEnd(10) + 'Links'.padEnd(7) + 'Summary',
                        '\u2500'.repeat(90),
                        ...pages.map(([cmd, p]) =>
                            cmd.padEnd(20) +
                            String(p.totalEvents).padEnd(8) +
                            (p.confidence >= 0 ? '+' : '') + String(Math.round(p.confidence * 100) / 100).padEnd(7) +
                            p.riskLevel.padEnd(10) +
                            String(p.links.length).padEnd(7) +
                            (p.summary || '').substring(0, 50)
                        ), '',
                        '\u2500\u2500 CONCEPTS \u2500\u2500',
                        ...Object.entries(state.wiki.concepts).map(([name, c]) =>
                            `  ${name}: ${c.commands.length} cmds, avg conf ${Math.round(c.avgConfidence * 100)}%, risk: ${c.riskLevel}`
                        ), '',
                        '\u2500\u2500 SYNTHESIS \u2500\u2500',
                        ...Object.entries(state.wiki.synthesis).map(([name, s]) =>
                            `  ${name}: ${s.description}`
                        ), '',
                        '\u2500\u2500 RECENT LOG (last 15) \u2500\u2500',
                        ...(state.wiki.log || []).slice(-15).reverse().map(l =>
                            `  [${l.time}] ${l.op} ${l.cmd || ''} ${l.action || ''} ${l.detail || ''}`
                        ),
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'viewContradictions': {
                    const unresolved = state.wiki.contradictions.filter(c => !c.resolved);
                    if (unresolved.length === 0) { vscode.window.showInformationMessage('[Grav] Kh\u00f4ng c\u00f3 contradictions'); return; }
                    const lines = [
                        '\u2550\u2550\u2550 CONTRADICTIONS (unresolved) \u2550\u2550\u2550', '',
                        ...unresolved.map((c, i) => [
                            `#${i + 1} [${c.type}] ${c.cmd}`,
                            `  Detail: ${c.detail}`,
                            `  Old claim: ${c.oldClaim}`,
                            `  New evidence: ${c.newEvidence}`,
                            `  Time: ${new Date(c.time).toLocaleString()}`, '',
                        ].join('\n')),
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'lintWiki': {
                    const issues = wikiLint();
                    if (issues.length === 0) { vscode.window.showInformationMessage('[Grav] Wiki s\u1ea1ch \u2014 kh\u00f4ng c\u00f3 v\u1ea5n \u0111\u1ec1'); return; }
                    const lines = [
                        '\u2550\u2550\u2550 WIKI LINT REPORT \u2550\u2550\u2550',
                        `Time: ${new Date().toLocaleString()}`,
                        `Issues found: ${issues.length}`, '',
                        ...issues.map(issue => [
                            `\u26a0 ${issue.type.toUpperCase()}: ${issue.detail}`,
                            ...issue.items.map(item => `    \u2022 ${typeof item === 'string' ? item : JSON.stringify(item)}`), '',
                        ].join('\n')),
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'resetLearn': {
                    const confirm = await vscode.window.showWarningMessage('X\u00f3a to\u00e0n b\u1ed9 d\u1eef li\u1ec7u h\u1ecdc + wiki?', 'X\u00f3a', 'H\u1ee7y');
                    if (confirm !== 'X\u00f3a') return;
                    state.learnData = {};
                    state.wiki = createEmptyWiki();
                    state.learnEpoch = 0;
                    if (state.ctx) {
                        state.ctx.globalState.update('learnData', {});
                        state.ctx.globalState.update('wiki', state.wiki);
                        state.ctx.globalState.update('learnEpoch', 0);
                    }
                    setupSafeApprove();
                    vscode.window.showInformationMessage('[Grav] \u0110\u00e3 reset learning data + wiki');
                    break;
                }
            }
        }),
        vscode.commands.registerCommand('grav.learnStats', async () => {
            vscode.commands.executeCommand('grav.manageTerminal');
        }),
    );
}

function deactivate() {
    if (state.sbMain)   state.sbMain.dispose();
    if (state.sbClicks) state.sbClicks.dispose();
    if (state.sbScroll) state.sbScroll.dispose();
    if (state.acceptTimer) clearInterval(state.acceptTimer);
    if (state.httpServer) try { state.httpServer.close(); } catch (_) {}
}

module.exports = { activate, deactivate, refreshBar };
