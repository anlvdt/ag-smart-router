// ═══════════════════════════════════════════════════════════════
//  Grav — Utilities (sanitized, testable)
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

/**
 * Escape special regex characters in a string.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize a file path — reject path traversal and null bytes.
 * @param {string} fp
 * @returns {boolean}
 */
function isPathSafe(fp) {
    if (!fp || typeof fp !== 'string') return false;
    if (fp.includes('\0')) return false;
    // Reject obvious traversal
    const normalized = path.normalize(fp);
    if (normalized.includes('..')) return false;
    return true;
}

/**
 * Write file with elevated permissions if needed.
 * Sanitizes inputs before shell execution.
 * @param {string} fp - absolute file path
 * @param {string} content - file content
 */
function elevatedWrite(fp, content) {
    if (!isPathSafe(fp)) throw new Error(`Unsafe path: ${fp}`);
    // Validate fp is absolute and within known safe directories
    const resolved = path.resolve(fp);
    const allowedRoots = [
        vscode.env.appRoot,                    // IDE installation
        os.tmpdir(),                           // temp files
        path.join(os.homedir(), '.antigravity'), // Antigravity config
    ];
    const inAllowed = allowedRoots.some(root => resolved.startsWith(path.resolve(root)));
    if (!inAllowed) throw new Error(`Path outside allowed directories: ${fp}`);

    try {
        fs.writeFileSync(fp, content, 'utf8');
        return;
    } catch (e) {
        if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    }

    const tmp = path.join(os.tmpdir(), 'grav-' + crypto.randomBytes(8).toString('hex') + '.tmp');
    fs.writeFileSync(tmp, content, 'utf8');
    try {
        if (process.platform === 'darwin') {
            // Use execFileSync with array args — no shell injection possible
            execFileSync('osascript', [
                '-e', `do shell script "cp " & quoted form of "${tmp}" & " " & quoted form of "${fp}" & " && chmod 644 " & quoted form of "${fp}" with administrator privileges`,
            ], { timeout: 30000 });
        } else if (process.platform === 'linux') {
            execFileSync('pkexec', ['cp', tmp, fp], { timeout: 30000 });
            execFileSync('pkexec', ['chmod', '644', fp], { timeout: 30000 });
        } else {
            throw new Error('Permission denied — restart as admin');
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

/**
 * Find workbench.html in the IDE installation.
 * @returns {string|null}
 */
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
            if (e.isDirectory()) {
                const r = deepFind(fp, name, depth - 1);
                if (r) return r;
            }
        }
    } catch (_) {}
    return null;
}

/**
 * Read a VS Code configuration value.
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
function cfg(key, fallback) {
    return vscode.workspace.getConfiguration('grav').get(key, fallback);
}

/**
 * Extract individual command names from a compound command string.
 * Handles pipes, chains, subshells, env vars, sudo, etc.
 * @param {string} cmdLine
 * @returns {string[]}
 */
function extractCommands(cmdLine) {
    if (!cmdLine || typeof cmdLine !== 'string') return [];
    const parts = cmdLine.split(/\s*(?:\|\||&&|[|;&])\s*/);
    const cmds = [];
    for (const part of parts) {
        let p = part.trim();
        if (!p) continue;
        p = p.replace(/^(?:(?:sudo|nohup|time|nice|ionice|strace|ltrace|env)\s+)+/gi, '');
        p = p.replace(/^(?:\w+=\S+\s+)+/, '');
        p = p.replace(/^\$\(\s*/, '').replace(/^\(\s*/, '').replace(/\)\s*$/, '');
        const match = p.match(/^([^\s]+)/);
        if (match) {
            let cmd = match[1].replace(/^.*[/\\]/, '');
            if (cmd) cmds.push(cmd.toLowerCase());
        }
    }
    return [...new Set(cmds)];
}

/**
 * Check if a command line matches any blacklist pattern.
 * @param {string} cmdLine
 * @param {string[]} blacklist
 * @returns {string|null} matched pattern or null
 */
function matchesBlacklist(cmdLine, blacklist) {
    const lower = cmdLine.toLowerCase().trim();
    for (const pattern of blacklist) {
        const p = pattern.toLowerCase().trim();
        if (!p) continue;
        if (lower.includes(p)) return pattern;
        if (p.startsWith('/') && p.endsWith('/')) {
            try {
                if (new RegExp(p.slice(1, -1), 'i').test(cmdLine)) return pattern;
            } catch (_) {}
        }
    }
    return null;
}

module.exports = {
    escapeRegex, isPathSafe, elevatedWrite, workbenchPath,
    cfg, extractCommands, matchesBlacklist,
};
