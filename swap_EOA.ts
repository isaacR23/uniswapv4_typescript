// Step 4 only: Swap USDC.e → USDC at EOA. Same steps as swap_gnosis_v2.ts Step 4.
// Set amount to convert (USDC.e, 6 decimals). Approves Permit2 for USDC.e if needed, then executes swap.

import { SwapExactInSingle } from "@uniswap/v4-sdk";
import { Actions, V4Planner } from "@uniswap/v4-sdk";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";
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

// Permit2 AllowanceTransfer: set allowance for Universal Router to pull USDC.e
const PERMIT2_APPROVE_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
];
import { UNIVERSAL_ROUTER_ABI } from "./constants_mainnet.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const _amountUsdcE = "1.994664";
const PRIVATE_KEY_EOA = Deno.env.get("PRIVATE_KEY_EOA");
const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";
const amountUsdcE = ethers.utils.parseUnits(_amountUsdcE, 6);
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
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const usdcEContract = new ethers.Contract(
  USDC_E_TOKEN.address,
  ERC20_ABI,
  signer,
);
const permit2Contract = new ethers.Contract(
  PERMIT2,
  PERMIT2_APPROVE_ABI,
  signer,
);

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

const poolKey = {
  currency0: USDC_E_TOKEN.address,
  currency1: USDC_TOKEN.address,
  fee: 20,
  tickSpacing: 1,
  hooks: HOOKS_ZERO,
};

// Quote then 0.5% slippage (same as swap_gnosis_v2.ts Step 4)
const quotedStep4 = await quoterContract.callStatic.quoteExactInputSingle({
  poolKey,
  zeroForOne: true,
  exactAmount: amountUsdcE,
  hookData: "0x00",
});
const amountOutQuoted4 = Array.isArray(quotedStep4)
  ? quotedStep4[0]
  : quotedStep4.amountOut;
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
console.log("[step_4_todelete.ts] Step 4 completed. Tx:", _receipt4.transactionHash);
