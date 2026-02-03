// Buy POL (gas) by spending USDC.e via the BuyGas contract on Polygon.
// 1) Approves USDC.e for the BuyGas contract if needed; 2) Calls buyGas(amount).

import { ethers } from "ethers";
import { RPC_URL, USDC_E_TOKEN } from "./constants_polygon.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const BUYGAS_ADDRESS = "0x2636A27d0b5D3082Dc698a7D24D26dFC0F4eaFbe";

const PRIVATE_KEY_EOA = Deno.env.get("PRIVATE_KEY_THIRD_WEB");
const _amountUsdcE = "0.2"; // USDC.e amount (6 decimals), e.g. "0.2" = 0.2 USDC.e

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY_EOA as string, provider);

const usdcAmountRaw = ethers.utils.parseUnits(_amountUsdcE, USDC_E_TOKEN.decimals);

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const buyGasAbi = ["function buyGas(uint256 usdcAmount)"];

const usdcE = new ethers.Contract(USDC_E_TOKEN.address, erc20Abi, signer);
const buyGas = new ethers.Contract(BUYGAS_ADDRESS, buyGasAbi, signer);

async function waitForTx(
  tx: ethers.providers.TransactionResponse,
  label: string,
  timeoutMs = 300000,
) {
  const receipt = await Promise.race([
    tx.wait(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`${label} confirmation timeout after ${timeoutMs / 1000}s`),
          ),
        timeoutMs,
      ),
    ),
  ]);
  console.log(`[buyGas.ts] ${label} confirmed. Block: ${receipt.blockNumber}`);
  return receipt;
}

let nonce = await provider.getTransactionCount(signer.address, "pending");
const polygonOptions = await getPolygonTxOptions(provider);
const gasLimit = 200000;
const maxCost = ethers.BigNumber.from(polygonOptions.maxFeePerGas).mul(
  gasLimit,
);

const maticBalance = await provider.getBalance(signer.address);
if (maticBalance.lt(maxCost)) {
  throw new Error(
    `Insufficient POL for gas. Need ~${ethers.utils.formatEther(maxCost)} POL, have ${ethers.utils.formatEther(maticBalance)} POL`,
  );
}

const balance = await usdcE.balanceOf(signer.address);
if (balance.lt(usdcAmountRaw)) {
  throw new Error(
    `Insufficient USDC.e. Need ${_amountUsdcE} USDC.e (${usdcAmountRaw}), have ${balance.toString()}`,
  );
}

// IMPORTANT : HERE is where we approved the contract
const allowance = await usdcE.allowance(signer.address, BUYGAS_ADDRESS);
if (allowance.lt(usdcAmountRaw)) {
  console.log("[buyGas.ts] Approving USDC.e for BuyGas contract...");
  const approveTx = await usdcE.approve(BUYGAS_ADDRESS, ethers.constants.MaxUint256, {
    ...polygonOptions,
    nonce,
    gasLimit: 80000,
  });
  console.log("[buyGas.ts] Approve tx hash:", approveTx.hash);
  await waitForTx(approveTx, "Approve");
  nonce += 1;
} else {
  console.log("[buyGas.ts] Allowance sufficient, skipping approve.");
}

console.log("[buyGas.ts] Calling buyGas(" + usdcAmountRaw.toString() + ")...");
const buyGasTx = await buyGas.buyGas(usdcAmountRaw, {
  ...polygonOptions,
  nonce,
  gasLimit,
});
console.log("[buyGas.ts] buyGas tx hash:", buyGasTx.hash);
console.log("[buyGas.ts] View on PolygonScan: https://polygonscan.com/tx/" + buyGasTx.hash);

const receipt = await waitForTx(buyGasTx, "buyGas");
console.log("[buyGas.ts] Gas used:", receipt.gasUsed.toString());
console.log("[buyGas.ts] Done. You received POL to this EOA.");
