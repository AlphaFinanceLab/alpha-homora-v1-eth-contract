import {
  SushiTokenInstance,
  MasterChefInstance,
  UniswapV2FactoryInstance,
  UniswapV2Router02Instance,
  UniswapV2PairInstance,
  StrategyAllETHOnlyInstance,
  StrategyAddTwoSidesOptimalInstance,
  StrategyLiquidateInstance,
  BankInstance,
  SimpleBankConfigInstance,
  SushiswapPool12GoblinInstance,
  WETHInstance,
} from '../typechain';

const SushiToken = artifacts.require('SushiToken');
const MasterChef = artifacts.require('MasterChef');
const UniswapV2Factory = artifacts.require('UniswapV2Factory');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const UniswapV2Pair = artifacts.require('UniswapV2Pair');
const StrategyAllETHOnly = artifacts.require('StrategyAllETHOnly');
const StrategyAddTwoSidesOptimal = artifacts.require('StrategyAddTwoSidesOptimal');
const StrategyLiquidate = artifacts.require('StrategyLiquidate');
const Bank = artifacts.require('Bank');
const SimpleBankConfig = artifacts.require('SimpleBankConfig');
const SushiswapPool12Goblin = artifacts.require('SushiswapPool12Goblin');

const WETH = artifacts.require('WETH');

const { expectRevert, time, BN, ether, constants } = require('@openzeppelin/test-helpers');

// Assert that actual is less than 0.01% difference from expected
function assertAlmostEqual(expected: string | BN, actual: string | BN) {
  const expectedBN = BN.isBN(expected) ? expected : new BN(expected);
  const actualBN = BN.isBN(actual) ? actual : new BN(actual);
  const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN);
  return assert.ok(
    diffBN.lt(expectedBN.div(new BN('1000'))),
    `Not almost equal. Expected ${expectedBN.toString()}. Actual ${actualBN.toString()}`
  );
}

const FOREVER = '2000000000';
const TOLERANCE = new BN('10000');

const toBN = (n: number) => new BN(n.toString());

