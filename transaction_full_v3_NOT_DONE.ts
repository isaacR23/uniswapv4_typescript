// 0) Assume Safe already has USDC.
// 1) Swap USDC -> USDC.e via Polymarket bridge (Safe sends USDC to bridge; Safe receives USDC.e).
// 2) Swap USDC.e -> USDC + 1% fee via Uniswap (like swap_gnosis_v3).
// 3) Swap 0.03 USDC -> WPOL and send WPOL to ACCOUNT_ADD_EOA (skip if Safe USDC < 0.03).
// Single-file implementation; bridge API inlined (get_polygon_bridge.ts does not export).

const POLYMARKET_BRIDGE_DEPOSIT = "https://bridge.polymarket.com/deposit";

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
    throw new Error(
      `[transaction_full_v3.ts][getDepositAddress] Polymarket bridge failed: ${res.status} ${msg}`,
    );
  }
  const data = (await res.json()) as BridgeDepositResponse;
  const evmAddress = data.address?.evm;
  if (!evmAddress) {
    throw new Error(
      "[transaction_full_v3.ts][getDepositAddress] No EVM deposit address in response.",
    );
  }
  return evmAddress;
}

import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  OperationType,
  SigningMethod,
} from "@safe-global/types-kit";
import { Actions, SwapExactInSingle, V4Planner } from "@uniswap/v4-sdk";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";
import { ethers } from "ethers";
import {
  RPC_URL,
  UNIVERSAL_ROUTER_ADDRESS,
  USDC_TOKEN,
  USDC_E_TOKEN,
  WPOL_TOKEN,
  PERMIT2,
  QUOTE_CONTRACT_ADDRESS,
  QUOTER_ABI,
} from "./constants_polygon.ts";
import { UNIVERSAL_ROUTER_ABI } from "./constants_mainnet.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE");
const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");
const FEE_RECIPIENT_ADDRESS = Deno.env.get("FEE_RECIPIENT_ADDRESS");
const EOA_RECIPIENT_ADDRESS = Deno.env.get("ACCOUNT_ADD_EOA");

if (!SAFE_ADDRESS || !OWNER_1_PRIVATE_KEY) {
  throw new Error(
    "[transaction_full_v3.ts] ACCOUNT_ADD_SAFE and PRIVATE_KEY_EOA must be set.",
  );
}
if (!EOA_RECIPIENT_ADDRESS) {
  throw new Error("[transaction_full_v3.ts] ACCOUNT_ADD_EOA must be set.");
}

console.log("[LN:70][transaction_full_v3.ts] Starting full flow: bridge USDC -> USDC.e, swap USDC.e -> USDC with 1% fee, then 3¢ USDC -> POL to EOA.");

const MIN_BRIDGE_USD = 2;
const THREE_CENTS_USDC = ethers.utils.parseUnits("0.03", 6);
const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";
const slippageBasisPoints = 200; // 2%
const FEE_BPS = 100; // 1% flat fee
const BRIDGE_POLL_INTERVAL_MS = 10_000;
const BRIDGE_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const SAFE_TX_GAS_LIMIT = "500000";
const POLYGON_GAS_PRICE_WEI = "25000000000"; // 25 Gwei

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

const usdcContract = new ethers.Contract(
  USDC_TOKEN.address,
  ERC20_ABI,
  provider,
);
const usdcEContract = new ethers.Contract(
  USDC_E_TOKEN.address,
  ERC20_ABI,
  provider,
);
const quoterContract = new ethers.Contract(
  QUOTE_CONTRACT_ADDRESS,
  QUOTER_ABI,
  provider,
);
const permit2Contract = new ethers.Contract(
  PERMIT2,
  PERMIT2_ABI,
  provider,
);

// --- Step 1: USDC -> USDC.e via Polymarket bridge ---
console.log("[LN:114][transaction_full_v3.ts] Step 1: Fetching Polymarket bridge deposit address for Safe.");
const bridgeEvmAddress = await getDepositAddress(SAFE_ADDRESS);
console.log("[LN:116][transaction_full_v3.ts] Step 1: Bridge deposit address obtained.");

