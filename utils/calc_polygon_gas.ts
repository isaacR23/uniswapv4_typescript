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
  const tip =
    feeData.maxPriorityFeePerGas?.gte(MIN_TIP_GWEI)
      ? feeData.maxPriorityFeePerGas
      : MIN_TIP_GWEI;
  const maxFee =
    feeData.maxFeePerGas?.gte(tip) ? feeData.maxFeePerGas : tip.mul(2);
  return {
    maxPriorityFeePerGas: tip.toString(),
    maxFeePerGas: maxFee.toString(),
  };
}
