// ═══════════════════════════════════════════════════════════════
//  Unit tests for terminal command analysis
// ═══════════════════════════════════════════════════════════════

// Mock vscode module before requiring anything
jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => fallback,
        }),
    },
    window: {},
    ConfigurationTarget: { Global: 1 },
}), { virtual: true });

const { extractCommands, matchesBlacklist, evaluateCommand } = require('../src/terminal');
const { LEARN } = require('../src/constants');

describe('extractCommands', () => {
    test('returns empty array for empty/null input', () => {
        expect(extractCommands('')).toEqual([]);
        expect(extractCommands(null)).toEqual([]);
        expect(extractCommands(undefined)).toEqual([]);
    });

    test('extracts single command', () => {
        expect(extractCommands('npm install')).toEqual(['npm']);
    });

    test('extracts piped commands', () => {
        expect(extractCommands('cat file | grep test')).toEqual(['cat', 'grep']);
    });

    test('extracts chained commands (&&)', () => {
        expect(extractCommands('npm run build && npm test')).toEqual(['npm']);
    });

    test('extracts chained different commands', () => {
        expect(extractCommands('mkdir dist && cp file.js dist/')).toEqual(['mkdir', 'cp']);
    });

    test('strips sudo prefix', () => {
        expect(extractCommands('sudo apt-get install nginx')).toEqual(['apt-get']);
    });

    test('strips env var assignments', () => {
        expect(extractCommands('NODE_ENV=production npm start')).toEqual(['npm']);
    });

    test('strips path prefixes', () => {
        expect(extractCommands('/usr/bin/node script.js')).toEqual(['node']);
    });

    test('deduplicates commands', () => {
        expect(extractCommands('npm install && npm run build')).toEqual(['npm']);
    });

    test('handles semicolons', () => {
        expect(extractCommands('echo hello; ls -la')).toEqual(['echo', 'ls']);
    });

    test('handles || operator', () => {
        expect(extractCommands('make || cmake .')).toEqual(['make', 'cmake']);
    });

    test('handles nohup and time prefixes', () => {
        expect(extractCommands('nohup time python script.py')).toEqual(['python']);
    });

    test('lowercases commands', () => {
        expect(extractCommands('NPM install')).toEqual(['npm']);
    });
});

describe('matchesBlacklist', () => {
    const blacklist = ['rm -rf /', 'mkfs', ':(){:|:&};:', 'format c:'];

    test('returns null for safe commands', () => {
        expect(matchesBlacklist('npm install', blacklist)).toBeNull();
        expect(matchesBlacklist('git push origin main', blacklist)).toBeNull();
    });

    test('matches exact substring', () => {
        expect(matchesBlacklist('rm -rf /', blacklist)).toBe('rm -rf /');
    });

    test('matches pattern within longer command', () => {
        expect(matchesBlacklist('sudo rm -rf / --no-preserve-root', blacklist)).toBe('rm -rf /');
    });

    test('matches mkfs', () => {
        expect(matchesBlacklist('mkfs.ext4 /dev/sda1', blacklist)).toBe('mkfs');
    });

    test('matches fork bomb', () => {
        expect(matchesBlacklist(':(){:|:&};:', blacklist)).toBe(':(){:|:&};:');
    });

    test('case insensitive', () => {
        expect(matchesBlacklist('FORMAT C:', blacklist)).toBe('format c:');
    });

    test('respects regex pattern', () => {
        const withRegex = [...blacklist, '/^eval\\s+/'];
        expect(matchesBlacklist('eval "dangerous code"', withRegex)).toBe('/^eval\\s+/');
    });

    test('skips regex patterns exceeding max length', () => {
        const longRegex = '/' + 'a'.repeat(LEARN.MAX_REGEX_LEN) + '/';
        expect(matchesBlacklist('aaa', [longRegex])).toBeNull();
    });

    test('handles invalid regex gracefully', () => {
        const badRegex = ['/[invalid/'];
        expect(matchesBlacklist('test', badRegex)).toBeNull();
    });
});

describe('evaluateCommand', () => {
    test('allows known safe commands', () => {
        const result = evaluateCommand('npm install');
        expect(result.allowed).toBe(true);
        expect(result.commands).toEqual(['npm']);
    });

    test('allows piped safe commands', () => {
        const result = evaluateCommand('cat file | grep pattern | sort');
        expect(result.allowed).toBe(true);
    });

    test('blocks blacklisted commands', () => {
        const result = evaluateCommand('rm -rf /');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Blocked by blacklist');
        expect(result.confidence).toBe(-1);
    });

    test('blocks unknown commands', () => {
        const result = evaluateCommand('some_unknown_tool --flag');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Unknown commands');
    });

    test('rejects unparseable input', () => {
        const result = evaluateCommand('');
        expect(result.allowed).toBe(false);
    });

    test('allows all common dev commands', () => {
        const devCmds = [
            'git status',
            'npm run build',
            'docker compose up -d',
            'cargo test',
            'python manage.py migrate',
            'kubectl get pods',
            'eslint src/',
            'jest --coverage',
        ];
        for (const cmd of devCmds) {
            const result = evaluateCommand(cmd);
            expect(result.allowed).toBe(true);
        }
    });

    test('blocks fork bomb regardless of context', () => {
        const result = evaluateCommand(':(){:|:&};:');
        expect(result.allowed).toBe(false);
    });
});
