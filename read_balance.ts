// Read token and native balances for a Gnosis Safe on Polygon.

import { ethers } from "ethers";
import { RPC_URL, USDC_TOKEN, USDC_E_TOKEN } from "./constants_polygon.ts";

const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE") ?? "";
if (!SAFE_ADDRESS) {
  console.error("[LN:9][read_balance.ts] Missing ACCOUNT_ADD_SAFE.");
  Deno.exit(1);
}

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

async function readBalance(): Promise<void> {
  const nativeBalance = await provider.getBalance(SAFE_ADDRESS);
  const usdc = new ethers.Contract(USDC_TOKEN.address, ERC20_ABI, provider);
  const usdcE = new ethers.Contract(USDC_E_TOKEN.address, ERC20_ABI, provider);

  const [usdcBalance, usdcEBalance] = await Promise.all([
    usdc.balanceOf(SAFE_ADDRESS),
    usdcE.balanceOf(SAFE_ADDRESS),
  ]);

  const usdcDecimals = await usdc.decimals();
  const usdcEDecimals = await usdcE.decimals();

  const usdcFormatted = ethers.utils.formatUnits(usdcBalance, usdcDecimals);
  const usdcEFormatted = ethers.utils.formatUnits(usdcEBalance, usdcEDecimals);
  const nativeFormatted = ethers.utils.formatEther(nativeBalance);

  console.log("[LN:35][read_balance.ts][readBalance] Safe balances:");
  console.log(`  ${USDC_TOKEN.symbol ?? "USDC"}: ${usdcFormatted}`);
  console.log(`  ${USDC_E_TOKEN.symbol ?? "USDC.e"}: ${usdcEFormatted}`);
  console.log(`  POL (native): ${nativeFormatted}`);
}

readBalance().catch((err) => {
  console.error("[LN:43][read_balance.ts] Failed to read balance.", err.message);
  Deno.exit(1);
});
