// ═══════════════════════════════════════════════════════════════
//  Unit tests for AI Learning Engine
// ═══════════════════════════════════════════════════════════════

jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => fallback,
            update: jest.fn().mockResolvedValue(undefined),
        }),
    },
    window: {
        showInformationMessage: jest.fn().mockResolvedValue(null),
        showWarningMessage: jest.fn().mockResolvedValue(null),
    },
    ConfigurationTarget: { Global: 1 },
}), { virtual: true });

const { state, createEmptyWiki } = require('../src/state');
const { LEARN, SAFE_TERMINAL_CMDS } = require('../src/constants');
const { extractCommandsForLearning, classifyCommand, recordCommandAction, getPromotedCommands, wikiQuery, wikiLint } = require('../src/learning');

afterEach(() => {
    jest.clearAllTimers();
});

beforeEach(() => {
    jest.useFakeTimers();
    state.learnData = {};
    state.learnEpoch = 0;
    state.userWhitelist = [];
    state.userBlacklist = [];
    state.patternCache = [];
    state.wiki = createEmptyWiki();
    state.ctx = {
        globalState: {
            get: jest.fn().mockReturnValue({}),
            update: jest.fn().mockResolvedValue(undefined),
        },
    };
});

describe('extractCommandsForLearning', () => {
    test('extracts from pipe chain', () => {
        expect(extractCommandsForLearning('git log | head -20')).toEqual(['git', 'head']);
    });

    test('handles empty input', () => {
        expect(extractCommandsForLearning('')).toEqual([]);
        expect(extractCommandsForLearning(null)).toEqual([]);
    });
});

describe('classifyCommand', () => {
    test('classifies npm as package-manager', () => {
        expect(classifyCommand('npm')).toBe('package-manager');
    });

    test('classifies git as version-control', () => {
        expect(classifyCommand('git')).toBe('version-control');
    });

    test('classifies docker as container-ops', () => {
        expect(classifyCommand('docker')).toBe('container-ops');
    });

    test('classifies jest as test-runner', () => {
        expect(classifyCommand('jest')).toBe('test-runner');
    });

    test('classifies unknown command as null', () => {
        expect(classifyCommand('my_custom_tool')).toBeNull();
    });

    test('classifies .py files as language-runtime', () => {
        expect(classifyCommand('script.py')).toBe('language-runtime');
    });

    test('classifies .sh files as shell-script', () => {
        expect(classifyCommand('deploy.sh')).toBe('shell-script');
    });
});

