# IMPORTANT NOTES:
The current version up to date to use uniswap v4 require an older version of ethers
To properly work with uniswap sdk install NOT the most recent ETHERS library version but "ethers": "npm:ethers@5.7.x" instead.

There are some differences between the swap written here and the one from the docs. The conversion is not exact. The reason is often the gas price defaulted by ethers is below what polygon expect. Therefore we have to adjust the gas tip and fee.

If you were to use this for high frequency swaps - use paid RPC URLs (like from alchemy) - do not use the current free alterntives.
