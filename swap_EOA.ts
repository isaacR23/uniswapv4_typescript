// Step 4 only: Swap USDC.e → USDC at EOA. Same steps as swap_gnosis_v2.ts Step 4.
// Swaps full EOA USDC.e balance. Approves Permit2 for USDC.e if needed, then executes swap.

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


// Permit2 AllowanceTransfer
const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
import { UNIVERSAL_ROUTER_ABI } from "./constants_mainnet.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const WAIT_TIMEOUT_MS = 120_000; // 2 min for Polygon
const PENDING_TX_POLL_MS = 8_000; // 8 s between checks
const PENDING_TX_TIMEOUT_MS = 180_000; // 3 min max wait

async function waitForNoPendingTx(
  provider: ethers.providers.Provider,
  address: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < PENDING_TX_TIMEOUT_MS) {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(address, "latest"),
      provider.getTransactionCount(address, "pending"),
    ]);
    if (pending <= latest) {
      return;
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    console.log("[swap_EOA.ts][pending] Pending tx(s) detected, waiting for confirm or drop...", elapsed, "s");
    await new Promise((r) => setTimeout(r, PENDING_TX_POLL_MS));
  }
  throw new Error(
    `[swap_EOA.ts] Timeout waiting for pending tx(s) to clear after ${PENDING_TX_TIMEOUT_MS / 1000}s. Check Polygonscan.`,
  );
}

async function waitForTx(
  tx: ethers.ContractTransaction,
): Promise<ethers.ContractReceipt> {
  const hash = tx.hash;
  return await Promise.race([
    tx.wait(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `[swap_EOA.ts] Tx confirmation timeout after ${WAIT_TIMEOUT_MS / 1000}s. Hash: ${hash} — check https://polygonscan.com/tx/${hash}`,
            ),
          ),
        WAIT_TIMEOUT_MS,
      ),
    ),
  ]);
}

const PRIVATE_KEY_EOA = Deno.env.get("PRIVATE_KEY_EOA");
const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";
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
  "function balanceOf(address account) view returns (uint256)",
];
const usdcEContract = new ethers.Contract(
  USDC_E_TOKEN.address,
  ERC20_ABI,
  signer,
);
const permit2Contract = new ethers.Contract(PERMIT2, PERMIT2_ABI, signer);

console.log("[swap_EOA.ts][init] Starting. EOA:", signer.address, "RPC:", RPC_URL);

await waitForNoPendingTx(provider, signer.address);

// Use exact USDC.e balance
console.log("[swap_EOA.ts][balance] Fetching USDC.e balance...");
const amountUsdcE = await usdcEContract.balanceOf(signer.address);
console.log("[swap_EOA.ts][balance] USDC.e:", amountUsdcE.toString(), "=", ethers.utils.formatUnits(amountUsdcE, 6));
if (amountUsdcE.isZero()) {
  throw new Error("[swap_EOA.ts] EOA has no USDC.e balance to swap.");
}

// 1) ERC20: allow Permit2 to pull USDC.e
console.log("[swap_EOA.ts][erc20] Checking ERC20 allowance...");
const erc20Allowance = await usdcEContract.allowance(signer.address, PERMIT2);
if (erc20Allowance.lt(amountUsdcE)) {
  console.log("[swap_EOA.ts][erc20] Approving Permit2...");
  const approveTx = await usdcEContract.approve(
    PERMIT2,
    ethers.constants.MaxUint256,
    await getPolygonTxOptions(provider),
  );
  await waitForTx(approveTx);
  console.log("[swap_EOA.ts][erc20] Permit2 approved.");
} else {
  console.log("[swap_EOA.ts][erc20] ERC20 allowance sufficient.");
}

// 2) Permit2: allow Universal Router to pull USDC.e (fixes 0xd81b2f2e AllowanceExpired)
const MAX_UINT160 = ethers.BigNumber.from(
  "0xffffffffffffffffffffffffffffffffffffffff",
);
const [permit2Amount, permit2Expiration] = await permit2Contract.allowance(
  signer.address,
  USDC_E_TOKEN.address,
  UNIVERSAL_ROUTER_ADDRESS,
);
const now = Math.floor(Date.now() / 1000);
const permit2Valid =
  permit2Amount.gte(amountUsdcE) && Number(permit2Expiration) > now;
if (permit2Valid) {
  console.log("[swap_EOA.ts][permit2] Permit2 allowance already valid, skipping approve.");
} else {
  console.log("[swap_EOA.ts][permit2] Sending Permit2 approve...");
  const permit2ApproveTx = await permit2Contract.approve(
    USDC_E_TOKEN.address,
    UNIVERSAL_ROUTER_ADDRESS,
    MAX_UINT160,
    deadline,
    await getPolygonTxOptions(provider),
  );
  console.log("[swap_EOA.ts][permit2] Permit2 approve tx sent, hash:", permit2ApproveTx.hash, "waiting for confirmation...");
  await waitForTx(permit2ApproveTx);
  console.log("[swap_EOA.ts][permit2] Permit2 approve confirmed.");
}

const poolKey = {
  currency0: USDC_E_TOKEN.address,
  currency1: USDC_TOKEN.address,
  fee: 20,
  tickSpacing: 1,
  hooks: HOOKS_ZERO,
};

// Quote then 2% slippage (permissive)
console.log("[swap_EOA.ts][quote] Getting quote...");
const quotedStep4 = await quoterContract.callStatic.quoteExactInputSingle({
  poolKey,
  zeroForOne: true,
  exactAmount: amountUsdcE,
  hookData: "0x00",
});
const amountOutQuoted4 = Array.isArray(quotedStep4)
  ? quotedStep4[0]
  : quotedStep4.amountOut;
const slippageBasisPoints = 200; // 2% - permissive
const slippageAmount4 = amountOutQuoted4
  .mul(ethers.BigNumber.from(10000 - slippageBasisPoints))
  .div(10000);
console.log("[swap_EOA.ts][quote] amountOut:", amountOutQuoted4.toString(), "minOut:", slippageAmount4.toString());

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

console.log("[swap_EOA.ts][execute] Getting gas options and nonce...");
const [gasOptions, nonce] = await Promise.all([
  getPolygonTxOptions(provider),
  provider.getTransactionCount(signer.address, "pending"),
]);
const txOptions4 = { ...gasOptions, nonce };
console.log("[swap_EOA.ts][execute] Sending swap tx (nonce:", nonce, ")...");
const tx4 = await universalRouter.execute(
  routePlanner4.commands,
  [encodedActions4],
  deadline,
  txOptions4,
);
console.log("[swap_EOA.ts][execute] Tx sent, hash:", tx4.hash, "waiting for confirmation...");
const _receipt4 = await waitForTx(tx4);
console.log("[swap_EOA.ts] Swap completed. Tx:", _receipt4.transactionHash);
