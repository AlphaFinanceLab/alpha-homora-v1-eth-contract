pragma solidity 0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "openzeppelin-solidity-2.3.0/contracts/utils/ReentrancyGuard.sol";
import "synthetix/contracts/interfaces/IStakingRewards.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/libraries/Math.sol";
import "./uniswap/IUniswapV2Router02.sol";
import "./uniswap/UniswapV2Library.sol";
import "./strategy/Strategy.sol";
import "./SafeToken.sol";
import "./Goblin.sol";

contract UniswapGoblin is Ownable, ReentrancyGuard, Goblin {
    using SafeToken for address;
    using SafeMath for uint256;

    IStakingRewards public staking;
    IUniswapV2Factory public factory;
    IUniswapV2Router02 public router;
    IUniswapV2Pair public lpToken;
    address public weth;
    address public fToken;
    address public uni;
    address public operator;

    Strategy addStrat;
    Strategy liqStrat;

    mapping(uint256 => uint256) shares;
    mapping(address => bool) approvedStrat;
    uint256 public totalShare;

    constructor(
        address _operator,
        IStakingRewards _staking,
        IUniswapV2Router02 _router,
        address _fToken,
        address _uni,
        Strategy _addStrat,
        Strategy _liqStrat
    ) public {
        operator = _operator;
        weth = _router.WETH();
        staking = _staking;
        router = _router;
        factory = IUniswapV2Factory(_router.factory());
        lpToken = IUniswapV2Pair(factory.getPair(weth, _fToken));
        fToken = _fToken;
        uni = _uni;
        addStrat = _addStrat;
        liqStrat = _liqStrat;
        lpToken.approve(address(_staking), uint256(-1)); // 100% trust in the staking pool
        lpToken.approve(address(router), uint256(-1)); // 100% trust in the router
        _fToken.safeApprove(address(router), uint256(-1)); // 100% trust in the router
        _uni.safeApprove(address(router), uint256(-1)); // 100% trust in the router
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "!operator");
        _;
    }

    /// @dev Return the entitied LP token balance for the given shares.
    /// @param share The number of shares to be converted to LP balance.
    function shareToBalance(uint256 share) public view returns (uint256) {
        uint256 totalBalance = staking.balanceOf(address(this));
        return share.mul(totalBalance).div(totalShare);
    }

    /// @dev Return the number of shares to receive if staking the given LP tokens.
    /// @param balance the number of LP tokens to be converted to shares.
    function balanceToShare(uint256 balance) public view returns (uint256) {
        if (totalShare == 0) {
            return balance;
        }
        uint256 totalBalance = staking.balanceOf(address(this));
        return balance.mul(totalShare).div(totalBalance);
    }

    /// @dev Re-invest whatever this worker has earned back to staked LP tokens.
    function reinvest() public {
        // 1. Withdraw all the rewards.
        staking.getReward();
        uint256 rewardBalance = uni.myBalance();
        if (rewardBalance == 0) return;
        // 2. Convert all the rewards to ETH.
        address[] memory path = new address[](2);
        path[0] = address(uni);
        path[1] = address(weth);
        router.swapExactTokensForETH(rewardBalance, 0, path, address(this), now);
        // 3. Use add ETH strategy to convert all ETH to LP tokens.
        addStrat.execute.value(address(this).balance)(address(0), 0, abi.encode(fToken, 0));
        // 4. Mint more LP tokens and stake them for more rewards.
        staking.stake(lpToken.balanceOf(address(this)));
    }

    /// @dev Work on the given position. Must be called by the operator.
    /// @param id The position ID to work on.
    /// @param user The original user that is interacting with the operator.
    /// @param debt The amount of user debt to help the strategy make decisions.
    /// @param data The encoded data, consisting of strategy address and calldata.
    function work(uint256 id, address user, uint256 debt, bytes calldata data)
        external
        payable
        onlyOperator
        nonReentrant
        returns (uint256)
    {
        // 1. Convert this position back to LP tokens.
        _removeShare(id);
        // 2. Perform the worker strategy; sending LP tokens + ETH; expecting LP tokens + ETH.
        (address strat, bytes memory ext) = abi.decode(data, (address, bytes));
        lpToken.transfer(strat, lpToken.balanceOf(address(this)));
        Strategy(strat).execute.value(msg.value)(user, debt, ext);
        // 3. Add LP tokens back to the farming pool.
        _addShare(id);
        // 4. Return any remaining ETH back to the operator.
        uint256 balance = address(this).balance;
        SafeToken.safeTransferETH(msg.sender, balance);
        return balance;
    }

    /// @dev Return the amount of ETH to receive if we are to liquidate the given position.
    /// @param id The position ID to perform health check.
    function health(uint256 id) external view returns (uint256) {
        // 1. Get the position's and total LP token balances.
        uint256 lpBalance = shareToBalance(shares[id]);
        uint256 lpSupply = lpToken.totalSupply();
        if (factory.feeTo() != address(0)) {
            uint256 kLast = lpToken.kLast();
            if (kLast != 0) {
                (uint256 reserve0, uint256 reserve1, ) = lpToken.getReserves();
                uint256 rootK = Math.sqrt(reserve0.mul(reserve1));
                uint256 rootKLast = Math.sqrt(kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = lpSupply.mul(rootK.sub(rootKLast));
                    uint256 denominator = rootK.mul(5).add(rootKLast);
                    lpSupply = lpSupply.add(numerator / denominator);
                }
            }
        }
        // 2. Get the pool's total supply of ETH and farming token.
        uint256 totalWETH = weth.balanceOf(address(lpToken));
        uint256 totalFarming = fToken.balanceOf(address(lpToken));
        // 3. Convert the position's LP tokens to the underlying assets.
        uint256 userWETH = lpBalance.mul(totalWETH).div(lpSupply);
        uint256 userFarming = lpBalance.mul(totalFarming).div(lpSupply);
        // 4. Convert all farming tokens to ETH and return total ETH.
        uint256 userMoreWETH = UniswapV2Library.getAmountOut(
            userFarming, totalFarming.sub(userFarming), totalWETH.sub(userWETH)
        );
        return userWETH.add(userMoreWETH);
    }

    /// @dev Liquidate the given position by converting it to ETH and return back to caller.
    /// @param id The position ID to perform liquidation
    function liquidate(uint256 id) external onlyOperator nonReentrant returns (uint256) {
        // 1. Convert the position back to LP tokens and use liquidate strategy.
        _removeShare(id);
        lpToken.transfer(address(liqStrat), lpToken.balanceOf(address(this)));
        liqStrat.execute(address(0), 0, abi.encode(fToken));
        // 2. Return all available ETH back to the operator.
        uint256 balance = address(this).balance;
        SafeToken.safeTransferETH(msg.sender, balance);
        return balance;
    }

    /// @dev Internal function to stake all outstanding LP tokens to the given position ID.
    function _addShare(uint256 id) internal {
        uint256 balance = lpToken.balanceOf(address(this));
        uint256 share = balanceToShare(balance);
        staking.stake(balance);
        shares[id] = shares[id].add(share);
        totalShare = totalShare.add(share);
    }

    /// @dev Internal function to remove shares of the ID and convert to outstanding LP tokens.
    function _removeShare(uint256 id) internal {
        uint256 share = shares[id];
        if (share > 0) {
            uint256 balance = shareToBalance(share);
            staking.withdraw(balance);
            totalShare = totalShare.sub(share);
            shares[id] = 0;
        }
    }

    /// @dev Recover ERC20 tokens that were accidentally sent to this smart contract.
    /// @param token The token contract. Can be anything. This contract should not hold ERC20 tokens.
    /// @param to The address to send the tokens to.
    /// @param value The number of tokens to transfer to `to`.
    function recover(address token, address to, uint256 value) external onlyOwner nonReentrant {
        token.safeTransfer(to, value);
    }

    function() external payable {}
}