const amountUsdc = await usdcContract.balanceOf(SAFE_ADDRESS);
const minBridgeAmount = ethers.utils.parseUnits(String(MIN_BRIDGE_USD), 6);
if (amountUsdc.lt(minBridgeAmount)) {
  throw new Error(
    "[transaction_full_v3.ts] Safe USDC balance below bridge minimum (2 USDC).",
  );
}

const transferIface = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const bridgeTransferData = transferIface.encodeFunctionData("transfer", [
  bridgeEvmAddress,
  amountUsdc,
]);

const bridgeTxData: MetaTransactionData = {
  to: USDC_TOKEN.address,
  value: "0",
  data: bridgeTransferData,
  operation: OperationType.Call,
};

console.log("[LN:138][transaction_full_v3.ts] Step 1: Initializing Safe protocol-kit.");
// @ts-ignore: Safe.init default export type not resolved in Deno
const protocolKit = await Safe.init({
  provider: RPC_URL,
  signer: OWNER_1_PRIVATE_KEY,
  safeAddress: SAFE_ADDRESS,
});

console.log("[LN:147][transaction_full_v3.ts] Step 1: Creating and signing Safe transaction (USDC transfer to bridge).");
let safeTransaction = await protocolKit.createTransaction({
  transactions: [bridgeTxData],
  options: {
    safeTxGas: SAFE_TX_GAS_LIMIT,
    gasPrice: POLYGON_GAS_PRICE_WEI,
  },
});
safeTransaction = await protocolKit.signTransaction(
  safeTransaction,
  SigningMethod.ETH_SIGN_TYPED_DATA_V4,
);
const txOptions1 = await getPolygonTxOptions(provider);
const txResponse1 = await protocolKit.executeTransaction(
  safeTransaction,
  txOptions1,
);
console.log(
  "[LN:164][transaction_full_v3.ts] Step 1: USDC sent to bridge. Tx:",
  txResponse1.hash,
);
console.log("[LN:166][transaction_full_v3.ts] Step 1: Waiting for transaction confirmation.");
await txResponse1.transactionResponse.wait();
console.log("[LN:168][transaction_full_v3.ts] Step 1: Transaction confirmed. Polling for USDC.e at Safe.");

const balanceUsdcEBefore = await usdcEContract.balanceOf(SAFE_ADDRESS);
const startedAt = Date.now();
while (Date.now() - startedAt < BRIDGE_POLL_TIMEOUT_MS) {
  const current = await usdcEContract.balanceOf(SAFE_ADDRESS);
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  console.log(
    "[LN:156][transaction_full_v3.ts] Polling Safe USDC.e balance.",
    elapsedSec,
    "s",
  );
  if (current.gt(balanceUsdcEBefore)) {
    break;
  }
  await new Promise((r) => setTimeout(r, BRIDGE_POLL_INTERVAL_MS));
}
const amountUsdcE = await usdcEContract.balanceOf(SAFE_ADDRESS);
if (amountUsdcE.lte(balanceUsdcEBefore)) {
  throw new Error(
    "[transaction_full_v3.ts] Bridge did not credit USDC.e at Safe before timeout.",
  );
}
const amountInTotal = amountUsdcE; // full Safe USDC.e balance after bridge
console.log(
  "[LN:195][transaction_full_v3.ts] Step 1 done. Safe USDC.e balance:",
  amountInTotal.toString(),
);

// --- Step 2: USDC.e -> USDC + 1% fee via Uniswap ---
console.log("[LN:200][transaction_full_v3.ts] Step 2: Building swap batch (1% fee, approves, Universal Router execute).");
const feeAmount = amountInTotal.mul(FEE_BPS).div(10000);
const amountToSwap = amountInTotal.sub(feeAmount);
if (amountToSwap.isZero()) {
  throw new Error(
    "[transaction_full_v3.ts] USDC.e amount too small; 1% fee would consume entire amount.",
  );
}
if (feeAmount.gt(0) && !FEE_RECIPIENT_ADDRESS) {
  throw new Error(
    "[transaction_full_v3.ts] FEE_RECIPIENT_ADDRESS must be set when charging 1% fee.",
  );
}

