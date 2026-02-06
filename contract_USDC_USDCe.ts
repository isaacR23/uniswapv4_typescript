// USDC → USDC.e swap via Gnosis Safe and BuyUsdce contract.
// Safe (ACCOUNT_ADD_SAFE) approves USDC then calls swapUsdcForUsdCe; receives USDC.e at 1:0.99 (1% fee).

import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  OperationType,
  SigningMethod,
} from "@safe-global/types-kit";
import { ethers } from "ethers";
import { formatEther, parseUnits } from "viem";
import { RPC_URL, USDC_TOKEN } from "./constants_polygon.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const BUY_USDCE_ADDRESS = "0x115869E36afAc1ddaE28C42fc8050A2F6fc25a11";

/** Amount of USDC to swap for USDC.e (human-readable, e.g. "2" = 2 USDC). */
const AMOUNT_TO_TRANSFER = "1";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const BUY_USDCE_ABI = [
  "function swapUsdcForUsdCe(uint256 usdcAmount)",
];

export interface IResponse {
  success: boolean;
  transactionHash?: string;
  gasUsed?: string;
  totalGasSpentWei?: string;
  totalGasSpentPOL?: string;
  error?: string;
}

/**
 * Swap USDC for USDC.e via the Safe. Safe must hold at least usdcAmount USDC.
 * Executes approve (if needed) + swapUsdcForUsdCe in one batch.
 */
export async function swapUsdcForUsdCeViaSafe(
  usdcAmount: string,
): Promise<IResponse> {
  const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE");
  const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");

  if (!SAFE_ADDRESS || !OWNER_1_PRIVATE_KEY) {
    console.log("[LN:48][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Missing env.");
    return { success: false, error: "Missing ACCOUNT_ADD_SAFE or PRIVATE_KEY_EOA" };
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const usdcContract = new ethers.Contract(
    USDC_TOKEN.address,
    ERC20_ABI,
    provider,
  );
  const buyUsdceIface = new ethers.utils.Interface(BUY_USDCE_ABI);
  const erc20Iface = new ethers.utils.Interface(ERC20_ABI);

  let amountWei: bigint;
  try {
    amountWei = parseUnits(usdcAmount, USDC_TOKEN.decimals);
  } catch {
    console.log("[LN:68][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Invalid amount.");
    return { success: false, error: "Invalid usdcAmount" };
  }

  if (amountWei === 0n) {
    console.log("[LN:73][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Zero amount.");
    return { success: false, error: "Amount must be greater than zero" };
  }

  const allowance = await usdcContract.allowance(SAFE_ADDRESS, BUY_USDCE_ADDRESS);
  const needApprove = BigInt(allowance.toString()) < amountWei;

  const transactions: MetaTransactionData[] = [];

  if (needApprove) {
    const approveData = erc20Iface.encodeFunctionData("approve", [
      BUY_USDCE_ADDRESS,
      ethers.constants.MaxUint256,
    ]);
    transactions.push({
      to: USDC_TOKEN.address,
      value: "0",
      data: approveData,
      operation: OperationType.Call,
    });
  }

  const swapData = buyUsdceIface.encodeFunctionData("swapUsdcForUsdCe", [
    amountWei.toString(),
  ]);
  transactions.push({
    to: BUY_USDCE_ADDRESS,
    value: "0",
    data: swapData,
    operation: OperationType.Call,
  });

  // @ts-ignore: Safe.init default export type not resolved in Deno
  const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: OWNER_1_PRIVATE_KEY,
    safeAddress: SAFE_ADDRESS,
  });

  const safeTxGasLimit = "300000";
  const polygonGasPriceWei = "25000000000";

  let safeTransaction = await protocolKit.createTransaction({
    transactions,
    options: {
      safeTxGas: safeTxGasLimit,
      gasPrice: polygonGasPriceWei,
    },
  });

  safeTransaction = await protocolKit.signTransaction(
    safeTransaction,
    SigningMethod.ETH_SIGN_TYPED_DATA_V4,
  );

  const txOptions = await getPolygonTxOptions(provider);

  try {
    const txResponse = await protocolKit.executeTransaction(
      safeTransaction,
      txOptions,
    );
    const hash = txResponse.hash;
    console.log("[LN:126][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Safe transaction executed.");

    const receipt = await txResponse.transactionResponse.wait();
    const gasUsedBig = BigInt(receipt.gasUsed.toString());
    const effectiveGasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice ?? 0;
    const priceBig = BigInt(effectiveGasPrice.toString());
    const totalGasWei = gasUsedBig * priceBig;
    const totalGasSpentPOL = formatEther(totalGasWei);
    console.log("[LN:132][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Gas used (units).");
    console.log("[LN:133][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Total gas spent (POL).");
    console.log("  gasUsed:", gasUsedBig.toString());
    console.log("  totalGasSpentWei:", totalGasWei.toString());
    console.log("  totalGasSpentPOL:", totalGasSpentPOL);

    return {
      success: true,
      transactionHash: hash,
      gasUsed: gasUsedBig.toString(),
      totalGasSpentWei: totalGasWei.toString(),
      totalGasSpentPOL,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("[LN:136][contract_USDC_USDCe.ts][swapUsdcForUsdCeViaSafe] Execution failed.");
    return { success: false, error: message };
  }
}

if (import.meta.main) {
  const result = await swapUsdcForUsdCeViaSafe(AMOUNT_TO_TRANSFER);
  console.log(result);
}
