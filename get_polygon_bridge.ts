// Call Polymarket Bridge API to get the deposit address for USDC.e on Polygon.
// Send native USDC to the returned EVM address to receive USDC.e.
// https://bridge.polymarket.com/deposit

const POLYMARKET_BRIDGE_DEPOSIT = "https://bridge.polymarket.com/deposit";
// Wallet address
const walletAddress = Deno.env.get("ACCOUNT_ADD_THIRD_WEB") ?? "";

interface BridgeDepositResponse {
  address: {
    evm?: string;
    svm?: string;
    btc?: string;
  };
}

/**
 * Fetches a unique deposit address from Polymarket Bridge API.
 * Send native USDC to address.evm to receive USDC.e.
 * To utilize the polygon bridge to move money from USDC -> USDC.e it is important to read before get_polygon_bridge_min.json . The min amount in polygon to send and receive USDC.e is 2dls
 */
async function getDepositAddress(walletAddress: string): Promise<BridgeDepositResponse> {
  const res = await fetch(POLYMARKET_BRIDGE_DEPOSIT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletAddress }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const msg = (errorData as { message?: string }).message ?? res.statusText;
    throw new Error(`Polymarket bridge deposit failed: ${res.status} ${msg}`);
  }

  return (await res.json()) as BridgeDepositResponse;
}



if (!walletAddress) {
  console.error("[LN:40][get_polygon_bridge.ts] Missing address. Set ACCOUNT_ADD_SAFE or pass address as first argument.");
  Deno.exit(1);
}

if (!walletAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
  console.error("[LN:45][get_polygon_bridge.ts] Invalid Ethereum address format.");
  Deno.exit(1);
}

const data = await getDepositAddress(walletAddress);
const evmAddress = data.address?.evm;

if (!evmAddress) {
  console.error("[LN:57][get_polygon_bridge.ts] No EVM deposit address in response.", data);
  Deno.exit(1);
}

console.log("[LN:57][get_polygon_bridge.ts] Deposit address (send native USDC here to receive USDC.e):", evmAddress);

if (data.address?.svm) console.log("[LN:57][get_polygon_bridge.ts] Address to depoit:", data.address);