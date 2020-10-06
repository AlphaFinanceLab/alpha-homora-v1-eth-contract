pragma solidity 0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/ownership/Ownable.sol";
import "./BankConfig.sol";

contract SimpleBankConfig is BankConfig, Ownable {
    uint256 public minDebtSize;
    uint256 public interestRate;
    uint256 public getReservePoolBps;
    uint256 public getKillBps;
    mapping (address => bool) public isGoblin;
    mapping (address => bool) public acceptDebt;
    mapping (address => uint256) public _workFactor;
    mapping (address => uint256) public _killFactor;

    constructor(
        uint256 _minDebtSize,
        uint256 _interestRate,
        uint256 _reservePoolBps,
        uint256 _killBps
    ) public {
        minDebtSize = _minDebtSize;
        interestRate = _interestRate;
        getReservePoolBps = _reservePoolBps;
        getKillBps = _killBps;
    }

    function getInterestRate(uint256 /* debt */, uint256 /* floating */) external view returns (uint256) {
        return interestRate;
    }

    function workFactor(address goblin, uint256 /* debt */) external view returns (uint256) {
        return _workFactor[goblin];
    }

    function killFactor(address goblin, uint256 /* debt */) external view returns (uint256) {
        return _killFactor[goblin];
    }

    function setMinDebtSize(uint256 val) external onlyOwner { minDebtSize = val; }
    function setInterestRate(uint256 val) external onlyOwner { interestRate = val; }
    function setReservePoolBps(uint256 val) external onlyOwner { getReservePoolBps = val; }
    function setKillBps(uint256 val) external onlyOwner { getKillBps = val; }
    function setIsGoblin(address addr, bool val) external onlyOwner{ isGoblin[addr] = val; }
    function setAcceptDebt(address addr, bool val) external onlyOwner{ acceptDebt[addr] = val; }
    function setWorkFactor(address addr, uint256 val) external onlyOwner{ _workFactor[addr] = val; }
    function setKillFactor(address addr, uint256 val) external onlyOwner{ _killFactor[addr] = val; }
}
