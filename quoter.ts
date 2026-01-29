import { SwapExactInSingle } from '@uniswap/v4-sdk'
import { USDC_TOKEN, USDC_E_TOKEN, QUOTE_CONTRACT_ADDRESS, QUOTER_ABI, RPC_URL } from './constants_polygon.ts'
import { ethers } from 'ethers'

export const CurrentConfig: SwapExactInSingle = {
    poolKey: {
        currency0: USDC_E_TOKEN.address,
        currency1: USDC_TOKEN.address,
        fee: 20, // if we want ETH on original example this is 500
        tickSpacing: 1, // if we want ETH on original example this is 10
        hooks: "0x0000000000000000000000000000000000000000",
    },
    zeroForOne: true,
    amountIn: ethers.utils.parseUnits('1', USDC_E_TOKEN.decimals).toString(), 
    amountOutMinimum: "0",
    hookData: '0x00'
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
const quoterContract = new ethers.Contract(QUOTE_CONTRACT_ADDRESS, QUOTER_ABI, provider)

const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle({
    poolKey: CurrentConfig.poolKey,
    zeroForOne: CurrentConfig.zeroForOne,
    exactAmount: CurrentConfig.amountIn,
    hookData: CurrentConfig.hookData,
})

const amountOut = Array.isArray(quotedAmountOut) ? quotedAmountOut[0] : quotedAmountOut.amountOut
console.log(`[LN:33][quoter.ts] Price for 1 USDC.e: USDC$`, ethers.utils.formatUnits(amountOut, USDC_TOKEN.decimals))
