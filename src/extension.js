// ===========================================================
// AG Autopilot — Merged: Auto Click & Scroll + Smart Router + Quota Fallback
// Base: ag-auto-click-scroll v8.3 by zixfel
// Added: Smart Router & Quota Fallback from ag-auto-model-switch v2.0
// ===========================================================
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const TAG_START = '<!-- AG-AUTOPILOT-START -->';
const TAG_END = '<!-- AG-AUTOPILOT-END -->';
// Also clean up old tags from all previous versions
const OLD_TAGS = [
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->', '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->', '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->', '<!-- AG-TOOLKIT-END -->']
];

function writeFileElevated(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
        const tmpPath = path.join(os.tmpdir(), 'ag-autopilot-' + Date.now() + '.tmp');
        fs.writeFileSync(tmpPath, content, 'utf8');
        try {
            if (process.platform === 'linux') {
                execSync(`pkexec bash -c "cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'"`, { timeout: 30000 });
            } else if (process.platform === 'darwin') {
                const cmd = `cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'`;
                execSync(`osascript -e 'do shell script "${cmd}" with administrator privileges'`, { timeout: 30000 });
            } else {
                throw err;
            }
        } catch (elevErr) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            if (elevErr === err) throw err;
            throw new Error('Permission denied. Restart VS Code as Admin.');
        }
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
}

function getWorkbenchPath() {
    const appRoot = vscode.env.appRoot;
    const candidates = [
        path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-main', 'workbench', 'workbench.html'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return findFileRecursive(path.join(appRoot, 'out'), 'workbench.html', 6);
}

function findFileRecursive(dir, filename, maxDepth) {
    if (maxDepth <= 0) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === filename) return fullPath;
            if (entry.isDirectory()) {
                const result = findFileRecursive(fullPath, filename, maxDepth - 1);
                if (result) return result;
            }
        }
    } catch (_) {}
    return null;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildScriptContent(context) {
    const config = vscode.workspace.getConfiguration('ag-auto');
    const pauseMs = config.get('scrollPauseMs', 7000);
    const scrollMs = config.get('scrollIntervalMs', 500);
    const clickMs = config.get('clickIntervalMs', 1000);
    const allPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept all', 'Accept']);
    const disabledPats = context.globalState.get('disabledClickPatterns', []);
    const patterns = allPatterns.filter(p => !disabledPats.includes(p) && p !== 'Accept');
    const enabled = config.get('enabled', true);
    const smartRouter = config.get('smartRouter', true);
    const quotaFallback = config.get('quotaFallback', true);

    const templatePath = path.join(context.extensionPath, 'media', 'autoScript.js');
    let script = fs.readFileSync(templatePath, 'utf8');

    const wbPath = getWorkbenchPath();
    const configFilePath = wbPath ? path.join(path.dirname(wbPath), 'ag-auto-config.json').replace(/\\/g, '/') : '';

    script = script.replace(/\/\*\{\{PAUSE_SCROLL_MS\}\}\*\/\d+/, pauseMs.toString());
    script = script.replace(/\/\*\{\{SCROLL_INTERVAL_MS\}\}\*\/\d+/, scrollMs.toString());
    script = script.replace(/\/\*\{\{CLICK_INTERVAL_MS\}\}\*\/\d+/, clickMs.toString());
    script = script.replace(/\/\*\{\{CLICK_PATTERNS\}\}\*\/\[.*?\]/, JSON.stringify(patterns));
    script = script.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/, enabled.toString());
    script = script.replace(/\/\*\{\{CONFIG_PATH\}\}\*\//, configFilePath);
    script = script.replace(/\/\*\{\{SMART_ROUTER\}\}\*\/\w+/, smartRouter.toString());
    script = script.replace(/\/\*\{\{QUOTA_FALLBACK\}\}\*\/\w+/, quotaFallback.toString());

    return script;
}

function writeConfigJson(context) {
    try {
        const wbPath = getWorkbenchPath();
        if (!wbPath) return;
        const wbDir = path.dirname(wbPath);
        const config = vscode.workspace.getConfiguration('ag-auto');
        const allPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept']);
        const disabledPats = context.globalState.get('disabledClickPatterns', []);
        const activePatterns = allPatterns.filter(p => !disabledPats.includes(p) && p !== 'Accept');
        const acceptEnabled = allPatterns.includes('Accept') && !disabledPats.includes('Accept');
        const configData = JSON.stringify({
            enabled: config.get('enabled', true),
            clickPatterns: activePatterns,
            acceptInChatOnly: acceptEnabled,
            pauseScrollMs: config.get('scrollPauseMs', 7000),
            scrollIntervalMs: config.get('scrollIntervalMs', 500),
            clickIntervalMs: config.get('clickIntervalMs', 1000),
            smartRouter: config.get('smartRouter', true),
            quotaFallback: config.get('quotaFallback', true)
        });
        writeFileElevated(path.join(wbDir, 'ag-auto-config.json'), configData);
    } catch (e) {
        console.error('[AG Autopilot] Error writing config JSON:', e.message);
    }
}