const poolKey = {
  currency0: USDC_E_TOKEN.address,
  currency1: USDC_TOKEN.address,
  fee: 20,
  tickSpacing: 1,
  hooks: HOOKS_ZERO,
};

console.log("[LN:222][transaction_full_v3.ts] Step 2: Getting quote for amountToSwap (USDC.e -> USDC).");
const quoted = await quoterContract.callStatic.quoteExactInputSingle({
  poolKey,
  zeroForOne: true,
  exactAmount: amountToSwap,
  hookData: "0x00",
});
const amountOutQuoted = Array.isArray(quoted) ? quoted[0] : quoted.amountOut;
const slippageAmount = amountOutQuoted
  .mul(ethers.BigNumber.from(10000 - slippageBasisPoints))
  .div(10000);

const deadline = Math.floor(Date.now() / 1000) + 3600;
const CurrentConfig: SwapExactInSingle = {
  poolKey,
  zeroForOne: true,
  amountIn: amountToSwap.toString(),
  amountOutMinimum: slippageAmount.toString(),
  hookData: "0x00",
};

const v4Planner = new V4Planner();
const routePlanner = new RoutePlanner();
v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [CurrentConfig]);
v4Planner.addAction(Actions.SETTLE_ALL, [
  CurrentConfig.poolKey.currency0,
  CurrentConfig.amountIn,
]);
v4Planner.addAction(Actions.TAKE_ALL, [
  CurrentConfig.poolKey.currency1,
  CurrentConfig.amountOutMinimum,
]);
const encodedActions = v4Planner.finalize();
routePlanner.addCommand(CommandType.V4_SWAP, [
  v4Planner.actions,
  v4Planner.params,
]);

const routerIface = new ethers.utils.Interface(UNIVERSAL_ROUTER_ABI);
const executeData = routerIface.encodeFunctionData("execute", [
  routePlanner.commands,
  [encodedActions],
  deadline,
]);

const erc20ApproveIface = new ethers.utils.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const approvePermit2Data = erc20ApproveIface.encodeFunctionData("approve", [
  PERMIT2,
  ethers.constants.MaxUint256,
]);

const MAX_UINT160 = ethers.BigNumber.from(
  "0xffffffffffffffffffffffffffffffffffffffff",
);
const permit2ApproveIface = new ethers.utils.Interface([
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
]);
const approveUniversalRouterData = permit2ApproveIface.encodeFunctionData(
  "approve",
  [USDC_E_TOKEN.address, UNIVERSAL_ROUTER_ADDRESS, MAX_UINT160, deadline],
);

console.log("[LN:284][transaction_full_v3.ts] Step 2: Checking ERC20 and Permit2 allowances.");
const erc20Allowance = await usdcEContract.allowance(SAFE_ADDRESS, PERMIT2);
const needErc20Approve = erc20Allowance.lt(amountToSwap);

const [permit2Amount, permit2Expiration] = await permit2Contract.allowance(
  SAFE_ADDRESS,
  USDC_E_TOKEN.address,
  UNIVERSAL_ROUTER_ADDRESS,
);
const now = Math.floor(Date.now() / 1000);
const needPermit2Approve =
  permit2Amount.lt(amountToSwap) || Number(permit2Expiration) <= now;

const feeTransferData = transferIface.encodeFunctionData("transfer", [
  FEE_RECIPIENT_ADDRESS,
  feeAmount,
]);

console.log("[LN:298][transaction_full_v3.ts] Step 2: Building Safe batch (fee transfer, approves if needed, execute).");
const safeTransactions: MetaTransactionData[] = [];
if (feeAmount.gt(0)) {
  safeTransactions.push({
    to: USDC_E_TOKEN.address,
    value: "0",
    data: feeTransferData,
    operation: OperationType.Call,
  });
}
if (needErc20Approve) {
  safeTransactions.push({
    to: USDC_E_TOKEN.address,
    value: "0",
    data: approvePermit2Data,
    operation: OperationType.Call,
  });
}
if (needPermit2Approve) {
  safeTransactions.push({
    to: PERMIT2,
    value: "0",
    data: approveUniversalRouterData,
    operation: OperationType.Call,
  });
}
safeTransactions.push({
  to: UNIVERSAL_ROUTER_ADDRESS,
  value: "0",
  data: executeData,
  operation: OperationType.Call,
});

