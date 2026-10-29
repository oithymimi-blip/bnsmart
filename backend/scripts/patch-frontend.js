'use strict';

/**
 * patch-frontend.js — Update frontend and public HTML files with the deployed contract & wallet addresses
 *
 * Usage:  node scripts/patch-frontend.js [0xCONTRACT_ADDRESS] [0xADMIN_WALLET]
 *    or:  node scripts/patch-frontend.js   (reads from deployed.json or .env)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

let contractAddress = process.argv[2];
let adminWallet     = process.argv[3];

// Try reading from deployed.json if no arg
if (!contractAddress) {
  const recPath = path.join(__dirname, '..', '..', 'deployed.json');
  if (fs.existsSync(recPath)) {
    try {
      contractAddress = JSON.parse(fs.readFileSync(recPath, 'utf8')).contractAddress;
    } catch (_) {}
  }
}

// Try reading from .env
if (!contractAddress) {
  contractAddress = process.env.GATEWAY_ADDRESS || '0xee4CE2048988aFf55Ec46933D7409A6d79C64F8A';
}

if (!adminWallet) {
  adminWallet = process.env.TREASURY || '0x28C8383b19B254D8A59DB32440dAF4E08c6FC396';
}

if (!contractAddress || contractAddress === 'PENDING_DEPLOY') {
  console.warn('⚠️  No deployed contract address found. Skipping contract address patch or using existing.');
}

const filesToPatch = [
  path.join(__dirname, '..', '..', 'frontend', 'index.html'),
  path.join(__dirname, '..', '..', 'frontend', 'ref', 'index.html'),
  path.join(__dirname, '..', '..', 'frontend', 'super.html'),
  path.join(__dirname, '..', '..', 'frontend', 'super', 'index.html'),
  path.join(__dirname, '..', '..', 'public', 'index.html'),
  path.join(__dirname, '..', '..', 'public', 'ref', 'index.html'),
  path.join(__dirname, '..', '..', 'public', 'super.html'),
  path.join(__dirname, '..', '..', 'public', 'super', 'index.html'),
  path.join(__dirname, '..', 'public', 'index.html'),
  path.join(__dirname, '..', 'public', 'super.html')
];

for (const filePath of filesToPatch) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  if (contractAddress && contractAddress !== 'PENDING_DEPLOY') {
    const gatewayRegex = /const GATEWAY\s*=\s*["'](?:0x[a-fA-F0-9]{40}|0xYOUR_GATEWAY_ADDRESS_HERE)["']/;
    if (gatewayRegex.test(content)) {
      content = content.replace(gatewayRegex, `const GATEWAY                   = "${contractAddress}"`);
      changed = true;
    }

    const bnsmartContractRegex = /const BNSMART_CONTRACT_ADDRESS\s*=\s*["'](?:0x[a-fA-F0-9]{40}|0xYOUR_GATEWAY_ADDRESS_HERE)["']/;
    if (bnsmartContractRegex.test(content)) {
      content = content.replace(bnsmartContractRegex, `const BNSMART_CONTRACT_ADDRESS = "${contractAddress}"`);
      changed = true;
    }

    const eraContractRegex = /const ERAVAREX_CONTRACT_ADDRESS\s*=\s*["'](?:0x[a-fA-F0-9]{40}|0xYOUR_GATEWAY_ADDRESS_HERE)["']/;
    if (eraContractRegex.test(content)) {
      content = content.replace(eraContractRegex, `const ERAVAREX_CONTRACT_ADDRESS = "${contractAddress}"`);
      changed = true;
    }
  }

  if (adminWallet) {
    const bnsmartWalletRegex = /const BNSMART_ADMIN_WALLET\s*=\s*["'](?:0x[a-fA-F0-9]{40}|0xYOUR_TREASURY_ADDRESS_HERE)["']/;
    if (bnsmartWalletRegex.test(content)) {
      content = content.replace(bnsmartWalletRegex, `const BNSMART_ADMIN_WALLET     = "${adminWallet}"`);
      changed = true;
    }

    const eraWalletRegex = /const ERAVAREX_ADMIN_WALLET\s*=\s*["'](?:0x[a-fA-F0-9]{40}|0xYOUR_TREASURY_ADDRESS_HERE)["']/;
    if (eraWalletRegex.test(content)) {
      content = content.replace(eraWalletRegex, `const ERAVAREX_ADMIN_WALLET     = "${adminWallet}"`);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log(`✅  Patched ${path.relative(path.join(__dirname, '..', '..'), filePath)}`);
  }
}
