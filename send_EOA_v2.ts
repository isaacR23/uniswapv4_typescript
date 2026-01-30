// Standard ERC-20 transfer from a regular wallet (EOA). Same env/token vars as send_gnosis.ts.

import { ethers } from "ethers";
import { RPC_URL, USDC_TOKEN } from "./constants_polygon.ts";

const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");
const DESTINATION_ADDRESS = Deno.env.get("ACCOUNT_ADD_THIRD_WEB");
const _amount = "2.094566";
const _send_token = USDC_TOKEN;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(OWNER_1_PRIVATE_KEY as string, provider);
console.log("[LN:14][send.ts] Starting ERC-20 transfer");
console.log("[LN:15][send.ts] From:", signer.address);
console.log("[LN:16][send.ts] To:", DESTINATION_ADDRESS);

// Check MATIC balance
const maticBalance = await provider.getBalance(signer.address);
console.log("[LN:19][send.ts] MATIC balance:", ethers.utils.formatEther(maticBalance), "MATIC");

// Check current nonce
const currentNonce = await provider.getTransactionCount(signer.address, "latest");
const pendingNonce = await provider.getTransactionCount(signer.address, "pending");
console.log("[LN:23][send.ts] Current nonce:", currentNonce, "Pending nonce:", pendingNonce);

if (currentNonce !== pendingNonce) {
  console.log("[LN:26][send.ts] WARNING: You have", pendingNonce - currentNonce, "pending transaction(s)!");
  console.log("[LN:27][send.ts] This transaction will queue behind them.");
}

const amount = ethers.utils.parseUnits(_amount, _send_token.decimals);
const iface = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount)",
]);
const data = iface.encodeFunctionData("transfer", [
  DESTINATION_ADDRESS,
  amount,
]);

// Get current network gas prices
const feeData = await provider.getFeeData();
console.log("[LN:40][send.ts] Network gas prices:");
console.log("  Base Fee:", feeData.lastBaseFeePerGas ? ethers.utils.formatUnits(feeData.lastBaseFeePerGas, "gwei") + " Gwei" : "N/A");
console.log("  Max Priority Fee:", feeData.maxPriorityFeePerGas ? ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, "gwei") + " Gwei" : "N/A");
console.log("  Max Fee:", feeData.maxFeePerGas ? ethers.utils.formatUnits(feeData.maxFeePerGas, "gwei") + " Gwei" : "N/A");

// Use aggressive gas pricing with multiplier
const baseFee = feeData.lastBaseFeePerGas || ethers.BigNumber.from("30000000000"); // 30 Gwei fallback
const priorityFee = feeData.maxPriorityFeePerGas || ethers.BigNumber.from("50000000000"); // 50 Gwei fallback

// Increase by 50% to ensure confirmation
const tip = priorityFee.mul(150).div(100);
const maxFee = baseFee.mul(2).add(tip); // 2x base fee + priority fee

const txOptions = {
  maxPriorityFeePerGas: tip,
  maxFeePerGas: maxFee,
  nonce: currentNonce, // Explicitly set nonce
  gasLimit: 100000, // Set explicit gas limit for ERC-20 transfer
};

console.log("[LN:58][send.ts] Transaction gas settings:");
console.log("  Max Priority Fee:", ethers.utils.formatUnits(tip, "gwei"), "Gwei");
console.log("  Max Fee:", ethers.utils.formatUnits(maxFee, "gwei"), "Gwei");
console.log("  Nonce:", currentNonce);
console.log("  Gas Limit:", txOptions.gasLimit);

// Estimate max cost
const maxCost = maxFee.mul(txOptions.gasLimit);
console.log("[LN:65][send.ts] Estimated max cost:", ethers.utils.formatEther(maxCost), "MATIC");

if (maticBalance.lt(maxCost)) {
  throw new Error(`Insufficient MATIC balance. Need ${ethers.utils.formatEther(maxCost)} MATIC, have ${ethers.utils.formatEther(maticBalance)} MATIC`);
}

console.log("[LN:70][send.ts] Sending transaction...");
const tx = await signer.sendTransaction({
  to: _send_token.address,
  data,
  value: 0,
  ...txOptions,
});
console.log("[LN:77][send.ts] Transaction broadcast. Hash:", tx.hash);
console.log("[LN:78][send.ts] View on PolygonScan: https://polygonscan.com/tx/" + tx.hash);

console.log("[LN:80][send.ts] Waiting for confirmation (timeout: 5 minutes)...");

try {
  const receipt = await Promise.race([
    tx.wait(),
    new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error("Transaction confirmation timeout after 5 minutes")), 300000)
    )
  ]);
  
  console.log("[LN:89][send.ts] ✅ Transfer confirmed!");
  console.log("  Block:", receipt.blockNumber);
  console.log("  Tx Hash:", receipt.transactionHash);
  console.log("  Gas Used:", receipt.gasUsed.toString());
  console.log("  Effective Gas Price:", ethers.utils.formatUnits(receipt.effectiveGasPrice, "gwei"), "Gwei");
} catch (error) {
  if (error instanceof Error && error.message.includes("timeout")) {
    console.log("[LN:96][send.ts] ⏱️  Transaction still pending after 5 minutes");
    console.log("[LN:97][send.ts] Check status: https://polygonscan.com/tx/" + tx.hash);
    console.log("[LN:98][send.ts] The transaction may still confirm - check PolygonScan for updates");
  } else {
    throw error;
  }
}