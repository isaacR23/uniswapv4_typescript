// Standard ERC-20 transfer from a regular wallet (EOA). Same env/token vars as send_gnosis.ts.

import { ethers } from "ethers";
import { RPC_URL, USDC_TOKEN } from "./constants_polygon.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");
const DESTINATION_ADDRESS = Deno.env.get("ACCOUNT_ADD_THIRD_WEB");
const _amount = "1.949023";
const _send_token = USDC_TOKEN;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(OWNER_1_PRIVATE_KEY as string, provider);


// Check MATIC balance
const maticBalance = await provider.getBalance(signer.address);

// Check current nonce
const currentNonce = await provider.getTransactionCount(signer.address, "latest");
const pendingNonce = await provider.getTransactionCount(signer.address, "pending");

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

const gasLimit = 100000;
const polygonOptions = await getPolygonTxOptions(provider);
const txOptions = {
  ...polygonOptions,
  nonce: currentNonce,
  gasLimit,
};

const maxFeeBn = ethers.BigNumber.from(polygonOptions.maxFeePerGas);
console.log("[LN:58][send.ts] Transaction gas settings:");
console.log("  Max Priority Fee:", ethers.utils.formatUnits(polygonOptions.maxPriorityFeePerGas, "gwei"), "Gwei");
console.log("  Max Fee:", ethers.utils.formatUnits(polygonOptions.maxFeePerGas, "gwei"), "Gwei");
console.log("  Nonce:", currentNonce);
console.log("  Gas Limit:", gasLimit);

const maxCost = maxFeeBn.mul(gasLimit);
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