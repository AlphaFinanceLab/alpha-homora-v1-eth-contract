# AlphaHomora 💫 🔐

**Unlock Your Yield Farming Potential**

The repository contains the smart contracts of [AlphaHomora](https://homora.alphafinance.io) leveraged yield farming protocol on [Ethereum](https://ethereum.org/) and [Binance Smart Chain](https://www.binance.org/en/smartChain) and any other EVM compatible blockchains you like. With AlphaHomora, the lenders can earn interests on supplied blockchain native currencies (i.e. ETH or BNB), while the farmers can borrow the currencies to farm with higher APY rates. Win-win.

## Smart Contract Structure

### Bank 🏦 ([code](./contracts/Bank.sol))

Bank is the smart contract that manages all leveraged yeild farming positions. All interactions to AlphaHomora happen through this smart contract. If you are a rich wizard 🧙‍♂️, you can deposit your ETH/BNB to earn intersts. If you are a poor farmer 👩‍🌾, you can open a new position on Bank by specifying the debt you will take anda Goblin who will work for your position.

### Goblins 👺 ([code](./contracts/Goblin.sol))

### UniswapGoblin 🦄👺 ([code](./contracts/UniswapGoblin.sol))

### StrategyAddETHOnly ⬆️Ξ ([code](./contracts/StrategyAddETHOnly.sol))

### StrategyLiquidate ⬇️Ξ ([code](./contracts/StrategyLiquidate.sol))

### Active Bug Bounty Program: https://immunefi.com/bounty/alphafinance/

## License

[MIT License](https://opensource.org/licenses/MIT)
