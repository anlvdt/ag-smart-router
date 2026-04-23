const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: { env: { appRoot: '/mock' }, workspace: { getConfiguration: () => ({ get: (k, f) => f }) } }, children: [], paths: [] };

const { SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST } = require('../src/constants');
const { matchesBlacklist } = require('../src/utils');

let conflicts = 0;
for (const cmd of SAFE_TERMINAL_CMDS) {
    let match = matchesBlacklist(cmd, DEFAULT_BLACKLIST);
    if (match) { console.log('BARE CONFLICT: "' + cmd + '" blocked by "' + match + '"'); conflicts++; }

    const argSets = [
        ' install', ' status', ' -h', ' --help', ' --version',
        ' -9 1234', ' -f', ' -rf .', ' --force',
        ' -a', ' push', ' push origin main', ' push -f',
        ' clean', ' clean -fdx',
        ' -R 777 /', ' -r root /',
        ' if=/dev/zero', ' if=/dev/urandom',
        ' -rf /', ' -rf ~', ' -rf *', ' -rf .git',
        ' system prune -a --volumes',
        ' delete hk',
        ' |sh', ' |bash',
    ];
    for (const args of argSets) {
        match = matchesBlacklist(cmd + args, DEFAULT_BLACKLIST);
        if (match) { console.log('  ARGS CONFLICT: "' + cmd + args + '" blocked by "' + match + '"'); conflicts++; }
    }
}
console.log('\n' + (conflicts === 0 ? 'OK: No conflicts' : 'FOUND: ' + conflicts + ' conflicts'));
