# IMPORTANT NOTES:
The current version up to date to use uniswap v4 require an older version of ethers
To properly work with uniswap sdk install NOT the most recent ETHERS library version but "ethers": "npm:ethers@5.7.x" instead.

To work with the swap is fine if you use the mainnet minimal ABI contract for the universal router.

There are some differences between the swap written here and the one from the docs. The conversion is not exact. The reason is often the gas price defaulted by ethers is below what polygon expect. Therefore we have to adjust the gas tip and fee.

If you were to use this for high frequency swaps - use paid RPC URLs (like from alchemy) - do not use the current free alterntives.

To utilize the polygon bridge to move money from USDC -> USDC.e it is important to read before get_polygon_bridge_min.json . The min amount in polygon to send and receive USDC.e is 2dls