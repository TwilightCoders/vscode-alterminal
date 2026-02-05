#!/usr/bin/env node
const fs = require('fs');

const requiredBinaries = [
  'node_modules/@lydell/node-pty',
  'node_modules/@lydell/node-pty-darwin-x64',
  'node_modules/@lydell/node-pty-darwin-arm64',
  'node_modules/@lydell/node-pty-linux-x64',
  'node_modules/@lydell/node-pty-linux-arm64',
  'node_modules/@lydell/node-pty-win32-x64',
];

let missing = [];
for (const binary of requiredBinaries) {
  if (!fs.existsSync(binary)) {
    missing.push(binary);
  }
}

if (missing.length > 0) {
  console.error('❌ ERROR: Missing required binaries:');
  missing.forEach(b => console.error('  - ' + b));
  console.error('\nRun: npm run install-binaries');
  process.exit(1);
}

console.log('✅ All platform binaries present');
