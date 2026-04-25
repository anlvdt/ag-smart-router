// ═══════════════════════════════════════════════════════════════
//  Grav — Terminal command analysis, evaluation & listener
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const { state } = require('./state');
const { SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, LEARN } = require('./constants');
const { cfg } = require('./utils');
const { getPromotedCommands, recordCommandAction, wikiQuery } = require('./learning');

/**
 * Extract individual command names from a compound command string.
 * Handles: pipes (|), chains (&&, ||, ;), subshells ($(...)), xargs, etc.
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
            let cmd = match[1];
            cmd = cmd.replace(/^.*[/\\]/, '');
            if (cmd) cmds.push(cmd.toLowerCase());
        }
    }
    return [...new Set(cmds)];
}

/**
 * Check if a full command line matches any blacklist pattern.
 * Supports substring matching and /regex/ patterns with length limit.
 */
function matchesBlacklist(cmdLine, blacklist) {
    const lower = cmdLine.toLowerCase().trim();
    for (const pattern of blacklist) {
        const p = pattern.toLowerCase().trim();
        if (!p) continue;
        if (lower.includes(p)) return pattern;
        if (p.startsWith('/') && p.endsWith('/') && p.length <= LEARN.MAX_REGEX_LEN) {
            try {
                if (new RegExp(p.slice(1, -1), 'i').test(cmdLine)) return pattern;
            } catch (_) {}
        }
    }
    return null;
}

/**
 * Evaluate a command line against whitelist + blacklist + learned data.
 */
function evaluateCommand(cmdLine) {
    const blacklist = [...DEFAULT_BLACKLIST, ...state.userBlacklist];
    const whitelist = [...SAFE_TERMINAL_CMDS, ...state.userWhitelist];

    const blocked = matchesBlacklist(cmdLine, blacklist);
    if (blocked) return { allowed: false, reason: `Blocked by blacklist: "${blocked}"`, commands: [], confidence: -1, wiki: null };

    const cmds = extractCommands(cmdLine);
    if (cmds.length === 0) return { allowed: false, reason: 'Could not parse command', commands: [], confidence: 0, wiki: null };

    const promotedCmds = getPromotedCommands();
    const fullWhitelist = [...whitelist, ...promotedCmds, ...state.patternCache];
    const unknown = [];
    let minConf = 1.0;
    const wikiInsights = [];

    for (const cmd of cmds) {
        if (fullWhitelist.includes(cmd)) continue;

        const wikiPage = wikiQuery(cmd);
        if (wikiPage) {
            wikiInsights.push({ cmd, riskLevel: wikiPage.riskLevel, summary: wikiPage.summary });
            if (wikiPage.riskLevel === 'safe' && wikiPage.totalEvents >= LEARN.OBSERVE_MIN) {
                minConf = Math.min(minConf, wikiPage.confidence);
                continue;
            }
            if (wikiPage.riskLevel === 'caution' && wikiPage.confidence > 0) {
                minConf = Math.min(minConf, wikiPage.confidence * 0.5);
                continue;
            }
        }

        const entry = state.learnData[cmd];
        if (entry && entry.conf > 0) {
            minConf = Math.min(minConf, entry.conf);
            continue;
        }
        unknown.push(cmd);
    }

    if (unknown.length > 0) {
        return { allowed: false, reason: `Unknown commands: ${unknown.join(', ')}`, commands: cmds, confidence: 0, wiki: wikiInsights };
    }
    return { allowed: true, reason: 'All commands whitelisted', commands: cmds, confidence: minConf, wiki: wikiInsights };
}

/**
 * Configure VS Code terminal auto-approve settings based on whitelist + learned commands.
 */
function setupSafeApprove() {
    setTimeout(() => {
        try {
            const c = vscode.workspace.getConfiguration();
            const rules = c.get('chat.tools.terminal.autoApprove') || {};
            const allWhitelist = [...SAFE_TERMINAL_CMDS, ...state.userWhitelist];
            const promoted = getPromotedCommands();
            for (const cmd of promoted) {
                if (!allWhitelist.includes(cmd)) allWhitelist.push(cmd);
            }
            for (const pat of state.patternCache) {
                if (!allWhitelist.includes(pat)) allWhitelist.push(pat);
            }
            for (const cmd of allWhitelist) {
                if (!state.userBlacklist.includes(cmd)) rules[cmd] = true;
            }
            for (const cmd of state.userBlacklist) delete rules[cmd];
            delete rules['/^/'];
            delete rules['/.*/s'];

            c.update('chat.tools.terminal.autoApprove', rules, vscode.ConfigurationTarget.Global)
                .then(() => c.update('chat.tools.terminal.enableAutoApprove', true, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.tools.terminal.ignoreDefaultAutoApproveRules', false, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.tools.terminal.autoReplyToPrompts', true, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.tools.edits.autoApprove', true, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.agent.terminal.autoApprove', true, vscode.ConfigurationTarget.Global))
                .catch(() => {});
        } catch (_) {}
    }, 3000);
}

/**
 * Terminal activity listener — captures commands for the learning engine.
 * FIX: Only records once per command execution (at end, when exit code is known)
 * to prevent duplicate event recording.
 */
