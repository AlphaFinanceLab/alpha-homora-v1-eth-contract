usePlugin('@nomiclabs/buidler-truffle5');
usePlugin('buidler-typechain');

module.exports = {
  solc: {
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
    artifacts: './build/contracts',
  },
  typechain: {
    outDir: './typechain',
    target: 'truffle-v5',
  },
};
