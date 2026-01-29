import { SwapExactInSingle } from "@uniswap/v4-sdk";
import {
  USDC_TOKEN,
  USDC_E_TOKEN,
  UNIVERSAL_ROUTER_ADDRESS,
  UNIVERSAL_ROUTER_ABI,
  RPC_URL,
} from "./constants_polygon.ts";
import { ethers } from "ethers";
import { UNIVERSAL_ROUTER_ABI as UNIVERSAL_ROUTER_ABI_MAINNET } from "./constants_mainnet.ts";

const _working_variables = {
  PRIVATE_KEY: Deno.env.get("PRIVATE_KEY_THIRD_WEB"),
  RPC_URL,
};

// Calculate amountOutMinimum based on desired slippage
// Example: set slippagePercent (e.g., 0.5 for 0.5%)
const slippagePercent = 0.5;
// Fetch external value for amountOutEstimate, or replace with logic as needed
const amountOutEstimate = ethers.utils.parseUnits("1", USDC_TOKEN.decimals); // placeholder
const slippageAmount = amountOutEstimate
  .mul(ethers.BigNumber.from(10000 - Math.floor(slippagePercent * 100)))
  .div(10000);

export const CurrentConfig: SwapExactInSingle = {
  poolKey: {
    currency0: USDC_E_TOKEN.address,
    currency1: USDC_TOKEN.address,
    fee: 20,
    tickSpacing: 1,
    hooks: "0x0000000000000000000000000000000000000000",
  },
  zeroForOne: true, // The direction of swap is ETH to USDC. Change it to 'false' for the reverse direction
  amountIn: ethers.utils.parseUnits("1", USDC_E_TOKEN.decimals).toString(),
  amountOutMinimum: slippageAmount.toString(),
  hookData: "0x00",
};

const provider = new ethers.providers.JsonRpcProvider(
  _working_variables.RPC_URL,
);
const signer = new ethers.Wallet(
  _working_variables.PRIVATE_KEY as string,
  provider,
);
const universalRouter = new ethers.Contract(
  UNIVERSAL_ROUTER_ADDRESS,
  UNIVERSAL_ROUTER_ABI_MAINNET,
  signer,
);

import { Actions, V4Planner } from "@uniswap/v4-sdk";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";

const v4Planner = new V4Planner();
const routePlanner = new RoutePlanner();

// Set deadline (1 hour from now)
const deadline = Math.floor(Date.now() / 1000) + 3600;

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

const isNativeInput =
  CurrentConfig.poolKey.currency0 ===
  "0x0000000000000000000000000000000000000000";

//////////////////// ADDED FOR POLYGON ////////////////////
const feeData = await provider.getFeeData();
const minTipGwei = ethers.BigNumber.from("25000000000"); // 25 Gwei, Polygon minimum
const tip = feeData.maxPriorityFeePerGas?.gte(minTipGwei)
  ? feeData.maxPriorityFeePerGas
  : minTipGwei;
const maxFee =
  feeData.maxFeePerGas?.gte(tip) ? feeData.maxFeePerGas : tip.mul(2);

const txOptions: {
  value?: string;
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
} = {
  maxPriorityFeePerGas: tip.toString(),
  maxFeePerGas: maxFee.toString(),
};
if (isNativeInput) txOptions.value = CurrentConfig.amountIn;
//////////////////// ADDED FOR POLYGON ////////////////////

const tx = await universalRouter.execute(
  routePlanner.commands,
  [encodedActions],
  deadline,
  txOptions,
);

const receipt = await tx.wait();
console.log("Swap completed! Transaction hash:", receipt.transactionHash);