function setupTerminalListener(ctx) {
    const _pendingExecs = new Map();

    const hasShellExec = !!vscode.window.onDidStartTerminalShellExecution;
    const hasShellEnd  = !!vscode.window.onDidEndTerminalShellExecution;
    const hasWriteData = !!vscode.window.onDidWriteTerminalData;
    console.log(`[Grav] Terminal listener: shellExec=${hasShellExec} shellEnd=${hasShellEnd} writeData=${hasWriteData}`);

    // Track command start (don't record yet — wait for end event with exit code)
    if (vscode.window.onDidStartTerminalShellExecution) {
        ctx.subscriptions.push(
            vscode.window.onDidStartTerminalShellExecution(e => {
                try {
                    const cmdLine = e.execution?.commandLine?.value || e.execution?.commandLine || '';
                    console.log('[Grav] shellExec START:', cmdLine);
                    if (!cmdLine || cmdLine.length < 2) return;
                    const id = e.execution?.id || Date.now().toString();
                    _pendingExecs.set(id, { command: cmdLine, startTime: Date.now() });
                } catch (err) { console.error('[Grav] shellExec error:', err.message); }
            })
        );
    }

    // Record at command end (with exit code for RLVR)
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
                            recordCommandAction(pending.command, exitCode === 0 ? 'approve' : 'reject', {
                                exitCode,
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                                duration: Date.now() - pending.startTime,
                            });
                        }
                    } else {
                        const cmdLine = e.execution?.commandLine?.value || e.execution?.commandLine || '';
                        if (cmdLine && cfg('learnEnabled', true) && typeof exitCode === 'number') {
                            recordCommandAction(cmdLine, exitCode === 0 ? 'approve' : 'reject', {
                                exitCode,
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                            });
                        }
                    }
                } catch (_) {}
            })
        );
    }

    // Fallback for older VS Code without shell execution API
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
                            if (cmdMatch) {
                                const cmdLine = cmdMatch[1].trim();
                                if (cmdLine.length >= 2) {
                                    recordCommandAction(cmdLine, 'approve', {
                                        project: vscode.workspace.workspaceFolders?.[0]?.name,
                                    });
                                }
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

    // Terminal open tracking
    ctx.subscriptions.push(
        vscode.window.onDidOpenTerminal(t => {
            try {
                const name = t.name || '';
                console.log('[Grav] terminal opened:', name);
                if (name && cfg('learnEnabled', true)) {
                    const cmds = extractCommands(name);
                    if (cmds.length > 0 && cmds[0] !== 'terminal' && cmds[0] !== 'bash' && cmds[0] !== 'zsh' && cmds[0] !== 'sh') {
                        console.log('[Grav] learning from terminal name:', name, '\u2192', cmds);
                        recordCommandAction(name, 'approve', {
                            project: vscode.workspace.workspaceFolders?.[0]?.name,
                        });
                    }
                }
            } catch (_) {}
        })
    );

    // Cleanup stale pending executions (>5 min)
    const cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - 300000;
        for (const [id, p] of _pendingExecs) {
            if (p.startTime < cutoff) _pendingExecs.delete(id);
        }
    }, 60000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cleanupTimer) });

    // Poll shell integration command history
    const _seenCmds = new Set();
    const pollTimer = setInterval(() => {
        if (!cfg('learnEnabled', true) || !state.enabled) return;
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
                            console.log('[Grav] poll captured:', cmdLine);
                            const exitCode = typeof exec.exitCode === 'number' ? exec.exitCode : undefined;
                            recordCommandAction(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                                exitCode,
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                            });
                        }
                    }
                }
                if (si.commandDetection && si.commandDetection.commands) {
                    for (const cmd of si.commandDetection.commands) {
                        const cmdLine = cmd.command || cmd.commandLine?.value || '';
                        if (!cmdLine || cmdLine.length < 2) continue;
                        const key = term.name + ':' + cmdLine + ':' + (cmd.timestamp || cmd.startTimestamp || 0);
                        if (_seenCmds.has(key)) continue;
                        _seenCmds.add(key);
                        console.log('[Grav] history captured:', cmdLine);
                        const exitCode = typeof cmd.exitCode === 'number' ? cmd.exitCode : undefined;
                        recordCommandAction(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                            exitCode,
                            project: vscode.workspace.workspaceFolders?.[0]?.name,
                        });
                    }
                }
            }
            if (_seenCmds.size > 5000) {
                const arr = [..._seenCmds];
                _seenCmds.clear();
                for (let i = arr.length - 2000; i < arr.length; i++) _seenCmds.add(arr[i]);
            }
        } catch (_) {}
    }, 3000);
    ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

    // Shell integration change listener
    if (vscode.window.onDidChangeTerminalShellIntegration) {
        ctx.subscriptions.push(
            vscode.window.onDidChangeTerminalShellIntegration(e => {
                try {
                    const si = e.shellIntegration;
                    if (!si || !si.onDidExecuteCommand) return;
                    console.log('[Grav] shellIntegration ready for:', e.terminal?.name);
                    ctx.subscriptions.push(
                        si.onDidExecuteCommand(cmd => {
                            try {
                                const cmdLine = cmd.commandLine?.value || cmd.commandLine || '';
                                console.log('[Grav] shellIntegration cmd:', cmdLine, 'exit:', cmd.exitCode);
                                if (!cmdLine || cmdLine.length < 2 || !cfg('learnEnabled', true)) return;
                                const key = (e.terminal?.name || '') + ':' + cmdLine + ':' + Date.now();
                                if (_seenCmds.has(key)) return;
                                _seenCmds.add(key);
                                const exitCode = typeof cmd.exitCode === 'number' ? cmd.exitCode : undefined;
                                recordCommandAction(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                                    exitCode,
                                    project: vscode.workspace.workspaceFolders?.[0]?.name,
                                });
                            } catch (_) {}
                        })
                    );
                } catch (_) {}
            })
        );
    }
}

module.exports = { extractCommands, matchesBlacklist, evaluateCommand, setupSafeApprove, setupTerminalListener };
