const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const MockStakingRewards = artifacts.require('MockStakingRewards');
const UniswapGoblin = artifacts.require('UniswapGoblin');
const Bank = artifacts.require('Bank');
const SimpleBankConfig = artifacts.require('SimpleBankConfig');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyAllETHOnly = artifacts.require('StrategyAllETHOnly');
const StrategyLiquidate = artifacts.require('StrategyLiquidate');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert, time, BN } = require('@openzeppelin/test-helpers');
const expectEvent = require('@openzeppelin/test-helpers/src/expectEvent');
const { web3 } = require('@openzeppelin/test-helpers/src/setup');

// Assert that actual is less than 0.01% difference from expected
function assertAlmostEqual(expected, actual) {
  const expectedBN = BN.isBN(expected) ? expected : new BN(expected);
  const actualBN = BN.isBN(actual) ? actual : new BN(actual);
  const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN);
  return assert.ok(
    diffBN.lt(expectedBN.div(new BN('10000'))),
    `Not almost equal. Expected ${expectedBN.toString()}. Actual ${actualBN.toString()}`
  );
}

contract('UniswapBank', ([deployer, alice, bob, eve]) => {
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
    this.config = await SimpleBankConfig.new(
      web3.utils.toWei('1', 'ether'), // 1 ETH min debt size
      '3472222222222', // 30% per year
      '1000', // 10% reserve pool
      '1000' // 10% Kill prize
    );
    this.bank = await Bank.new(this.config.address);
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
    await this.config.setGoblin(this.goblin.address, true, true, '7000', '8000');
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

  it('should allow positions without debt', async () => {
    // Deployer deposits 3 ETH to the bank
    await this.bank.deposit({ value: web3.utils.toWei('3', 'ether') });
    // Alice cannot take 1 ETH loan but only put in 0.3 ETH
    await expectRevert(
      this.bank.work(
        0,
        this.goblin.address,
        web3.utils.toWei('1', 'ether'),
        '0',
        web3.eth.abi.encodeParameters(
          ['address', 'bytes'],
          [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
        ),
        { value: web3.utils.toWei('0.3', 'ether'), from: alice }
      ),
      'bad work factor'
    );
    // Alice cannot take 0.3 debt because it is too small
    await expectRevert(
      this.bank.work(
        0,
        this.goblin.address,
        web3.utils.toWei('0.3', 'ether'),
        '0',
        web3.eth.abi.encodeParameters(
          ['address', 'bytes'],
          [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
        ),
        { value: web3.utils.toWei('0.3', 'ether'), from: alice }
      ),
      'too small debt size'
    );
    // Alice can take 0 debt ok
    await this.bank.work(
      0,
      this.goblin.address,
      web3.utils.toWei('0', 'ether'),
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('0.3', 'ether'), from: alice }
    );
  });

  it('should work', async () => {
    // Alice cannot take 1 ETH loan because the contract does not have it
    await expectRevert(
      this.bank.work(
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
      'insufficient ETH in the bank'
    );
    // Deployer deposits 3 ETH to the bank
    await this.bank.deposit({ value: web3.utils.toWei('3', 'ether') });
    // Now Alice can take 1 ETH loan + 1 ETH of her to create a new position
    console.log(
      (
        await this.bank.work(
          0,
          this.goblin.address,
          web3.utils.toWei('1', 'ether'),
          '0',
          web3.eth.abi.encodeParameters(
            ['address', 'bytes'],
            [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
          ),
          { value: web3.utils.toWei('1', 'ether'), from: alice }
        )
      ).receipt.gasUsed
    );
    // Her position should have ~2 ETH health (minus some small trading fee)
    assert.equal('1997459271062521105', await this.goblin.health('1'));
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));
    await this.goblin.reinvest({ from: eve });
    assertAlmostEqual('1428571428571295', await this.uni.balanceOf(eve));
    // Her position should now have more than 2 ETH health and ~1.3 ETH debt
    await this.bank.deposit(); // Random action to trigger interest computation
    const healthDebt = await this.bank.positionInfo('1');
    assertAlmostEqual('2582123996372678436', healthDebt[0]);
    assertAlmostEqual('1299999999999980800', healthDebt[1]);
    assertAlmostEqual('2000000000000000000', await web3.eth.getBalance(this.bank.address));
    assertAlmostEqual('1299999999999980800', await this.bank.glbDebtVal());
    assertAlmostEqual('30000000000000000', await this.bank.reservePool());
    assertAlmostEqual('3269999999999982720', await this.bank.totalETH());
    // You can't liquidate her position yet
    await expectRevert(this.bank.kill('1'), "can't liquidate", { from: eve });
    await time.increase(time.duration.days(1));
    await expectRevert(this.bank.kill('1'), "can't liquidate", { from: eve });
    await time.increase(time.duration.days(1));
    await this.bank.deposit(); // Random action to trigger interest computation
    assertAlmostEqual('3972004999999927424', await this.bank.totalETH());

    const eveBefore = await web3.eth.getBalance(eve);
    // Now you can liquidate because of the insane interest rate
    await this.bank.kill('1', { from: eve });
    expect(await web3.eth.getBalance(eve)).to.be.bignumber.gt(eveBefore); //Should get rewards
    assertAlmostEqual('4079999999999919360', await web3.eth.getBalance(this.bank.address));
    assert.equal('0', await this.bank.glbDebtVal());
    assertAlmostEqual('108000555555547491', await this.bank.reservePool());
    assertAlmostEqual('3972004999999927424', await this.bank.totalETH());
    // Alice creates a new position again
    console.log(
      (
        await this.bank.work(
          0,
          this.goblin.address,
          web3.utils.toWei('1', 'ether'),
          '0',
          web3.eth.abi.encodeParameters(
            ['address', 'bytes'],
            [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
          ),
          { value: web3.utils.toWei('1', 'ether'), from: alice }
        )
      ).receipt.gasUsed
    );
    // She can close position
    await this.bank.work(
      2,
      this.goblin.address,
      '0',
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.liqStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { from: alice }
    );
  });

  it('Should deposit and withdraw eth from Bank (bad debt case)', async () => {
    // Deployer deposits 10 ETH to the bank
    await this.bank.deposit({ value: web3.utils.toWei('10', 'ether') });
    assertAlmostEqual('10000000000000000000', await this.bank.balanceOf(deployer));

    // Bob borrows 2 ETH loan
    await this.bank.work(
      0,
      this.goblin.address,
      web3.utils.toWei('2', 'ether'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('1', 'ether'), from: bob }
    );
    assertAlmostEqual('8000000000000000000', await web3.eth.getBalance(this.bank.address));
    assertAlmostEqual('2000000000000000000', await this.bank.glbDebtVal());
    assertAlmostEqual('10000000000000000000', await this.bank.totalETH());

    // Alice deposits 2 ETH
    await this.bank.deposit({ value: web3.utils.toWei('2', 'ether'), from: alice });

    // check Alice gETH balance = 2/10 * 10 = 2 gETH
    assertAlmostEqual('2000000000000000000', await this.bank.balanceOf(alice));
    assertAlmostEqual('12000000000000000000', await this.bank.totalSupply());

    // Simulate ETH price is very high by swap fToken to ETH (reduce ETH supply)
    await this.token.mint(deployer, web3.utils.toWei('100', 'ether'));
    await this.token.approve(this.router.address, web3.utils.toWei('100', 'ether'));
    await this.router.swapExactTokensForTokens(
      web3.utils.toWei('100', 'ether'),
      '0',
      [this.token.address, this.weth.address],
      deployer,
      FOREVER
    );
    assertAlmostEqual('10000000000000000000', await web3.eth.getBalance(this.bank.address));

    // Alice liquidates Bob position#1
    let aliceBefore = new BN(await web3.eth.getBalance(alice));

    await this.bank.kill(1, { from: alice, gasPrice: 0 });
    let aliceAfter = new BN(await web3.eth.getBalance(alice));

    // Bank balance is increase by liquidation
    assertAlmostEqual('10002702699312215556', await web3.eth.getBalance(this.bank.address));

    // Alice is liquidator, Alice should receive 10% Kill prize
    // ETH back from liquidation 3002999235795062, 10% of 3002999235795062 is 300299923579506
    assertAlmostEqual('300299923579506', aliceAfter.sub(aliceBefore));

    // Alice withdraws 2 gETH
    aliceBefore = new BN(await web3.eth.getBalance(alice));
    await this.bank.withdraw(await this.bank.balanceOf(alice), { from: alice, gasPrice: 0 });
    aliceAfter = new BN(await web3.eth.getBalance(alice));

    // alice gots 2/12 * 10.002702699312215556 = 1.667117116552036
    assertAlmostEqual('1667117116552036400', aliceAfter.sub(aliceBefore));
  });

  it('should liquidate user position correctly', async () => {
    // Bob deposits 20 ETH
    await this.bank.deposit({ value: web3.utils.toWei('20', 'ether'), from: bob });

    // Position#1: Alice borrows 10 ETH loan
    await this.bank.work(
      0,
      this.goblin.address,
      web3.utils.toWei('10', 'ether'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('10', 'ether'), from: alice }
    );

    await this.token.mint(deployer, web3.utils.toWei('100', 'ether'));
    await this.token.approve(this.router.address, web3.utils.toWei('100', 'ether'));

    // Price swing 10%
    // Add more token to the pool equals to sqrt(10*((0.1)**2) / 9) - 0.1 = 0.005409255338945984, (0.1 is the balance of token in the pool)
    await this.router.swapExactTokensForTokens(
      web3.utils.toWei('0.005409255338945984', 'ether'),
      '0',
      [this.token.address, this.weth.address],
      deployer,
      FOREVER
    );
    await expectRevert(this.bank.kill('1'), "can't liquidate");

    // Price swing 20%
    // Add more token to the pool equals to
    // sqrt(10*((0.10540925533894599)**2) / 8) - 0.10540925533894599 = 0.012441874858811944
    // (0.10540925533894599 is the balance of token in the pool)

    await this.router.swapExactTokensForTokens(
      web3.utils.toWei('0.012441874858811944', 'ether'),
      '0',
      [this.token.address, this.weth.address],
      deployer,
      FOREVER
    );
    await expectRevert(this.bank.kill('1'), "can't liquidate");

    // Price swing 23.43%
    // Existing token on the pool = 0.10540925533894599 + 0.012441874858811944 = 0.11785113019775793
    // Add more token to the pool equals to
    // sqrt(10*((0.11785113019775793)**2) / 7.656999999999999) - 0.11785113019775793 = 0.016829279312591913
    await this.router.swapExactTokensForTokens(
      web3.utils.toWei('0.016829279312591913', 'ether'),
      '0',
      [this.token.address, this.weth.address],
      deployer,
      FOREVER
    );
    await expectRevert(this.bank.kill('1'), "can't liquidate");

    // Price swing 30%
    // Existing token on the pool = 0.11785113019775793 + 0.016829279312591913 = 0.13468040951034985
    // Add more token to the pool equals to
    // sqrt(10*((0.13468040951034985)**2) / 7) - 0.13468040951034985 = 0.026293469053292218
    await this.router.swapExactTokensForTokens(
      web3.utils.toWei('0.026293469053292218', 'ether'),
      '0',
      [this.token.address, this.weth.address],
      deployer,
      FOREVER
    );

    // Bob can kill alice's position
    await this.bank.kill('1', { from: bob });
  });

  it('should reinvest correctly', async () => {
    // Set Bank's debt interests to 0% per year
    await this.config.setParams(
      web3.utils.toWei('1', 'ether'), // 1 ETH min debt size,
      '0', // 0% per year
      '1000', // 10% reserve pool
      '1000' // 10% Kill prize
    );

    // Set Reinvest bounty to 10% of the reward
    await this.goblin.setReinvestBountyBps('1000');

    // Bob deposits 10 ETH
    await this.bank.deposit({ value: web3.utils.toWei('10', 'ether'), from: bob, gasPrice: 0 });

    // Alice deposits 12 ETH
    await this.bank.deposit({ value: web3.utils.toWei('12', 'ether'), from: alice, gasPrice: 0 });

    // Position#1: Bob borrows 10 ETH loan
    await this.bank.work(
      0,
      this.goblin.address,
      web3.utils.toWei('10', 'ether'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('10', 'ether'), from: bob, gasPrice: 0 }
    );

    // Position#2: Alice borrows 2 ETH loan
    await this.bank.work(
      0,
      this.goblin.address,
      web3.utils.toWei('2', 'ether'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('1', 'ether'), from: alice, gasPrice: 0 }
    );

    // ---------------- Reinvest#1 -------------------
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));

    let goblinLPBefore = await this.staking.balanceOf(this.goblin.address);
    await this.goblin.reinvest({ from: eve });
    // Goblin receives 142857142857129598 uni as a reward
    // Eve got 10% of 142857142857129598 uni = 0.1 * 142857142857129598 = 14285714285712960 bounty
    assertAlmostEqual('14285714285712960', await this.uni.balanceOf(eve));

    // Remaining Goblin reward = 142857142857129598 - 14285714285712960 = 128571428571416638 (~90% reward)
    // Convert 128571428571416638 uni to 282085379060981681 ETH
    // Convert ETH to 17975920502268804 LP token
    let goblinLPAfter = await this.staking.balanceOf(this.goblin.address);

    // LP tokens of goblin should be inceased from reinvestment
    assertAlmostEqual('17975920502268804', goblinLPAfter.sub(goblinLPBefore));

    // Check Bob position info
    await this.goblin.health('1');
    let bobInfo = await this.bank.positionInfo('1');
    assertAlmostEqual('22810575597213675970', bobInfo[0]);
    assertAlmostEqual('10000000000000000000', bobInfo[1]);

    // Check Alice position info
    await this.goblin.health('2');
    let aliceInfo = await this.bank.positionInfo('2');
    assertAlmostEqual('3070622598989835731', aliceInfo[0]);
    assertAlmostEqual('2000000000000000000', aliceInfo[1]);

    // ---------------- Reinvest#2 -------------------
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));

    goblinLPBefore = await this.staking.balanceOf(this.goblin.address);
    await this.goblin.reinvest({ from: eve });
    // Goblin receives 142858796296283038 uni as a reward
    // Eve got 10% of 142858796296283038 uni = 0.1 * 142858796296283038 = 14285879629628304 bounty
    // Now alice have 14285714285712960 uni (1st) + 14285879629628304 uni (2nd) = 28571593915341264 uni
    assertAlmostEqual('28571593915341262', await this.uni.balanceOf(eve));

    // Remaining Goblin reward = 142858796296283038 - 14285879629628304 = 128572916666654734 (~90% reward)
    // Convert 128572916666654734 uni to 157462478899282341 ETH
    // Convert ETH to 5001669421841640 LP token
    goblinLPAfter = await this.staking.balanceOf(this.goblin.address);
    // LP tokens of goblin should be inceased from reinvestment
    assertAlmostEqual('5001669421841640', goblinLPAfter.sub(goblinLPBefore)); //?

    // Check Bob position info
    bobInfo = await this.bank.positionInfo('1');
    assertAlmostEqual('22964613877609863123', bobInfo[0]);
    assertAlmostEqual('10000000000000000000', bobInfo[1]);

    // Check Alice position info
    aliceInfo = await this.bank.positionInfo('2');
    assertAlmostEqual('3092717125901593185', aliceInfo[0]);
    assertAlmostEqual('2000000000000000000', aliceInfo[1]);

    // ---------------- Reinvest#3 -------------------
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));

    goblinLPBefore = await this.staking.balanceOf(this.goblin.address);
    await this.goblin.reinvest({ from: eve });
    // Goblin receives 142858796296283038 uni as a reward
    // Eve got 10% of 142858796296283038 uni = 0.1 * 142858796296283038 = 14285879629628304 bounty
    // Now alice have 14285714285712960 uni (1st) + 14285879629628304 uni (2nd) + 14285879629628304 uni (3rd) = 42857473544969568 uni
    assertAlmostEqual('42857473544969568', await this.uni.balanceOf(eve));

    // Remaining Goblin reward = 142858796296283038 - 14285879629628304 = 128572916666654734 (~90% reward)
    // Convert 128572916666654734 uni to 74159218067697746 ETH
    // Convert ETH to 2350053120029788 LP token
    goblinLPAfter = await this.staking.balanceOf(this.goblin.address);

    // LP tokens of goblin should be inceased from reinvestment
    assertAlmostEqual('2350053120029788', goblinLPAfter.sub(goblinLPBefore));

    const bobBefore = new BN(await web3.eth.getBalance(bob));
    // Bob close position#1
    await this.bank.work(
      1,
      this.goblin.address,
      '0',
      '1000000000000000000000',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.liqStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { from: bob, gasPrice: 0 }
    );
    const bobAfter = new BN(await web3.eth.getBalance(bob));

    // Check Bob account
    assertAlmostEqual('13037163593789687703', bobAfter.sub(bobBefore));

    // Alice add ETH again
    await this.bank.work(
      2,
      this.goblin.address,
      0,
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { value: web3.utils.toWei('10', 'ether'), from: alice }
    );

    const aliceBefore = new BN(await web3.eth.getBalance(alice));
    // Alice close position#2
    await this.bank.work(
      2,
      this.goblin.address,
      '0',
      '1000000000000000000000000000000',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [this.liqStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0'])]
      ),
      { from: alice, gasPrice: 0 }
    );
    const aliceAfter = new BN(await web3.eth.getBalance(alice));

    // Check Alice account
    assertAlmostEqual('8747417676666762843', aliceAfter.sub(aliceBefore));
  });
});
