pragma solidity =0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v2-core/contracts/libraries/Math.sol";
import "./uniswap/UniswapV2Library.sol";
import "./uniswap/IUniswapV2Router02.sol";
import "./interfaces/IBank.sol";

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

contract IbETHRouter is Ownable {
    using SafeMath for uint256;

    address public router;
    address public ibETH; 
    address public alpha;     
    address public lpToken;     

    constructor(address _router, address _ibETH, address _alpha) public {
        router = _router;
        ibETH = _ibETH;   
        alpha = _alpha;                             
        address factory = IUniswapV2Router02(router).factory();   
        lpToken = UniswapV2Library.pairFor(factory, ibETH, alpha);                  
        IUniswapV2Pair(lpToken).approve(router, uint256(-1)); // 100% trust in the router        
        IBank(ibETH).approve(router, uint256(-1)); // 100% trust in the router        
        IERC20(alpha).approve(router, uint256(-1)); // 100% trust in the router        
    }

    function() external payable {
        assert(msg.sender == ibETH); // only accept ETH via fallback from the Bank contract
    }

    // **** ETH-ibETH FUNCTIONS ****
    // Get number of ibETH needed to withdraw to get exact amountETH from the Bank
    function ibETHForExactETH(uint256 amountETH) public view returns (uint256) {
        uint256 totalETH = IBank(ibETH).totalETH();        
        return totalETH == 0 ? amountETH : amountETH.mul(IBank(ibETH).totalSupply()).add(totalETH).sub(1).div(totalETH); 
    }   
    
    // Add ETH and Alpha from ibETH-Alpha Pool.
    // 1. Receive ETH and Alpha from caller.
    // 2. Wrap ETH to ibETH.
    // 3. Provide liquidity to the pool.
    function addLiquidityETH(        
        uint256 amountAlphaDesired,
        uint256 amountAlphaMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable        
        returns (
            uint256 amountAlpha,
            uint256 amountETH,
            uint256 liquidity
        ) {                
        TransferHelper.safeTransferFrom(alpha, msg.sender, address(this), amountAlphaDesired);
        IBank(ibETH).deposit.value(msg.value)();   
        uint256 amountIbETHDesired = IBank(ibETH).balanceOf(address(this)); 
        uint256 amountIbETH;
        (amountAlpha, amountIbETH, liquidity) = IUniswapV2Router02(router).addLiquidity(
            alpha,
            ibETH,
            amountAlphaDesired,            
            amountIbETHDesired,
            amountAlphaMin,            
            0,
            to,
            deadline
        );         
        if (amountAlphaDesired > amountAlpha) {
            TransferHelper.safeTransfer(alpha, msg.sender, amountAlphaDesired.sub(amountAlpha));
        }                       
        IBank(ibETH).withdraw(amountIbETHDesired.sub(amountIbETH));        
        amountETH = msg.value - address(this).balance;
        if (amountETH > 0) {
            TransferHelper.safeTransferETH(msg.sender, address(this).balance);
        }
        require(amountETH >= amountETHMin, "IbETHRouter: require more ETH than amountETHmin");
    }

    /// @dev Compute optimal deposit amount
    /// @param amtA amount of token A desired to deposit
    /// @param amtB amonut of token B desired to deposit
    /// @param resA amount of token A in reserve
    /// @param resB amount of token B in reserve
    /// (forked from ./StrategyAddTwoSidesOptimal.sol)
    function optimalDeposit(
        uint256 amtA,
        uint256 amtB,
        uint256 resA,
        uint256 resB
    ) internal pure returns (uint256 swapAmt, bool isReversed) {
        if (amtA.mul(resB) >= amtB.mul(resA)) {
            swapAmt = _optimalDepositA(amtA, amtB, resA, resB);
            isReversed = false;
        } else {
            swapAmt = _optimalDepositA(amtB, amtA, resB, resA);
            isReversed = true;
        }
    }

    /// @dev Compute optimal deposit amount helper
    /// @param amtA amount of token A desired to deposit
    /// @param amtB amonut of token B desired to deposit
    /// @param resA amount of token A in reserve
    /// @param resB amount of token B in reserve
    /// (forked from ./StrategyAddTwoSidesOptimal.sol)
    function _optimalDepositA(
        uint256 amtA,
        uint256 amtB,
        uint256 resA,
        uint256 resB
    ) internal pure returns (uint256) {
        require(amtA.mul(resB) >= amtB.mul(resA), "Reversed");

        uint256 a = 997;
        uint256 b = uint256(1997).mul(resA);
        uint256 _c = (amtA.mul(resB)).sub(amtB.mul(resA));
        uint256 c = _c.mul(1000).div(amtB.add(resB)).mul(resA);

        uint256 d = a.mul(c).mul(4);
        uint256 e = Math.sqrt(b.mul(b).add(d));

        uint256 numerator = e.sub(b);
        uint256 denominator = a.mul(2);

        return numerator.div(denominator);
    }

    // Add ibETH and Alpha to ibETH-Alpha Pool.
    // All ibETH and Alpha supplied are optimally swap and add too ibETH-Alpha Pool.
    function addLiquidityTwoSidesOptimal(        
        uint256 amountIbETHDesired,        
        uint256 amountAlphaDesired,        
        uint256 amountLPMin,
        address to,
        uint256 deadline
    )
        external        
        returns (            
            uint256 liquidity
        ) {        
        if (amountIbETHDesired > 0) {
            TransferHelper.safeTransferFrom(ibETH, msg.sender, address(this), amountIbETHDesired);    
        }
        if (amountAlphaDesired > 0) {
            TransferHelper.safeTransferFrom(alpha, msg.sender, address(this), amountAlphaDesired);    
        }        
        uint256 swapAmt;
        bool isReversed;
        {
            (uint256 r0, uint256 r1, ) = IUniswapV2Pair(lpToken).getReserves();
            (uint256 ibETHReserve, uint256 alphaReserve) = IUniswapV2Pair(lpToken).token0() == ibETH ? (r0, r1) : (r1, r0);
            (swapAmt, isReversed) = optimalDeposit(amountIbETHDesired, amountAlphaDesired, ibETHReserve, alphaReserve);
        }
        address[] memory path = new address[](2);
        (path[0], path[1]) = isReversed ? (alpha, ibETH) : (ibETH, alpha);        
        IUniswapV2Router02(router).swapExactTokensForTokens(swapAmt, 0, path, address(this), now);                
        (,, liquidity) = IUniswapV2Router02(router).addLiquidity(
            alpha,
            ibETH,
            IERC20(alpha).balanceOf(address(this)),            
            IBank(ibETH).balanceOf(address(this)),
            0,            
            0,
            to,
            deadline
        );        
        uint256 dustAlpha = IERC20(alpha).balanceOf(address(this));
        uint256 dustIbETH = IBank(ibETH).balanceOf(address(this));
        if (dustAlpha > 0) {
            TransferHelper.safeTransfer(alpha, msg.sender, dustAlpha);
        }    
        if (dustIbETH > 0) {
            TransferHelper.safeTransfer(ibETH, msg.sender, dustIbETH);
        }                    
        require(liquidity >= amountLPMin, "IbETHRouter: receive less lpToken than amountLPMin");
    }

    // Add ETH and Alpha to ibETH-Alpha Pool.
    // All ETH and Alpha supplied are optimally swap and add too ibETH-Alpha Pool.
    function addLiquidityTwoSidesOptimalETH(                
        uint256 amountAlphaDesired,        
        uint256 amountLPMin,
        address to,
        uint256 deadline
    )
        external
        payable        
        returns (            
            uint256 liquidity
        ) {                
        if (amountAlphaDesired > 0) {
            TransferHelper.safeTransferFrom(alpha, msg.sender, address(this), amountAlphaDesired);    
        }       
        IBank(ibETH).deposit.value(msg.value)();   
        uint256 amountIbETHDesired = IBank(ibETH).balanceOf(address(this));                  
        uint256 swapAmt;
        bool isReversed;
        {
            (uint256 r0, uint256 r1, ) = IUniswapV2Pair(lpToken).getReserves();
            (uint256 ibETHReserve, uint256 alphaReserve) = IUniswapV2Pair(lpToken).token0() == ibETH ? (r0, r1) : (r1, r0);
            (swapAmt, isReversed) = optimalDeposit(amountIbETHDesired, amountAlphaDesired, ibETHReserve, alphaReserve);
        }        
        address[] memory path = new address[](2);
        (path[0], path[1]) = isReversed ? (alpha, ibETH) : (ibETH, alpha);        
        IUniswapV2Router02(router).swapExactTokensForTokens(swapAmt, 0, path, address(this), now);                
        (,, liquidity) = IUniswapV2Router02(router).addLiquidity(
            alpha,
            ibETH,
            IERC20(alpha).balanceOf(address(this)),            
            IBank(ibETH).balanceOf(address(this)),
            0,            
            0,
            to,
            deadline
        );        
        uint256 dustAlpha = IERC20(alpha).balanceOf(address(this));
        uint256 dustIbETH = IBank(ibETH).balanceOf(address(this));
        if (dustAlpha > 0) {
            TransferHelper.safeTransfer(alpha, msg.sender, dustAlpha);
        }    
        if (dustIbETH > 0) {
            TransferHelper.safeTransfer(ibETH, msg.sender, dustIbETH);
        }                    
        require(liquidity >= amountLPMin, "IbETHRouter: receive less lpToken than amountLPMin");
    }
      
    // Remove ETH and Alpha from ibETH-Alpha Pool.
    // 1. Remove ibETH and Alpha from the pool.
    // 2. Unwrap ibETH to ETH.
    // 3. Return ETH and Alpha to caller.
    function removeLiquidityETH(        
        uint256 liquidity,
        uint256 amountAlphaMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public returns (uint256 amountAlpha, uint256 amountETH) {                  
        TransferHelper.safeTransferFrom(lpToken, msg.sender, address(this), liquidity);          
        uint256 amountIbETH;
        (amountAlpha, amountIbETH) = IUniswapV2Router02(router).removeLiquidity(
            alpha,
            ibETH,
            liquidity,
            amountAlphaMin,
            0,
            address(this),
            deadline
        );                        
        TransferHelper.safeTransfer(alpha, to, amountAlpha); 
        IBank(ibETH).withdraw(amountIbETH);        
        amountETH = address(this).balance;
        if (amountETH > 0) {
            TransferHelper.safeTransferETH(msg.sender, address(this).balance);
        }
        require(amountETH >= amountETHMin, "IbETHRouter: receive less ETH than amountETHmin");                               
    }

    // Remove liquidity from ibETH-Alpha Pool and convert all ibETH to Alpha 
    // 1. Remove ibETH and Alpha from the pool.
    // 2. Swap ibETH for Alpha.
    // 3. Return Alpha to caller.   
    function removeLiquidityAllAlpha(        
        uint256 liquidity,
        uint256 amountAlphaMin,        
        address to,
        uint256 deadline
    ) public returns (uint256 amountAlpha) {                  
        TransferHelper.safeTransferFrom(lpToken, msg.sender, address(this), liquidity);          
        (uint256 removeAmountAlpha, uint256 removeAmountIbETH) = IUniswapV2Router02(router).removeLiquidity(
            alpha,
            ibETH,
            liquidity,
            0,
            0,
            address(this),
            deadline
        );        
        address[] memory path = new address[](2);
        path[0] = ibETH;
        path[1] = alpha;
        uint256[] memory amounts = IUniswapV2Router02(router).swapExactTokensForTokens(removeAmountIbETH, 0, path, to, deadline);               
        TransferHelper.safeTransfer(alpha, to, removeAmountAlpha);                        
        amountAlpha = removeAmountAlpha.add(amounts[1]);
        require(amountAlpha >= amountAlphaMin, "IbETHRouter: receive less Alpha than amountAlphaMin");                               
    }       

    // Swap exact amount of ETH for Token
    // 1. Receive ETH from caller
    // 2. Wrap ETH to ibETH.
    // 3. Swap ibETH for Token    
    function swapExactETHForAlpha(
        uint256 amountAlphaOutMin,        
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {                           
        IBank(ibETH).deposit.value(msg.value)();   
        address[] memory path = new address[](2);
        path[0] = ibETH;
        path[1] = alpha;     
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapExactTokensForTokens(IBank(ibETH).balanceOf(address(this)), amountAlphaOutMin, path, to, deadline);
        amounts = new uint256[](2);        
        amounts[0] = msg.value;
        amounts[1] = swapAmounts[1];
    }

    // Swap Token for exact amount of ETH
    // 1. Receive Token from caller
    // 2. Swap Token for ibETH.
    // 3. Unwrap ibETH to ETH.
    function swapAlphaForExactETH(
        uint256 amountETHOut,
        uint256 amountAlphaInMax,         
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        TransferHelper.safeTransferFrom(alpha, msg.sender, address(this), amountAlphaInMax);
        address[] memory path = new address[](2);
        path[0] = alpha;
        path[1] = ibETH;
        IBank(ibETH).withdraw(0);
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapTokensForExactTokens(ibETHForExactETH(amountETHOut), amountAlphaInMax, path, address(this), deadline);                           
        IBank(ibETH).withdraw(swapAmounts[1]);
        amounts = new uint256[](2);
        amounts[0] = swapAmounts[0];
        amounts[1] = address(this).balance;
        TransferHelper.safeTransferETH(to, address(this).balance);        
        if (amountAlphaInMax > amounts[0]) {
            TransferHelper.safeTransfer(alpha, msg.sender, amountAlphaInMax.sub(amounts[0]));
        }                    
    }

    // Swap exact amount of Token for ETH
    // 1. Receive Token from caller
    // 2. Swap Token for ibETH.
    // 3. Unwrap ibETH to ETH.
    function swapExactAlphaForETH(
        uint256 amountAlphaIn,
        uint256 amountETHOutMin,         
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        TransferHelper.safeTransferFrom(alpha, msg.sender, address(this), amountAlphaIn); 
        address[] memory path = new address[](2);
        path[0] = alpha;
        path[1] = ibETH;
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapExactTokensForTokens(amountAlphaIn, 0, path, address(this), deadline);                        
        IBank(ibETH).withdraw(swapAmounts[1]);        
        amounts = new uint256[](2);
        amounts[0] = swapAmounts[0];
        amounts[1] = address(this).balance;
        TransferHelper.safeTransferETH(to, amounts[1]);
        require(amounts[1] >= amountETHOutMin, "IbETHRouter: receive less ETH than amountETHmin");                                       
    }

    // Swap ETH for exact amount of Token
    // 1. Receive ETH from caller
    // 2. Wrap ETH to ibETH.
    // 3. Swap ibETH for Token    
    function swapETHForExactAlpha(
        uint256 amountAlphaOut,          
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {             
        IBank(ibETH).deposit.value(msg.value)();              
        uint256 amountIbETHInMax = IBank(ibETH).balanceOf(address(this));        
        address[] memory path = new address[](2);
        path[0] = ibETH;
        path[1] = alpha;                
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapTokensForExactTokens(amountAlphaOut, amountIbETHInMax, path, to, deadline);                                                
        amounts = new uint256[](2);               
        amounts[0] = msg.value;
        amounts[1] = swapAmounts[1];
        // Transfer left over ETH back
        if (amountIbETHInMax > swapAmounts[0]) {                         
            IBank(ibETH).withdraw(amountIbETHInMax.sub(swapAmounts[0]));                    
            amounts[0] = msg.value - address(this).balance;
            TransferHelper.safeTransferETH(to, address(this).balance);
        }                                       
    }   

    /// @dev Recover ERC20 tokens that were accidentally sent to this smart contract.
    /// @param token The token contract. Can be anything. This contract should not hold ERC20 tokens.
    /// @param to The address to send the tokens to.
    /// @param value The number of tokens to transfer to `to`.
    function recover(address token, address to, uint256 value) external onlyOwner {        
        TransferHelper.safeTransfer(token, to, value);                
    }

    /// @dev Recover ETH that were accidentally sent to this smart contract.    
    /// @param to The address to send the ETH to.
    /// @param value The number of ETH to transfer to `to`.
    function recoverETH(address to, uint256 value) external onlyOwner {        
        TransferHelper.safeTransferETH(to, value);                
    }
}