contract('SushiswapPool12Bank', ([deployer, alice, bob, eve]) => {
  const SUSHI_REWARD_PER_BLOCK = ether('0.076');
  const REINVEST_BOUNTY_BPS = new BN('100'); // 1% reinvest bounty
  const RESERVE_POOL_BPS = new BN('1000'); // 10% reserve pool
  const KILL_PRIZE_BPS = new BN('1000'); // 10% Kill prize
  const INTEREST_RATE = new BN('3472222222222'); // 30% per year
  const MIN_DEBT_SIZE = ether('1'); // 1 ETH min debt size
  const WORK_FACTOR = new BN('7000');
  const KILL_FACTOR = new BN('8000');

  let factory: UniswapV2FactoryInstance;
  let weth: WETHInstance;
  let router: UniswapV2Router02Instance;
  let sushi: SushiTokenInstance;
  let lp: UniswapV2PairInstance;
  let addStrat: StrategyAllETHOnlyInstance;
  let liqStrat: StrategyLiquidateInstance;
  let config: SimpleBankConfigInstance;
  let bank: BankInstance;
  let masterChef: MasterChefInstance;
  let poolId: number;
  let goblin: SushiswapPool12GoblinInstance;

  beforeEach(async () => {
    factory = await UniswapV2Factory.new(deployer);
    weth = await WETH.new();
    router = await UniswapV2Router02.new(factory.address, weth.address);
    sushi = await SushiToken.new();
    await sushi.mint(deployer, web3.utils.toWei('200', 'ether'));
    await factory.createPair(weth.address, sushi.address);
    lp = await UniswapV2Pair.at(await factory.getPair(sushi.address, weth.address));
    addStrat = await StrategyAllETHOnly.new(router.address);
    liqStrat = await StrategyLiquidate.new(router.address);
    config = await SimpleBankConfig.new(MIN_DEBT_SIZE, INTEREST_RATE, RESERVE_POOL_BPS, KILL_PRIZE_BPS);
    bank = await Bank.new(config.address);
    masterChef = await MasterChef.new(sushi.address, deployer, SUSHI_REWARD_PER_BLOCK, 0, 0);
    // Transfer ownership so masterChef can mint SUSHI
    await sushi.transferOwnership(masterChef.address);
    // Add mock masterChef's pool
    poolId = 12;
    for (let _ of Array.from(Array(poolId).keys())) {
      await masterChef.add(0, constants.ZERO_ADDRESS, false);
    }
    // Add lp to masterChef's pool
    await masterChef.add(1, lp.address, false);
    goblin = await SushiswapPool12Goblin.new(
      bank.address,
      masterChef.address,
      router.address,
      addStrat.address,
      liqStrat.address,
      REINVEST_BOUNTY_BPS
    );
    await config.setGoblin(goblin.address, true, true, WORK_FACTOR, KILL_FACTOR);

    const twoSideStrat = await StrategyAddTwoSidesOptimal.new(router.address, goblin.address);
    await goblin.setStrategyOk([twoSideStrat.address], true);
    await goblin.setCriticalStrategies(twoSideStrat.address, liqStrat.address);

    // Deployer adds 1e17 MOCK + 1e18 WEI
    await sushi.approve(router.address, ether('0.1'));
    await router.addLiquidityETH(sushi.address, ether('0.1'), '0', '0', deployer, FOREVER, {
      value: ether('1'),
    });
  });

  it('should has MOCK as fToken in SushiswapGoblin', async () => {
    // Deployer sends some LP tokens to Alice and Bob
    expect(await goblin.sushi()).to.be.equal(sushi.address);
  });

  it('should give rewards out when you stake LP tokens', async () => {
    // Deployer sends some LP tokens to Alice and Bob
    await lp.transfer(alice, ether('0.05'));
    await lp.transfer(bob, ether('0.05'));
    // Alice stakes 0.01 LP tokens and waits for 1 day
    await lp.approve(masterChef.address, ether('100'), { from: alice });
    await lp.approve(masterChef.address, ether('100'), { from: bob });
    await masterChef.deposit(poolId, ether('0.01'), { from: alice });
    await masterChef.deposit(poolId, ether('0.02'), { from: bob }); // alice +1 Reward
    await masterChef.withdraw(poolId, ether('0.02'), { from: bob }); // alice +1/3 Reward  Bob + 2/3 Reward
    await masterChef.withdraw(poolId, ether('0.01'), { from: alice }); // alice +1 Reward
    expect(await sushi.balanceOf(alice)).to.be.bignumber.closeTo(
      SUSHI_REWARD_PER_BLOCK.mul(new BN('7')).div(new BN('3')),
      TOLERANCE
    );
    expect(await sushi.balanceOf(bob)).to.be.bignumber.closeTo(
      SUSHI_REWARD_PER_BLOCK.mul(new BN('2')).div(new BN('3')),
      TOLERANCE
    );
  });

  it('should allow positions without debt', async () => {
    // Deployer deposits 3 ETH to the bank
    await bank.deposit({ value: ether('3') });
    // Alice can take 0 debt ok
    await bank.work(
      0,
      goblin.address,
      ether('0'),
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('0.3'), from: alice }
    );
  });

  it('should not allow positions with debt less than MIN_DEBT_SIZE', async () => {
    // Deployer deposits 3 ETH to the bank
    await bank.deposit({ value: ether('3') });
    // Alice cannot take 0.3 debt because it is too small
    await expectRevert(
      bank.work(
        0,
        goblin.address,
        ether('0.3'),
        '0',
        web3.eth.abi.encodeParameters(
          ['address', 'bytes'],
          [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
        ),
        { value: ether('0.3'), from: alice }
      ),
      'too small debt size'
    );
  });

  it('should not allow positions with bad work factor', async () => {
    // Deployer deposits 3 ETH to the bank
    await bank.deposit({ value: ether('3') });
    // Alice cannot take 1 ETH loan but only put in 0.3 ETH
    await expectRevert(
      bank.work(
        0,
        goblin.address,
        ether('1'),
        '0',
        web3.eth.abi.encodeParameters(
          ['address', 'bytes'],
          [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
        ),
        { value: ether('0.3'), from: alice }
      ),
      'bad work factor'
    );
  });

  it('should not allow positions if Bank has less ETH than requested loan', async () => {
    // Alice cannot take 1 ETH loan because the contract does not have it
    await expectRevert(
      bank.work(
        0,
        goblin.address,
        ether('1'),
        '0',
        web3.eth.abi.encodeParameters(
          ['address', 'bytes'],
          [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
        ),
        { value: ether('1'), from: alice }
      ),
      'insufficient ETH in the bank'
    );
  });

  it('should work', async () => {
    // Deployer deposits 3 ETH to the bank
    const deposit = ether('3');
    await bank.deposit({ value: deposit });
    // Now Alice can take 1 ETH loan + 1 ETH of her to create a new position
    const loan = ether('1');
    await bank.work(
      0,
      goblin.address,
      loan,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('1'), from: alice }
    );
    // Her position should have ~2 ETH health (minus some small trading fee)
    assert.equal('1997459271062521105', await goblin.health('1'));
    await time.increase(time.duration.days(1));
    await goblin.reinvest({ from: eve });
    assertAlmostEqual(
      SUSHI_REWARD_PER_BLOCK.mul(new BN('2')).mul(REINVEST_BOUNTY_BPS).div(new BN('10000')),
      await sushi.balanceOf(eve)
    );
    await bank.deposit(); // Random action to trigger interest computation
    const healthDebt = await bank.positionInfo('1');
    expect(healthDebt[0]).to.be.bignumber.above(ether('2'));
    const interest = ether('0.3'); //30% interest rate
    assertAlmostEqual(healthDebt[1], interest.add(loan));
    assertAlmostEqual(await web3.eth.getBalance(bank.address), deposit.sub(loan));
    assertAlmostEqual(await bank.glbDebtVal(), interest.add(loan));
    const reservePool = interest.mul(RESERVE_POOL_BPS).div(new BN('10000'));
    assertAlmostEqual(reservePool, await bank.reservePool());
    assertAlmostEqual(deposit.add(interest).sub(reservePool), await bank.totalETH());
  });

  it('should not able to liquidate healthy position', async () => {
    // Deployer deposits 3 ETH to the bank
    const deposit = ether('3');
    await bank.deposit({ value: deposit });
    // Now Alice can take 1 ETH loan + 1 ETH of her to create a new position
    const loan = ether('1');
    await bank.work(
      0,
      goblin.address,
      loan,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('1'), from: alice }
    );
    // Her position should have ~2 ETH health (minus some small trading fee)
    await time.increase(time.duration.days(1));
    await goblin.reinvest({ from: eve });
    await bank.deposit(); // Random action to trigger interest computation

    // You can't liquidate her position yet
    await expectRevert(bank.kill('1'), "can't liquidate", { from: eve });
    await time.increase(time.duration.days(1));
    await expectRevert(bank.kill('1'), "can't liquidate", { from: eve });
  });

  it('should has correct interest rate growth', async () => {
    // Deployer deposits 3 ETH to the bank
    const deposit = ether('3');
    await bank.deposit({ value: deposit });
    // Now Alice can take 1 ETH loan + 1 ETH of her to create a new position
    const loan = ether('1');
    await bank.work(
      0,
      goblin.address,
      loan,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('1'), from: alice }
    );

    await time.increase(time.duration.days(1));
    await goblin.reinvest({ from: eve });
    await bank.deposit(); // Random action to trigger interest computation

    await time.increase(time.duration.days(1));
    await time.increase(time.duration.days(1));

    await bank.deposit(); // Random action to trigger interest computation
    const interest = ether('0.3'); //30% interest rate
    const reservePool = interest.mul(RESERVE_POOL_BPS).div(new BN('10000'));
    assertAlmostEqual(
      deposit
        .add(interest.sub(reservePool))
        .add(interest.sub(reservePool).mul(new BN(13)).div(new BN(10)))
        .add(interest.sub(reservePool).mul(new BN(13)).div(new BN(10))),
      await bank.totalETH()
    );
  });

  it('should be able to liquidate bad position', async () => {
    // Deployer deposits 3 ETH to the bank
    const deposit = ether('3');
    await bank.deposit({ value: deposit });
    // Now Alice can take 1 ETH loan + 1 ETH of her to create a new position
    const loan = ether('1');
    await bank.work(
      0,
      goblin.address,
      loan,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('1'), from: alice }
    );

    await time.increase(time.duration.days(1));
    await goblin.reinvest({ from: eve });
    await bank.deposit(); // Random action to trigger interest computation

    await time.increase(time.duration.days(1));
    await time.increase(time.duration.days(1));

    await bank.deposit(); // Random action to trigger interest computation
    const interest = ether('0.3'); //30% interest rate
    const reservePool = interest.mul(RESERVE_POOL_BPS).div(new BN('10000'));
    assertAlmostEqual(
      deposit
        .add(interest.sub(reservePool))
        .add(interest.sub(reservePool).mul(new BN(13)).div(new BN(10)))
        .add(interest.sub(reservePool).mul(new BN(13)).div(new BN(10))),
      await bank.totalETH()
    );

    const eveBefore = new BN(await web3.eth.getBalance(eve));

    // Now you can liquidate because of the insane interest rate
    await bank.kill('1', { from: eve });

    expect(new BN(await web3.eth.getBalance(eve))).to.be.bignumber.gt(eveBefore); //Should get rewards
    assertAlmostEqual(
      deposit
        .add(interest)
        .add(interest.mul(new BN(13)).div(new BN(10)))
        .add(interest.mul(new BN(13)).div(new BN(10))),
      await web3.eth.getBalance(bank.address)
    );
    assert.equal('0', await bank.glbDebtVal());
    assertAlmostEqual(
      reservePool.add(reservePool.mul(new BN(13)).div(new BN(10))).add(reservePool.mul(new BN(13)).div(new BN(10))),
      await bank.reservePool()
    );
    assertAlmostEqual(
      deposit
        .add(interest.sub(reservePool))
        .add(interest.sub(reservePool).mul(new BN(13)).div(new BN(10)))
        .add(interest.sub(reservePool).mul(new BN(13)).div(new BN(10))),
      await bank.totalETH()
    );

    // Alice creates a new position again
    console.log(
      (
        await bank.work(
          0,
          goblin.address,
          ether('1'),
          '0',
          web3.eth.abi.encodeParameters(
            ['address', 'bytes'],
            [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
          ),
          { value: ether('1'), from: alice }
        )
      ).receipt.gasUsed
    );
    // She can close position
    await bank.work(
      2,
      goblin.address,
      '0',
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [liqStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { from: alice }
    );
  });

  it('Should deposit and withdraw eth from Bank (bad debt case)', async () => {
    // Deployer deposits 10 ETH to the bank
    const deposit = ether('10');
    await bank.deposit({ value: deposit });
    expect(await bank.balanceOf(deployer)).to.be.bignumber.equal(deposit);

    // Bob borrows 2 ETH loan
    const loan = ether('2');
    await bank.work(
      0,
      goblin.address,
      loan,
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('1'), from: bob }
    );
    expect(await web3.eth.getBalance(bank.address)).to.be.bignumber.equal(deposit.sub(loan));
    expect(await bank.glbDebtVal()).to.be.bignumber.equal(loan);
    expect(await bank.totalETH()).to.be.bignumber.equal(deposit);

    // Alice deposits 2 ETH
    const aliceDeposit = ether('2');
    await bank.deposit({
      value: aliceDeposit,
      from: alice,
    });

    // check Alice gETH balance = 2/10 * 10 = 2 gETH
    assertAlmostEqual(aliceDeposit, await bank.balanceOf(alice));
    assertAlmostEqual(deposit.add(aliceDeposit), await bank.totalSupply());

    // Simulate ETH price is very high by swap fToken to ETH (reduce ETH supply)
    await sushi.approve(router.address, ether('100'));
    await router.swapExactTokensForTokens(ether('100'), '0', [sushi.address, weth.address], deployer, FOREVER);
    assertAlmostEqual(deposit.sub(loan).add(aliceDeposit), await web3.eth.getBalance(bank.address));

    // Alice liquidates Bob position#1
    let aliceBefore = new BN(await web3.eth.getBalance(alice));

    await bank.kill(1, { from: alice, gasPrice: 0 });
    let aliceAfter = new BN(await web3.eth.getBalance(alice));

    // Bank balance is increase by liquidation
    assertAlmostEqual('10002702699312215556', await web3.eth.getBalance(bank.address));
    // Alice is liquidator, Alice should receive 10% Kill prize
    // ETH back from liquidation 3002999235795062, 10% of 3002999235795062 is 300299923579506
    assertAlmostEqual('300299923579506', aliceAfter.sub(aliceBefore));

    // Alice withdraws 2 gETH
    aliceBefore = new BN(await web3.eth.getBalance(alice));
    await bank.withdraw(await bank.balanceOf(alice), {
      from: alice,
      gasPrice: 0,
    });
    aliceAfter = new BN(await web3.eth.getBalance(alice));

    // alice gots 2/12 * 10.002702699312215556 = 1.667117116552036
    assertAlmostEqual('1667117116552036400', aliceAfter.sub(aliceBefore));
  });

  it('should liquidate user position correctly', async () => {
    // Bob deposits 20 ETH
    await bank.deposit({
      value: ether('20'),
      from: bob,
    });

    // Position#1: Alice borrows 10 ETH loan
    await bank.work(
      0,
      goblin.address,
      ether('10'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('10'), from: alice }
    );

    await sushi.approve(router.address, ether('100'));

    // Price swing 10%
    // Add more token to the pool equals to sqrt(10*((0.1)**2) / 9) - 0.1 = 0.005409255338945984, (0.1 is the balance of token in the pool)
    await router.swapExactTokensForTokens(
      web3.utils.toWei('0.005409255338945984', 'ether'),
      '0',
      [sushi.address, weth.address],
      deployer,
      FOREVER
    );
    await expectRevert(bank.kill('1'), "can't liquidate");

    // Price swing 20%
    // Add more token to the pool equals to
    // sqrt(10*((0.10540925533894599)**2) / 8) - 0.10540925533894599 = 0.012441874858811944
    // (0.10540925533894599 is the balance of token in the pool)

    await router.swapExactTokensForTokens(
      web3.utils.toWei('0.012441874858811944', 'ether'),
      '0',
      [sushi.address, weth.address],
      deployer,
      FOREVER
    );
    await expectRevert(bank.kill('1'), "can't liquidate");

    // Price swing 23.43%
    // Existing token on the pool = 0.10540925533894599 + 0.012441874858811944 = 0.11785113019775793
    // Add more token to the pool equals to
    // sqrt(10*((0.11785113019775793)**2) / 7.656999999999999) - 0.11785113019775793 = 0.016829279312591913
    await router.swapExactTokensForTokens(
      web3.utils.toWei('0.016829279312591913', 'ether'),
      '0',
      [sushi.address, weth.address],
      deployer,
      FOREVER
    );
    await expectRevert(bank.kill('1'), "can't liquidate");

    // Price swing 30%
    // Existing token on the pool = 0.11785113019775793 + 0.016829279312591913 = 0.13468040951034985
    // Add more token to the pool equals to
    // sqrt(10*((0.13468040951034985)**2) / 7) - 0.13468040951034985 = 0.026293469053292218
    await router.swapExactTokensForTokens(
      web3.utils.toWei('0.026293469053292218', 'ether'),
      '0',
      [sushi.address, weth.address],
      deployer,
      FOREVER
    );

    // Bob can kill alice's position
    await bank.kill('1', { from: bob });
  });

  it('should reinvest correctly', async () => {
    // Set Bank's debt interests to 0% per year
    await config.setParams(
      ether('1'), // 1 ETH min debt size,
      '0', // 0% per year
      '1000', // 10% reserve pool
      '1000' // 10% Kill prize
    );

    // Set Reinvest bounty to 10% of the reward
    await goblin.setReinvestBountyBps('1000');

    // Bob deposits 10 ETH
    await bank.deposit({
      value: ether('10'),
      from: bob,
      gasPrice: 0,
    });

    // Alice deposits 12 ETH
    await bank.deposit({
      value: ether('10'),
      from: alice,
      gasPrice: 0,
    });

    // Position#1: Bob borrows 10 ETH loan
    await bank.work(
      0,
      goblin.address,
      ether('10'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('10'), from: bob, gasPrice: 0 }
    );

    // Position#2: Alice borrows 2 ETH loan
    await bank.work(
      0,
      goblin.address,
      ether('2'),
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: ether('1'), from: alice, gasPrice: 0 }
    );

    // ---------------- Reinvest#1 -------------------
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));

    let [goblinLPBefore, goblinDebtBefore] = await masterChef.userInfo(poolId, goblin.address);
    await goblin.reinvest({ from: eve });
    // Goblin receives 227999999998874730 sushi as a reward
    // Eve got 10% of 227999999998874730 sushi = 0.1 * 227999999998874730 = 22799999999887473 bounty
    assertAlmostEqual('22799999999887473', await sushi.balanceOf(eve));

    // Remaining Goblin reward = 227999999998874730 - 22799999999887473 = 205199999998987257 (~90% reward)
    // Convert 205199999998987257 sushi to 671683776318381694 ETH
    // Convert ETH to 1252466339860712438 LP token and stake
    let [goblinLPAfter, goblinDebtAfter] = await masterChef.userInfo(poolId, goblin.address);

    // LP tokens of goblin should be inceased from reinvestment
    // assertAlmostEqual("1252466339860712438", goblinLPAfter.sub(goblinLPBefore));
    expect(goblinLPAfter).to.be.bignumber.gt(goblinLPBefore);

    // Check Bob position info
    await goblin.health('1');
    let [bobHealth, bobDebtToShare] = await bank.positionInfo('1');
    expect(bobHealth).to.be.bignumber.gt(ether('20')); // Get Reward and increase health
    assertAlmostEqual(ether('10'), bobDebtToShare); //Why this is not 13??

    // Check Alice position info
    await goblin.health('2');
    let [aliceHealth, aliceDebtToShare] = await bank.positionInfo('2');
    expect(aliceHealth).to.be.bignumber.gt(ether('3')); // Get Reward and increase health
    assertAlmostEqual(ether('2'), aliceDebtToShare);

    // ---------------- Reinvest#2 -------------------
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));

    [goblinLPBefore, goblinDebtBefore] = await masterChef.userInfo(poolId, goblin.address);
    await goblin.reinvest({ from: eve });
    // Goblin receives 151999999999376792 sushi as a reward
    // Eve got 10% of 151999999999376792 sushi = 0.1 * 151999999999376792 = 15199999999937679 bounty
    // Now Eve have 22799999999887473 sushi (1st) + 15199999999937679 sushi (2nd) = 37999999999825152 sushi
    assertAlmostEqual('37999999999825152', await sushi.balanceOf(eve));

    // Remaining Goblin reward = 142858796296283038 - 14285879629628304 = 128572916666654734 (~90% reward)
    // Convert 128572916666654734 uni to 157462478899282341 ETH
    // Convert ETH to 5001669421841640 LP token
    [goblinLPAfter, goblinDebtAfter] = await masterChef.userInfo(poolId, goblin.address);
    // LP tokens of goblin should be inceased from reinvestment
    expect(goblinLPAfter).to.be.bignumber.gt(goblinLPBefore);

    // Check Bob position info
    [bobHealth, bobDebtToShare] = await bank.positionInfo('1');
    expect(bobHealth).to.be.bignumber.gt(ether('20')); // Get Reward and increase health
    assertAlmostEqual(ether('10'), bobDebtToShare);

    // Check Alice position info
    [aliceHealth, aliceDebtToShare] = await bank.positionInfo('2');
    expect(aliceHealth).to.be.bignumber.gt(ether('3')); // Get Reward and increase health
    assertAlmostEqual(ether('2'), aliceDebtToShare);

    // ---------------- Reinvest#3 -------------------
    // Wait for 1 day and someone calls reinvest
    await time.increase(time.duration.days(1));

    [goblinLPBefore, goblinDebtBefore] = await masterChef.userInfo(poolId, goblin.address);
    await goblin.reinvest({ from: eve });
    // Goblin receives 151999999999250105 uni as a reward
    // Eve got 10% of 151999999999250105 uni = 0.1 * 151999999999250105 = 15199999999925010 bounty
    // Now Eve have 22799999999887473 sushi (1st) + 15199999999937679 sushi (2nd) + 15199999999925010 sushi (3rd) = 53199999999750162 sushi
    assertAlmostEqual('53199999999750162', await sushi.balanceOf(eve));

    // Remaining Goblin reward = 142858796296283038 - 14285879629628304 = 128572916666654734 (~90% reward)
    // Convert 128572916666654734 uni to 74159218067697746 ETH
    // Convert ETH to 2350053120029788 LP token
    [goblinLPAfter, goblinDebtAfter] = await masterChef.userInfo(poolId, goblin.address);
    // LP tokens of goblin should be inceased from reinvestment
    expect(goblinLPAfter).to.be.bignumber.gt(goblinLPBefore);

    const bobBefore = new BN(await web3.eth.getBalance(bob));

    // Bob close position#1
    await bank.work(
      1,
      goblin.address,
      '0',
      '1000000000000000000000',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [liqStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { from: bob, gasPrice: 0 }
    );
    const bobAfter = new BN(await web3.eth.getBalance(bob));

    // Check Bob account
    expect(bobAfter).to.be.bignumber.gt(bobBefore); //Bob must be richer

    // Alice add ETH again
    await bank.work(
      2,
      goblin.address,
      0,
      '0', // max return = 0, don't return ETH to the debt
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [addStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { value: web3.utils.toWei('10', 'ether'), from: alice }
    );

    const aliceBefore = new BN(await web3.eth.getBalance(alice));
    // Alice close position#2
    await bank.work(
      2,
      goblin.address,
      '0',
      '1000000000000000000000000000000',
      web3.eth.abi.encodeParameters(
        ['address', 'bytes'],
        [liqStrat.address, web3.eth.abi.encodeParameters(['address', 'uint256'], [sushi.address, '0'])]
      ),
      { from: alice, gasPrice: 0 }
    );
    const aliceAfter = new BN(await web3.eth.getBalance(alice));

    // Check Alice account
    expect(aliceAfter).to.be.bignumber.gt(aliceBefore); //Alice must be richer
  });
});
