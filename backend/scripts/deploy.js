'use strict';

/**
 * deploy.js — Deploy EraVarex.sol to BSC Mainnet
 *
 * Usage:  node scripts/deploy.js
 *
 * Reads ADMIN_PRIVATE_KEY + RPC_URL from ../.env
 * Writes the deployed address back to ../.env (GATEWAY_ADDRESS)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');

async function main() {
  console.log('\n🚀  BNSmart Deployment Script');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!process.env.ADMIN_PRIVATE_KEY || !process.env.RPC_URL) {
    console.error('❌  Missing ADMIN_PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const rawKey   = process.env.ADMIN_PRIVATE_KEY.trim();
  const formattedKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;
  const wallet   = new ethers.Wallet(formattedKey, provider);
  const address  = wallet.address;

  const network = await provider.getNetwork();
  const balance = await provider.getBalance(address);

  console.log(`  Network  : ${network.name} (chainId ${network.chainId})`);
  console.log(`  Deployer : ${address}`);
  console.log(`  Balance  : ${ethers.formatEther(balance)} BNB`);

  if (balance < ethers.parseEther('0.0001')) {
    console.error(`\n❌  Insufficient BNB. Current: ${ethers.formatEther(balance)} BNB`);
    console.error('    Send at least 0.001 BNB to:', address);
    console.error('    Alternatively, follow the manual deployment guide on BSCScan / Remix.');
    process.exit(1);
  }

  // Read compiled bytecode from solc output
  const contractPath = path.join(__dirname, '..', '..', 'contracts', 'BNSmart.sol');
  console.log(`\n  Contract : ${contractPath}`);
  console.log('  Compiling with solc...');

  const solc = require('solc');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { 'BNSmart.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      console.error('❌  Compilation errors:');
      errors.forEach(e => console.error(' ', e.formattedMessage));
      process.exit(1);
    }
    output.errors.filter(e => e.severity === 'warning').forEach(w => {
      console.warn('  ⚠️ ', w.message);
    });
  }

  const contract = output.contracts['BNSmart.sol']['BNSmart'];
  const abi      = contract.abi;
  const bytecode = '0x' + contract.evm.bytecode.object;

  console.log('  ✅ Compiled successfully (Bytecode size: ' + Math.floor(bytecode.length / 2) + ' bytes)\n');

  // Deploy
  console.log('  Sending deployment transaction...');
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy();

  const deployTxHash = deployed.deploymentTransaction().hash;
  console.log(`  Tx hash  : ${deployTxHash}`);
  console.log('  ⏳ Waiting for confirmation...\n');

  await deployed.waitForDeployment();
  const contractAddress = await deployed.getAddress();

  console.log(`  ✅ Deployed at: ${contractAddress}`);

  // Set treasury if specified and different from deployer
  const treasuryTarget = (process.env.TREASURY || address).trim();
  if (treasuryTarget.toLowerCase() !== address.toLowerCase()) {
    console.log(`\n  Setting treasury to ${treasuryTarget}...`);
    const instance = new ethers.Contract(contractAddress, abi, wallet);
    const tx2 = await instance.setVault(treasuryTarget);
    await tx2.wait();
    console.log(`  ✅ Treasury / Vault set to: ${treasuryTarget}`);
  } else {
    console.log(`\n  Vault automatically initialized to deployer: ${address}`);
  }

  // Patch .env
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (/GATEWAY_ADDRESS=.*/.test(envContent)) {
      envContent = envContent.replace(/GATEWAY_ADDRESS=.*/, `GATEWAY_ADDRESS=${contractAddress}`);
    } else {
      envContent += `\nGATEWAY_ADDRESS=${contractAddress}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log(`  ✅ .env updated with GATEWAY_ADDRESS=${contractAddress}`);
  }

  // Write deployment record (gitignored)
  const record = {
    contractName: 'BNSmart',
    contractAddress,
    deployer: address,
    txHash: deployTxHash,
    network: { name: network.name, chainId: String(network.chainId) },
    timestamp: new Date().toISOString()
  };
  const recPath = path.join(__dirname, '..', '..', 'deployed.json');
  fs.writeFileSync(recPath, JSON.stringify(record, null, 2));

  // Auto-patch frontend
  console.log('\n  Patching frontend files...');
  require('./patch-frontend');
  console.log('  ✅ Frontend patched\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉  DEPLOYMENT COMPLETE');
  console.log(`    Contract : ${contractAddress}`);
  console.log(`    Network  : BSC Mainnet (ChainId ${network.chainId})`);
  console.log(`    Explorer : https://bscscan.com/address/${contractAddress}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  return contractAddress;
}

main().catch(err => {
  console.error('\n❌  Deployment failed:', err.message || err);
  process.exit(1);
});
