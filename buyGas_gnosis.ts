// Buy POL (gas) by spending USDC.e via the BuyGas contract on Polygon.
// Executes from a Gnosis Safe: 1) Approves USDC.e for BuyGas if needed; 2) Calls buyGas(amount).
// Uses ACCOUNT_ADD_SAFE and PRIVATE_KEY_EOA (Safe owner). POL is sent to the Safe.

import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  OperationType,
  SigningMethod,
} from "@safe-global/types-kit";
import { ethers } from "ethers";
import { RPC_URL, USDC_E_TOKEN } from "./constants_polygon.ts";
import { getPolygonTxOptions } from "./utils/calc_polygon_gas.ts";

const BUYGAS_ADDRESS = "0x2636A27d0b5D3082Dc698a7D24D26dFC0F4eaFbe";

const SAFE_ADDRESS = Deno.env.get("ACCOUNT_ADD_SAFE");
const OWNER_1_PRIVATE_KEY = Deno.env.get("PRIVATE_KEY_EOA");
const _amountUsdcE = "0.2"; // USDC.e amount (6 decimals), e.g. "0.2" = 0.2 USDC.e

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const usdcAmountRaw = ethers.utils.parseUnits(_amountUsdcE, USDC_E_TOKEN.decimals);

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const usdcE = new ethers.Contract(USDC_E_TOKEN.address, erc20Abi, provider);

// Checks using Safe as the account
const balance = await usdcE.balanceOf(SAFE_ADDRESS);
if (balance.lt(usdcAmountRaw)) {
  throw new Error(
    `[buyGas_gnosis] Insufficient USDC.e in Safe. Need ${_amountUsdcE} USDC.e (${usdcAmountRaw}), have ${balance.toString()}`,
  );
}

const allowance = await usdcE.allowance(SAFE_ADDRESS, BUYGAS_ADDRESS);
const needApprove = allowance.lt(usdcAmountRaw);

const erc20Iface = new ethers.utils.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const buyGasIface = new ethers.utils.Interface([
  "function buyGas(uint256 usdcAmount)",
]);

const approveData = erc20Iface.encodeFunctionData("approve", [
  BUYGAS_ADDRESS,
  ethers.constants.MaxUint256,
]);
const buyGasData = buyGasIface.encodeFunctionData("buyGas", [
  usdcAmountRaw.toString(),
]);

const safeTransactions: MetaTransactionData[] = [];
if (needApprove) {
  safeTransactions.push({
    to: USDC_E_TOKEN.address,
    value: "0",
    data: approveData,
    operation: OperationType.Call,
  });
}
safeTransactions.push({
  to: BUYGAS_ADDRESS,
  value: "0",
  data: buyGasData,
  operation: OperationType.Call,
});

// @ts-ignore: Safe.init default export type not resolved in Deno
const protocolKit = await Safe.init({
  provider: RPC_URL,
  signer: OWNER_1_PRIVATE_KEY,
  safeAddress: SAFE_ADDRESS,
});

const safeTxGasLimit = "350000"; // approve (if used) + buyGas
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

const txOptions = await getPolygonTxOptions(provider);
const txResponse = await protocolKit.executeTransaction(
  safeTransaction,
  txOptions,
);

console.log("[buyGas_gnosis] Safe transaction executed:", txResponse.hash);
console.log(
  "[buyGas_gnosis] View on PolygonScan: https://polygonscan.com/tx/" +
    txResponse.hash,
);

const receipt = await txResponse.transactionResponse.wait();
console.log("[buyGas_gnosis] Gas used:", receipt.gasUsed.toString());
console.log("[buyGas_gnosis] Done. POL was sent to the Safe:", SAFE_ADDRESS);