function installScript(context) {
    const wbPath = getWorkbenchPath();
    if (!wbPath) {
        vscode.window.showErrorMessage('[AG Autopilot] Không tìm thấy workbench.html!');
        return false;
    }
    const wbDir = path.dirname(wbPath);
    const scriptContent = buildScriptContent(context);

    // Cleanup old JS injection from workbench.js
    const JS_TAG_START = '/* AG-AUTO-CLICK-SCROLL-JS-START */';
    const JS_TAG_END = '/* AG-AUTO-CLICK-SCROLL-JS-END */';
    try {
        const htmlContent = fs.readFileSync(wbPath, 'utf8');
        const scriptMatches = htmlContent.match(/src="([^"]*\.js)"/g) || [];
        const jsFiles = new Set();
        for (const match of scriptMatches) {
            const srcMatch = match.match(/src="([^"]*\.js)"/);
            if (srcMatch) {
                const jsName = path.basename(srcMatch[1].split('?')[0]);
                if (jsName === 'ag-auto-script.js' || jsName === 'ag-modelswitch-client.js') continue;
                const sameDirPath = path.join(wbDir, jsName);
                if (fs.existsSync(sameDirPath)) jsFiles.add(sameDirPath);
                const parent1 = path.join(wbDir, '..', jsName);
                if (fs.existsSync(parent1)) jsFiles.add(path.resolve(parent1));
            }
        }
        if (jsFiles.size === 0) {
            const fallbackNames = ['workbench.desktop.main.js', 'workbench.js'];
            for (const name of fallbackNames) {
                const found = findFileRecursive(path.join(wbDir, '..'), name, 3);
                if (found) { jsFiles.add(found); break; }
            }
        }
        for (const jsPath of jsFiles) {
            let jsContent = fs.readFileSync(jsPath, 'utf8');
            const jsRegex = new RegExp(`${escapeRegex(JS_TAG_START)}[\\s\\S]*?${escapeRegex(JS_TAG_END)}`, 'g');
            if (jsRegex.test(jsContent)) {
                jsContent = jsContent.replace(jsRegex, '');
                writeFileElevated(jsPath, jsContent);
            }
        }
    } catch (err) {
        console.error('[AG Autopilot] Cleanup JS error:', err.message);
    }

    // Write script + inject HTML tag
    try {
        let html = fs.readFileSync(wbPath, 'utf8');
        // Remove ALL old tags (both old extensions + new)
        const allTags = [[TAG_START, TAG_END], ...OLD_TAGS];
        for (const [start, end] of allTags) {
            const regex = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`, 'g');
            html = html.replace(regex, '');
        }
        // Remove old script files from previous extensions
        for (const oldFile of ['ag-modelswitch-client.js', 'ag-auto-script.js']) {
            const oldPath = path.join(wbDir, oldFile);
            if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (_) {}
        }

        const ts = Date.now();
        const destPath = path.join(wbDir, 'ag-auto-script.js');
        writeFileElevated(destPath, scriptContent);

        const injection = `\n${TAG_START}\n<script src="ag-auto-script.js?v=${ts}"></script>\n${TAG_END}`;
        html = html.replace('</html>', injection + '\n</html>');
        writeFileElevated(wbPath, html);
        console.log('[AG Autopilot] ✅ Injected successfully');
    } catch (err) {
        console.error('[AG Autopilot] Inject error:', err.message);
        return false;
    }
    return true;
}

function updateProductChecksums() {
    try {
        let productJsonPath = null;
        if (process.resourcesPath) {
            const candidate = path.join(process.resourcesPath, 'app', 'product.json');
            if (fs.existsSync(candidate)) productJsonPath = candidate;
        }
        if (!productJsonPath) {
            const wbPath = getWorkbenchPath();
            if (!wbPath) return;
            let searchDir = path.dirname(wbPath);
            for (let i = 0; i < 8; i++) {
                const candidate = path.join(searchDir, 'product.json');
                if (fs.existsSync(candidate)) { productJsonPath = candidate; break; }
                searchDir = path.dirname(searchDir);
            }
        }
        if (!productJsonPath) return;
        const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
        if (!productJson.checksums) return;
        const appRoot = path.dirname(productJsonPath);
        const outDir = path.join(appRoot, 'out');
        let updated = false;
        for (const relativePath in productJson.checksums) {
            const nativePath = relativePath.split('/').join(path.sep);
            let filePath = path.join(outDir, nativePath);
            if (!fs.existsSync(filePath)) filePath = path.join(appRoot, nativePath);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath);
                const hash = crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '');
                if (productJson.checksums[relativePath] !== hash) {
                    productJson.checksums[relativePath] = hash;
                    updated = true;
                }
            }
        }
        if (updated) {
            writeFileElevated(productJsonPath, JSON.stringify(productJson, null, '\t'));
        }
        return updated;
    } catch (e) {
        console.error('[AG Autopilot] Checksum error:', e.message);
        return false;
    }
}

function clearV8CodeCache() {
    try {
        let codeCacheDir;
        if (process.platform === 'win32') {
            const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
            codeCacheDir = path.join(appDataDir, 'Antigravity', 'Code Cache', 'js');
        } else if (process.platform === 'darwin') {
            codeCacheDir = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'Code Cache', 'js');
        } else {
            codeCacheDir = path.join(os.homedir(), '.config', 'Antigravity', 'Code Cache', 'js');
        }
        if (fs.existsSync(codeCacheDir)) {
            fs.rmSync(codeCacheDir, { recursive: true, force: true });
        }
    } catch (e) {}
}

function uninstallScript() {
    const wbPath = getWorkbenchPath();
    if (!wbPath) return false;
    const wbDir = path.dirname(wbPath);
    const JS_TAG_START = '/* AG-AUTO-CLICK-SCROLL-JS-START */';
    const JS_TAG_END = '/* AG-AUTO-CLICK-SCROLL-JS-END */';
    try {
        let html = fs.readFileSync(wbPath, 'utf8');
        const allTags = [[TAG_START, TAG_END], ...OLD_TAGS];
        for (const [start, end] of allTags) {
            const regex = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`, 'g');
            html = html.replace(regex, '');
        }
        writeFileElevated(wbPath, html);
        for (const f of ['ag-auto-script.js', 'ag-modelswitch-client.js']) {
            const p = path.join(wbDir, f);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        const mainJsCandidates = ['workbench.desktop.main.js', 'workbench.js'];
        for (const name of mainJsCandidates) {
            const p = path.join(wbDir, name);
            if (fs.existsSync(p)) {
                let js = fs.readFileSync(p, 'utf8');
                const jsRegex = new RegExp(`${escapeRegex(JS_TAG_START)}[\\s\\S]*?${escapeRegex(JS_TAG_END)}`, 'g');
                js = js.replace(jsRegex, '');
                writeFileElevated(p, js);
            }
        }
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`[AG Autopilot] Uninstall failed: ${err.message}`);
        return false;
    }
}

