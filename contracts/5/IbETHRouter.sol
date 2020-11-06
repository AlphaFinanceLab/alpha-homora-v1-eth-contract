pragma solidity =0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/IERC20.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/SafeMath.sol";
import "./uniswap/UniswapV2Library.sol";
import "./Bank.sol";

// helper methods for interacting with ERC20 tokens and sending ETH that do not consistently return true/false
library TransferHelper {
    function safeApprove(
        address token,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('approve(address,uint256)')));
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x095ea7b3, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferHelper: APPROVE_FAILED"
        );
    }

    function safeTransfer(
        address token,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferHelper: TRANSFER_FAILED"
        );
    }

    function safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferHelper: TRANSFER_FROM_FAILED"
        );
    }

    function safeTransferETH(address to, uint256 value) internal {
        (bool success, ) = to.call.value(value)(new bytes(0));
        require(success, "TransferHelper: ETH_TRANSFER_FAILED");
    }
}

// IbETHRouter modifies UniswapV2Router02 to use AlphaHomora's ibETH, instead of WETH
contract IbETHRouter {
    using SafeMath for uint256;

    address public factory;
    address payable ibETH; // usd ibETH, instead of WETH

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "IbETHRouter: EXPIRED");
        _;
    }
    
    constructor(address _factory, address payable _ibETH) public {
        factory = _factory;
        ibETH = _ibETH;
    }

    function() external payable {
        assert(msg.sender == ibETH); // only accept ETH via fallback from the Bank contract
    }

    // **** ETH-ibETH FUNCTIONS ****
    // Get number of ibETH received for the amouthETH send to Bank
    function ETHToIbETH(uint256 amountETH) public view returns (uint256) {
        uint256 totalETH = Bank(ibETH).totalETH();        
        return totalETH == 0 ? amountETH : amountETH.mul(Bank(ibETH).totalSupply()).div(totalETH); 
    } 

    // Get exact number of ETH needed to deposit to get amountIbETH from the Bank
    // Note: Round up the amount of ETH needed, to be used with Bank.deposit
    function IbETHToExactETH(uint256 amountIbETH) public view returns (uint256) {
        uint256 totalSupply = Bank(ibETH).totalSupply();         
        return totalSupply == 0? amountIbETH : amountIbETH.mul(Bank(ibETH).totalETH()).add(totalSupply).sub(1).div(totalSupply);                   
    } 

    // Get exact number of ETH received when withdraw amountIbETH from the Bank    
    // Note: Round down the amount of ETH received, to be used with Bank.withdraw
    function ExactIbETHToETH(uint256 amountIbETH) public view returns (uint256) {
        uint256 totalSupply = Bank(ibETH).totalSupply();         
        return totalSupply == 0? amountIbETH : amountIbETH.mul(Bank(ibETH).totalETH()).div(totalSupply);                   
    } 

    // **** ADD LIQUIDITY **** (UNCHANGED)
    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal returns (uint256 amountA, uint256 amountB) {
        // create the pair if it doesn't exist yet
        if (IUniswapV2Factory(factory).getPair(tokenA, tokenB) == address(0)) {
            IUniswapV2Factory(factory).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = UniswapV2Library.getReserves(
            factory,
            tokenA,
            tokenB
        );
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = UniswapV2Library.quote(
                amountADesired,
                reserveA,
                reserveB
            );
            if (amountBOptimal <= amountBDesired) {
                require(
                    amountBOptimal >= amountBMin,
                    "IbETHRouter: INSUFFICIENT_B_AMOUNT"
                );
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = UniswapV2Library.quote(
                    amountBDesired,
                    reserveB,
                    reserveA
                );
                assert(amountAOptimal <= amountADesired);
                require(
                    amountAOptimal >= amountAMin,
                    "IbETHRouter: INSUFFICIENT_A_AMOUNT"
                );
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    // (UNCHANGED)
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        external
        ensure(deadline)
        returns (
            uint256 amountA,
            uint256 amountB,
            uint256 liquidity
        )
    {
        (amountA, amountB) = _addLiquidity(
            tokenA,
            tokenB,
            amountADesired,
            amountBDesired,
            amountAMin,
            amountBMin
        );
        address pair = UniswapV2Library.pairFor(factory, tokenA, tokenB);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IUniswapV2Pair(pair).mint(to);
    }

    // Add ETH and Token to ibETH-Token pool.
    // 1. Receive ETH and Token from caller
    // 2. Wrap ETH to ibETH.
    // 3. Add ETH and Token to the pool.
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountIbETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        ensure(deadline)
        returns (
            uint256 amountToken,
            uint256 amountIbETH,
            uint256 liquidity
        )
    {                        
        (amountToken, amountIbETH) = _addLiquidity(
            token,
            ibETH,
            amountTokenDesired,
            ETHToIbETH(msg.value),
            amountTokenMin,            
            amountIbETHMin
        );        
        address pair = UniswapV2Library.pairFor(factory, token, ibETH);        
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);                        
        uint256 amountETH = IbETHToExactETH(amountIbETH);        
        Bank(ibETH).deposit.value(amountETH)();          
        assert(Bank(ibETH).transfer(pair, amountIbETH));        
        liquidity = IUniswapV2Pair(pair).mint(to);
        // refund dust eth, if any
        if (msg.value > amountETH) {            
            TransferHelper.safeTransferETH(msg.sender, msg.value - amountETH);
        }            
    }

    // **** REMOVE LIQUIDITY **** (UNCHANGED)
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = UniswapV2Library.pairFor(factory, tokenA, tokenB);
        IUniswapV2Pair(pair).transferFrom(msg.sender, pair, liquidity); // send liquidity to pair
        (uint256 amount0, uint256 amount1) = IUniswapV2Pair(pair).burn(to);
        (address token0, ) = UniswapV2Library.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0
            ? (amount0, amount1)
            : (amount1, amount0);
        require(
            amountA >= amountAMin,
            "IbETHRouter: INSUFFICIENT_A_AMOUNT"
        );
        require(
            amountB >= amountBMin,
            "IbETHRouter: INSUFFICIENT_B_AMOUNT"
        );
    }
    
    // Remove ETH and Token from ibETH-Token Pool.
    // 1. Remove ibETH and Token from the pool.
    // 2. Unwrap ibETH to ETH.
    // 3. Return ETH and Token to caller.
    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountIbETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountToken, uint256 amountIbETH) {                
        (amountToken, amountIbETH) = removeLiquidity(
            token,
            ibETH,
            liquidity,
            amountTokenMin,
            amountIbETHMin,
            address(this),
            deadline
        );        
        TransferHelper.safeTransfer(token, to, amountToken);                
        Bank(ibETH).withdraw(amountIbETH);        
        TransferHelper.safeTransferETH(to, ExactIbETHToETH(amountIbETH));
    }

    // (UNCHANGED)
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        address pair = UniswapV2Library.pairFor(factory, tokenA, tokenB);
        uint256 value = approveMax ? uint256(-1) : liquidity;
        IUniswapV2Pair(pair).permit(
            msg.sender,
            address(this),
            value,
            deadline,
            v,
            r,
            s
        );
        (amountA, amountB) = removeLiquidity(
            tokenA,
            tokenB,
            liquidity,
            amountAMin,
            amountBMin,
            to,
            deadline
        );
    }
    
    // Same as removeLiquidityETH, just with permit.
    function removeLiquidityETHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountIbETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountToken, uint256 amountIbETH) {        
        address pair = UniswapV2Library.pairFor(factory, token, ibETH);
        uint256 value = approveMax ? uint256(-1) : liquidity;
        IUniswapV2Pair(pair).permit(
            msg.sender,
            address(this),
            value,
            deadline,
            v,
            r,
            s
        );
        (amountToken, amountIbETH) = removeLiquidityETH(
            token,
            liquidity,
            amountTokenMin,
            amountIbETHMin,
            to,
            deadline
        );
    }

    // **** REMOVE LIQUIDITY (supporting fee-on-transfer tokens) ****
    // Remove ETH and Token from ibETH-Token Pool.    
    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountIbETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountIbETH) {
        (, amountIbETH) = removeLiquidity(
            token,
            ibETH,
            liquidity,
            amountTokenMin,
            amountIbETHMin,
            address(this),
            deadline
        );        
        TransferHelper.safeTransfer(
            token,
            to,
            IERC20(token).balanceOf(address(this))
        );        
        Bank(ibETH).withdraw(amountIbETH);
        TransferHelper.safeTransferETH(to, ExactIbETHToETH(amountIbETH));
    }
    
    // Same as removeLiquidityETHSupportingFeeOnTransferTokens, just with permit.
    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountIbETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountIbETH) {
        address pair = UniswapV2Library.pairFor(factory, token, ibETH);
        uint256 value = approveMax ? uint256(-1) : liquidity;
        IUniswapV2Pair(pair).permit(
            msg.sender,
            address(this),
            value,
            deadline,
            v,
            r,
            s
        );
        amountIbETH = removeLiquidityETHSupportingFeeOnTransferTokens(
            token,
            liquidity,
            amountTokenMin,
            amountIbETHMin,
            to,
            deadline
        );
    }

    // **** SWAP **** (UNCHANGED)
    // requires the initial amount to have already been sent to the first pair
    function _swap(
        uint256[] memory amounts,
        address[] memory path,
        address _to
    ) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = UniswapV2Library.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));
            address to = i < path.length - 2
                ? UniswapV2Library.pairFor(factory, output, path[i + 2])
                : _to;
            IUniswapV2Pair(UniswapV2Library.pairFor(factory, input, output))
                .swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    // (UNCHANGED)
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = UniswapV2Library.getAmountsOut(factory, amountIn, path);
        require(
            amounts[amounts.length - 1] >= amountOutMin,
            "IbETHRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );
        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amounts[0]
        );
        _swap(amounts, path, to);
    }

    // (UNCHANGED)
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = UniswapV2Library.getAmountsIn(factory, amountOut, path);
        require(
            amounts[0] <= amountInMax,
            "IbETHRouter: EXCESSIVE_INPUT_AMOUNT"
        );
        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amounts[0]
        );
        _swap(amounts, path, to);
    }

    // Swap exact amount of ETH for Token
    // 1. Receive ETH from caller
    // 2. Wrap ETH to ibETH.
    // 3. Swap ibETH for Token    
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {                
        require(path[0] == ibETH, "IbETHRouter: INVALID_PATH");
        amounts = UniswapV2Library.getAmountsOut(factory, ETHToIbETH(msg.value), path);        
        require(
            amounts[amounts.length - 1] >= amountOutMin,
            "IbETHRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );        
        Bank(ibETH).deposit.value(msg.value)();        
        assert(
            Bank(ibETH).transfer(
                UniswapV2Library.pairFor(factory, path[0], path[1]),
                amounts[0]
            )
        );
        _swap(amounts, path, to);
    }

    // Swap Token for exact amount of ETH
    // 1. Receive Token from caller
    // 2. Swap Token for ibETH.
    // 3. Unwrap ibETH to ETH.
    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == ibETH, "IbETHRouter: INVALID_PATH");        
        amounts = UniswapV2Library.getAmountsIn(factory, ETHToIbETH(amountOut), path);        
        require(
            amounts[0] <= amountInMax,
            "IbETHRouter: EXCESSIVE_INPUT_AMOUNT"
        );
        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amounts[0]
        );
        _swap(amounts, path, address(this));  
        uint256 amountIbETH = amounts[amounts.length - 1];      
        Bank(ibETH).withdraw(amountIbETH);        
        TransferHelper.safeTransferETH(to, ExactIbETHToETH(amountIbETH));
    }

    // Swap exact amount of Token for ETH
    // 1. Receive Token from caller
    // 2. Swap Token for ibETH.
    // 3. Unwrap ibETH to ETH.
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == ibETH, "IbETHRouter: INVALID_PATH");
        amounts = UniswapV2Library.getAmountsOut(factory, amountIn, path);
        require(
            amounts[amounts.length - 1] >= amountOutMin,
            "IbETHRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );        
        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amounts[0]
        );
        _swap(amounts, path, address(this));
        uint256 amountIbETH = amounts[amounts.length - 1];        
        Bank(ibETH).withdraw(amountIbETH);        
        TransferHelper.safeTransferETH(to, ExactIbETHToETH(amountIbETH));
    }

    // Swap ETH for exact amount of Token
    // 1. Receive ETH from caller
    // 2. Wrap ETH to ibETH.
    // 3. Swap ibETH for Token    
    function swapETHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == ibETH, "IbETHRouter: INVALID_PATH");
        amounts = UniswapV2Library.getAmountsIn(factory, amountOut, path);
        require(
            amounts[0] <= msg.value,
            "IbETHRouter: EXCESSIVE_INPUT_AMOUNT"
        );                
        uint256 amountETH = IbETHToExactETH(amounts[0]);         
        Bank(ibETH).deposit.value(amountETH)();            
        assert(
            Bank(ibETH).transfer(
                UniswapV2Library.pairFor(factory, path[0], path[1]),
                amounts[0]
            )
        );
        _swap(amounts, path, to);
        // refund dust eth, if any
        if (msg.value > amounts[0])
            TransferHelper.safeTransferETH(msg.sender, msg.value - amountETH);
    }

    // **** SWAP (supporting fee-on-transfer tokens) **** (UNCHANGED)
    // requires the initial amount to have already been sent to the first pair
    function _swapSupportingFeeOnTransferTokens(
        address[] memory path,
        address _to
    ) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = UniswapV2Library.sortTokens(input, output);
            IUniswapV2Pair pair = IUniswapV2Pair(
                UniswapV2Library.pairFor(factory, input, output)
            );
            uint256 amountInput;
            uint256 amountOutput;
            {
                // scope to avoid stack too deep errors
                (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) = input == token0
                    ? (reserve0, reserve1)
                    : (reserve1, reserve0);
                amountInput = IERC20(input).balanceOf(address(pair)).sub(
                    reserveInput
                );
                amountOutput = UniswapV2Library.getAmountOut(
                    amountInput,
                    reserveInput,
                    reserveOutput
                );
            }
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOutput)
                : (amountOutput, uint256(0));
            address to = i < path.length - 2
                ? UniswapV2Library.pairFor(factory, output, path[i + 2])
                : _to;
            pair.swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    // (UNCHANGED)
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amountIn
        );
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20(path[path.length - 1]).balanceOf(to).sub(balanceBefore) >=
                amountOutMin,
            "IbETHRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    // Same as swapExactETHForTokens, just with supporting fee on transfer.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) {
        require(path[0] == ibETH, "IbETHRouter: INVALID_PATH");
        uint256 amountIn = msg.value;                
        Bank(ibETH).deposit.value(amountIn)();        
        assert(
            Bank(ibETH).transfer(
                UniswapV2Library.pairFor(factory, path[0], path[1]),
                ETHToIbETH(amountIn)
            )
        );
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);        
        require(
            IERC20(path[path.length - 1]).balanceOf(to).sub(balanceBefore) >=
                amountOutMin,
            "IbETHRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    // Same as swapExactTokensForETH, just with supporting fee on transfer.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        require(path[path.length - 1] == ibETH, "IbETHRouter: INVALID_PATH");
        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amountIn
        );
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = Bank(ibETH).balanceOf(address(this));
        require(
            amountOut >= amountOutMin,
            "IbETHRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );                
        Bank(ibETH).withdraw(amountOut);        
        TransferHelper.safeTransferETH(to, ExactIbETHToETH(amountOut));        
    }    

    // **** LIBRARY FUNCTIONS **** (UNCHANGED)
    function quote(
        uint256 amountA,
        uint256 reserveA,
        uint256 reserveB
    ) public pure returns (uint256 amountB) {
        return UniswapV2Library.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        return UniswapV2Library.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountIn) {
        return UniswapV2Library.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] memory path)
        public
        view
        returns (uint256[] memory amounts)
    {
        return UniswapV2Library.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] memory path)
        public
        view
        returns (uint256[] memory amounts)
    {
        return UniswapV2Library.getAmountsIn(factory, amountOut, path);
    }
}
