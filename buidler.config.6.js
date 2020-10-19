usePlugin('@nomiclabs/buidler-truffle5');
usePlugin('buidler-typechain');

module.exports = {
  solc: {
    version: '0.6.12',
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
  paths: {
    sources: './contracts/6',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  typechain: {
    outDir: './typechain',
    target: 'truffle-v5',
  },
};
