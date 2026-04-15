// ═══════════════════════════════════════════════════════════════
//  Grav — Terminal Activity Listener
//
//  Captures terminal commands via multiple VS Code APIs:
//  1. onDidStartTerminalShellExecution (VS Code 1.93+)
//  2. onDidEndTerminalShellExecution (exit code = RLVR signal)
//  3. onDidWriteTerminalData fallback (older VS Code)
//  4. Shell integration polling
//  5. Shell integration change listener
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const { cfg, extractCommands, matchesBlacklist } = require('./utils');
const { DEFAULT_BLACKLIST } = require('./constants');

/**
 * Setup all terminal listeners.
 * @param {vscode.ExtensionContext} ctx
 * @param {object} learning - learning module reference
 */
function setup(ctx, learning) {
    const _pendingExecs = new Map();
    const _seenCmds = new Set();

    function getProject() {
        return vscode.workspace.workspaceFolders?.[0]?.name;
    }

    // Safe record — skip blacklisted commands to prevent learning dangerous patterns
    const userBlacklist = cfg('terminalBlacklist', []);
    const allBlacklist = [...DEFAULT_BLACKLIST, ...userBlacklist];
    function safeRecord(cmdLine, action, context) {
        if (!cfg('learnEnabled', true)) return;
        if (matchesBlacklist(cmdLine, allBlacklist)) return;
        learning.recordAction(cmdLine, action, context);
    }

    // ── Method 1: Shell execution API ──
    if (vscode.window.onDidStartTerminalShellExecution) {
        ctx.subscriptions.push(
            vscode.window.onDidStartTerminalShellExecution(e => {
                try {
                    const cmdLine = e.execution?.commandLine?.value || e.execution?.commandLine || '';
                    if (!cmdLine || cmdLine.length < 2) return;
                    const id = e.execution?.id || Date.now().toString();
                    _pendingExecs.set(id, { command: cmdLine, startTime: Date.now() });
                    if (cfg('learnEnabled', true)) {
                        safeRecord(cmdLine, 'approve', { project: getProject() });
                    }
                } catch (_) {}
            })
        );
    }

    if (vscode.window.onDidEndTerminalShellExecution) {
        ctx.subscriptions.push(
            vscode.window.onDidEndTerminalShellExecution(e => {
                try {
                    const id = e.execution?.id || '';
                    const exitCode = e.exitCode;
                    const pending = _pendingExecs.get(id);
                    if (pending) {
                        _pendingExecs.delete(id);
                        if (cfg('learnEnabled', true) && typeof exitCode === 'number') {
                            safeRecord(pending.command, exitCode === 0 ? 'approve' : 'reject', {
                                exitCode, project: getProject(), duration: Date.now() - pending.startTime,
                            });
                        }
                    } else {
                        const cmdLine = e.execution?.commandLine?.value || e.execution?.commandLine || '';
                        if (cmdLine && cfg('learnEnabled', true) && typeof exitCode === 'number') {
                            safeRecord(cmdLine, exitCode === 0 ? 'approve' : 'reject', {
                                exitCode, project: getProject(),
                            });
                        }
                    }
                } catch (_) {}
            })
        );
    }

    // ── Method 2: Terminal data write (fallback) ──
    if (!vscode.window.onDidStartTerminalShellExecution && vscode.window.onDidWriteTerminalData) {
        const _termBuffers = new Map();
        ctx.subscriptions.push(
            vscode.window.onDidWriteTerminalData(e => {
                try {
                    if (!cfg('learnEnabled', true)) return;
                    const tid = e.terminal?.name || 'default';
                    const buf = (_termBuffers.get(tid) || '') + e.data;
                    const lines = buf.split(/\r?\n/);
                    if (lines.length > 1) {
                        for (let i = 0; i < lines.length - 1; i++) {
                            const line = lines[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
                            if (!line || line.length < 3 || line.length > 500) continue;
                            const cmdMatch = line.match(/^[\$>%#]\s+(.+)/) || line.match(/\$\s+(.+)$/);
                            if (cmdMatch && cmdMatch[1].trim().length >= 2) {
                                safeRecord(cmdMatch[1].trim(), 'approve', { project: getProject() });
                            }
                        }
                        _termBuffers.set(tid, lines[lines.length - 1]);
                    } else {
                        _termBuffers.set(tid, buf.slice(-1000));
                    }
                } catch (_) {}
            })
        );
    }

    // ── Method 3: Terminal open tracking ──
    ctx.subscriptions.push(
        vscode.window.onDidOpenTerminal(t => {
            try {
                const name = t.name || '';
                if (name && cfg('learnEnabled', true)) {
                    const cmds = extractCommands(name);
                    if (cmds.length > 0 && !['terminal', 'bash', 'zsh', 'sh'].includes(cmds[0])) {
                        safeRecord(name, 'approve', { project: getProject() });
                    }
                }
            } catch (_) {}
        })
    );

    // ── Method 4: Poll shell integration ──
    const pollTimer = setInterval(() => {
        if (!cfg('learnEnabled', true)) return;
        try {
            for (const term of vscode.window.terminals) {
                const si = term.shellIntegration;
                if (!si) continue;
                const exec = si.executeCommand;
                if (exec) {
                    const cmdLine = exec.commandLine?.value || exec.commandLine || '';
                    if (cmdLine && cmdLine.length >= 2) {
                        const key = term.name + ':' + cmdLine + ':' + (exec.startTimestamp || 0);
                        if (!_seenCmds.has(key)) {
                            _seenCmds.add(key);
                            const exitCode = typeof exec.exitCode === 'number' ? exec.exitCode : undefined;
                            safeRecord(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                                exitCode, project: getProject(),
                            });
                        }
                    }
                }
            }
            // Prevent memory leak
            if (_seenCmds.size > 5000) {
                const arr = [..._seenCmds];
                _seenCmds.clear();
                for (let i = arr.length - 2000; i < arr.length; i++) _seenCmds.add(arr[i]);
            }
        } catch (_) {}
    }, 3000);
    ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

    // ── Method 5: Shell integration change listener ──
    if (vscode.window.onDidChangeTerminalShellIntegration) {
        ctx.subscriptions.push(
            vscode.window.onDidChangeTerminalShellIntegration(e => {
                try {
                    const si = e.shellIntegration;
                    if (!si || !si.onDidExecuteCommand) return;
                    ctx.subscriptions.push(
                        si.onDidExecuteCommand(cmd => {
                            try {
                                const cmdLine = cmd.commandLine?.value || cmd.commandLine || '';
                                if (!cmdLine || cmdLine.length < 2 || !cfg('learnEnabled', true)) return;
                                const key = (e.terminal?.name || '') + ':' + cmdLine + ':' + Date.now();
                                if (_seenCmds.has(key)) return;
                                _seenCmds.add(key);
                                const exitCode = typeof cmd.exitCode === 'number' ? cmd.exitCode : undefined;
                                safeRecord(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                                    exitCode, project: getProject(),
                                });
                            } catch (_) {}
                        })
                    );
                } catch (_) {}
            })
        );
    }

    // ── Cleanup stale pending executions ──
    const cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - 300000;
        for (const [id, p] of _pendingExecs) {
            if (p.startTime < cutoff) _pendingExecs.delete(id);
        }
    }, 60000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cleanupTimer) });
}

module.exports = { setup };
