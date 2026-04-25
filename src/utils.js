// ═══════════════════════════════════════════════════════════════
//  Grav — Utility functions
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execSync } = require('child_process');

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function cfg(key, fallback) {
    return vscode.workspace.getConfiguration('grav').get(key, fallback);
}

/** Safely escape a string for use inside single-quoted shell arguments */
function shellEscape(s) {
    return s.replace(/'/g, "'\\''");
}

function elevatedWrite(fp, content) {
    try { fs.writeFileSync(fp, content, 'utf8'); return; } catch (e) {
        if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    }
    const tmp = path.join(os.tmpdir(), 'grav-' + Date.now() + '.tmp');
    fs.writeFileSync(tmp, content, 'utf8');
    try {
        const safeTmp = shellEscape(tmp);
        const safeFp = shellEscape(fp);
        if (process.platform === 'darwin')
            execSync(`osascript -e 'do shell script "cp \\'${safeTmp}\\' \\'${safeFp}\\' && chmod 644 \\'${safeFp}\\'" with administrator privileges'`, { timeout: 30000 });
        else if (process.platform === 'linux')
            execSync(`pkexec bash -c "cp '${safeTmp}' '${safeFp}' && chmod 644 '${safeFp}'"`, { timeout: 30000 });
        else throw new Error('Permission denied — restart as admin');
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

function workbenchPath() {
    const root = vscode.env.appRoot;
    const candidates = [
        'out/vs/code/electron-sandbox/workbench/workbench.html',
        'out/vs/code/electron-browser/workbench/workbench.html',
        'out/vs/workbench/workbench.html',
        'out/vs/code/browser/workbench/workbench.html',
        'out/vs/code/electron-main/workbench/workbench.html',
    ];
    for (const c of candidates) {
        const p = path.join(root, c);
        if (fs.existsSync(p)) return p;
    }
    return deepFind(path.join(root, 'out'), 'workbench.html', 6);
}

function deepFind(dir, name, depth) {
    if (depth <= 0) return null;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, e.name);
            if (e.isFile() && e.name === name) return fp;
            if (e.isDirectory()) { const r = deepFind(fp, name, depth - 1); if (r) return r; }
        }
    } catch (_) {}
    return null;
}

module.exports = { esc, cfg, shellEscape, elevatedWrite, workbenchPath, deepFind };
