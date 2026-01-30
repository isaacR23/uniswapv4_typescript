// Standard ERC-20 transfer from a regular wallet (EOA). Same env/token vars as send_gnosis.ts.

import { ethers } from "ethers";
import { RPC_URL, USDC_E_TOKEN, USDC_TOKEN } from "./constants_polygon.ts";

const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");
const DESTINATION_ADDRESS = Deno.env.get("ACCOUNT_ADD_THIRD_WEB");
const _amount = "2.094566";
const _send_token = USDC_TOKEN;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(OWNER_1_PRIVATE_KEY as string, provider);

const amount = ethers.utils.parseUnits(_amount, _send_token.decimals);
const iface = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount)",
]);
const data = iface.encodeFunctionData("transfer", [
  DESTINATION_ADDRESS,
  amount,
]);

const feeData = await provider.getFeeData();
const minTipGwei = ethers.BigNumber.from("25000000000"); // 25 Gwei, Polygon minimum
const tip = feeData.maxPriorityFeePerGas?.gte(minTipGwei)
  ? feeData.maxPriorityFeePerGas
  : minTipGwei;
const maxFee =
  feeData.maxFeePerGas?.gte(tip) ? feeData.maxFeePerGas : tip.mul(2);

const txOptions = {
  maxPriorityFeePerGas: tip.toString(),
  maxFeePerGas: maxFee.toString(),
};

const tx = await signer.sendTransaction({
  to: _send_token.address,
  data,
  value: 0,
  ...txOptions,
});
const _receipt = await tx.wait();
console.log("[LN:43][send.ts] Transfer executed.", _receipt.transactionHash);
