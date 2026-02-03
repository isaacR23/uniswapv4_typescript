// Polygon gas options: enforce minimum 25 Gwei tip so txs are accepted by the chain.

import { ethers } from "ethers";

const MIN_TIP_GWEI = ethers.BigNumber.from("25000000000"); // 25 Gwei, Polygon minimum

export async function getPolygonTxOptions(
  provider: ethers.providers.Provider,
): Promise<{
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
}> {
  const feeData = await provider.getFeeData();
  const GAS_BUMP_PERCENT = 150; // 50% bump to handle replacement txs (REPLACEMENT_UNDERPRICED)
  const rawTip =
    feeData.maxPriorityFeePerGas?.gte(MIN_TIP_GWEI)
      ? feeData.maxPriorityFeePerGas
      : MIN_TIP_GWEI;
  const tip = rawTip.mul(GAS_BUMP_PERCENT).div(100);
  const rawMaxFee =
    feeData.maxFeePerGas?.gte(rawTip) ? feeData.maxFeePerGas : rawTip.mul(2);
  const maxFee = rawMaxFee.mul(GAS_BUMP_PERCENT).div(100);
  return {
    maxPriorityFeePerGas: tip.toString(),
    maxFeePerGas: maxFee.toString(),
  };
}
