// USDC.e -> USDC swap via Gnosis Safe (sender and recipient = Safe).
// Safe executes in one batch: (1) USDC.e.approve(Permit2) (2) Permit2.approve(Universal Router) (3) Universal Router.execute(swap).
// Same pool/amounts as swap.ts; Safe tx flow from send_gnosis.ts.
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
  USDC_E_TOKEN,
  USDC_TOKEN,
  PERMIT2,
} from "./constants_polygon.ts";
import { UNIVERSAL_ROUTER_ABI } from "./constants_mainnet.ts";

const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE");
const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");

const _amount = "2.097124";
const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";
const slippagePercent = 2;
const amountIn = ethers.utils.parseUnits(_amount, USDC_E_TOKEN.decimals);
const amountOutEstimate = ethers.utils.parseUnits(_amount, USDC_TOKEN.decimals);
const slippageAmount = amountOutEstimate
  .mul(ethers.BigNumber.from(10000 - Math.floor(slippagePercent * 100)))
  .div(10000);

const poolKey = {
  currency0: USDC_E_TOKEN.address,
  currency1: USDC_TOKEN.address,
  fee: 20,
  tickSpacing: 1,
  hooks: HOOKS_ZERO,
};

const CurrentConfig: SwapExactInSingle = {
  poolKey,
  zeroForOne: true,
  amountIn: amountIn.toString(),
  amountOutMinimum: slippageAmount.toString(),
  hookData: "0x00",
};

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
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

// 1) Safe approves USDC.e to Permit2 (ERC20)
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
  [USDC_E_TOKEN.address, UNIVERSAL_ROUTER_ADDRESS, MAX_UINT160, deadline],
);

const safeTransactions: MetaTransactionData[] = [
  {
    to: USDC_E_TOKEN.address,
    value: "0",
    data: approvePermit2Data,
    operation: OperationType.Call,
  },
  {
    to: PERMIT2,
    value: "0",
    data: approveUniversalRouterData,
    operation: OperationType.Call,
  },
  {
    to: UNIVERSAL_ROUTER_ADDRESS,
    value: "0",
    data: executeData,
    operation: OperationType.Call,
  },
];

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

// Polygon: set gas so execTransaction doesn't revert with GS013 (gasPrice/safeTxGas 0)
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

const txResponse = await protocolKit.executeTransaction(
  safeTransaction,
  txOptions,
);
console.log("[LN:125][swap_gnosis.ts] Safe transaction executed (USDC.e -> USDC).", txResponse);

const receipt = await txResponse.transactionResponse.wait();
console.log("[LN:129][swap_gnosis.ts] Transaction receipt from wait.", receipt);