function isScriptInjected() {
    try {
        const wbPath = getWorkbenchPath();
        if (!wbPath) return false;
        const html = fs.readFileSync(wbPath, 'utf8');
        return html.includes(TAG_START);
    } catch (e) { return false; }
}

let _settingsPanel = null;

function openSettingsPanel(context) {
    if (_settingsPanel) { _settingsPanel.dispose(); _settingsPanel = null; return; }
    const panel = vscode.window.createWebviewPanel('agAutoSettings', 'AG Autopilot - Settings', vscode.ViewColumn.One, { enableScripts: true });
    _settingsPanel = panel;
    panel.onDidDispose(() => { _settingsPanel = null; });

    const config = vscode.workspace.getConfiguration('ag-auto');
    panel.webview.html = getSettingsHtml({
        enabled: config.get('enabled', true),
        scrollEnabled: config.get('scrollEnabled', true),
        smartRouter: config.get('smartRouter', true),
        quotaFallback: config.get('quotaFallback', true),
        scrollPauseMs: config.get('scrollPauseMs', 7000),
        scrollIntervalMs: config.get('scrollIntervalMs', 500),
        clickIntervalMs: config.get('clickIntervalMs', 1000),
        clickPatterns: config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept']),
        disabledClickPatterns: context.globalState.get('disabledClickPatterns', []),
        language: config.get('language', 'vi'),
        clickStats: _clickStats,
        totalClicks: _totalClicks
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'changeLang') {
            const cfg = vscode.workspace.getConfiguration('ag-auto');
            await cfg.update('language', msg.lang, vscode.ConfigurationTarget.Global);
            panel.webview.html = getSettingsHtml({
                enabled: cfg.get('enabled', true), scrollEnabled: cfg.get('scrollEnabled', true),
                smartRouter: cfg.get('smartRouter', true), quotaFallback: cfg.get('quotaFallback', true),
                scrollPauseMs: cfg.get('scrollPauseMs', 7000), scrollIntervalMs: cfg.get('scrollIntervalMs', 500),
                clickIntervalMs: cfg.get('clickIntervalMs', 1000),
                clickPatterns: cfg.get('clickPatterns', ['Run', 'Allow', 'Always Allow', 'Accept']),
                disabledClickPatterns: context.globalState.get('disabledClickPatterns', []),
                language: msg.lang, clickStats: _clickStats, totalClicks: _totalClicks
            });
            return;
        }
        if (msg.command === 'toggle') {
            _autoAcceptEnabled = msg.enabled;
            await vscode.workspace.getConfiguration('ag-auto').update('enabled', msg.enabled, vscode.ConfigurationTarget.Global);
            writeConfigJson(context); updateStatusBarItem(); return;
        }
        if (msg.command === 'scrollToggle') {
            _httpScrollEnabled = msg.enabled;
            await vscode.workspace.getConfiguration('ag-auto').update('scrollEnabled', msg.enabled, vscode.ConfigurationTarget.Global);
            writeConfigJson(context); updateStatusBarItem(); return;
        }
        if (msg.command === 'routerToggle') {
            await vscode.workspace.getConfiguration('ag-auto').update('smartRouter', msg.enabled, vscode.ConfigurationTarget.Global);
            writeConfigJson(context); return;
        }
        if (msg.command === 'quotaToggle') {
            await vscode.workspace.getConfiguration('ag-auto').update('quotaFallback', msg.enabled, vscode.ConfigurationTarget.Global);
            writeConfigJson(context); return;
        }
        if (msg.command === 'save') {
            const cfg = vscode.workspace.getConfiguration('ag-auto');
            await cfg.update('enabled', msg.data.enabled, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollPauseMs', msg.data.scrollPauseMs, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollIntervalMs', msg.data.scrollIntervalMs, vscode.ConfigurationTarget.Global);
            await cfg.update('clickIntervalMs', msg.data.clickIntervalMs, vscode.ConfigurationTarget.Global);
            await cfg.update('clickPatterns', msg.data.clickPatterns, vscode.ConfigurationTarget.Global);
            await cfg.update('smartRouter', msg.data.smartRouter, vscode.ConfigurationTarget.Global);
            await cfg.update('quotaFallback', msg.data.quotaFallback, vscode.ConfigurationTarget.Global);
            await context.globalState.update('disabledClickPatterns', msg.data.disabledClickPatterns);
            try { await cfg.update('language', msg.data.language, vscode.ConfigurationTarget.Global); } catch (e) {}
            _autoAcceptEnabled = msg.data.enabled;
            _httpClickPatterns = msg.data.clickPatterns.filter(p => !msg.data.disabledClickPatterns.includes(p));
            writeConfigJson(context); updateStatusBarItem();
            vscode.window.setStatusBarMessage('$(check) [AG Autopilot] ✅ Saved!', 3000);
        }
        if (msg.command === 'reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
        if (msg.command === 'resetStats') {
            _clickStats = {}; _totalClicks = 0;
            context.globalState.update('clickStats', {}); context.globalState.update('totalClicks', 0);
            panel.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 });
        }
        if (msg.command === 'clearClickLog') {
            _clickLog = [];
            if (_extensionContext) _extensionContext.globalState.update('clickLog', []);
            panel.webview.postMessage({ command: 'clickLogUpdate', log: [] });
        }
        if (msg.command === 'getClickLog') panel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
        if (msg.command === 'getStats') panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
    }, undefined, context.subscriptions);

    const statsTimer = setInterval(() => {
        try { panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks }); } catch (e) { clearInterval(statsTimer); }
    }, 2000);
    panel.onDidDispose(() => clearInterval(statsTimer));
}

