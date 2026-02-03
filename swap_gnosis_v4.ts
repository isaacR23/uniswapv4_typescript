// USDC -> DAI swap via Gnosis Safe (sender and recipient = Safe).
// Flat 1% fee: Safe sends 1% of USDC to fee recipient, then swaps remaining 99%.
// Safe executes in one batch: fee transfer (if any) + approve(s) if needed + Universal Router.execute(swap).
// Mitigations from debug_swap_EOA.txt: Safe balance for amount, quoter + 2% slippage, getPolygonTxOptions, conditional approve txs.
// https://docs.safe.global/sdk/protocol-kit/guides/execute-transactions

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
  PERMIT2,
  QUOTE_CONTRACT_ADDRESS,
  QUOTER_ABI,
} from "./constants_polygon.ts";
import { UNIVERSAL_ROUTER_ABI } from "./constants_mainnet.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE");
const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");
const FEE_RECIPIENT_ADDRESS = Deno.env.get("FEE_RECIPIENT_ADDRESS");

const NATIVE_POL = "0x0000000000000000000000000000000000000000";
const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";
const slippageBasisPoints = 200; // 2% - per debug_swap_EOA
const FEE_BPS = 100; // 1% flat fee of amount being transacted

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

const usdcContract = new ethers.Contract(
  USDC_TOKEN.address,
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

// Use Safe's USDC balance (avoid V4TooMuchRequested / SETTLE_ALL mismatch - debug_swap_EOA §5)
const amountInTotal = await usdcContract.balanceOf(SAFE_ADDRESS);
if (amountInTotal.isZero()) {
  throw new Error("[swap_gnosis_v3.ts] Safe has no USDC balance to swap.");
}

// Flat 1% fee: deduct fee from amount to swap, send fee to FEE_RECIPIENT_ADDRESS
const feeAmount = amountInTotal.mul(FEE_BPS).div(10000);
const amountToSwap = amountInTotal.sub(feeAmount);
if (amountToSwap.isZero()) {
  throw new Error("[swap_gnosis_v3.ts] Safe USDC balance too small; 1% fee would consume entire amount.");
}
if (feeAmount.gt(0) && !FEE_RECIPIENT_ADDRESS) {
  throw new Error("[swap_gnosis_v3.ts] FEE_RECIPIENT_ADDRESS must be set when charging 1% fee.");
}

// V4: native POL = address(0). Pool key: currency0 = USDC, currency1 = POL so zeroForOne: true = USDC -> POL.
const poolKey = {
  currency0: USDC_TOKEN.address,
  currency1: NATIVE_POL,
  fee: 20,
  tickSpacing: 1,
  hooks: HOOKS_ZERO,
};

// Quote then apply slippage for the amount we actually swap (99%) - debug_swap_EOA §8
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

const CurrentConfig: SwapExactInSingle = {
  poolKey,
  zeroForOne: true, // YOU MUST NOT CHANGE THIS VALUE
  amountIn: amountToSwap.toString(),
  amountOutMinimum: slippageAmount.toString(),
  hookData: "0x00",
};
const v4Planner = new V4Planner();
const routePlanner = new RoutePlanner();
const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour, same as swap.ts

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

// 1) Safe approves USDC to Permit2 (ERC20)
const erc20ApproveIface = new ethers.utils.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const approvePermit2Data = erc20ApproveIface.encodeFunctionData("approve", [
  PERMIT2,
  ethers.constants.MaxUint256,
]);

// 2) Safe sets Permit2 allowance for Universal Router (fixes 0xd81b2f2e AllowanceExpired)
const MAX_UINT160 = ethers.BigNumber.from(
  "0xffffffffffffffffffffffffffffffffffffffff",
);
const permit2ApproveIface = new ethers.utils.Interface([
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
]);
const approveUniversalRouterData = permit2ApproveIface.encodeFunctionData(
  "approve",
  [USDC_TOKEN.address, UNIVERSAL_ROUTER_ADDRESS, MAX_UINT160, deadline],
);

// Only include approve txs when allowance insufficient (debug_swap_EOA §6, §7 optimization)
const erc20Allowance = await usdcContract.allowance(SAFE_ADDRESS, PERMIT2);
const needErc20Approve = erc20Allowance.lt(amountToSwap);

const [permit2Amount, permit2Expiration] = await permit2Contract.allowance(
  SAFE_ADDRESS,
  USDC_TOKEN.address,
  UNIVERSAL_ROUTER_ADDRESS,
);
const now = Math.floor(Date.now() / 1000);
const needPermit2Approve =
  permit2Amount.lt(amountToSwap) || Number(permit2Expiration) <= now;

// Encode USDC transfer for 1% fee (Safe -> fee recipient)
const transferIface = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const feeTransferData = transferIface.encodeFunctionData("transfer", [
  FEE_RECIPIENT_ADDRESS,
  feeAmount,
]);

const safeTransactions: MetaTransactionData[] = [];
if (feeAmount.gt(0)) {
  safeTransactions.push({
    to: USDC_TOKEN.address,
    value: "0",
    data: feeTransferData,
    operation: OperationType.Call,
  });
}
if (needErc20Approve) {
  safeTransactions.push({
    to: USDC_TOKEN.address,
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

// @ts-ignore: Safe.init default export type not resolved in Deno
const protocolKit = await Safe.init({
  provider: RPC_URL,
  signer: OWNER_1_PRIVATE_KEY,
  safeAddress: SAFE_ADDRESS,
});

// Safe tx must have non-zero safeTxGas and gasPrice or contract reverts with GS013
const safeTxGasLimit = "500000"; // gas for inner swap execution
const polygonGasPriceWei = "25000000000"; // 25 Gwei, Polygon minimum

let safeTransaction = await protocolKit.createTransaction({
  transactions: safeTransactions,
  options: {
    safeTxGas: safeTxGasLimit,
    gasPrice: polygonGasPriceWei,
  },
});

safeTransaction = await protocolKit.signTransaction(
  safeTransaction,
  SigningMethod.ETH_SIGN_TYPED_DATA_V4,
);

// Polygon: use shared gas helper (25 Gwei min + bump - debug_swap_EOA §16)
const txOptions = await getPolygonTxOptions(provider);

const txResponse = await protocolKit.executeTransaction(
  safeTransaction,
  txOptions,
);
console.log("[LN:228][swap_gnosis_v3.ts] Safe transaction executed (USDC -> DAI, 1% fee).");

const receipt = await txResponse.transactionResponse.wait();
console.log("[LN:231][swap_gnosis_v3.ts] Transaction receipt.", receipt.transactionHash);
