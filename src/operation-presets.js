'use strict';

const { DEFAULT_PATTERNS, RISKY_PATTERNS, PRESET_PATTERNS } = require('./constants');

const KNOWN_PATTERN_VARIANTS = Object.freeze([
    'ACCEPT ALL',
    'Allow This Workspace',
]);

const VALID_PATTERN_SET = new Set([
    ...DEFAULT_PATTERNS,
    ...RISKY_PATTERNS,
    ...Object.values(PRESET_PATTERNS).flat(),
    ...KNOWN_PATTERN_VARIANTS,
]);

const ORDERED_VALID_PATTERNS = Object.freeze([...VALID_PATTERN_SET]);

const OPERATION_PRESETS = Object.freeze({
    safe: {
        label: 'Safe',
        description: 'Code edits and agent flow only. Terminal and browser approvals stay conservative.',
        approvePatterns: [
            'Accept',
            'Accept All',
            'Accept all',
            'Retry',
            'Proceed',
            'Approve',
            'Expand',
        ],
        skipBrowserAgent: true,
        skipTerminalAccept: true,
        approveIntervalMs: 1800,
        autoScroll: true,
        dryRun: false,
        presetMode: 'custom',
    },
    balanced: {
        label: 'Balanced',
        description: 'Default operating mode. Covers common terminal approvals while keeping browser/tool safety on.',
        approvePatterns: [
            'Accept',
            'Accept All',
            'Accept all',
            'ACCEPT ALL',
            'Retry',
            'Proceed',
            'Run Task',
            'Run',
            'Execute',
            'Approve',
            'Expand',
            'Allow in Workspace',
            'Allow This Workspace',
        ],
        skipBrowserAgent: true,
        skipTerminalAccept: true,
        approveIntervalMs: 1200,
        autoScroll: true,
        dryRun: false,
        presetMode: 'custom',
    },
    fast: {
        label: 'Fast',
        description: 'Moves quickest through routine flows. Browser skip is off and blind native accepts are allowed.',
        approvePatterns: [
            'Accept',
            'Accept All',
            'Accept all',
            'ACCEPT ALL',
            'Retry',
            'Proceed',
            'Run Task',
            'Run',
            'Execute',
            'Approve',
            'Expand',
            'Allow in Workspace',
            'Allow This Workspace',
            'Allow',
            'Allow Once',
        ],
        skipBrowserAgent: false,
        skipTerminalAccept: false,
        approveIntervalMs: 700,
        autoScroll: true,
        dryRun: false,
        presetMode: 'custom',
    },
});

function getOperationPresets() {
    return Object.entries(OPERATION_PRESETS).map(([id, preset]) => ({
        id,
        label: preset.label,
        description: preset.description,
    }));
}

function getOperationPreset(mode) {
    return OPERATION_PRESETS[mode] || null;
}

function buildOperationPreset(mode) {
    const preset = getOperationPreset(mode);
    if (!preset) return null;

    const approvePatterns = [...new Set(preset.approvePatterns.filter((pattern) => VALID_PATTERN_SET.has(pattern)))];
    const disabledPatterns = ORDERED_VALID_PATTERNS.filter((pattern) => !approvePatterns.includes(pattern));

    return {
        operationMode: mode,
        label: preset.label,
        description: preset.description,
        presetMode: preset.presetMode || 'custom',
        approvePatterns,
        disabledPatterns,
        skipBrowserAgent: !!preset.skipBrowserAgent,
        skipTerminalAccept: preset.skipTerminalAccept !== false,
        approveIntervalMs: preset.approveIntervalMs,
        autoScroll: preset.autoScroll !== false,
        dryRun: !!preset.dryRun,
        enabled: true,
    };
}

function isKnownOperationMode(mode) {
    return !!getOperationPreset(mode);
}

function normalizeOperationMode(mode) {
    return isKnownOperationMode(mode) ? mode : 'custom';
}

module.exports = {
    ORDERED_VALID_PATTERNS,
    buildOperationPreset,
    getOperationPreset,
    getOperationPresets,
    isKnownOperationMode,
    normalizeOperationMode,
};