safeTransaction = await protocolKit.createTransaction({
  transactions: safeTransactions,
  options: {
    safeTxGas: SAFE_TX_GAS_LIMIT,
    gasPrice: POLYGON_GAS_PRICE_WEI,
  },
});
console.log("[LN:341][transaction_full_v3.ts] Step 2: Creating, signing, and executing Safe transaction.");
safeTransaction = await protocolKit.signTransaction(
  safeTransaction,
  SigningMethod.ETH_SIGN_TYPED_DATA_V4,
);
const txOptions2 = await getPolygonTxOptions(provider);
const txResponse2 = await protocolKit.executeTransaction(
  safeTransaction,
  txOptions2,
);
console.log(
  "[LN:351][transaction_full_v3.ts] Step 2: Safe transaction broadcast. Tx:",
  txResponse2.hash,
);
console.log("[LN:353][transaction_full_v3.ts] Step 2: Waiting for confirmation.");
const receipt2 = await txResponse2.transactionResponse.wait();
console.log(
  "[LN:355][transaction_full_v3.ts] Step 2: Confirmed. Receipt:",
  receipt2.transactionHash,
);

// --- Step 3: 0.03 USDC -> WPOL, send WPOL to ACCOUNT_ADD_EOA ---
console.log("[LN:363][transaction_full_v3.ts] Step 3: Checking Safe USDC balance for 3¢ swap.");
const usdcAfterStep2 = await usdcContract.balanceOf(SAFE_ADDRESS);
if (usdcAfterStep2.lt(THREE_CENTS_USDC)) {
  console.log(
    "[LN:367][transaction_full_v3.ts] Step 3: Skipped (Safe USDC balance below 0.03).",
  );
} else {
  const poolKeyStep3 = {
    currency0: USDC_TOKEN.address,
    currency1: WPOL_TOKEN.address,
    fee: 20,
    tickSpacing: 1,
    hooks: HOOKS_ZERO,
  };
  console.log("[LN:378][transaction_full_v3.ts] Step 3: Getting quote USDC -> WPOL.");
  const quotedStep3 = await quoterContract.callStatic.quoteExactInputSingle({
    poolKey: poolKeyStep3,
    zeroForOne: true,
    exactAmount: THREE_CENTS_USDC,
    hookData: "0x00",
  });
  const amountOutStep3 = Array.isArray(quotedStep3)
    ? quotedStep3[0]
    : quotedStep3.amountOut;
  const slippageStep3 = amountOutStep3
    .mul(ethers.BigNumber.from(10000 - slippageBasisPoints))
    .div(10000);

  const deadlineStep3 = Math.floor(Date.now() / 1000) + 3600;
  const configStep3: SwapExactInSingle = {
    poolKey: poolKeyStep3,
    zeroForOne: true,
    amountIn: THREE_CENTS_USDC.toString(),
    amountOutMinimum: slippageStep3.toString(),
    hookData: "0x00",
  };

  const v4PlannerStep3 = new V4Planner();
  const routePlannerStep3 = new RoutePlanner();
  v4PlannerStep3.addAction(Actions.SWAP_EXACT_IN_SINGLE, [configStep3]);
  v4PlannerStep3.addAction(Actions.SETTLE_ALL, [
    configStep3.poolKey.currency0,
    configStep3.amountIn,
  ]);
  v4PlannerStep3.addAction(Actions.TAKE_ALL, [
    configStep3.poolKey.currency1,
    configStep3.amountOutMinimum,
  ]);
  const encodedActionsStep3 = v4PlannerStep3.finalize();
  routePlannerStep3.addCommand(CommandType.V4_SWAP, [
    v4PlannerStep3.actions,
    v4PlannerStep3.params,
  ]);

  const executeDataStep3 = routerIface.encodeFunctionData("execute", [
    routePlannerStep3.commands,
    [encodedActionsStep3],
    deadlineStep3,
  ]);

  const approvePermit2DataUsdc = erc20ApproveIface.encodeFunctionData(
    "approve",
    [PERMIT2, ethers.constants.MaxUint256],
  );
  const approveUniversalRouterDataUsdc = permit2ApproveIface.encodeFunctionData(
    "approve",
    [
      USDC_TOKEN.address,
      UNIVERSAL_ROUTER_ADDRESS,
      MAX_UINT160,
      deadlineStep3,
    ],
  );

  const erc20AllowanceUsdc = await usdcContract.allowance(
    SAFE_ADDRESS,
    PERMIT2,
  );
  const needErc20ApproveStep3 = erc20AllowanceUsdc.lt(THREE_CENTS_USDC);

  const [permit2AmountUsdc, permit2ExpirationUsdc] =
    await permit2Contract.allowance(
      SAFE_ADDRESS,
      USDC_TOKEN.address,
      UNIVERSAL_ROUTER_ADDRESS,
    );
  const nowStep3 = Math.floor(Date.now() / 1000);
  const needPermit2ApproveStep3 =
    permit2AmountUsdc.lt(THREE_CENTS_USDC) ||
    Number(permit2ExpirationUsdc) <= nowStep3;

  const wpolTransferData = transferIface.encodeFunctionData("transfer", [
    EOA_RECIPIENT_ADDRESS,
    slippageStep3,
  ]);

  console.log(
    "[LN:438][transaction_full_v3.ts] Step 3: Building Safe batch (approves if needed, execute, transfer WPOL to EOA).",
  );
  const safeTransactionsStep3: MetaTransactionData[] = [];
  if (needErc20ApproveStep3) {
    safeTransactionsStep3.push({
      to: USDC_TOKEN.address,
      value: "0",
      data: approvePermit2DataUsdc,
      operation: OperationType.Call,
    });
  }
  if (needPermit2ApproveStep3) {
    safeTransactionsStep3.push({
      to: PERMIT2,
      value: "0",
      data: approveUniversalRouterDataUsdc,
      operation: OperationType.Call,
    });
  }
  safeTransactionsStep3.push({
    to: UNIVERSAL_ROUTER_ADDRESS,
    value: "0",
    data: executeDataStep3,
    operation: OperationType.Call,
  });
  safeTransactionsStep3.push({
    to: WPOL_TOKEN.address,
    value: "0",
    data: wpolTransferData,
    operation: OperationType.Call,
  });

  safeTransaction = await protocolKit.createTransaction({
    transactions: safeTransactionsStep3,
    options: {
      safeTxGas: SAFE_TX_GAS_LIMIT,
      gasPrice: POLYGON_GAS_PRICE_WEI,
    },
  });
  console.log(
    "[LN:472][transaction_full_v3.ts] Step 3: Creating, signing, and executing Safe transaction.",
  );
  safeTransaction = await protocolKit.signTransaction(
    safeTransaction,
    SigningMethod.ETH_SIGN_TYPED_DATA_V4,
  );
  const txOptions3 = await getPolygonTxOptions(provider);
  const txResponse3 = await protocolKit.executeTransaction(
    safeTransaction,
    txOptions3,
  );
  console.log(
    "[LN:482][transaction_full_v3.ts] Step 3: Safe transaction broadcast. Tx:",
    txResponse3.hash,
  );
  console.log("[LN:484][transaction_full_v3.ts] Step 3: Waiting for confirmation.");
  await txResponse3.transactionResponse.wait();
  console.log(
    "[LN:487][transaction_full_v3.ts] Step 3 done. WPOL sent to ACCOUNT_ADD_EOA.",
  );
}

console.log(
  "[LN:493][transaction_full_v3.ts] Full flow completed (bridge, swap with 1% fee, 3¢ USDC→POL to EOA).",
);
