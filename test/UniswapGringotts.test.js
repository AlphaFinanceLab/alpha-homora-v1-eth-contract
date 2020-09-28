const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const MockStakingRewards = artifacts.require('MockStakingRewards');
const UniswapGoblin = artifacts.require('UniswapGoblin');
const Gringotts = artifacts.require('Gringotts');
const SimpleGringottsConfig = artifacts.require('SimpleGringottsConfig');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyAllETHOnly = artifacts.require('StrategyAllETHOnly');
const StrategyLiquidate = artifacts.require('StrategyLiquidate');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert, time, BN } = require('@openzeppelin/test-helpers');
const expectEvent = require('@openzeppelin/test-helpers/src/expectEvent');

// Assert that actual is less than 0.01% difference from expected
function assertAlmostEqual(expected, actual) {
  const expectedBN = new BN(expected);
  const actualBN = new BN(actual);
  const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN);
  return assert.ok(
    diffBN.lt(expectedBN.div(new BN('10000'))),
    `Not almost equal. Expected ${expectedBN.toString()}. Actual ${actualBN.toString()}`
  );
}

contract('UniswapGringotts', ([deployer, alice, bob, eve]) => {
  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    this.uni = await MockERC20.new('UNISWAP', 'UNI');
    await this.token.mint(deployer, web3.utils.toWei('100', 'ether'));
    await this.token.mint(alice, web3.utils.toWei('100', 'ether'));
    await this.token.mint(bob, web3.utils.toWei('100', 'ether'));
    await this.uni.mint(deployer, web3.utils.toWei('100', 'ether'));
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.addStrat = await StrategyAllETHOnly.new(this.router.address);
    this.liqStrat = await StrategyLiquidate.new(this.router.address);
    this.config = await SimpleGringottsConfig.new(
      web3.utils.toWei('1', 'ether'), // 1 ETH min debt size
      '3472222222222', // 30% per year
      '1000', // 10% reserve pool
      '100' // 1% Kedavra prize
    );
    this.bank = await Gringotts.new(this.config.address);
    this.staking = await MockStakingRewards.new(deployer, deployer, this.uni.address, this.lp.address);
    this.goblin = await UniswapGoblin.new(
      this.bank.address,
      this.staking.address,
      this.router.address,
      this.token.address,
      this.uni.address,
      this.addStrat.address,
      this.liqStrat.address,
      '100'
    );
    await this.config.setWhiteListed(this.goblin.address, true);
    await this.config.setLiquidateFactor(this.goblin.address, '8000');
    // Deployer adds 1e17 MOCK + 1e18 WEI
    await this.token.approve(this.router.address, web3.utils.toWei('0.1', 'ether'));
    await this.router.addLiquidityETH(
      this.token.address,
      web3.utils.toWei('0.1', 'ether'),
      '0',
      '0',
      deployer,
      FOREVER,
      {
        value: web3.utils.toWei('1', 'ether'),
      }
    );
    // Deployer adds 1e17 UNI + 1e18 WEI
    await this.uni.approve(this.router.address, web3.utils.toWei('0.1', 'ether'));
    await this.router.addLiquidityETH(this.uni.address, web3.utils.toWei('0.1', 'ether'), '0', '0', deployer, FOREVER, {
      value: web3.utils.toWei('1', 'ether'),
    });
    // Deployer transfer 1e18 UNI to StakingRewards contract and notify reward
    await this.uni.transfer(this.staking.address, web3.utils.toWei('1', 'ether'));
    await this.staking.notifyRewardAmount(web3.utils.toWei('1', 'ether'));
  });

  it('should give rewards out when you stake LP tokens', async () => {
    // Deployer sends some LP tokens to Alice and Bob
    await this.lp.transfer(alice, web3.utils.toWei('0.05', 'ether'));
    await this.lp.transfer(bob, web3.utils.toWei('0.05', 'ether'));
    // Alice stakes 0.01 LP tokens and waits for 1 day
    await this.lp.approve(this.staking.address, web3.utils.toWei('100', 'ether'), { from: alice });
    await this.staking.stake(web3.utils.toWei('0.01', 'ether'), { from: alice });
    await time.increase(time.duration.days(1));
    assertAlmostEqual('142857142857129600', await this.staking.earned(alice)); // 1/7 of total reward
    // Bob stakes 0.02 LP tokens and waits for 1 day
    await this.lp.approve(this.staking.address, web3.utils.toWei('100', 'ether'), { from: bob });
    await this.staking.stake(web3.utils.toWei('0.02', 'ether'), { from: bob });
    await time.increase(time.duration.days(1));
    assertAlmostEqual('190476190476172800', await this.staking.earned(alice)); // 4/21 of total reward
    assertAlmostEqual('95238095238086400', await this.staking.earned(bob)); // 2/21 of total reward
  });

  it('should work', async () => {
    // Alice cannot take 1 ETH loan because the contract does not have it
    await expectRevert(
      this.bank.alohomora(
        0,
        this.goblin.address,
        web3.utils.toWei('1', 'ether'),
        '0',
        web3.eth.abi.encodeParameters(
          ['address', 'bytes'],
          [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
        ),
        { value: web3.utils.toWei('1', 'ether'), from: alice }
      ),
      '!eth.sufficient'
    );
    // Deployer deposits 3 ETH to the bank
    await this.bank.engorgio({ value: web3.utils.toWei('3', 'ether') });
    // Now Alice can take 1 ETH loan + 1 ETH of her to create a new position
    await this.bank.alohomora(
      0,
      this.goblin.address,
      web3.utils.toWei('1', 'ether'),
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('1', 'ether'), from: alice }
    );
    // Her position should have ~2 ETH health (minus some small trading fee)
    assert.equal('1997459271062521105', await this.goblin.health('1'));
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));
    await this.goblin.reinvest({ from: eve });
    assertAlmostEqual('1428571428571295', await this.uni.balanceOf(eve));
    // Her position should now have more than 2 ETH health and ~1.3 ETH debt
    await this.bank.engorgio(); // Random action to trigger interest computation
    const healthDebt = await this.bank.positionInfo('1');
    assertAlmostEqual('2582123996372678436', healthDebt[0]);
    assertAlmostEqual('1299999999999980800', healthDebt[1]);
    assertAlmostEqual('2000000000000000000', await web3.eth.getBalance(this.bank.address));
    assertAlmostEqual('1299999999999980800', await this.bank.glbDebtVal());
    assertAlmostEqual('30000000000000000', await this.bank.reservePool());
    assertAlmostEqual('3269999999999982720', await this.bank.totalETH());
    // You can't liquidate her position yet
    await expectRevert(this.bank.kedavra('1'), "can't liquidate", { from: eve });
    await time.increase(time.duration.days(1));
    await expectRevert(this.bank.kedavra('1'), "can't liquidate", { from: eve });
    await time.increase(time.duration.days(1));
    await this.bank.engorgio(); // Random action to trigger interest computation
    assertAlmostEqual('3972004999999927424', await this.bank.totalETH());
    await this.bank.kedavra('1', { from: eve });
    assertAlmostEqual('4079999999999919360', await web3.eth.getBalance(this.bank.address));
    assert.equal('0', await this.bank.glbDebtVal());
    assertAlmostEqual('108000555555547491', await this.bank.reservePool());
    assertAlmostEqual('3972004999999927424', await this.bank.totalETH());
  });
});