function getSettingsHtml(cfg) {
    const patternsJson = JSON.stringify(cfg.clickPatterns);
    const disabledPatternsJson = JSON.stringify(cfg.disabledClickPatterns);
    const lang = cfg.language || 'vi';

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AG Autopilot Settings</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#1e1e2e;color:#e8ecf4;padding:24px;line-height:1.6}
h1{font-size:1.6em;background:linear-gradient(135deg,#89b4fa,#a6e3a1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.subtitle{color:#9098b0;margin-bottom:24px;font-size:0.9em}
.title-row{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.click-badge{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#45475a,#313244);border:1px solid #585b70;border-radius:20px;padding:4px 12px;font-size:0.8em;color:#a6e3a1;font-weight:600}
.click-badge .count{color:#f9e2af;font-size:1.1em}
.btn-reset-stats{background:none;border:1px solid #585b70;border-radius:12px;color:#f38ba8;font-size:0.7em;padding:2px 10px;cursor:pointer}
.btn-reset-stats:hover{background:#f38ba8;color:#1e1e2e}
.top-row{display:flex;gap:16px;margin-bottom:16px}.top-row>*{flex:1;min-width:0}
.stats-card,.clicklog-card{background:#313244;border-radius:12px;padding:16px;border:1px solid #45475a}
.stats-card-title,.clicklog-title{font-size:0.9em;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.stats-card-title{color:#89b4fa}.clicklog-title{color:#f9e2af}
.stats-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.stats-label{min-width:100px;font-size:0.8em;color:#cdd6f4;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats-bar-bg{flex:1;height:18px;background:#1e1e2e;border-radius:9px;overflow:hidden}
.stats-bar{height:100%;border-radius:9px;transition:width 0.6s cubic-bezier(0.22,1,0.36,1)}
.stats-bar.bar-1{background:linear-gradient(90deg,#89b4fa,#74c7ec)}.stats-bar.bar-2{background:linear-gradient(90deg,#a6e3a1,#94e2d5)}
.stats-bar.bar-3{background:linear-gradient(90deg,#f9e2af,#fab387)}.stats-bar.bar-4{background:linear-gradient(90deg,#f38ba8,#eba0ac)}
.stats-bar.bar-5{background:linear-gradient(90deg,#cba6f7,#b4befe)}.stats-bar.bar-6{background:linear-gradient(90deg,#94e2d5,#89dceb)}
.stats-count{min-width:36px;font-size:0.8em;color:#bac2de;font-weight:600;text-align:left}
.stats-crown{font-size:0.9em}
.clicklog-entry{padding:6px 10px;border-bottom:1px solid #1e1e2e;display:flex;justify-content:space-between;align-items:center;gap:8px}
.clicklog-entry:last-child{border-bottom:none}
.clicklog-pattern{font-weight:600;font-size:0.85em}.clicklog-time{color:#bac2de;font-size:0.75em;white-space:nowrap}
.card{background:#313244;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #45475a;transition:border-color 0.2s}
.card:hover{border-color:#89b4fa}
.card-title{font-size:1.1em;font-weight:600;color:#89b4fa;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.field{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.field:last-child{margin-bottom:0}
label{color:#d4daf0;font-size:0.95em}
input[type="number"],select{width:140px;padding:8px 12px;border:1px solid #45475a;border-radius:8px;background:#1e1e2e;color:#cdd6f4;font-size:0.95em;outline:none}
input[type="number"]:focus,select:focus{border-color:#89b4fa}
.toggle{position:relative;width:50px;height:26px;cursor:pointer}
.toggle input{display:none}
.toggle .slider{position:absolute;inset:0;background:#45475a;border-radius:26px;transition:0.3s}
.toggle .slider::before{content:'';position:absolute;left:3px;top:3px;width:20px;height:20px;background:#cdd6f4;border-radius:50%;transition:0.3s}
.toggle input:checked+.slider{background:#00d26a;box-shadow:0 0 12px rgba(0,210,106,0.5)}
.toggle input:checked+.slider::before{transform:translateX(24px);background:#fff}
.pattern-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.btn{padding:10px 24px;border:none;border-radius:8px;cursor:pointer;font-size:0.95em;font-weight:600;transition:all 0.2s}
.btn-primary{background:linear-gradient(135deg,#89b4fa,#74c7ec);color:#1e1e2e}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(137,180,250,0.4)}
.actions{display:flex;justify-content:flex-end;margin-top:24px;gap:12px}
.hint{color:#b8c0d8;font-size:0.85em;display:block;margin-top:6px;font-style:italic;opacity:0.9}
</style>
</head>
<body>
<div class="title-row">
    <h1>⚡ AG Autopilot</h1>
    <span class="click-badge">🎯 <span class="count" id="totalCount">${cfg.totalClicks || 0}</span> clicks</span>
</div>
<div class="top-row">
    <div class="stats-card">
        <div class="stats-card-title">📊 Click Stats <button class="btn-reset-stats" onclick="resetStats()">↺ Reset</button></div>
        <div id="statsBars"></div>
    </div>
    <div class="clicklog-card">
        <div class="clicklog-title">🎯 Click Log <button class="btn-reset-stats" onclick="clearClickLog()">↺ Clear</button></div>
        <div id="clickLogList" style="max-height:300px;overflow-y:auto"><div style="color:#6c7086;padding:8px;font-size:0.85em">No clicks yet</div></div>
    </div>
</div>
<p class="subtitle">All-in-one: Auto Click & Scroll + Smart Model Router + Quota Fallback</p>

<!-- Master + Language -->
<div class="card">
    <div class="card-title">🔌 Status</div>
    <div class="field"><label>Enable Auto Click & Scroll</label>
        <label class="toggle"><input type="checkbox" id="chkEnabled" ${cfg.enabled ? 'checked' : ''} onchange="instantToggle()"><span class="slider"></span></label></div>
    <div class="field" style="margin-top:12px"><label>Language</label>
        <select id="selLang" onchange="changeLang()">
            <option value="vi" ${lang === 'vi' ? 'selected' : ''}>Tiếng Việt</option>
            <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
            <option value="zh" ${lang === 'zh' ? 'selected' : ''}>中文</option>
        </select></div>
</div>

<!-- Smart Router -->
<div class="card">
    <div class="card-title">🧠 Smart Model Router</div>
    <div class="field"><label>Tự chọn model theo nội dung prompt</label>
        <label class="toggle"><input type="checkbox" id="chkRouter" ${cfg.smartRouter ? 'checked' : ''} onchange="routerToggle()"><span class="slider"></span></label></div>
    <p class="hint">Cheap (Flash) cho câu đơn giản, Extreme (Opus) cho kiến trúc/debug, Default (Pro) cho còn lại</p>
</div>

<!-- Quota Fallback -->
<div class="card">
    <div class="card-title">🔄 Quota Fallback</div>
    <div class="field"><label>Tự đổi model khi hết quota + gửi "Continue"</label>
        <label class="toggle"><input type="checkbox" id="chkQuota" ${cfg.quotaFallback ? 'checked' : ''} onchange="quotaToggle()"><span class="slider"></span></label></div>
    <p class="hint">Khi model hiện tại hết quota, tự chuyển sang model khác và tiếp tục</p>
</div>

<!-- Scroll -->
<div class="card">
    <div class="card-title">📜 Auto Scroll</div>
    <div class="field"><label>Enable Auto Scroll</label>
        <label class="toggle"><input type="checkbox" id="chkScroll" ${cfg.scrollEnabled !== false ? 'checked' : ''} onchange="scrollToggle()"><span class="slider"></span></label></div>
    <div class="field" style="margin-top:12px"><label>Pause time (ms)</label>
        <input type="number" id="txtPauseMs" value="${cfg.scrollPauseMs}" min="1000" max="60000" step="500"></div>
    <div class="field"><label>Scroll speed (ms)</label>
        <input type="number" id="txtScrollMs" value="${cfg.scrollIntervalMs}" min="100" max="5000" step="100"></div>
</div>

<!-- Click -->
<div class="card">
    <div class="card-title">🎯 Auto Click</div>
    <div class="field"><label>Click speed (ms)</label>
        <input type="number" id="txtClickMs" value="${cfg.clickIntervalMs}" min="200" max="5000" step="100"></div>
    <div style="margin-top:16px"><label>BUTTON TEMPLATES</label><div class="pattern-list" id="templateList"></div></div>
</div>

<div class="actions">
    <button class="btn" style="background:#45475a;color:#e8ecf4" onclick="vscode.postMessage({command:'reload'})">🔄 Reload</button>
    <button class="btn btn-primary" onclick="saveSettings()">💾 Save & Apply</button>
</div>

<script>
const vscode=acquireVsCodeApi();
const DEFAULT_PATTERNS=['Run','Allow','Accept','Always Allow','Keep Waiting','Retry','Continue','Allow Once','Allow This Con','Accept all'];
const DEFAULT_DISABLED=['Accept all'];
let patterns=${patternsJson};
let disabledPatterns=${disabledPatternsJson};
DEFAULT_PATTERNS.forEach(function(p){if(patterns.indexOf(p)===-1&&disabledPatterns.indexOf(p)===-1){if(DEFAULT_DISABLED.indexOf(p)!==-1)disabledPatterns.push(p);else patterns.push(p);}});
var DISPLAY_NAMES={'Allow This Con':'Allow This Conversion'};
function displayName(p){return DISPLAY_NAMES[p]||p;}
function renderPatterns(){
    var list=document.getElementById('templateList');
    var allP=[],seen={};
    DEFAULT_PATTERNS.concat(patterns).concat(disabledPatterns).forEach(function(p){if(!seen[p]){seen[p]=true;allP.push(p);}});
    var h='';
    allP.forEach(function(p){
        var isOn=patterns.indexOf(p)!==-1;
        var bg=isOn?'#1e1e2e':'#2a2a3a';var brd=isOn?'#585b70':'#45475a';var opa=isOn?'1':'0.5';
        var stColor=isOn?'#a6e3a1':'#f38ba8';
        h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:'+bg+';border:1px solid '+brd+';border-radius:8px;margin-bottom:6px;opacity:'+opa+'">';
        h+='<div style="display:flex;align-items:center;gap:10px">';
        h+='<input type="checkbox" '+(isOn?'checked':'')+' onchange="togPat(&quot;'+p+'&quot;)" style="width:16px;height:16px;cursor:pointer;accent-color:#a6e3a1">';
        h+='<span style="font-weight:600;color:#cdd6f4">'+displayName(p)+'</span></div>';
        h+='<span style="font-size:0.75em;padding:2px 8px;border-radius:4px;background:'+(isOn?'#1a3a1a':'#3a1a1a')+';color:'+stColor+';font-weight:600">'+(isOn?'ON':'OFF')+'</span>';
        h+='</div>';
    });
    list.innerHTML=h;
}
function togPat(v){
    if(patterns.indexOf(v)!==-1){patterns=patterns.filter(function(x){return x!==v});if(disabledPatterns.indexOf(v)===-1)disabledPatterns.push(v);}
    else{disabledPatterns=disabledPatterns.filter(function(x){return x!==v});if(patterns.indexOf(v)===-1)patterns.push(v);}
    renderPatterns();
}
function saveSettings(){
    vscode.postMessage({command:'save',data:{
        enabled:document.getElementById('chkEnabled').checked,
        smartRouter:document.getElementById('chkRouter').checked,
        quotaFallback:document.getElementById('chkQuota').checked,
        scrollPauseMs:parseInt(document.getElementById('txtPauseMs').value)||7000,
        scrollIntervalMs:parseInt(document.getElementById('txtScrollMs').value)||500,
        clickIntervalMs:parseInt(document.getElementById('txtClickMs').value)||1000,
        clickPatterns:patterns,disabledClickPatterns:disabledPatterns,
        language:document.getElementById('selLang').value
    }});
}
renderPatterns();
function instantToggle(){vscode.postMessage({command:'toggle',enabled:document.getElementById('chkEnabled').checked});}
function scrollToggle(){vscode.postMessage({command:'scrollToggle',enabled:document.getElementById('chkScroll').checked});}
function routerToggle(){vscode.postMessage({command:'routerToggle',enabled:document.getElementById('chkRouter').checked});}
function quotaToggle(){vscode.postMessage({command:'quotaToggle',enabled:document.getElementById('chkQuota').checked});}
function changeLang(){vscode.postMessage({command:'changeLang',lang:document.getElementById('selLang').value});}
function resetStats(){vscode.postMessage({command:'resetStats'});document.getElementById('totalCount').textContent='0';renderStatsBars({});}
function clearClickLog(){vscode.postMessage({command:'clearClickLog'});document.getElementById('clickLogList').innerHTML='<div style="color:#6c7086;padding:8px;font-size:0.85em">No clicks yet</div>';}
var allPatterns=DEFAULT_PATTERNS.slice();
function renderStatsBars(stats){
    var container=document.getElementById('statsBars');var maxCount=0;
    for(var i=0;i<allPatterns.length;i++){var c=stats[allPatterns[i]]||0;if(c>maxCount)maxCount=c;}
    var html='';
    for(var i=0;i<allPatterns.length;i++){
        var name=allPatterns[i];var count=stats[name]||0;var pct=maxCount>0?Math.round((count/maxCount)*100):0;
        var barClass='bar-'+((i%6)+1);var crown=(count>0&&count===maxCount)?' 👑':'';
        html+='<div class="stats-row"><span class="stats-label">'+displayName(name)+'</span>';
        html+='<div class="stats-bar-bg"><div class="stats-bar '+barClass+'" style="width:'+pct+'%"></div></div>';
        html+='<span class="stats-count">'+count+crown+'</span></div>';
    }
    container.innerHTML=html;
}
function renderClickLog(log){
    var el=document.getElementById('clickLogList');if(!log||log.length===0){el.innerHTML='<div style="color:#6c7086;padding:8px;font-size:0.85em">No clicks yet</div>';return;}
    var html='';var colors={Run:'#a6e3a1',Allow:'#89b4fa',Accept:'#fab387','Always Allow':'#89dceb',Retry:'#cba6f7','Keep Waiting':'#94e2d5',Continue:'#74c7ec'};
    for(var i=0;i<log.length;i++){var c=log[i];var col=colors[c.pattern]||'#cdd6f4';
        html+='<div class="clicklog-entry"><span class="clicklog-pattern" style="color:'+col+'">'+c.pattern+'</span><span class="clicklog-time">'+c.time+'</span></div>';}
    el.innerHTML=html;
}
window.addEventListener('message',function(event){
    var msg=event.data;
    if(msg.command==='statsUpdated'){document.getElementById('totalCount').textContent=msg.totalClicks||0;renderStatsBars(msg.clickStats||{});}
    if(msg.command==='clickLogUpdate')renderClickLog(msg.log);
});
vscode.postMessage({command:'getStats'});vscode.postMessage({command:'getClickLog'});
renderStatsBars(${JSON.stringify(cfg.clickStats || {})});
</script>
</body></html>`;
}

// =============================================================
// STATUS BAR
// =============================================================
let statusBarItem, statusBarScroll;

function createStatusBarItem(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    statusBarItem.command = 'ag-auto.openSettings';
    context.subscriptions.push(statusBarItem);
    statusBarScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    statusBarScroll.command = 'ag-auto.openSettings';
    context.subscriptions.push(statusBarScroll);
    updateStatusBarItem();
    statusBarItem.show(); statusBarScroll.show();
}

function updateStatusBarItem() {
    const acceptOn = _autoAcceptEnabled;
    const scrollOn = _httpScrollEnabled;
    statusBarItem.text = acceptOn ? '$(check) Accept ON' : '$(circle-slash) Accept OFF';
    statusBarItem.color = acceptOn ? '#4EC9B0' : '#F44747';
    statusBarItem.backgroundColor = acceptOn ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarScroll.text = scrollOn ? '$(check) Scroll ON' : '$(circle-slash) Scroll OFF';
    statusBarScroll.color = scrollOn ? '#4EC9B0' : '#F44747';
    statusBarScroll.backgroundColor = scrollOn ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
}

// =============================================================
// HTTP SERVER for IPC
// =============================================================
const http = require('http');
let _autoAcceptEnabled = true;
let _httpScrollEnabled = true;
let _httpClickPatterns = [];
let _httpScrollConfig = { pauseScrollMs: 5000, scrollIntervalMs: 500, clickIntervalMs: 2000 };
let _clickStats = {};
let _clickLog = [];
let _totalClicks = 0;
let _resetStatsRequested = false;
let _extensionContext = null;
let _httpServer = null;
const AG_HTTP_PORT_START = 48787;
const AG_HTTP_PORT_END = 48850;
let _actualPort = 0;

function startHttpServer() {
    if (_httpServer) return;
    const cfg = vscode.workspace.getConfiguration('ag-auto');
    _httpClickPatterns = cfg.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept']);
    const _DEFAULT_PATS = ['Run', 'Allow', 'Accept', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Allow This Con', 'Accept all'];
    const _DEFAULT_OFF = ['Accept all'];
    _DEFAULT_PATS.forEach(p => { if (!_httpClickPatterns.includes(p) && !_DEFAULT_OFF.includes(p)) _httpClickPatterns.push(p); });
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
                try {
                    const incoming = JSON.parse(decodeURIComponent(parsed.query.stats));
                    for (const key in incoming) { if (!_clickStats[key]) _clickStats[key] = 0; _clickStats[key] += incoming[key]; }
                    let total = 0; for (const key in _clickStats) total += _clickStats[key]; _totalClicks = total;
                    if (_extensionContext) { _extensionContext.globalState.update('clickStats', _clickStats); _extensionContext.globalState.update('totalClicks', _totalClicks); }
                } catch (e) {}
            }
            if (parsed.pathname === '/ag-reset-stats') { _clickStats = {}; _totalClicks = 0; res.writeHead(200); res.end(JSON.stringify({ reset: true })); return; }
            if (parsed.pathname === '/api/click-log' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        const timestamp = (function(){ var d=new Date(); var pad=function(n){return n<10?'0'+n:n}; return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+' '+pad(d.getDate())+'/'+pad(d.getMonth()+1); })();
                        const entry = { time: timestamp, pattern: data.pattern || 'click', button: (data.button || '').substring(0, 80) };
                        _clickLog.unshift(entry); if (_clickLog.length > 50) _clickLog.pop();
                        if (_extensionContext) _extensionContext.globalState.update('clickLog', _clickLog);
                        if (_settingsPanel) _settingsPanel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
                        res.writeHead(200); res.end(JSON.stringify({ logged: true }));
                    } catch (e) { res.writeHead(200); res.end(JSON.stringify({ error: e.message })); }
                });
                return;
            }

            res.writeHead(200);
            const safePatterns = _httpClickPatterns.filter(p => p !== 'Accept');
            const acceptEnabled = _httpClickPatterns.includes('Accept');
            const agCfg = vscode.workspace.getConfiguration('ag-auto');
            const response = {
                enabled: _autoAcceptEnabled, scrollEnabled: _httpScrollEnabled,
                clickPatterns: safePatterns, acceptInChatOnly: acceptEnabled,
                pauseScrollMs: _httpScrollConfig.pauseScrollMs, scrollIntervalMs: _httpScrollConfig.scrollIntervalMs,
                clickIntervalMs: _httpScrollConfig.clickIntervalMs,
                smartRouter: agCfg.get('smartRouter', true), quotaFallback: agCfg.get('quotaFallback', true),
                clickStats: _clickStats, totalClicks: _totalClicks
            };
            if (_resetStatsRequested) { response.resetStats = true; _resetStatsRequested = false; }
            res.end(JSON.stringify(response));
        });

        function tryListenPort(port) {
            if (port > AG_HTTP_PORT_END) return;
            _httpServer.removeAllListeners('error');
            _httpServer.once('error', (e) => { if (e.code === 'EADDRINUSE') tryListenPort(port + 1); });
            _httpServer.listen(port, '127.0.0.1', () => {
                _actualPort = port;
                console.log('[AG Autopilot] ✅ HTTP server on port ' + port);
                try {
                    const wbPath = getWorkbenchPath();
                    if (wbPath) {
                        const portFile = path.join(path.dirname(wbPath), 'ag-auto-port-' + process.pid + '.txt');
                        fs.writeFileSync(portFile, String(port), 'utf8');
                        const listFile = path.join(path.dirname(wbPath), 'ag-auto-ports.json');
                        let portList = []; try { portList = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch (_) {}
                        portList = portList.filter(e => e.pid !== process.pid);
                        portList.push({ pid: process.pid, port: port, time: Date.now() });
                        fs.writeFileSync(listFile, JSON.stringify(portList), 'utf8');
                    }
                } catch (pe) {}
            });
        }
        tryListenPort(AG_HTTP_PORT_START);
    } catch (e) { console.log('[AG Autopilot] HTTP server failed:', e.message); }
}

let _autoAcceptInterval = null;
const CHAT_ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion'
];

function startCommandsLoop() {
    const config = vscode.workspace.getConfiguration('ag-auto');
    _autoAcceptEnabled = config.get('enabled', true);
    const clickMs = config.get('clickIntervalMs', 2000);
    if (_autoAcceptInterval) clearInterval(_autoAcceptInterval);
    _autoAcceptInterval = setInterval(() => {
        if (!_autoAcceptEnabled) return;
        const wantsAccept = _httpClickPatterns.some(p => p.toLowerCase().includes('accept'));
        if (!wantsAccept) return;
        Promise.allSettled(CHAT_ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))).catch(() => {});
    }, clickMs);
}

// =============================================================
// ACTIVATION
// =============================================================
function activate(context) {
    console.log('[AG Autopilot] Activating v' + (context.extension?.packageJSON?.version || '3.x') + '...');
    _extensionContext = context;
    _clickStats = context.globalState.get('clickStats', {});
    _totalClicks = context.globalState.get('totalClicks', 0);
    const storedLog = context.globalState.get('clickLog', []);
    if (storedLog && storedLog.length > 0) _clickLog = storedLog;

    // Win32 Keep Waiting native dialog
    if (process.platform === 'win32') {
        const { execFile } = require('child_process');
        const keepWaitingScript = `
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class AgWin32{
public delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr lParam);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr hwnd,EnumWindowsProc cb,IntPtr lParam);
[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder s,int n);
[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd,StringBuilder s,int n);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr w,IntPtr l);
}
"@
$global:clicked=$false
[AgWin32]::EnumWindows({param($hWnd,$lp)
if(-not [AgWin32]::IsWindowVisible($hWnd)){return $true}
if($global:clicked){return $false}
[AgWin32]::EnumChildWindows($hWnd,{param($ch,$lp2)
$cls=New-Object System.Text.StringBuilder 64
[AgWin32]::GetClassName($ch,$cls,64)|Out-Null
if($cls.ToString() -eq 'Button'){$txt=New-Object System.Text.StringBuilder 256
[AgWin32]::GetWindowText($ch,$txt,256)|Out-Null
if($txt.ToString() -match 'Keep Waiting'){[AgWin32]::PostMessage($ch,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$global:clicked=$true}}
return $true},[IntPtr]::Zero)|Out-Null
if($global:clicked){return $false}
return $true},[IntPtr]::Zero)|Out-Null
if($global:clicked){Write-Output 'CLICKED'}`.trim();
        const keepWaitingInterval = setInterval(() => {
            if (!_autoAcceptEnabled || !_httpClickPatterns.includes('Keep Waiting')) return;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', keepWaitingScript], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') {
                    _totalClicks++; if (!_clickStats['Keep Waiting']) _clickStats['Keep Waiting'] = 0; _clickStats['Keep Waiting']++;
                    if (_extensionContext) { _extensionContext.globalState.update('clickStats', _clickStats); _extensionContext.globalState.update('totalClicks', _totalClicks); }
                }
            });
        }, 3000);
        context.subscriptions.push({ dispose: () => clearInterval(keepWaitingInterval) });
    }

    // Inject logic
    {
        const needsInject = !isScriptInjected();
        const currentVersion = context.extension?.packageJSON?.version || '0';
        const lastVersion = context.globalState.get('ag-injected-version', '0');
        const versionChanged = currentVersion !== lastVersion;

        if (needsInject || versionChanged) {
            try {
                installScript(context);
                context.globalState.update('ag-injected-version', currentVersion);
                clearV8CodeCache();
                updateProductChecksums();
                setTimeout(() => { vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 1000);
            } catch (e) { console.error('[AG Autopilot] Inject error:', e.message); }
        } else {
            // Update script file only (no reload needed)
            try {
                const wbPath = getWorkbenchPath();
                if (wbPath) {
                    const scriptContent = buildScriptContent(context);
                    writeFileElevated(path.join(path.dirname(wbPath), 'ag-auto-script.js'), scriptContent);
                }
            } catch (e) {}
            updateProductChecksums();
        }

        startHttpServer();
        startCommandsLoop();
        writeConfigJson(context);
    }

    createStatusBarItem(context);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ag-auto')) updateStatusBarItem();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ag-auto.enable', async () => {
        if (installScript(context)) {
            updateStatusBarItem();
            const choice = await vscode.window.showInformationMessage('[AG Autopilot] ✅ Injected! Reload to activate.', 'Reload Now');
            if (choice === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ag-auto.disable', async () => {
        if (uninstallScript()) {
            updateStatusBarItem();
            const choice = await vscode.window.showInformationMessage('[AG Autopilot] 🗑️ Removed! Reload to finish.', 'Reload Now');
            if (choice === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ag-auto.openSettings', () => openSettingsPanel(context)));
}

function deactivate() {
    if (statusBarItem) statusBarItem.dispose();
    try {
        const wbPath = getWorkbenchPath();
        if (wbPath) {
            const portFile = path.join(path.dirname(wbPath), 'ag-auto-port-' + process.pid + '.txt');
            if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
            const listFile = path.join(path.dirname(wbPath), 'ag-auto-ports.json');
            try {
                let portList = JSON.parse(fs.readFileSync(listFile, 'utf8'));
                portList = portList.filter(e => e.pid !== process.pid);
                fs.writeFileSync(listFile, JSON.stringify(portList), 'utf8');
            } catch (_) {}
        }
    } catch (_) {}
}

module.exports = { activate, deactivate };
