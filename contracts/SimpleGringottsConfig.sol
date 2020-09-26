pragma solidity 0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "./GringottsConfig.sol";

contract SimpleGringottsConfig is GringottsConfig, Ownable {
    uint256 public minDebtSize;
    uint256 public getInterestRate;
    uint256 public getReservePoolBps;
    uint256 public getKedavraBps;
    mapping (address => bool) public isWhiteListed;
    mapping (address => uint256) public openFactor;
    mapping (address => uint256) public liquidateFactor;

    constructor(
        uint256 _minDebtSize,
        uint256 _interestRate,
        uint256 _reservePoolBps,
        uint256 _kedavraBps
    ) public {
        minDebtSize = _minDebtSize;
        getInterestRate = _interestRate;
        getReservePoolBps = _reservePoolBps;
        getKedavraBps = _kedavraBps;
    }

    function poke() external {}
    function setMinDebtSize(uint256 val) external onlyOwner { minDebtSize = val; }
    function setInterestRate(uint256 val) external onlyOwner { getInterestRate = val; }
    function setReservePoolBps(uint256 val) external onlyOwner { getReservePoolBps = val; }
    function setKedavraBps(uint256 val) external onlyOwner { getKedavraBps = val; }
    function setWhiteListed(address addr, bool val) external onlyOwner{ isWhiteListed[addr] = val; }
    function setOpenFactor(address addr, uint256 val) external onlyOwner{ openFactor[addr] = val; }
    function setLiquidateFactor(address addr, uint256 val) external onlyOwner{ liquidateFactor[addr] = val; }
}
