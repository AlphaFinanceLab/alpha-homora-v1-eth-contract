require('@nomiclabs/hardhat-truffle5');
require('hardhat-typechain');

module.exports = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      chainId: 31337,
      gas: 12000000,
      blockGasLimit: 0x1fffffffffffff,
      allowUnlimitedContractSize: true,
      timeout: 1800000,
      accounts: [
        {
          privateKey: process.env.PRIVATE_KEY_1,
          balance: '10000000000000000000000',
        },
        {
          privateKey: process.env.PRIVATE_KEY_2,
          balance: '10000000000000000000000',
        },
        {
          privateKey: process.env.PRIVATE_KEY_3,
          balance: '10000000000000000000000',
        },
        {
          privateKey: process.env.PRIVATE_KEY_4,
          balance: '10000000000000000000000',
        },
      ],
    },
  },
  solidity: {
    version: '0.5.16',
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
  paths: {
    sources: './contracts/5',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  typechain: {
    outDir: './typechain',
    target: 'truffle-v5',
  },
};
