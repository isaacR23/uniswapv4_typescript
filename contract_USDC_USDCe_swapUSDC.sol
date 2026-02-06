// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BuyUsdce
/// @notice Swap USDC for USDC.e at 1:0.99 rate (1% fee) on Polygon. Owner can replenish USDC.e by sending USDC to a configured replenish-address contract that returns USDC.e to this contract.
contract BuyUsdce is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC = IERC20(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359);
    IERC20 public immutable USDC_E = IERC20(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174);

    uint256 public constant FEE_NUMERATOR = 99;
    uint256 public constant FEE_DENOMINATOR = 100;
    uint256 public constant MIN_BRIDGE_AMOUNT = 2e6;

    /// @notice Address (contract) that receives USDC and sends USDC.e back to this contract.
    address public replenishAddress;

    event Swapped(address indexed user, uint256 usdcIn, uint256 usdceOut, uint256 fee);
    event ReplenishAddressUpdated(address indexed replenishAddress);
    event ReplenishedFromBridge(uint256 usdcSent, uint256 usdceReceived);
    event OwnerWithdraw(address indexed token, uint256 amount);
    event UsdceDeposited(address indexed sender, uint256 amount);

    error InsufficientUSDCeReserve();
    error ZeroAmount();
    error ReplenishAddressNotSet();
    error BelowMinBridgeAmount();
    error InsufficientUSDCBalance();
    error TransferFailed(); // used for POL send in withdrawAll
    error ZeroBalance();
    error PermitExpired();

    constructor(address _owner) Ownable(_owner) {}

    /// @notice Swap USDC for USDC.e at 1:0.99 (1% fee). User must approve this contract to spend USDC first.
    /// @param usdcAmount Amount of USDC to swap (6 decimals).
    function swapUsdcForUsdCe(uint256 usdcAmount) external nonReentrant {
        (uint256 usdceOut, uint256 fee) = calculateSwap(usdcAmount);

        if (USDC_E.balanceOf(address(this)) < usdceOut) revert InsufficientUSDCeReserve();

        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
        USDC_E.safeTransfer(msg.sender, usdceOut);

        emit Swapped(msg.sender, usdcAmount, usdceOut, fee);
    }

    /// @notice Swap USDC for USDC.e in one tx using EIP-2612 permit. No prior approve needed: sign a permit message off-chain, then call this with the signature.
    /// @param usdcAmount Amount of USDC to swap (6 decimals).
    /// @param deadline Permit deadline (unix timestamp); signature is invalid after this.
    /// @param v Permit signature v (from EIP-2612 typed data sign).
    /// @param r Permit signature r.
    /// @param s Permit signature s.
    function swapUsdcForUsdCeWithPermit(
        uint256 usdcAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (block.timestamp > deadline) revert PermitExpired();

        IERC20Permit(address(USDC)).permit(msg.sender, address(this), usdcAmount, deadline, v, r, s);

        (uint256 usdceOut, uint256 fee) = calculateSwap(usdcAmount);

        if (USDC_E.balanceOf(address(this)) < usdceOut) revert InsufficientUSDCeReserve();

        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
        USDC_E.safeTransfer(msg.sender, usdceOut);

        emit Swapped(msg.sender, usdcAmount, usdceOut, fee);
    }

    /// @notice Owner deposits USDC.e into the contract to fund the swap reserve. Owner must approve this contract to spend USDC.e first.
    /// For lowest gas, the owner can instead send USDC.e directly to this contract from their wallet (one ERC20 transfer); no need to call this.
    /// @param amount Amount of USDC.e to deposit (6 decimals).
    function depositUsdce(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        // Low-level call: no returndata decode (works for tokens that return bool or nothing). Saves gas vs SafeERC20.
        (bool ok,) = address(USDC_E).call(
            abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount))
        );
        if (!ok) revert TransferFailed();
        emit UsdceDeposited(msg.sender, amount);
    }

    /// @notice Owner sets the replenishment address. That contract receives USDC from this contract and sends USDC.e back here.
    /// @param _replenishAddress Contract address that accepts USDC and returns USDC.e to this contract.
    function setReplenishAddress(address _replenishAddress) external onlyOwner {
        replenishAddress = _replenishAddress;
        emit ReplenishAddressUpdated(_replenishAddress);
    }

    /// @notice Owner replenishes USDC.e by sending USDC to the configured replenish address. That contract sends USDC.e back to this contract.
    /// @param usdcAmount Amount of USDC to send (min 2 USDC, 6 decimals).
    function replenishFromBridge(uint256 usdcAmount) external onlyOwner nonReentrant {
        if (replenishAddress == address(0)) revert ReplenishAddressNotSet();
        if (usdcAmount < MIN_BRIDGE_AMOUNT) revert BelowMinBridgeAmount();
        if (USDC.balanceOf(address(this)) < usdcAmount) revert InsufficientUSDCBalance();

        USDC.safeTransfer(replenishAddress, usdcAmount);

        emit ReplenishedFromBridge(usdcAmount, 0);
    }

    /// @notice Owner withdraws accumulated USDC (fees) to owner.
    function withdrawUsdc(uint256 amount) external onlyOwner nonReentrant {
        USDC.safeTransfer(owner(), amount);
        emit OwnerWithdraw(address(USDC), amount);
    }

    /// @notice Owner emergency withdraws USDC.e to owner.
    function withdrawUsdCe(uint256 amount) external onlyOwner nonReentrant {
        USDC_E.safeTransfer(owner(), amount);
        emit OwnerWithdraw(address(USDC_E), amount);
    }

    /// @notice Owner withdraws all POL and all balances of the given ERC20 tokens to the owner. Pass token addresses to sweep (e.g. USDC, USDC.e, or any other ERC20).
    /// @param tokens Array of ERC20 token addresses to sweep (pass empty array to withdraw only POL).
    function withdrawAll(address[] calldata tokens) external onlyOwner nonReentrant {
        uint256 polBalance = address(this).balance;
        if (polBalance > 0) {
            (bool sent,) = owner().call{value: polBalance}("");
            if (!sent) revert TransferFailed();
            emit OwnerWithdraw(address(0), polBalance);
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = IERC20(tokens[i]);
            uint256 bal = token.balanceOf(address(this));
            if (bal > 0) {
                token.safeTransfer(owner(), bal);
                emit OwnerWithdraw(address(token), bal);
            }
        }
        if (polBalance == 0 && tokens.length == 0) revert ZeroBalance();
    }

    /// @notice Accept POL so that withdrawAll can sweep it if sent to the contract.
    receive() external payable {}

    /// @notice Contract's USDC.e balance (reserve for swaps).
    function getUsdCeReserve() external view returns (uint256) {
        return USDC_E.balanceOf(address(this));
    }

    /// @notice Contract's USDC balance (fees / pre-bridge).
    function getUsdcBalance() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @notice Calculate USDC.e out and fee for a given USDC amount (1:0.99).
    function calculateSwap(uint256 usdcAmount) public pure returns (uint256 usdceOut, uint256 fee) {
        usdceOut = (usdcAmount * FEE_NUMERATOR) / FEE_DENOMINATOR;
        fee = usdcAmount - usdceOut;
    }
}
