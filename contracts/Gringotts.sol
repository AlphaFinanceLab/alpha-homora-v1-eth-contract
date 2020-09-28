pragma solidity 0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/SafeMath.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/Math.sol";
import "openzeppelin-solidity-2.3.0/contracts/utils/ReentrancyGuard.sol";
import "./GringottsConfig.sol";
import "./Goblin.sol";
import "./SafeToken.sol";

contract Gringotts is ERC20, ReentrancyGuard, Ownable {
    event Deposit(address indexed user, uint256 share, uint256 value);
    event Withdrawal(address indexed user, uint256 share, uint256 value);

    using SafeToken for address;
    using SafeMath for uint256;

    struct Position {
        address goblin;
        address owner;
        uint256 debtShare;
    }

    GringottsConfig public config;
    mapping (uint256 => Position) public positions;
    uint256 public nextPositionID = 1;

    uint256 public glbDebtShare;
    uint256 public glbDebtVal;
    uint256 public lastAccrueTime;
    uint256 public reservePool;

    /// @dev Require that the caller must be an EOA account to avoid flash loans.
    modifier onlyEOA() {
        require(msg.sender == tx.origin, "!eoa");
        _;
    }

    /// @dev Add more debt to the global debt pool.
    modifier accrue() {
        if (now > lastAccrueTime) {
            uint256 timePast = now.sub(lastAccrueTime);
            uint256 ratePerSec = config.getInterestRate();
            uint256 interest = ratePerSec.mul(glbDebtVal).mul(timePast).div(1e18);
            uint256 toReserve = interest.mul(config.getReservePoolBps()).div(10000);
            reservePool = reservePool.add(toReserve);
            glbDebtVal = glbDebtVal.add(interest);
            lastAccrueTime = now;
        }
        _;
    }

    constructor(GringottsConfig _config) public {
        config = _config;
        lastAccrueTime = now;
    }

    /// @dev Return the ETH debt value given the debt share.
    /// @param debtShare The debt share to be converted.
    function debtShareToVal(uint256 debtShare) public view returns (uint256) {
        if (glbDebtShare == 0) return debtShare; // When there's no share, 1 share = 1 val.
        return debtShare.mul(glbDebtVal).div(glbDebtShare);
    }

    /// @dev Return the debt share for the given debt value.
    /// @param debtVal The debt value to be converted.
    function debtValToShare(uint256 debtVal) public view returns (uint256) {
        if (glbDebtShare == 0) return debtVal; // When there's no share, 1 share = 1 val.
        return debtVal.mul(glbDebtShare).div(glbDebtVal);
    }

    /// @dev Return ETH value and debt of the given position. Be careful of unaccrued interests.
    /// @param id The position ID to query.
    function positionInfo(uint256 id) public view returns (uint256, uint256) {
        Position storage pos = positions[id];
        return (Goblin(pos.goblin).health(id), debtShareToVal(pos.debtShare));
    }

    /// @dev Return the total ETH entitied to the token holders.
    function totalETH() public view returns (uint256) {
        return address(this).balance.add(glbDebtVal).sub(reservePool);
    }

    /// @dev Add more ETH to Gringotts. Hope to get some good returns.
    function engorgio() external payable accrue nonReentrant {
        uint256 total = totalETH().sub(msg.value);
        uint256 share = total == 0 ? msg.value : msg.value.mul(totalSupply()).div(total);
        _mint(msg.sender, share);
        emit Deposit(msg.sender, share, msg.value);
    }

    /// @dev Withdraw ETH from Gringotts by burning the share tokens.
    function reducio(uint256 share) external accrue nonReentrant {
        uint256 amount = share.mul(totalETH()).div(totalSupply());
        _burn(msg.sender, share);
        emit Withdrawal(msg.sender, share, amount);
        msg.sender.transfer(amount);
    }

    /// @dev Create a new farming position to unlock your yield farming potential.
    /// @param id The ID of the position to unlock the earning. Use ZERO for new position.
    /// @param goblin The address of the authorized goblin to work for this position.
    /// @param loan The amount of ETH to borrow from the pool.
    /// @param maxReturn The max amount of ETH to return to the pool.
    /// @param data The calldata to pass along to the goblin for more working context.
    function alohomora(uint256 id, address goblin, uint256 loan, uint256 maxReturn, bytes calldata data)
        external payable
        onlyEOA accrue nonReentrant
    {
        // 1. Sanity check the input ID, or add a new position of ID is 0.
        if (id == 0) {
            id = nextPositionID;
            positions[id].goblin = goblin;
            positions[id].owner = msg.sender;
            nextPositionID++;
        } else {
            require(id < nextPositionID, "!position.id");
        }
        // 2.
        Position storage pos = positions[id];
        require(config.isWhiteListed(goblin), "!goblin.isWhiteListed");
        require(pos.owner == msg.sender, "!position.owner");
        require(pos.goblin == goblin, "!position.goblin");
        // 2. Compute new position debt.
        uint256 debt = _removeDebt(pos).add(loan);
        // 3. Perform the actual work.
        uint256 sendETH = msg.value.add(loan);
        require(sendETH <= address(this).balance, "!eth.sufficient");
        uint256 beforeETH = address(this).balance.sub(sendETH);
        Goblin(pos.goblin).work.value(sendETH)(id, msg.sender, debt, data);
        uint256 back = address(this).balance.sub(beforeETH);
        // 4. Update position debt.
        uint256 lessDebt = Math.min(debt, Math.min(back, maxReturn));
        debt = debt.sub(lessDebt);
        // 5. Check position health. Only applicable with nonzero debt.
        if (debt > 0) {
            require(debt >= config.minDebtSize(), "!minDebtSize");
            // TODO: Check with goblin config.
        } else {
            require(Goblin(pos.goblin).health(id) == 0, "!zero");
        }
        _addDebt(pos, debt);
        // 6. Return ETH back.
        if (back > lessDebt) SafeToken.safeTransferETH(msg.sender, back - lessDebt);
    }

    /// @dev *Avada Kedavra* Cast the killing curse to the position. Liquidate it immediately.
    /// @param id The position ID to be killed.
    function kedavra(uint256 id) external onlyEOA accrue nonReentrant {
        // 1. Verify that the position is eligible for liquidation.
        Position storage pos = positions[id];
        require(pos.debtShare > 0, "no debt");
        uint256 debt = _removeDebt(pos);
        uint256 health = Goblin(pos.goblin).health(id);
        require(health.mul(config.liquidateFactor(pos.goblin)) < debt.mul(10000), "can't liquidate");
        // 2. Perform liquidation and compute the amount of ETH received.
        uint256 beforeETH = address(this).balance;
        Goblin(pos.goblin).liquidate(id);
        uint256 back = address(this).balance.sub(beforeETH);
        uint256 prize = back.mul(config.getKedavraBps()).div(10000);
        uint256 rest = back.sub(prize);
        // 3. Clear position debt and return funds to liquidator and position owner.
        if (prize > 0) SafeToken.safeTransferETH(msg.sender, prize);
        if (rest > debt) SafeToken.safeTransferETH(pos.owner, rest - debt);
    }

    /// @dev Internal function to add the given debt value to the given position.
    function _addDebt(Position storage pos, uint256 debtVal) internal {
        uint256 debtShare = debtValToShare(debtVal);
        pos.debtShare = pos.debtShare.add(debtShare);
        glbDebtShare = glbDebtShare.add(debtShare);
        glbDebtVal = glbDebtVal.add(debtVal);
    }

    /// @dev Internal function to clear the debt of the given position. Return the debt value.
    function _removeDebt(Position storage pos) internal returns (uint256) {
        uint256 debtShare = pos.debtShare;
        uint256 debtVal = debtShareToVal(debtShare);
        pos.debtShare = 0;
        glbDebtShare = glbDebtShare.sub(debtShare);
        glbDebtVal = glbDebtVal.sub(debtVal);
        return debtVal;
    }

    /// @dev Update pool configuration to a new address. Must only be called by owner.
    /// @param _config The new configurator address.
    function updateConfig(GringottsConfig _config) external onlyOwner {
        config = _config;
    }

    /// @dev Withdraw ETH reserve for underwater positions to the given address.
    /// @param to The address to transfer ETH to.
    /// @param value The number of ETH tokens to withdraw. Must not exceed `reservePool`.
    function withdrawReserve(address to, uint256 value) external onlyOwner nonReentrant {
        reservePool = reservePool.sub(value);
        SafeToken.safeTransferETH(to, value);
    }

    /// @dev Recover ERC20 tokens that were accidentally sent to this smart contract.
    /// @param token The token contract. Can be anything. This contract should not hold ERC20 tokens.
    /// @param to The address to send the tokens to.
    /// @param value The number of tokens to transfer to `to`.
    function recover(address token, address to, uint256 value) external onlyOwner nonReentrant {
        token.safeTransfer(to, value);
    }

    /// @dev Fallback function to accept ETH. Goblins will send ETH back the pool.
    function() external payable {}
}
