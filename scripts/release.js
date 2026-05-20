#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const vsixName = `grav-${pkg.version}.vsix`;
const vsixPath = path.join(root, vsixName);
const forbiddenEntries = [
    '.kluster/',
    'scratch_',
    'media/dashboard-mock.html',
    'build-vsce.js',
    'AGENTS.md',
];

function run(cmd, args, options = {}) {
    const capture = !!options.capture;
    const result = spawnSync(cmd, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    if (result.status !== 0) {
        const stderr = capture ? (result.stderr || '') : '';
        throw new Error(`${cmd} ${args.join(' ')} failed${stderr ? `\n${stderr}` : ''}`);
    }
    return capture ? (result.stdout || '') : '';
}

function sha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

console.log(`\n== Grav release ${pkg.version} ==\n`);

run('npm', ['test']);

const tree = run('npx', ['-y', '@vscode/vsce', 'ls', '--tree'], { capture: true });
for (const forbidden of forbiddenEntries) {
    if (tree.includes(forbidden)) {
        throw new Error(`Refusing release: VSIX tree still contains "${forbidden}"`);
    }
}

console.log(tree.trim());
run('npx', ['-y', '@vscode/vsce', 'package']);

if (!fs.existsSync(vsixPath)) {
    throw new Error(`Expected VSIX not found: ${vsixPath}`);
}

const digest = sha256(vsixPath);
const size = fs.statSync(vsixPath).size;

console.log('\n== Release artifact ==');
console.log(`VSIX   ${vsixName}`);
console.log(`Bytes  ${size}`);
console.log(`SHA256 ${digest}`);
