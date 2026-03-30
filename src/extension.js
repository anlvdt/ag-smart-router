const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Script tags
const TAG_START = '<!-- AG-MODEL-SWITCH-START -->';
const TAG_END = '<!-- AG-MODEL-SWITCH-END -->';

/**
 * Robust file writing with macOS osascript elevation
 */
function writeFileElevated(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
        
        const tmpPath = path.join(os.tmpdir(), 'ag-modelswitch-' + Date.now() + '.tmp');
        fs.writeFileSync(tmpPath, content, 'utf8');

        try {
            if (process.platform === 'darwin') {
                const cmd = `cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'`;
                execSync(`osascript -e 'do shell script "${cmd}" with administrator privileges'`, { timeout: 30000 });
                console.log('[AG Model Switch] Elevated write success.');
            } else {
                throw err;
            }
        } catch (elevErr) {
            try { fs.unlinkSync(tmpPath); } catch (_) { }
            console.error('[AG Model Switch] Elevation failed:', elevErr.message);
            throw new Error('Permission denied. Please restart VS Code as Admin.');
        }

        try { fs.unlinkSync(tmpPath); } catch (_) { }
    }
}

/**
 * Locate VS Code workbench.html
 */
function getWorkbenchPath() {
    const appRoot = vscode.env.appRoot;
    const candidates = [
        path.join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    
    // Deep search if not found
    return findFileRecursive(path.join(appRoot, 'out'), 'workbench.html', 5);
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
    } catch (_) { }
    return null;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inject main JS file into workbench
 */
function installScript(context) {
    const wbPath = getWorkbenchPath();
    if (!wbPath) {
        vscode.window.showErrorMessage('[AG Model Switch] Could not find workbench.html');
        return false;
    }

    const wbDir = path.dirname(wbPath);
    
    const config = vscode.workspace.getConfiguration('ag-model-switch');
    const isEnabled = config.get('enabled', true);
    
    let scriptContent = fs.readFileSync(path.join(context.extensionPath, 'media', 'autoModelScript.js'), 'utf8');
    scriptContent = scriptContent.replace('/*{{ENABLED}}*/true', `${isEnabled}`);

    try {
        let html = fs.readFileSync(wbPath, 'utf8');
        
        // Remove old tags
        const htmlRegex = new RegExp(`${escapeRegex(TAG_START)}[\\s\\S]*?${escapeRegex(TAG_END)}`, 'g');
        html = html.replace(htmlRegex, '');

        // Write the local injected script
        const destPath = path.join(wbDir, 'ag-modelswitch-client.js');
        writeFileElevated(destPath, scriptContent);

        // Inject script tag into workbench.html
        const ts = Date.now();
        const injection = `\n${TAG_START}\n<script src="ag-modelswitch-client.js?v=${ts}"></script>\n${TAG_END}`;
        html = html.replace('</html>', injection + '\n</html>');

        writeFileElevated(wbPath, html);
        console.log('[AG Model Switch] Injected into workbench.html successfully.');
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`[AG Model Switch] Injection failed: ${err.message}`);
        return false;
    }
}

function uninstallScript() {
    const wbPath = getWorkbenchPath();
    if (!wbPath) return false;

    const wbDir = path.dirname(wbPath);
    try {
        let html = fs.readFileSync(wbPath, 'utf8');
        const htmlRegex = new RegExp(`${escapeRegex(TAG_START)}[\\s\\S]*?${escapeRegex(TAG_END)}`, 'g');
        html = html.replace(htmlRegex, '');
        writeFileElevated(wbPath, html);

        const scriptPath = path.join(wbDir, 'ag-modelswitch-client.js');
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        return true;
    } catch (err) {
        return false;
    }
}

function activate(context) {
    console.log('[AG Model Switch] Activated');

    // Auto-install on startup
    setTimeout(() => {
        installScript(context);
    }, 2000);

    const enableCmd = vscode.commands.registerCommand('ag-model-switch.enable', async () => {
        const config = vscode.workspace.getConfiguration('ag-model-switch');
        await config.update('enabled', true, true);
        installScript(context);
        vscode.window.showInformationMessage('AG Model Switch is now ENABED. Please reloading window to apply immediately if already open.', 'Reload Window').then(res => {
            if (res === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    });

    const disableCmd = vscode.commands.registerCommand('ag-model-switch.disable', async () => {
        const config = vscode.workspace.getConfiguration('ag-model-switch');
        await config.update('enabled', false, true);
        uninstallScript();
        vscode.window.showInformationMessage('AG Model Switch is now DISABLED. Reload to remove script.', 'Reload Window').then(res => {
            if (res === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    });

    context.subscriptions.push(enableCmd, disableCmd);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
