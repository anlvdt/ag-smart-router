#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Grav — Test Runner (zero dependencies)
//  Run: node test/run-all.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testDir = __dirname;
const files = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.js'))
    .sort();

console.log(`\n🧪 Grav Test Suite — ${files.length} test files\n`);

let totalPassed = 0, totalFailed = 0;

for (const file of files) {
    const fp = path.join(testDir, file);
    try {
        const output = execSync(`node "${fp}"`, { encoding: 'utf8', timeout: 10000 });
        const match = output.match(/Results: (\d+) passed, (\d+) failed/);
        if (match) {
            const p = parseInt(match[1]), f = parseInt(match[2]);
            totalPassed += p;
            totalFailed += f;
            const icon = f > 0 ? '✗' : '✓';
            console.log(`  ${icon} ${file}: ${p} passed, ${f} failed`);
        } else {
            console.log(`  ? ${file}: (no summary found)`);
        }
    } catch (e) {
        totalFailed++;
        console.log(`  ✗ ${file}: CRASHED`);
        if (e.stderr) console.log(`    ${e.stderr.split('\n')[0]}`);
    }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
