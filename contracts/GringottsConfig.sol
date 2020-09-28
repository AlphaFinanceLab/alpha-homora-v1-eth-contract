pragma solidity 0.5.16;

interface GringottsConfig {
    /// @dev Return minimum ETH debt size per position.
    function minDebtSize() external view returns (uint256);

    /// @dev Return the interest rate per second, using 1e18 as denom.
    function getInterestRate() external view returns (uint256);

    /// @dev Return the bps rate for reserve pool.
    function getReservePoolBps() external view returns (uint256);

    /// @dev Return the bps rate for Avada Kedavra caster.
    function getKedavraBps() external view returns (uint256);

    /// @dev Return whether the given goblin accepts more debt. Revert on non-goblin.
    function acceptDebt(address worker) external view returns (bool);

    /// @dev Return the work factor for the given goblin, using 1e4 as denom. Revert on non-goblin.
    function workFactor(address worker) external view returns (uint256);

    /// @dev Return the kill factor for the given goblin, using 1e4 as denom. Revert on non-goblin.
    function killFactor(address worker) external view returns (uint256);
}
