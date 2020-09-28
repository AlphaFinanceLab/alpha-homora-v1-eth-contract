pragma solidity 0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "./GringottsConfig.sol";

contract SimpleGringottsConfig is Ownable {
    uint256 public minDebtSize;
    uint256 public interestRate;
    uint256 public getReservePoolBps;
    uint256 public getKedavraBps;
    mapping (address => bool) public acceptDebt;
    mapping (address => uint256) public workFactor;
    mapping (address => uint256) public killFactor;

    constructor(
        uint256 _minDebtSize,
        uint256 _interestRate,
        uint256 _reservePoolBps,
        uint256 _kedavraBps
    ) public {
        minDebtSize = _minDebtSize;
        interestRate = _interestRate;
        getReservePoolBps = _reservePoolBps;
        getKedavraBps = _kedavraBps;
    }

    function getInterestRate(uint256 /* debt */, uint256 /* floating */) external view returns (uint256) {
        return interestRate;
    }

    function setMinDebtSize(uint256 val) external onlyOwner { minDebtSize = val; }
    function setInterestRate(uint256 val) external onlyOwner { interestRate = val; }
    function setReservePoolBps(uint256 val) external onlyOwner { getReservePoolBps = val; }
    function setKedavraBps(uint256 val) external onlyOwner { getKedavraBps = val; }
    function setAcceptDebt(address addr, bool val) external onlyOwner{ acceptDebt[addr] = val; }
    function setWorkFactor(address addr, uint256 val) external onlyOwner{ workFactor[addr] = val; }
    function setKillFactor(address addr, uint256 val) external onlyOwner{ killFactor[addr] = val; }
}
