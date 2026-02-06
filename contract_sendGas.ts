// Send gas to EOA via SendGas.claimGasFor: EOA signs EIP-712, THIRD_WEB relayer submits.
// Matches contract_sendGas.sol (EIP712 "SendGas"/"1", ClaimGasFor(recipient, deadline), GAS_AMOUNT = 2 ether).

import { ethers } from "ethers";
import { type Hex } from "viem";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL } from "./constants_polygon.ts";

// --- Fixed constants (must match contract_sendGas.sol) ---
const CHAIN_ID = 137;
const SEND_GAS_CONTRACT_ADDRESS = "0x2419bC7ace852cBCCE23Dc6C65712168463222b3" as const; // Replace with deployed SendGas address
const EIP712_DOMAIN_NAME = "SendGas" as const;
const EIP712_VERSION = "1" as const;
const _GAS_AMOUNT_ETHER = "2" as const; // POL per claim; must match contract immutable GAS_AMOUNT (2 ether)

const SEND_GAS_ABI = [
  "function claimGasFor(address recipient, uint256 deadline, bytes calldata signature) external",
  "function hasClaimedGas(address addr) external view returns (bool)",
  "function getBalance() external view returns (uint256)",
  "function remainingClaims() external view returns (uint256)",
];

export interface IResponse {
  success: boolean;
  transactionHash?: string;
  gasUsed?: string;
  totalGasSpentWei?: string;
  totalGasSpentPOL?: string;
  error?: string;
}

/**
 * Sends 2 POL to EOA via SendGas.claimGasFor (matches contract_sendGas.sol).
 * Pre-checks: hasClaimedGas(recipient), remainingClaims() > 0.
 * 1. EOA signs EIP-712 ClaimGasFor(recipient, deadline) (domain SendGas/1, chainId 137).
 * 2. THIRD_WEB relayer calls claimGasFor(recipient, deadline, signature).
 */
export async function sendGasToEoa(): Promise<IResponse> {
  const PRIVATE_KEY_EOA = Deno.env.get("PRIVATE_KEY_EOA");
  const PRIVATE_KEY_THIRD_WEB = Deno.env.get("PRIVATE_KEY_THIRD_WEB");
  const RECIPIENT_EOA = Deno.env.get("ACCOUNT_ADD_EOA");

  if (!PRIVATE_KEY_EOA || !PRIVATE_KEY_THIRD_WEB || !RECIPIENT_EOA) {
    console.log("[LN:42][contract_sendGas.ts][sendGasToEoa] Missing env.");
    return {
      success: false,
      error: "Missing PRIVATE_KEY_EOA, PRIVATE_KEY_THIRD_WEB, or ACCOUNT_ADD_EOA",
    };
  }

  const sendGasAddress: string = SEND_GAS_CONTRACT_ADDRESS;
  if (!sendGasAddress || sendGasAddress === "0x0000000000000000000000000000000000000000") {
    console.log("[LN:52][contract_sendGas.ts][sendGasToEoa] SendGas contract address not set.");
    return { success: false, error: "SEND_GAS_CONTRACT_ADDRESS not configured" };
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const contractRead = new ethers.Contract(
    SEND_GAS_CONTRACT_ADDRESS,
    SEND_GAS_ABI,
    provider,
  );

  const recipient = RECIPIENT_EOA as Hex;

  const [alreadyClaimed, remaining] = await Promise.all([
    contractRead.hasClaimedGas(recipient),
    contractRead.remainingClaims(),
  ]);
  if (alreadyClaimed) {
    console.log("[LN:68][contract_sendGas.ts][sendGasToEoa] Recipient already claimed.");
    return { success: false, error: "AlreadyClaimed" };
  }
  if (remaining.isZero()) {
    console.log("[LN:72][contract_sendGas.ts][sendGasToEoa] Contract has no POL for claims.");
    return { success: false, error: "InsufficientBalance" };
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // now + 1 hour

  const domain = {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: SEND_GAS_CONTRACT_ADDRESS as Hex,
  };

  const types = {
    ClaimGasFor: [
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    recipient,
    deadline,
  };

  let signature: Hex;
  try {
    const account = privateKeyToAccount(
      (PRIVATE_KEY_EOA.startsWith("0x") ? PRIVATE_KEY_EOA : `0x${PRIVATE_KEY_EOA}`) as Hex,
    );
    signature = await account.signTypedData({
      domain,
      types,
      primaryType: "ClaimGasFor",
      message,
    });
  } catch (e) {
    console.log("[LN:88][contract_sendGas.ts][sendGasToEoa] EIP-712 sign failed.");
    return { success: false, error: e instanceof Error ? e.message : "Sign failed" };
  }

  const relayerWallet = new ethers.Wallet(
    PRIVATE_KEY_THIRD_WEB.startsWith("0x") ? PRIVATE_KEY_THIRD_WEB : `0x${PRIVATE_KEY_THIRD_WEB}`,
    provider,
  );
  const contract = new ethers.Contract(
    SEND_GAS_CONTRACT_ADDRESS,
    SEND_GAS_ABI,
    relayerWallet,
  );

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

  try {
    const tx = await contract.claimGasFor(
      recipient,
      deadline.toString(),
      signature,
      txOptions,
    );
    console.log("[LN:126][contract_sendGas.ts][sendGasToEoa] Transaction broadcast.");
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed.toString();
    const totalGasSpentWei = receipt.gasUsed.mul(maxFee).toString();
    const totalGasSpentPOL = formatEther(BigInt(totalGasSpentWei));
    console.log("[LN:132][contract_sendGas.ts][sendGasToEoa] Confirmed. Hash:", receipt.transactionHash, "Gas used:", gasUsed, "Cost POL:", totalGasSpentPOL);
    return {
      success: true,
      transactionHash: receipt.transactionHash,
      gasUsed,
      totalGasSpentWei,
      totalGasSpentPOL,
    };
  } catch (e) {
    console.log("[LN:142][contract_sendGas.ts][sendGasToEoa] claimGasFor failed.");
    return {
      success: false,
      error: e instanceof Error ? e.message : "Transaction failed",
    };
  }
}

if (import.meta.main) {
  const result = await sendGasToEoa();
  console.log(JSON.stringify(result, null, 2));
}
