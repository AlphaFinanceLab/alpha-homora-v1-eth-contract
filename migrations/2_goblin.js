const Bank = artifacts.require('Bank');
const SimpleBankConfig = artifacts.require('SimpleBankConfig');
const WETH = artifacts.require('WETH');
const UniswapV2Factory = artifacts.require('UniswapV2Factory');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const UniswapV2Pair = artifacts.require('UniswapV2Pair');
const MockERC20 = artifacts.require('MockERC20');
const StrategyAllETHOnly = artifacts.require('StrategyAllETHOnly');
const StrategyLiquidate = artifacts.require('StrategyLiquidate');
const StakingRewards = artifacts.require('StakingRewards');
const UniswapGoblin = artifacts.require('UniswapGoblin');
const FOREVER = '2000000000';

module.exports = function (deployer, network, [creator]) {
  if (network !== 'kovan') return;

  deployer.then(async () => {
    const tokens = {
      USDT: {
        name: 'Mock USDT',
        symbol: 'USDT',
        uniToStaking: '35',
        liquidity: '17500',
      },
      USDC: {
        name: 'Mock USDC',
        symbol: 'USDC',
        uniToStaking: '35',
        liquidity: '17500',
      },
      DAI: {
        name: 'Mock DAI',
        symbol: 'DAI',
        uniToStaking: '35',
        liquidity: '17500',
      },
      WBTC: {
        name: 'Mock DAI',
        symbol: 'DAI',
        uniToStaking: '35',
        liquidity: '1.6338343759',
      },
    };

    const router = await UniswapV2Router02.at('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
    const factory = await UniswapV2Factory.at(await router.factory());
    const weth = await WETH.at(await router.WETH());

    // Set up Uni/ETH pool
    await deployer.deploy(MockERC20, 'UNISWAP', 'UNI');
    const uni = await MockERC20.deployed();
    await uni.mint(creator, web3.utils.toWei('1000000', 'ether'));

    // Deployer adds 2000 UNI + 20 ETH
    await uni.approve(router.address, web3.utils.toWei('2000', 'ether'));
    await router.addLiquidityETH(uni.address, web3.utils.toWei('2000', 'ether'), '0', '0', creator, FOREVER, {
      value: web3.utils.toWei('20', 'ether'),
    });

    // Set up AddETH and Liquidate strategy
    await deployer.deploy(StrategyAllETHOnly, router.address);
    const addStrat = await StrategyAllETHOnly.deployed();

    await deployer.deploy(StrategyLiquidate, router.address);
    const liqStrat = await StrategyLiquidate.deployed();

    // Set up Bank
    await deployer.deploy(
      SimpleBankConfig,
      web3.utils.toWei('1', 'ether'), // min debt size 1 ETH
      '5787037040', // 18.25% per year
      '1000', // 10% reserve pool
      '500' // 5% kill prize
    );
    const config = await SimpleBankConfig.deployed();

    await deployer.deploy(Bank, config.address);
    const bank = await Bank.deployed();

    for (const key of Object.keys(tokens)) {
      await deployer.deploy(MockERC20, tokens[key].name, tokens[key].symbol);
      const token = await MockERC20.deployed();

      await factory.createPair(weth.address, token.address);
      const pair = await factory.getPair(token.address, weth.address);
      const lp = await UniswapV2Pair.at(pair);

      await deployer.deploy(StakingRewards, creator, creator, uni.address, lp.address);
      const staking = await StakingRewards.deployed();

      await deployer.deploy(
        UniswapGoblin,
        bank.address,
        staking.address,
        router.address,
        token.address,
        uni.address,
        addStrat.address,
        liqStrat.address,
        '300' // 3% reinvest bounty
      );

      const goblin = await UniswapGoblin.deployed();

      // setup goblin to config
      await config.setGoblin(goblin.address, true, true, '7000', '8000');

      // mint mock token to deployer
      await token.mint(creator, web3.utils.toWei('1000000', 'ether'));

      // Deployer adds 17500 Token + 50 ETH
      await token.approve(router.address, web3.utils.toWei(tokens[key].liquidity, 'ether'));
      await router.addLiquidityETH(
        token.address,
        web3.utils.toWei(tokens[key].liquidity, 'ether'),
        '0',
        '0',
        creator,
        FOREVER,
        {
          value: web3.utils.toWei('50', 'ether'),
        }
      );

      // Deployer stake Token|ETH LP tokens
      const lpBalance = await lp.balanceOf(creator);
      await lp.approve(staking.address, lpBalance);
      await staking.stake(lpBalance);

      // Deployer transfer 35 UNI to StakingRewards contract and notify reward
      await uni.transfer(staking.address, web3.utils.toWei(tokens[key].uniToStaking, 'ether'));
      await staking.notifyRewardAmount(web3.utils.toWei(tokens[key].uniToStaking, 'ether'));
    }
  });
};
