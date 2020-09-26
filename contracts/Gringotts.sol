pragma solidity 0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/SafeERC20.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/SafeMath.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/Math.sol";
import "openzeppelin-solidity-2.3.0/contracts/utils/ReentrancyGuard.sol";
import "./DegenPoolConfig.sol";
import "./Worker.sol";

contract Gringotts is ERC20, ReentrancyGuard, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    struct Position {
        address worker;
        address owner;
        uint256 debtShare;
    }

    DegenPoolConfig public config;
    Position[] public positions;

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
            config.poke();
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

    constructor(DegenPoolConfig initConfig) public {
        config = initConfig;
        lastAccrueTime = now;
    }

    /// @dev Return the total ETH entitied to the token holders.
    function totalETH() public view returns (uint256) {
        return address(this).balance.add(glbDebtVal).sub(reservePool);
    }

    /// @dev Return whether the given position can be open.
    function canOpen(uint256 id) public view returns (bool) {
        require(id < positions.length, "!position.id");
        Position storage pos = positions[id];
        if (pos.debtShare == 0) {
            return true; // No debt. Healthy!
        }
        uint256 debt = pos.debtShare.mul(glbDebtVal).div(glbDebtShare);
        uint256 value = Worker(pos.worker).health(id);
        return value.mul(10000) >= debt.mul(config.openFactor(pos.worker));
    }

    /// @dev Return whether the given position can be liquidated.
    function canLiquidate(uint256 id) public view returns (bool) {
        require(id < positions.length, "!position.id");
        Position storage pos = positions[id];
        if (pos.debtShare == 0) {
            return false; // No debt. Healthy!
        }
        uint256 debt = pos.debtShare.mul(glbDebtVal).div(glbDebtShare);
        uint256 value = Worker(pos.worker).health(id);
        return value.mul(10000) < debt.mul(config.liquidateFactor(pos.worker));
    }

    /// @dev Add more ETH to the pool. Hope to get some good returns.
    function deposit() external payable accrue nonReentrant {
        uint256 total = totalETH().sub(msg.value);
        if (total == 0) {
            _mint(msg.sender, msg.value);
        } else {
            _mint(msg.sender, msg.value.mul(totalSupply()).div(total));
        }
    }

    /// @dev Withdraw ETH from the pool by burning the share tokens.
    function withdraw(uint256 share) external accrue nonReentrant {
        uint256 amount = share.mul(totalETH()).div(totalSupply());
        _burn(msg.sender, share);
        msg.sender.transfer(amount);
    }

    /// @dev Create a new farming position to unlock your yield farming potential.
    /// @param id The ID of the position to unlock the earning. Use MAX_UINT for new position.
    /// @param worker The address of the authorized worker to work for this position.
    /// @param moreDebt The amount of ETH to borrow from the pool.
    /// @param maxLessDebt The max amount of ETH to return to the pool.
    /// @param data The calldata to pass along to the worker for more working context.
    function alohomora(
        uint256 id,
        address worker,
        uint256 moreDebt,
        uint256 maxLessDebt,
        bytes calldata data
    ) external payable onlyEOA accrue nonReentrant {
        // 1. Sanity check the input values.
        if (id == uint256(-1)) {
            id = positions.length;
            positions.push(
                Position({worker: worker, owner: msg.sender, debtShare: 0})
            );
        }
        require(config.isWhiteListed(worker), "!worker.isWhiteListed");
        require(id < positions.length, "!position.id");
        Position storage pos = positions[id];
        require(pos.owner == msg.sender, "!position.owner");
        require(pos.worker == worker, "!position.worker");
        // 2. Compute new position debt.
        uint256 currentDebt = pos.debtShare == 0
            ? 0
            : pos.debtShare.mul(glbDebtVal).div(glbDebtShare);
        uint256 newDebt = currentDebt.add(moreDebt);
        // 3. Perform the actual work.
        uint256 back = Worker(pos.worker).work.value(msg.value.add(moreDebt))(
            id,
            msg.sender,
            newDebt,
            data
        );
        // 4. Update position debt.
        uint256 lessDebt = Math.min(newDebt, Math.min(back, maxLessDebt));
        newDebt = newDebt.sub(lessDebt);
        uint256 newDebtShare = glbDebtShare == 0
            ? newDebt
            : newDebt.mul(glbDebtShare).div(glbDebtShare);
        glbDebtVal = glbDebtVal.add(newDebt).sub(currentDebt);
        glbDebtShare = glbDebtShare.add(newDebtShare).sub(pos.debtShare);
        pos.debtShare = newDebtShare;
        // 5. Check position health.
        require(newDebt >= config.minDebtSize(), "!minDebtSize");
        require(canOpen(id), "!position.canOpen");
        // TODO: Check max worker debt.
        // 6. Return ETH back.
        if (back > lessDebt) {
            uint256 toSend = back - lessDebt;
            (bool backOk, ) = msg.sender.call.value(toSend)(new bytes(0));
            require(backOk, "!back.transfer");
        }
    }

    /// @dev *Avada Kedavra* Cast the killing curse to the position. Liquidate it immediately.
    /// @param id The position ID to be killed.
    function kedavra(uint256 id) external onlyEOA accrue nonReentrant {
        require(id < positions.length, "!position.id");
        Position storage pos = positions[id];
        Worker(pos.worker).reinvest();
        require(canLiquidate(id), "!position.canLiquidate");
        uint256 wad = Worker(pos.worker).liquidate(id);
        uint256 prize = wad.mul(config.getKedavraBps()).div(10000);
        uint256 rest = wad.sub(prize);
        uint256 debt = pos.debtShare.mul(glbDebtVal).div(glbDebtShare);
        uint256 remain = rest > debt ? rest.sub(debt) : 0;
        glbDebtVal = glbDebtVal.sub(debt);
        glbDebtShare = glbDebtShare.sub(pos.debtShare);
        pos.debtShare = 0;
        if (prize > 0) {
            (bool prizeOk, ) = msg.sender.call.value(prize)(new bytes(0));
            require(prizeOk, "!prize.transfer");
        }
        if (remain > 0) {
            (bool remainOk, ) = msg.sender.call.value(remain)(new bytes(0));
            require(remainOk, "!remain.transfer");
        }
    }

    /// @dev Update pool configuration to a new address. Must only be called by owner.
    /// @param _config The new configurator address.
    function updateConfig(DegenPoolConfig _config) external onlyOwner {
        config = _config;
    }

    /// @dev Withdraw ETH reserve for underwater positions to the given address.
    /// @param to The address to transfer ETH to.
    /// @param amount The number of ETH tokens to withdraw. Must not exceed `reservePool`.
    function withdrawReserve(address to, uint256 amount) external onlyOwner nonReentrant {
        reservePool = reservePool.sub(amount);
        (bool remainOk, ) = to.call.value(amount)(new bytes(0));
        require(remainOk, "!reserve.transfer");
    }

    /// @dev Recover ERC20 tokens that were accidentally sent to this smart contract.
    /// @param token The token contract. Must not be this contract or otherwise owner can steal.
    /// @param to The address to send the tokens to.
    /// @param value The number of tokens to transfer to `to`.
    function recover(IERC20 token, address to, uint256 value) external onlyOwner nonReentrant {
        require(address(token) != address(this), "!recover");
        token.safeTransfer(to, value);
    }

    /// @dev Fallback function to accept ETH. Workers will send ETH back the pool.
    function() external payable {}
}
