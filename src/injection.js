// ═══════════════════════════════════════════════════════════════
//  Grav — Runtime Injection (workbench.html management)
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const {
    TAG, LEGACY_TAGS, LEGACY_SCRIPTS, RUNTIME_FILE, CONFIG_FILE, DEFAULT_PATTERNS,
    HIGH_CONF, COOLDOWN, REJECT_WORDS, EDITOR_SKIP, LIMITS,
} = require('./constants');
const { escapeRegex, elevatedWrite, workbenchPath, cfg } = require('./utils');

/**
 * Build the runtime JS with injected config values.
 * @param {vscode.ExtensionContext} ctx
 * @returns {string}
 */
function buildRuntime(ctx) {
    const dp = ctx.globalState.get('disabledPatterns', []);
    const pats = cfg('approvePatterns', DEFAULT_PATTERNS).filter(p => !dp.includes(p));
    let src = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'runtime.js'), 'utf8');
    // Config values
    src = src.replace(/\/\*\{\{PAUSE_MS\}\}\*\/\d+/,    String(cfg('scrollPauseMs', 7000)));
    src = src.replace(/\/\*\{\{SCROLL_MS\}\}\*\/\d+/,   String(cfg('scrollIntervalMs', 500)));
    src = src.replace(/\/\*\{\{APPROVE_MS\}\}\*\/\d+/,  String(cfg('approveIntervalMs', 1000)));
    src = src.replace(/\/\*\{\{PATTERNS\}\}\*\/\[.*?\]/, JSON.stringify(pats));
    src = src.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/,     String(cfg('enabled', true)));
    // Shared constants from constants.js
    src = src.replace(/\/\*\{\{REJECT_WORDS\}\}\*\/\[.*?\]/, JSON.stringify(REJECT_WORDS));
    src = src.replace(/\/\*\{\{EDITOR_SKIP\}\}\*\/\[.*?\]/, JSON.stringify(EDITOR_SKIP));
    src = src.replace(/\/\*\{\{HIGH_CONF\}\}\*\/\{.*?\}/, JSON.stringify(HIGH_CONF));
    src = src.replace(/\/\*\{\{COOLDOWN\}\}\*\/\{.*?\}/, JSON.stringify(COOLDOWN));
    src = src.replace(/\/\*\{\{LIMITS\}\}\*\/\{.*?\}/, JSON.stringify(LIMITS));
    return src;
}

/**
 * Inject runtime into workbench.html.
 * @param {vscode.ExtensionContext} ctx
 * @returns {boolean}
 */
function inject(ctx) {
    const wb = workbenchPath();
    if (!wb) {
        vscode.window.showErrorMessage('[Grav] workbench.html not found');
        return false;
    }
    const dir = path.dirname(wb);
    try {
        let html = fs.readFileSync(wb, 'utf8');
        // Strip legacy + own tags
        for (const [s, e] of [[TAG.open, TAG.close], ...LEGACY_TAGS]) {
            html = html.replace(new RegExp(escapeRegex(s) + '[\\s\\S]*?' + escapeRegex(e), 'g'), '');
        }
        // Remove legacy script files
        for (const f of [...LEGACY_SCRIPTS, RUNTIME_FILE]) {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) { /* file cleanup */ }
        }
        // Write runtime
        elevatedWrite(path.join(dir, RUNTIME_FILE), buildRuntime(ctx));
        html = html.replace('</html>',
            `\n${TAG.open}\n<script src="${RUNTIME_FILE}?v=${Date.now()}"></script>\n${TAG.close}\n</html>`);
        elevatedWrite(wb, html);
    } catch (e) {
        console.error('[Grav] inject:', e.message);
        return false;
    }
    return true;
}

/**
 * Remove runtime from workbench.html.
 * @returns {boolean}
 */
