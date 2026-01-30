// Workflow: 0) USDC→USDC.e via Polygon bridge 1) Send USDC.e to Safe 2) Confirm Safe balance
// 3) Safe sends USDC.e back to EOA 4) Swap USDC.e→USDC at EOA.
// Step 0: get bridge deposit address, send native USDC there (min 2 USD), wait for USDC.e.
// Step 4 ensures ERC20→Permit2 and Permit2→Universal Router approvals before swapping.

// IMPORTANT NOTES: POLYGON BRIDGE CHARGES 0.004 USD PER BRIDGE so you need to do +2 dls

const POLYMARKET_BRIDGE_DEPOSIT = "https://bridge.polymarket.com/deposit";
const MIN_BRIDGE_USD = 2; // Polygon bridge accepts less but returns nothing below 2 USD
const _amount = "2";

interface BridgeDepositResponse {
  address: {
    evm?: string;
    svm?: string;
    btc?: string;
  };
}

async function getDepositAddress(walletAddress: string): Promise<string> {
  const res = await fetch(POLYMARKET_BRIDGE_DEPOSIT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletAddress }),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const msg = (errorData as { message?: string }).message ?? res.statusText;
    throw new Error(`[swap_gnosis_v2.ts][getDepositAddress] Bridge deposit failed: ${res.status} ${msg}`);
  }
  const data = (await res.json()) as BridgeDepositResponse;
  const evmAddress = data.address?.evm;
  if (!evmAddress) {
    throw new Error("[swap_gnosis_v2.ts][getDepositAddress] No EVM deposit address in response.");
  }
  return evmAddress;
}

import { SwapExactInSingle } from "@uniswap/v4-sdk";
import { Actions, V4Planner } from "@uniswap/v4-sdk";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";
import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  OperationType,
  SigningMethod,
} from "@safe-global/types-kit";
import { ethers } from "ethers";
import {
  RPC_URL,
  USDC_E_TOKEN,
  USDC_TOKEN,
  UNIVERSAL_ROUTER_ADDRESS,
  QUOTE_CONTRACT_ADDRESS,
  QUOTER_ABI,
  PERMIT2,
} from "./constants_polygon.ts";
import { UNIVERSAL_ROUTER_ABI } from "./constants_mainnet.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE");
const PRIVATE_KEY_EOA = Deno.env.get("PRIVATE_KEY_EOA");

const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";
const amount = ethers.utils.parseUnits(_amount, 6);
const minBridgeAmount = ethers.utils.parseUnits(String(MIN_BRIDGE_USD), 6);
if (amount.lt(minBridgeAmount)) {
  throw new Error(
    "[swap_gnosis_v2.ts] Amount below Polygon bridge minimum. Send at least 2 USD (bridge accepts less but returns nothing).",
  );
}
const deadline = Math.floor(Date.now() / 1000) + 3600;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY_EOA as string, provider);
const universalRouter = new ethers.Contract(
  UNIVERSAL_ROUTER_ADDRESS,
  UNIVERSAL_ROUTER_ABI,
  signer,
);
const quoterContract = new ethers.Contract(
  QUOTE_CONTRACT_ADDRESS,
  QUOTER_ABI,
  provider,
);

const ERC20_ABI = [
  "function transfer(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const usdcEContract = new ethers.Contract(
  USDC_E_TOKEN.address,
  ERC20_ABI,
  signer,
);

const PERMIT2_APPROVE_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
];
const permit2Contract = new ethers.Contract(
  PERMIT2,
  PERMIT2_APPROVE_ABI,
  signer,
);
const _usdcContract = new ethers.Contract(
  USDC_TOKEN.address,
  ERC20_ABI,
  signer,
);

