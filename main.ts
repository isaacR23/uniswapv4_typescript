/**
 * Uniswap v4 single-hop swap (ETH → USDC).
 * See: https://docs.uniswap.org/sdk/v4/guides/swaps/single-hop-swapping
 *
 * Env: RPC_URL, PRIVATE_KEY, UNIVERSAL_ROUTER_ADDRESS (optional),
 *      AMOUNT_IN (optional, default 1 ETH), MIN_AMOUNT_OUT (from quote / slippage).
 */

import { Actions, SwapExactInSingle, V4Planner } from "@uniswap/v4-sdk";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";
import { ethers } from "ethers";


//////////// DO NOT CHANGE VARIABLES BELOW ////////////
const USDC_TOKEN = {
  address: 
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC POLYGON
  decimals: 6,
} as const;

const USDC_E_TOKEN = {
  address: 
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e POLYGON
  decimals: 6,
} as const;

const _working_variables = {
  NETWORK: "polygon",
  AMOUNT_IN: Deno.env.get("AMOUNT_IN"),
  CURRENCY0_ADDRESS: USDC_E_TOKEN.address,
  CURRENCY1_ADDRESS: USDC_TOKEN.address,
  CURRENCT_0_DECIMALS: USDC_E_TOKEN.decimals,
  CURRENCT_1_DECIMALS: USDC_TOKEN.decimals,
  MIN_AMOUNT_OUT: Deno.env.get("MIN_AMOUNT_OUT"),
  RPC_URL: Deno.env.get("RPC_URL"),
  PRIVATE_KEY: Deno.env.get("PRIVATE_KEY"),
  UNIVERSAL_ROUTER_ADDRESS: Deno.env.get("UNIVERSAL_ROUTER_ADDRESS"),
} as const;
//////////// DO NOT CHANGE VARIABLES ABOVE ////////////

export const CurrentConfig: SwapExactInSingle = {
  poolKey: {
      currency0: _working_variables.CURRENCY0_ADDRESS,
      currency1: _working_variables.CURRENCY1_ADDRESS,
      fee: 500,
      tickSpacing: 10,
      hooks: "0x0000000000000000000000000000000000000000",
  },
  zeroForOne: true, // The direction of swap is ETH to USDC. Change it to 'false' for the reverse direction
  amountIn: ethers.utils.parseUnits('1', _working_variables.CURRENCT_0_DECIMALS).toString(),
  amountOutMinimum: "minAmountOut", // Change according to the slippage desired
  hookData: '0x00'
}