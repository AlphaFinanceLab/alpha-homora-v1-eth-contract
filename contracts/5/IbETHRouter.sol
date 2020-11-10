pragma solidity =0.5.16;
import "./uniswap/UniswapV2Library.sol";
import "./uniswap/IUniswapV2Router02.sol";
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/IERC20.sol";
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
    // Get number of ibETH received for the amouthETH send to Bank
    function exactETHToIbETH(uint256 amountETH) public view returns (uint256) {
        uint256 totalETH = IBank(ibETH).totalETH();        
        return totalETH == 0 ? amountETH : amountETH.mul(IBank(ibETH).totalSupply()).div(totalETH); 
    } 

    // Get number of ETH needed to deposit to get exact amountIbETH from the Bank
    // Note: Round up the amount of ETH needed, to be used with Bank.deposit
    function ethForExactIbETH(uint256 amountIbETH) public view returns (uint256) {
        uint256 totalSupply = IBank(ibETH).totalSupply();         
        return totalSupply == 0? amountIbETH : amountIbETH.mul(IBank(ibETH).totalETH()).add(totalSupply).sub(1).div(totalSupply);                   
    } 

    // Get number of ETH received when withdraw exact amountIbETH from the Bank    
    // Note: Round down the amount of ETH received, to be used with Bank.withdraw
    function exactIbETHToETH(uint256 amountIbETH) public view returns (uint256) {
        uint256 totalSupply = IBank(ibETH).totalSupply();         
        return totalSupply == 0? amountIbETH : amountIbETH.mul(IBank(ibETH).totalETH()).div(totalSupply);                   
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
        uint256 amountIbETHDesired = exactETHToIbETH(msg.value);                         
        uint256 amountIbETH;
        (amountAlpha, amountIbETH, liquidity) = IUniswapV2Router02(router).addLiquidity(
            alpha,
            ibETH,
            amountAlphaDesired,            
            amountIbETHDesired,
            amountAlphaMin,            
            exactETHToIbETH(amountETHMin),
            to,
            deadline
        );         
        if (amountAlphaDesired > amountAlpha) {
            TransferHelper.safeTransfer(alpha, msg.sender, amountAlphaDesired.sub(amountAlpha));
        }            
        if (amountIbETHDesired > amountIbETH) {
            uint256 ibETHLeftOver = amountIbETHDesired.sub(amountIbETH);
            IBank(ibETH).withdraw(ibETHLeftOver);        
            TransferHelper.safeTransferETH(msg.sender, exactIbETHToETH(ibETHLeftOver));
        }          
        amountETH = exactIbETHToETH(amountIbETH);
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
            exactETHToIbETH(amountETHMin),
            address(this),
            deadline
        );                        
        TransferHelper.safeTransfer(alpha, to, amountAlpha);                
        IBank(ibETH).withdraw(amountIbETH);        
        TransferHelper.safeTransferETH(to, exactIbETHToETH(amountIbETH));
        amountETH = exactIbETHToETH(amountIbETH);     
    }

    // Remove liquidity from ibETH-Alpha Pool and convert all ibETH to Alpha 
    // 1. Remove ibETH and Alpha from the pool.
    // 2. Swap ibETH for Alpha.
    // 3. Return Alpha to caller.   
    function removeLiquidityAllAlpha(        
        uint256 liquidity,
        uint256 amountAlphaMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public returns (uint256 amountAlpha) {                  
        TransferHelper.safeTransferFrom(lpToken, msg.sender, address(this), liquidity);          
        (uint256 removeAmountAlpha, uint256 removeAmountIbETH) = IUniswapV2Router02(router).removeLiquidity(
            alpha,
            ibETH,
            liquidity,
            amountAlphaMin,
            exactETHToIbETH(amountETHMin),
            address(this),
            deadline
        );        
        address[] memory path = new address[](2);
        path[0] = ibETH;
        path[1] = alpha;
        uint256[] memory amounts = IUniswapV2Router02(router).swapExactTokensForTokens(removeAmountIbETH, 0, path, to, deadline);               
        TransferHelper.safeTransfer(alpha, to, removeAmountAlpha);                        
        amountAlpha = removeAmountAlpha.add(amounts[1]);
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
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapExactTokensForTokens(exactETHToIbETH(msg.value), amountAlphaOutMin, path, to, deadline);
        amounts = new uint256[](2);
        amounts[0] = exactIbETHToETH(swapAmounts[0]);
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
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapTokensForExactTokens(exactETHToIbETH(amountETHOut), amountAlphaInMax, path, address(this), deadline);                   
        IBank(ibETH).withdraw(swapAmounts[1]);        
        TransferHelper.safeTransferETH(to, exactIbETHToETH(swapAmounts[1]));        
        if (amountAlphaInMax > swapAmounts[0]) {
            TransferHelper.safeTransfer(alpha, msg.sender, amountAlphaInMax.sub(swapAmounts[0]));
        }            
        amounts = new uint256[](2);
        amounts[0] = swapAmounts[0];
        amounts[1] = exactIbETHToETH(swapAmounts[1]);
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
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapExactTokensForTokens(amountAlphaIn, exactETHToIbETH(amountETHOutMin), path, address(this), deadline);                
        IBank(ibETH).withdraw(swapAmounts[1]);        
        TransferHelper.safeTransferETH(to, exactIbETHToETH(swapAmounts[1]));
        amounts = new uint256[](2);
        amounts[0] = swapAmounts[0];
        amounts[1] = exactIbETHToETH(swapAmounts[1]);
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
        uint256 amountIbETHInMax = exactETHToIbETH(msg.value);        
        address[] memory path = new address[](2);
        path[0] = ibETH;
        path[1] = alpha;
        uint256[] memory swapAmounts = IUniswapV2Router02(router).swapTokensForExactTokens(amountAlphaOut, amountIbETHInMax, path, to, deadline);        
        if (amountIbETHInMax > swapAmounts[1]) {
            uint256 ibETHLeftOver = amountIbETHInMax.sub(swapAmounts[1]);
            IBank(ibETH).withdraw(ibETHLeftOver);        
            TransferHelper.safeTransferETH(to, exactIbETHToETH(ibETHLeftOver));
        }
        amounts = new uint256[](2);
        amounts[0] = exactIbETHToETH(swapAmounts[0]);
        amounts[1] = swapAmounts[1];              
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
