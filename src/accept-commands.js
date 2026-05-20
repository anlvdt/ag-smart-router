'use strict';

const SKIP_DISCOVERY_TERMS = Object.freeze([
    'setting', 'config', 'preference', 'browser', 'permission', 'manage',
    'open', 'show', 'toggle', 'enable', 'disable', 'edit', 'view',
    'list', 'reset', 'clear', 'input', 'prompt', 'dialog', 'confirm',
    'ask', 'select', 'pick', 'choose',
]);

const ACCEPT_COMMAND_WHITELIST = Object.freeze([
    'antigravity.accept',
    'antigravity.acceptAll',
    'windsurf.accept',
    'windsurf.acceptAll',
    'cascade.accept',
    'cascade.acceptAll',
    'codeium.accept',
    'workbench.action.chat.applyAll',
    'workbench.action.chat.accept',
    'inlineChat.accept',
    'chatEditor.action.accept',
    'github.copilot.acceptWorkspaceEdit',
]);

const SAFE_NATIVE_ACCEPT_COMMANDS = Object.freeze([
    'workbench.action.chat.applyAll',
    'inlineChat.accept',
    'chatEditor.action.accept',
    'github.copilot.acceptWorkspaceEdit',
]);

function normalizeCommandId(cmd) {
    return String(cmd || '').trim().toLowerCase();
}

function deriveDynamicAcceptCommands(allCommands) {
    const commands = Array.isArray(allCommands) ? allCommands : [];
    const discovered = commands.filter((cmd) => {
        const lower = normalizeCommandId(cmd);
        if (!lower) return false;

        if (ACCEPT_COMMAND_WHITELIST.some((item) => lower === item.toLowerCase())) {
            return true;
        }

        const namespaceMatch = lower.includes('antigravity') ||
            lower.includes('windsurf') ||
            lower.includes('cascade') ||
            lower.includes('codeium') ||
            lower.includes('agent') ||
            lower.includes('copilot') ||
            lower.includes('chat') ||
            lower.includes('inlinechat');
        const actionMatch = lower.includes('accept') ||
            lower.includes('approve') ||
            lower.includes('allow') ||
            lower.includes('keep') ||
            lower.includes('apply');

        if (SKIP_DISCOVERY_TERMS.some((term) => lower.includes(term))) return false;
        return namespaceMatch && actionMatch;
    });

    const merged = [...discovered];
    for (const cmd of ACCEPT_COMMAND_WHITELIST) {
        if (!merged.some((item) => normalizeCommandId(item) === normalizeCommandId(cmd))) {
            merged.push(cmd);
        }
    }
    return merged;
}

function isSafeNativeAcceptCommand(cmd) {
    const lower = normalizeCommandId(cmd);
    return SAFE_NATIVE_ACCEPT_COMMANDS.some((item) => lower === item.toLowerCase());
}

function isBlindAcceptCommand(cmd) {
    const lower = normalizeCommandId(cmd);
    if (!lower) return false;
    if (isSafeNativeAcceptCommand(lower)) return false;
    if (lower === 'workbench.action.chat.accept') return true;

    return (
        lower.startsWith('antigravity.') ||
        lower.startsWith('windsurf.') ||
        lower.startsWith('cascade.') ||
        lower.startsWith('codeium.')
    ) && (
        lower.includes('.accept') ||
        lower.includes('.approve') ||
        lower.includes('.allow')
    );
}

function shouldExecuteAcceptCommand(cmd, options = {}) {
    const skipTerminalAccept = options.skipTerminalAccept !== false;
    const skipBrowserAgent = !!options.skipBrowserAgent;

    if ((skipTerminalAccept || skipBrowserAgent) && isBlindAcceptCommand(cmd)) {
        return false;
    }
    return true;
}

function partitionAcceptCommands(commands, options = {}) {
    const allowed = [];
    const filtered = [];
    for (const cmd of commands || []) {
        if (shouldExecuteAcceptCommand(cmd, options)) allowed.push(cmd);
        else filtered.push(cmd);
    }
    return { allowed, filtered };
}

module.exports = {
    ACCEPT_COMMAND_WHITELIST,
    SAFE_NATIVE_ACCEPT_COMMANDS,
    deriveDynamicAcceptCommands,
    isBlindAcceptCommand,
    partitionAcceptCommands,
    shouldExecuteAcceptCommand,
};
