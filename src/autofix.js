'use strict';

/**
 * Common typo mappings.
 * Keys should be lowercase, trimmed command prefixes.
 */
const TYPO_MAP = {
    'gti ': 'git ',
    'npm instal ': 'npm install ',
    'npm instal': 'npm install',
    'npm rnu ': 'npm run ',
    'yarn addd ': 'yarn add ',
    'cleaer': 'clear',
    'claer': 'clear',
    'gi t': 'git ',
    'gti status': 'git status',
    'git stats': 'git status',
    'git statsu': 'git status',
    'git psuh': 'git push',
    'git plul': 'git pull',
    'yarn addd': 'yarn add',
    'npx crate-react-app': 'npx create-react-app',
    'npx create-next-app': 'npx create-next-app@latest' // common modernization
};

/**
 * Evaluate a failed command line and its terminal output to determine
 * if a safe, automatic fix can be applied.
 * 
 * @param {string} cmdLine The command that failed.
 * @param {string} output The last few lines of terminal output.
 * @returns {string|null} The corrected command, or null if no fix is found.
 */
function evaluate(cmdLine, output) {
    if (!cmdLine || typeof cmdLine !== 'string') return null;
    const cmd = cmdLine.trim();
    if (!cmd) return null;

    const lowerCmd = cmd.toLowerCase();
    const outStr = (output || '').toLowerCase();

    // 1. Check exact typo matches
    for (const [typo, fix] of Object.entries(TYPO_MAP)) {
        if (lowerCmd === typo || lowerCmd.startsWith(typo)) {
            // Keep the rest of the arguments if it was a prefix match
            if (lowerCmd.startsWith(typo) && lowerCmd !== typo) {
                // Ensure we don't accidentally replace a substring in the middle
                const originalArgs = cmd.substring(typo.length);
                return fix + originalArgs;
            }
            return fix;
        }
    }

    // 2. Python missing alias (common on macOS)
    if (lowerCmd.startsWith('python ') || lowerCmd === 'python') {
        if (outStr.includes('command not found: python') || outStr.includes('is not recognized') || outStr.includes('no such file or directory')) {
            return cmd.replace(/^python/i, 'python3');
        }
    }

    // 3. Pip missing alias
    if (lowerCmd.startsWith('pip ') || lowerCmd === 'pip') {
        if (outStr.includes('command not found: pip') || outStr.includes('is not recognized')) {
            return cmd.replace(/^pip/i, 'pip3');
        }
    }

    // 4. Git "most similar command is" parser
    // Example: "git: 'stats' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tstatus"
    if (lowerCmd.startsWith('git ')) {
        const similarMatch = output.match(/most similar command is\s*\n\s*([a-zA-Z0-9_-]+)/i);
        if (similarMatch && similarMatch[1]) {
            const suggested = similarMatch[1].trim();
            // We need to replace the invalid git subcommand with the suggested one
            // We can just extract the arguments assuming structure `git <bad> <args>`
            const parts = cmd.split(/\s+/);
            if (parts.length >= 2) {
                parts[1] = suggested;
                return parts.join(' ');
            }
        }
    }

    return null;
}

module.exports = {
    evaluate
};
