// GOAL - Execute a swap with a GNOSIS safe wallet (1-of-1 single owner)
// Single-owner flow: create → sign → execute (no API Kit propose/confirm needed)
// https://docs.safe.global/sdk/protocol-kit/guides/execute-transactions
// https://docs.safe.global/sdk/protocol-kit/guides/signatures/transactions

import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  OperationType,
  SigningMethod,
} from "@safe-global/types-kit";
import { ethers } from "ethers";
import { RPC_URL, DAI_TOKEN, USDC_TOKEN, USDC_E_TOKEN } from "./constants_polygon.ts";

const SAFE_ADDRESS = Deno.env.get('ACCOUNT_ADD_SAFE')
const OWNER_1_PRIVATE_KEY = Deno.env.get('PRIVATE_KEY_EOA')
const DESTINATION_ADDRESS = Deno.env.get('ACCOUNT_ADD_THIRD_WEB')
const _amount = "1.30"
const _send_token = USDC_E_TOKEN

// Safe.init static factory (Deno type resolution workaround for default export)
// @ts-ignore: Safe.init default export type not resolved in Deno
const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: OWNER_1_PRIVATE_KEY,
    safeAddress: SAFE_ADDRESS
  })

// Encode ERC-20 transfer(to, amount): DAI uses 18 decimals
const amount = ethers.utils.parseUnits(_amount, _send_token.decimals);
const iface = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount)",
]);
const data = iface.encodeFunctionData("transfer", [
  DESTINATION_ADDRESS,
  amount,
]);

const safeTransactionData: MetaTransactionData = {
  to: _send_token.address,
//   value: String(amount),
    value: "0",
  data,
  operation: OperationType.Call,
};

let safeTransaction = await protocolKit.createTransaction({
  transactions: [safeTransactionData],
});

// Sign with the single owner (adds signature to safeTransaction.signatures)
safeTransaction = await protocolKit.signTransaction(
  safeTransaction,
  SigningMethod.ETH_SIGN_TYPED_DATA_V4,
);

// Execute directly — 1-of-1 Safe only needs this one signature
const txResponse = await protocolKit.executeTransaction(safeTransaction);

console.log("Safe transaction executed:", txResponse.hash);
