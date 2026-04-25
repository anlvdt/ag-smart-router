// ═══════════════════════════════════════════════════════════════
//  Unit tests for utility functions
// ═══════════════════════════════════════════════════════════════

jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => fallback,
        }),
    },
}), { virtual: true });

const { esc, shellEscape, cfg } = require('../src/utils');

describe('esc (regex escape)', () => {
    test('escapes special regex characters', () => {
        expect(esc('a.b')).toBe('a\\.b');
        expect(esc('a*b')).toBe('a\\*b');
        expect(esc('a+b')).toBe('a\\+b');
        expect(esc('a?b')).toBe('a\\?b');
        expect(esc('a(b)')).toBe('a\\(b\\)');
        expect(esc('a[b]')).toBe('a\\[b\\]');
    });

    test('returns plain strings unchanged', () => {
        expect(esc('hello')).toBe('hello');
        expect(esc('abc123')).toBe('abc123');
    });
});

describe('shellEscape', () => {
    test('escapes single quotes', () => {
        expect(shellEscape("hello")).toBe("hello");
        expect(shellEscape("it's")).toBe("it'\\''s");
    });

    test('handles multiple single quotes', () => {
        expect(shellEscape("it's a 'test'")).toBe("it'\\''s a '\\''test'\\''");
    });

    test('no-op for strings without quotes', () => {
        expect(shellEscape('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    });
});

describe('cfg', () => {
    test('returns fallback value', () => {
        expect(cfg('nonExistent', 42)).toBe(42);
    });

    test('returns fallback string', () => {
        expect(cfg('language', 'vi')).toBe('vi');
    });
});