function eject() {
    const wb = workbenchPath();
    if (!wb) return false;
    const dir = path.dirname(wb);
    try {
        let html = fs.readFileSync(wb, 'utf8');
        for (const [s, e] of [[TAG.open, TAG.close], ...LEGACY_TAGS]) {
            html = html.replace(new RegExp(escapeRegex(s) + '[\\s\\S]*?' + escapeRegex(e), 'g'), '');
        }
        elevatedWrite(wb, html);
        for (const f of [...LEGACY_SCRIPTS, RUNTIME_FILE]) {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) { /* file cleanup */ }
        }
        return true;
    } catch (e) {
        vscode.window.showErrorMessage('[Grav] eject failed: ' + e.message);
        return false;
    }
}

/** Check if runtime is currently injected. */
function isInjected() {
    try {
        const wb = workbenchPath();
        return wb ? fs.readFileSync(wb, 'utf8').includes(TAG.open) : false;
    } catch (_) { return false; }
}

/** Patch product.json checksums to suppress "corrupt" warning. */
function patchChecksums() {
    try {
        let pjp = null;
        if (process.resourcesPath) {
            const c = path.join(process.resourcesPath, 'app', 'product.json');
            if (fs.existsSync(c)) pjp = c;
        }
        if (!pjp) {
            const wb = workbenchPath();
            if (!wb) return;
            let d = path.dirname(wb);
            for (let i = 0; i < 8; i++) {
                const c = path.join(d, 'product.json');
                if (fs.existsSync(c)) { pjp = c; break; }
                d = path.dirname(d);
            }
        }
        if (!pjp) return;
        const pj = JSON.parse(fs.readFileSync(pjp, 'utf8'));
        if (!pj.checksums) return;
        const root = path.dirname(pjp);
        const outDir = path.join(root, 'out');
        let dirty = false;
        for (const rp in pj.checksums) {
            const rel = rp.split('/').join(path.sep);
            let fp = path.join(outDir, rel);
            if (!fs.existsSync(fp)) fp = path.join(root, rel);
            if (!fs.existsSync(fp)) continue;
            const h = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('base64').replace(/=+$/, '');
            if (pj.checksums[rp] !== h) { pj.checksums[rp] = h; dirty = true; }
        }
        if (dirty) elevatedWrite(pjp, JSON.stringify(pj, null, '\t'));
    } catch (_) { /* non-critical */ }
}

/** Clear IDE code cache to force reload of injected runtime. */
function clearCodeCache() {
    try {
        const base = process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity')
            : process.platform === 'darwin'
                ? path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity')
                : path.join(os.homedir(), '.config', 'Antigravity');
        const d = path.join(base, 'Code Cache', 'js');
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (_) { /* non-critical */ }
}

/** Write runtime config file for hot-reload without re-injection. */
function writeRuntimeConfig(ctx) {
    try {
        const wb = workbenchPath();
        if (!wb) return;
        const dp = ctx.globalState.get('disabledPatterns', []);
        const pats = cfg('approvePatterns', DEFAULT_PATTERNS).filter(p => !dp.includes(p));
        elevatedWrite(path.join(path.dirname(wb), CONFIG_FILE), JSON.stringify({
            enabled: cfg('enabled', true),
            scrollEnabled: cfg('autoScroll', true),
            patterns: pats,
            acceptInChatOnly: cfg('approvePatterns', []).includes('Accept') && !dp.includes('Accept'),
            pauseMs: cfg('scrollPauseMs', 7000),
            scrollMs: cfg('scrollIntervalMs', 500),
            approveMs: cfg('approveIntervalMs', 1000),
        }));
    } catch (_) { /* non-critical */ }
}

/** Hot-update runtime file without full re-injection. */
function hotUpdateRuntime(ctx) {
    try {
        const wb = workbenchPath();
        if (wb) elevatedWrite(path.join(path.dirname(wb), RUNTIME_FILE), buildRuntime(ctx));
    } catch (e) {
        console.error('[Grav] hot-update runtime:', e.message);
    }
}

module.exports = {
    buildRuntime, inject, eject, isInjected,
    patchChecksums, clearCodeCache, writeRuntimeConfig, hotUpdateRuntime,
};
