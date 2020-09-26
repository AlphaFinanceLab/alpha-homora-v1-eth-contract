pragma solidity 0.5.16;

interface DegenPoolConfig {
    /// @dev Poke the config pool to update its internal state.
    function poke() external;

    /// @dev Return minimum ETH debt size per position.
    function minDebtSize() external view returns (uint256);

    /// @dev Return whether the given worker is whitelisted.
    function isWhiteListed(address worker) external view returns (bool);

    /// @dev Return health factors for the given worker, using 1e4 as denom.
    function openFactor(address worker) external view returns (uint256);

    /// @dev Return health factors for the given worker, using 1e4 as denom.
    function liquidateFactor(address worker) external view returns (uint256);

    /// @dev Return the interest rate per second, using 1e18 as denom.
    function getInterestRate() external view returns (uint256);

    /// @dev Return the bps rate for reserve pool.
    function getReservePoolBps() external view returns (uint256);

    /// @dev Return the bps rate for Avada Kedavra caster.
    function getKedavraBps() external view returns (uint256);
}