// Step 0: USDC → USDC.e via Polygon bridge (get EVM address, send USDC, wait for USDC.e)
const step0Start = Date.now();
const bridgeEvmAddress = await getDepositAddress(signer.address);
console.log("[LN:95][swap_gnosis_v2.ts][step0] Bridge deposit address:", bridgeEvmAddress);
const iface = new ethers.utils.Interface(ERC20_ABI);
const transferToBridgeData = iface.encodeFunctionData("transfer", [
  bridgeEvmAddress,
  amount,
]);
const txOptions0 = await getPolygonTxOptions(provider);
const tx0 = await signer.sendTransaction({
  to: USDC_TOKEN.address,
  data: transferToBridgeData,
  value: 0,
  ...txOptions0,
});
const _receipt0 = await tx0.wait();
console.log("[LN:123][swap_gnosis_v2.ts][step0] USDC sent to bridge; waiting for USDC.e.", _receipt0.transactionHash);

const balanceBefore = await usdcEContract.balanceOf(signer.address);
const pollIntervalMs = 10_000;
const pollTimeoutMs = 5 * 60 * 1000;
const startedAt = Date.now();
while (Date.now() - startedAt < pollTimeoutMs) {
  const current = await usdcEContract.balanceOf(signer.address);
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  console.log("[LN:119][swap_gnosis_v2.ts][step0] Polling USDC.e balance.", elapsedSec, "s");
  if (current.gt(balanceBefore)) {
    break;
  }
  await new Promise((r) => setTimeout(r, pollIntervalMs));
}
const balanceAfter = await usdcEContract.balanceOf(signer.address);
const amountUsdcE = balanceAfter.sub(balanceBefore);
if (amountUsdcE.lte(0)) {
  throw new Error(
    "[swap_gnosis_v2.ts][step0] Bridge did not credit USDC.e before timeout.",
  );
}
const step0DurMs = Date.now() - step0Start;
console.log("[LN:133][swap_gnosis_v2.ts][step0] Step 0 completed. Using USDC.e received after fee for rest of steps. Duration:", step0DurMs, "ms");

const poolKey = {
  currency0: USDC_E_TOKEN.address,
  currency1: USDC_TOKEN.address,
  fee: 20,
  tickSpacing: 1,
  hooks: HOOKS_ZERO,
};

// Step 1: EOA sends USDC.e to Safe (use actual received amount after bridge fee)
const step1Start = Date.now();
const transferData = iface.encodeFunctionData("transfer", [
  SAFE_ADDRESS,
  amountUsdcE,
]);
const txOptions1 = await getPolygonTxOptions(provider);
const tx1 = await signer.sendTransaction({
  to: USDC_E_TOKEN.address,
  data: transferData,
  value: 0,
  ...txOptions1,
});
const _receipt1 = await tx1.wait();
const step1DurMs = Date.now() - step1Start;
console.log("[LN:166][swap_gnosis_v2.ts][step1] Step 1 completed.", _receipt1.transactionHash, "Duration:", step1DurMs, "ms");

// Step 2: Confirm Safe holds USDC.e
const step2Start = Date.now();
const safeBalance = await usdcEContract.balanceOf(SAFE_ADDRESS);
if (safeBalance.lt(amountUsdcE)) {
  throw new Error(
    "[swap_gnosis_v2.ts][step2] Safe USDC.e balance less than amount sent.",
  );
}
const step2DurMs = Date.now() - step2Start;
console.log("[LN:172][swap_gnosis_v2.ts][step2] Step 2 completed. Duration:", step2DurMs, "ms");

// Step 3: Safe sends USDC.e back to EOA (use actual received amount after bridge fee)
const step3Start = Date.now();
const transferToEoaData = iface.encodeFunctionData("transfer", [
  signer.address,
  amountUsdcE,
]);
const safeTransactionData: MetaTransactionData = {
  to: USDC_E_TOKEN.address,
  value: "0",
  data: transferToEoaData,
  operation: OperationType.Call,
};

// @ts-ignore: Safe.init default export type not resolved in Deno
const protocolKit = await Safe.init({
  provider: RPC_URL,
  signer: PRIVATE_KEY_EOA,
  safeAddress: SAFE_ADDRESS,
});

