// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SendGas
/// @notice Distribute 10 POL to new Polygon users, one time per address only.
/// Supports self-claim (claimGas) when user has gas, or relayer-claimed (claimGasFor) when user signs off-chain and a relayer pays gas.
contract SendGas is Ownable, ReentrancyGuard, EIP712 {
    uint256 public immutable GAS_AMOUNT = 2 ether;

    bytes32 private constant CLAIM_GAS_FOR_TYPEHASH =
        keccak256("ClaimGasFor(address recipient,uint256 deadline)");

    mapping(address => bool) public hasClaimed;

    event GasClaimed(address indexed recipient, uint256 amount);
    event FundsWithdrawn(address indexed owner, uint256 amount);
    event FundsDeposited(address indexed sender, uint256 amount);
    event TokenWithdrawn(address indexed token, uint256 amount);

    error AlreadyClaimed();
    error InsufficientBalance();
    error ZeroBalance();
    error ZeroAmount();
    error TransferFailed();
    error SignatureExpired();
    error InvalidSignature();

    constructor(address _owner) Ownable(_owner) EIP712("SendGas", "1") {}

    /// @notice Claim 10 POL once per address. Callable by anyone who has not yet claimed (requires caller to have gas).
    function claimGas() external nonReentrant {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();
        if (address(this).balance < GAS_AMOUNT) revert InsufficientBalance();

        hasClaimed[msg.sender] = true;

        (bool sent,) = msg.sender.call{value: GAS_AMOUNT}("");
        if (!sent) revert TransferFailed();

        emit GasClaimed(msg.sender, GAS_AMOUNT);
    }

    /// @notice Claim 10 POL for a recipient who signed off-chain. Relayer pays gas; POL is sent to recipient.
    /// Use this when the recipient has no gas: they sign a ClaimGasFor(recipient, deadline) message; your backend submits this tx.
    /// EIP-712 domain: name "SendGas", version "1", chainId, this contract address.
    /// Typed data: ClaimGasFor(address recipient,uint256 deadline) with recipient and deadline.
    /// @param recipient Address that will receive the POL (must match the signer of the signature).
    /// @param deadline EIP-712 deadline; signature is invalid after this timestamp.
    /// @param signature EIP-712 signature from recipient for ClaimGasFor(recipient, deadline).
    function claimGasFor(address recipient, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (hasClaimed[recipient]) revert AlreadyClaimed();
        if (address(this).balance < GAS_AMOUNT) revert InsufficientBalance();

        bytes32 typeHash = CLAIM_GAS_FOR_TYPEHASH;
        bytes32 structHash;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, typeHash)
            mstore(add(ptr, 0x20), recipient)
            mstore(add(ptr, 0x40), deadline)
            structHash := keccak256(ptr, 0x60)
            mstore(0x40, add(ptr, 0x60))
        }
        bytes32 digest = _hashTypedDataV4(structHash);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != recipient) revert InvalidSignature();

        hasClaimed[recipient] = true;
        (bool sent,) = recipient.call{value: GAS_AMOUNT}("");
        if (!sent) revert TransferFailed();

        emit GasClaimed(recipient, GAS_AMOUNT);
    }

    /// @notice Owner withdraws all POL and all balances of the given ERC20 tokens to the owner.
    /// @param tokens Array of ERC20 token addresses to sweep (pass empty array to withdraw only POL).
    function withdrawAll(address[] calldata tokens) external onlyOwner nonReentrant {
        uint256 polBalance = address(this).balance;
        if (polBalance > 0) {
            (bool sent,) = owner().call{value: polBalance}("");
            if (!sent) revert TransferFailed();
            emit FundsWithdrawn(owner(), polBalance);
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = IERC20(tokens[i]);
            uint256 bal = token.balanceOf(address(this));
            if (bal > 0) {
                bool ok = token.transfer(owner(), bal);
                if (!ok) revert TransferFailed();
                emit TokenWithdrawn(address(token), bal);
            }
        }
        if (polBalance == 0 && tokens.length == 0) revert ZeroBalance();
    }

    /// @notice Owner deposits POL to fund gas claims. Sends POL with the call (e.g. depositGas{value: 100 ether}()).
    function depositGas() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        emit FundsDeposited(msg.sender, msg.value);
    }

    /// @notice Allow owner to fund the contract with POL by sending a plain transfer to the contract.
    receive() external payable onlyOwner {
        if (msg.value > 0) {
            emit FundsDeposited(msg.sender, msg.value);
        }
    }

    /// @notice Check if an address has already claimed gas.
    function hasClaimedGas(address addr) external view returns (bool) {
        return hasClaimed[addr];
    }

    /// @notice Current contract balance in wei.
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Number of full claims still possible with current balance.
    function remainingClaims() external view returns (uint256) {
        return address(this).balance / GAS_AMOUNT;
    }
}