describe('recordCommandAction', () => {
    test('creates new entry for unknown command', () => {
        recordCommandAction('npm install', 'approve', {});
        expect(state.learnData['npm']).toBeDefined();
        expect(state.learnData['npm'].obs).toBe(1);
        expect(state.learnData['npm'].conf).toBeGreaterThan(0);
    });

    test('increases confidence on approve', () => {
        recordCommandAction('cargo build', 'approve', {});
        const conf1 = state.learnData['cargo'].conf;
        recordCommandAction('cargo build', 'approve', {});
        const conf2 = state.learnData['cargo'].conf;
        expect(conf2).toBeGreaterThan(conf1);
    });

    test('decreases confidence on repeated rejects', () => {
        // With SGD + momentum, need enough rejects to overcome batch averaging
        for (let i = 0; i < 5; i++) recordCommandAction('risky_cmd', 'reject', {});
        const confAfter = state.learnData['risky_cmd'].conf;
        expect(confAfter).toBeLessThan(0);
    });

    test('rewards extra for approve + exit code 0', () => {
        recordCommandAction('cmd_a', 'approve', { exitCode: 0 });
        const confA = state.learnData['cmd_a'].conf;

        recordCommandAction('cmd_b', 'approve', {});
        const confB = state.learnData['cmd_b'].conf;

        expect(confA).toBeGreaterThan(confB);
    });

    test('penalizes approve with non-zero exit code', () => {
        recordCommandAction('cmd_c', 'approve', { exitCode: 1 });
        const confC = state.learnData['cmd_c'].conf;

        recordCommandAction('cmd_d', 'approve', { exitCode: 0 });
        const confD = state.learnData['cmd_d'].conf;

        expect(confC).toBeLessThan(confD);
    });

    test('increments epoch', () => {
        expect(state.learnEpoch).toBe(0);
        recordCommandAction('ls', 'approve', {});
        expect(state.learnEpoch).toBe(1);
        recordCommandAction('ls', 'approve', {});
        expect(state.learnEpoch).toBe(2);
    });

    test('records history entries', () => {
        recordCommandAction('git status', 'approve', {});
        expect(state.learnData['git'].history.length).toBe(1);
        expect(state.learnData['git'].history[0]).toHaveProperty('t');
        expect(state.learnData['git'].history[0]).toHaveProperty('c');
        expect(state.learnData['git'].history[0]).toHaveProperty('r');
    });

    test('limits rewards buffer to BATCH_SIZE', () => {
        for (let i = 0; i < LEARN.BATCH_SIZE + 5; i++) {
            recordCommandAction('batch_cmd', 'approve', {});
        }
        expect(state.learnData['batch_cmd'].rewards.length).toBeLessThanOrEqual(LEARN.BATCH_SIZE);
    });

    test('confidence stays in [-1, 1]', () => {
        for (let i = 0; i < 100; i++) {
            recordCommandAction('bounded_cmd', 'approve', { exitCode: 0 });
        }
        expect(state.learnData['bounded_cmd'].conf).toBeLessThanOrEqual(1);
        expect(state.learnData['bounded_cmd'].conf).toBeGreaterThanOrEqual(-1);
    });

    test('ingests into wiki', () => {
        recordCommandAction('webpack build', 'approve', {});
        expect(state.wiki.index['webpack']).toBeDefined();
        expect(state.wiki.index['webpack'].totalEvents).toBe(1);
        expect(state.wiki.index['webpack'].approves).toBe(1);
    });
});

describe('getPromotedCommands', () => {
    test('returns empty when no data', () => {
        expect(getPromotedCommands()).toEqual([]);
    });

    test('returns commands above promote threshold', () => {
        state.learnData['trusted_cmd'] = {
            conf: LEARN.PROMOTE_THRESH + 0.01,
            obs: LEARN.OBSERVE_MIN,
            velocity: 0, rewards: [], history: [], contexts: {},
            lastSeen: Date.now(), promoted: false, demoted: false,
        };
        state.learnData['untrusted_cmd'] = {
            conf: 0.1,
            obs: LEARN.OBSERVE_MIN,
            velocity: 0, rewards: [], history: [], contexts: {},
            lastSeen: Date.now(), promoted: false, demoted: false,
        };
        const promoted = getPromotedCommands();
        expect(promoted).toContain('trusted_cmd');
        expect(promoted).not.toContain('untrusted_cmd');
    });

    test('requires minimum observations', () => {
        state.learnData['new_cmd'] = {
            conf: 0.99,
            obs: LEARN.OBSERVE_MIN - 1,
            velocity: 0, rewards: [], history: [], contexts: {},
            lastSeen: Date.now(), promoted: false, demoted: false,
        };
        expect(getPromotedCommands()).not.toContain('new_cmd');
    });
});

describe('wikiQuery', () => {
    test('returns null for unknown command', () => {
        expect(wikiQuery('nonexistent')).toBeNull();
    });

    test('returns page data for known command', () => {
        recordCommandAction('npm test', 'approve', {});
        const result = wikiQuery('npm');
        expect(result).not.toBeNull();
        expect(result.totalEvents).toBe(1);
        expect(result.riskLevel).toBeDefined();
    });
});

describe('wikiLint', () => {
    test('returns empty issues for clean wiki', () => {
        const issues = wikiLint();
        expect(Array.isArray(issues)).toBe(true);
    });

    test('detects orphan pages', () => {
        state.wiki.index['orphan_cmd'] = {
            firstSeen: Date.now(), lastUpdated: Date.now(),
            totalEvents: 5, approves: 5, rejects: 0,
            confidence: 0.8, links: [], sources: [],
            tags: [], summary: '', riskLevel: 'safe',
        };
        const issues = wikiLint();
        const orphanIssue = issues.find(i => i.type === 'orphans');
        expect(orphanIssue).toBeDefined();
        expect(orphanIssue.items).toContain('orphan_cmd');
    });
});