const safeTxGasLimit = "500000";
const polygonGasPriceWei = "25000000000";
let safeTransaction = await protocolKit.createTransaction({
  transactions: [safeTransactionData],
  options: {
    safeTxGas: safeTxGasLimit,
    gasPrice: polygonGasPriceWei,
  },
});

safeTransaction = await protocolKit.signTransaction(
  safeTransaction,
  SigningMethod.ETH_SIGN_TYPED_DATA_V4,
);

const txOptions3 = await getPolygonTxOptions(provider);
const txResponse3 = await protocolKit.executeTransaction(
  safeTransaction,
  txOptions3,
);
const _receipt3 = await txResponse3.transactionResponse.wait();
const step3DurMs = Date.now() - step3Start;
console.log("[LN:218][swap_gnosis_v2.ts][step3] Step 3 completed.", _receipt3.transactionHash, "Duration:", step3DurMs, "ms");

// Step 4: Swap USDC.e → USDC at EOA (quote then 0.5% slippage, per swap.ts)
const step4Start = Date.now();

// 1) ERC20: allow Permit2 to pull USDC.e
const erc20Allowance = await usdcEContract.allowance(signer.address, PERMIT2);
if (erc20Allowance.lt(amountUsdcE)) {
  const approveTx = await usdcEContract.approve(
    PERMIT2,
    ethers.constants.MaxUint256,
    await getPolygonTxOptions(provider),
  );
  await approveTx.wait();
}

// 2) Permit2: allow Universal Router to pull USDC.e (fixes 0xd81b2f2e AllowanceExpired)
const MAX_UINT160 = ethers.BigNumber.from(
  "0xffffffffffffffffffffffffffffffffffffffff",
);
const permit2ApproveTx = await permit2Contract.approve(
  USDC_E_TOKEN.address,
  UNIVERSAL_ROUTER_ADDRESS,
  MAX_UINT160,
  deadline,
  await getPolygonTxOptions(provider),
);
await permit2ApproveTx.wait();

const quotedStep4 = await quoterContract.callStatic.quoteExactInputSingle({
  poolKey,
  zeroForOne: true,
  exactAmount: amountUsdcE,
  hookData: "0x00",
});
const amountOutQuoted4 = Array.isArray(quotedStep4)
  ? quotedStep4[0]
  : quotedStep4.amountOut;
// 0.5% slippage: accept 99.5% of quoted (basis 10000 → 9950)
const slippageBasisPoints = 50; // 0.5%
const slippageAmount4 = amountOutQuoted4
  .mul(ethers.BigNumber.from(10000 - slippageBasisPoints))
  .div(10000);

const configStep4: SwapExactInSingle = {
  poolKey,
  zeroForOne: true,
  amountIn: amountUsdcE.toString(),
  amountOutMinimum: slippageAmount4.toString(),
  hookData: "0x00",
};

console.log("configStep4", configStep4);

const v4Planner4 = new V4Planner();
const routePlanner4 = new RoutePlanner();
v4Planner4.addAction(Actions.SWAP_EXACT_IN_SINGLE, [configStep4]);
v4Planner4.addAction(Actions.SETTLE_ALL, [
  configStep4.poolKey.currency0,
  configStep4.amountIn,
]);
v4Planner4.addAction(Actions.TAKE_ALL, [
  configStep4.poolKey.currency1,
  configStep4.amountOutMinimum,
]);
const encodedActions4 = v4Planner4.finalize();
routePlanner4.addCommand(CommandType.V4_SWAP, [
  v4Planner4.actions,
  v4Planner4.params,
]);

const txOptions4 = await getPolygonTxOptions(provider);
const tx4 = await universalRouter.execute(
  routePlanner4.commands,
  [encodedActions4],
  deadline,
  txOptions4,
);
const _receipt4 = await tx4.wait();
const step4DurMs = Date.now() - step4Start;
console.log("[LN:259][swap_gnosis_v2.ts][step4] Step 4 completed.", _receipt4.transactionHash, "Duration:", step4DurMs, "ms");
