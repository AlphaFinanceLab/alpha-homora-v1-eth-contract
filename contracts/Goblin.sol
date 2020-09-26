pragma solidity 0.5.16;

interface Goblin {
    /// @dev Work on a (potentially new) position. Optionally send ETH back to Gringotts.
    function work(
        uint256 id,
        address owner,
        uint256 debt,
        bytes calldata data
    ) external payable returns (uint256);

    /// @dev Re-invest whatever the goblin is working on.
    function reinvest() external;

    /// @dev Return the amount of ETH wei to get back if we are to liquidate the position.
    function health(uint256 id) external view returns (uint256);

    /// @dev Liquidate the given position to ETH. Send all ETH back to Gringotts.
    function liquidate(uint256 id) external returns (uint256);
}
