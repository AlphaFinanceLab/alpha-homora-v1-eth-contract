import {
  MockERC20Instance,
  UniswapV2FactoryInstance,
  UniswapV2Router02Instance,
  UniswapV2PairInstance,
  BankInstance,
  SimpleBankConfigInstance,
  WETHInstance,
  IbETHRouterInstance,
} from '../typechain';

const { BN, ether, expectRevert } = require('@openzeppelin/test-helpers');

const UniswapV2Factory = artifacts.require('UniswapV2Factory');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const UniswapV2Pair = artifacts.require('UniswapV2Pair');
const Bank = artifacts.require('Bank');
const SimpleBankConfig = artifacts.require('SimpleBankConfig');
const IbETHRouter = artifacts.require('IbETHRouter');

const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

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

contract('IbETHRouter', ([deployer, alice]) => {
  const RESERVE_POOL_BPS = new BN('1000'); // 10% reserve pool
  const KILL_PRIZE_BPS = new BN('1000'); // 10% Kill prize
  const INTEREST_RATE = new BN('3472222222222'); // 30% per year
  const MIN_DEBT_SIZE = ether('1'); // 1 ETH min debt size
  const DEFAULT_ETH_BALANCE = ether('10000');

  let factory: UniswapV2FactoryInstance;
  let weth: WETHInstance;
  let router: UniswapV2Router02Instance;
  let ibETHRouter: IbETHRouterInstance;
  let token: MockERC20Instance;
  let lp: UniswapV2PairInstance;
  let config: SimpleBankConfigInstance;
  let bank: BankInstance;

  beforeEach(async () => {
    factory = await UniswapV2Factory.new(deployer);
    weth = await WETH.new();
    router = await UniswapV2Router02.new(factory.address, weth.address);
    token = await MockERC20.new('ALPHA', 'ALPHA');
    await token.mint(deployer, ether('10000'));
    await token.mint(alice, ether('100'));
    config = await SimpleBankConfig.new(MIN_DEBT_SIZE, INTEREST_RATE, RESERVE_POOL_BPS, KILL_PRIZE_BPS);
    bank = await Bank.new(config.address);
    await bank.deposit({ value: ether('100') });
    await bank.deposit({ from: alice, value: ether('10') });
    expect(await web3.eth.getBalance(bank.address)).to.be.bignumber.equal(ether('110'));
    expect(await bank.balanceOf(alice)).to.be.bignumber.equal(ether('10'));
    expect(await bank.balanceOf(deployer)).to.be.bignumber.equal(ether('100'));

    // Send some ETH to Bank to create interest
    // This make 1 ibETH = 1.045454545454545454 ETH
    await web3.eth.sendTransaction({ from: deployer, to: bank.address, value: ether('5') });

    // Create ibETH-MOCK pair
    await factory.createPair(bank.address, token.address);
    lp = await UniswapV2Pair.at(await factory.getPair(token.address, bank.address));

    ibETHRouter = await IbETHRouter.new(router.address, bank.address, token.address);

    // Deployer adds 10000 MOCK + 100 ibETH, price 100 MOCK : 1 ibETH
    await token.approve(router.address, ether('10000'));
    await bank.approve(router.address, ether('100'));
    await router.addLiquidity(token.address, bank.address, ether('10000'), ether('100'), '0', '0', deployer, FOREVER);
  });

  it('should receive some interest when redeem ibETH', async () => {
    await bank.withdraw(await bank.balanceOf(alice), { from: alice });
    expect(await bank.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(alice))).to.be.bignumber.above(DEFAULT_ETH_BALANCE);
  });

  it('should be able to add liquidity to ibETH-MOCK with ETH and MOCK', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when add liquidity to ibETH-MOCK with too little ETH', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    expectRevert(
      ibETHRouter.addLiquidityETH(ether('100'), 0, ether('50'), alice, FOREVER, {
        from: alice,
        value: ether('1'),
      }),
      'IbETHRouter: require more ETH than amountETHmin'
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when add liquidity to ibETH-MOCK with too little MOCK', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    expectRevert(
      ibETHRouter.addLiquidityETH(ether('100'), ether('1000'), 0, alice, FOREVER, {
        from: alice,
        value: ether('1'),
      }),
      'UniswapV2Router: INSUFFICIENT_A_AMOUNT'
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity with excess ETH and get dust ETH back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    // Adding 100 MOCK requires adding 1 ibETH
    // Deposit 1.045454545454545454 ETH, yield 1 ibETH
    // Only need 1.045454545454545454 ETH, but add 10 ETH
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('10'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
    assertAlmostEqual(
      new BN(await web3.eth.getBalance(alice)),
      aliceETHBalanceBefore.sub(ether('1.045454545454545454'))
    );
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.sub(ether('100')));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity with excess MOCK and has some leftover', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    // Add 100 MOCK requires adding 1 ibETH
    // Deposit 0.1 ETH, yield 0.095652173913043478 ibETH
    // Only need 9.565217391304347800 MOCK, but add 100 MOCK
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('0.1'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore.sub(ether('0.1')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(
      aliceTokenBalanceBefore.sub(ether('9.565217391304347800'))
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with only ibETH', async () => {
    const aliceIbETHBalanceBefore = await bank.balanceOf(alice);
    await bank.approve(ibETHRouter.address, ether('5'), { from: alice });
    // Sending 5 ibETH, 5*0.5 = 2.5 ibETH should be used to swap optimally for MOCK
    // Should get slightly less than 250 MOCK from swap.
    // So should add liquidity total of ~250 MOCK and ~2.5 ibETH and get ~25 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimal(ether('5'), 0, 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('24.657979004220051623'));
    expect(await bank.balanceOf(alice)).to.be.bignumber.closeTo(aliceIbETHBalanceBefore.sub(ether('5')), new BN('1'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with only MOCK', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Sending 50 MOCK, 50*0.5 = 25 MOCK should be used to swap optimally for ibETH
    // Should get slightly less than 0.25 ibETH from swap.
    // So should add liquidity total of ~25 MOCK and ~0.25 ibETH and get ~2.5 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimal(0, ether('50'), 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('2.493131844569650832'));
    expect(await token.balanceOf(alice)).to.be.bignumber.closeTo(aliceTokenBalanceBefore.sub(ether('50')), new BN('1'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with more ibETH than required', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceIbETHBalanceBefore = await bank.balanceOf(alice);
    await bank.approve(ibETHRouter.address, ether('5'), { from: alice });
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Add 50 MOCK requires adding 0.5 ibETH
    // Sending 5 ibETH, (5-0.5)*0.5 = 2.25 ibETH should be used to swap optimally for MOCK
    // Should get slightly less than 225 MOCK from swap.
    // So should add liquidity total of ~275 MOCK and ~2.75 ibETH and get ~27.5 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimal(ether('5'), ether('50'), 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('27.220190062987375140'));
    expect(await token.balanceOf(alice)).to.be.bignumber.closeTo(aliceTokenBalanceBefore.sub(ether('50')), new BN('1'));
    expect(await bank.balanceOf(alice)).to.be.bignumber.closeTo(aliceIbETHBalanceBefore.sub(ether('5')), new BN('1'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with more MOCK than required', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceIbETHBalanceBefore = await bank.balanceOf(alice);
    await bank.approve(ibETHRouter.address, ether('0.1'), { from: alice });
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Add 0.1 ibETH requires adding 10 MOCK
    // Sending 50 MOCK, (50-10)*0.5 = 20 MOCK should be used to swap optimally for ibETH
    // Should get slightly less than 0.2 ibETH from swap.
    // So should add liquidity total of ~30 MOCK and ~0.3 ibETH and get ~3 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimal(ether('0.1'), ether('50'), 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('2.995004473319087933'));
    expect(await token.balanceOf(alice)).to.be.bignumber.closeTo(aliceTokenBalanceBefore.sub(ether('50')), new BN('1'));
    expect(await bank.balanceOf(alice)).to.be.bignumber.closeTo(aliceIbETHBalanceBefore.sub(ether('0.1')), new BN('1'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when add liquidity optimally with less lpToken than minumum specified', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceIbETHBalanceBefore = await bank.balanceOf(alice);
    await bank.approve(ibETHRouter.address, ether('0.1'), { from: alice });
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Add 0.1 ibETH requires adding 10 MOCK
    // Sending 50 MOCK, (50-10)*0.5 = 20 MOCK should be used to swap optimally for ibETH
    // Should get slightly less than 0.2 ibETH from swap.
    // So should add liquidity total of ~30 MOCK and ~0.3 ibETH and get ~3 lpToken, but require at least 100 lpToken
    expectRevert(
      ibETHRouter.addLiquidityTwoSidesOptimal(ether('0.1'), ether('50'), ether('100'), alice, FOREVER, {
        from: alice,
      }),
      'IbETHRouter: receive less lpToken than amountLPMin'
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore);
    expect(await bank.balanceOf(alice)).to.be.bignumber.equal(aliceIbETHBalanceBefore);
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with only ETH', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    // Depositing 5 ETH yield 4.7826087 ibETH
    // Sending 4.7826087 ibETH, 4.7826087*0.5 = 2.39130435 ibETH should be used to swap optimally for MOCK
    // Should get slightly less than 239.130435 MOCK from swap.
    // So should add liquidity total of ~239.13 MOCK and ~2.39 ibETH and get ~23.9 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimalETH(0, 0, alice, FOREVER, {
      from: alice,
      value: ether('5'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('23.598262739768173752'));
    expect(new BN(await web3.eth.getBalance(alice))).to.be.bignumber.closeTo(
      aliceETHBalanceBefore.sub(ether('5')),
      ether('0.01')
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with more ETH than required', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Add 50 MOCK requires adding 0.5 ibETH
    // Depositing 5 ETH yield 4.7826087 ibETH
    // Sending 4.7826087 ibETH, (4.7826087-0.5)*0.5 = 2.14130435 ibETH should be used to swap optimally for MOCK
    // Should get slightly less than 214.130435 MOCK from swap.
    // So should add liquidity total of ~264 MOCK and ~2.64 ibETH and get ~26.4 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimalETH(ether('50'), 0, alice, FOREVER, {
      from: alice,
      value: ether('5'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('26.157827816948699953'));
    expect(await token.balanceOf(alice)).to.be.bignumber.closeTo(aliceTokenBalanceBefore.sub(ether('50')), new BN('1'));
    expect(new BN(await web3.eth.getBalance(alice))).to.be.bignumber.closeTo(
      aliceETHBalanceBefore.sub(ether('5')),
      ether('0.01')
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to add liquidity optimally with less ETH than required', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Depositing 0.1 ETH yield 0.095652174 ibETH
    // Add 0.095652174 ibETH requires adding 9.5652174 MOCK
    // Sending 50 MOCK, (50-9.5652174)*0.5 = 20.2173913 MOCK should be used to swap optimally for ibETH
    // Should get slightly less than 0.202 ibETH from swap.
    // So should add liquidity total of ~29.7826087 MOCK and ~0.297 ibETH and get ~2.97 lpToken
    await ibETHRouter.addLiquidityTwoSidesOptimalETH(ether('50'), 0, alice, FOREVER, {
      from: alice,
      value: ether('0.1'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('2.973189122784300740'));
    expect(await token.balanceOf(alice)).to.be.bignumber.closeTo(aliceTokenBalanceBefore.sub(ether('50')), new BN('1'));
    expect(new BN(await web3.eth.getBalance(alice))).to.be.bignumber.closeTo(
      aliceETHBalanceBefore.sub(ether('0.1')),
      ether('0.01')
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when add liquidity optimally ETH with less lpToken than minumum specified', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    await token.approve(ibETHRouter.address, ether('50'), { from: alice });
    // Add 50 MOCK requires adding 0.5 ibETH
    // Depositing 5 ETH yield 4.7826087 ibETH
    // Sending 4.7826087 ibETH, (4.7826087-0.5)*0.5 = 2.14130435 ibETH should be used to swap optimally for MOCK
    // Should get slightly less than 214.130435 MOCK from swap.
    // So should add liquidity total of ~264 MOCK and ~2.64 ibETH and get ~26.4 lpToken
    expectRevert(
      ibETHRouter.addLiquidityTwoSidesOptimalETH(ether('50'), ether('100'), alice, FOREVER, {
        from: alice,
        value: ether('5'),
      }),
      'IbETHRouter: receive less lpToken than amountLPMin'
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore);
    expect(new BN(await web3.eth.getBalance(alice))).to.be.bignumber.closeTo(aliceETHBalanceBefore, ether('0.01'));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to remove liquidity and get ETH and MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.652173913043478 MOCK
    // So, removeLiquidity should get 1 ETH and 95.652173913043478 MOCK back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    await ibETHRouter.removeLiquidityETH(aliceLPBalanceBefore, 0, 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(
      aliceTokenBalanceBefore.add(ether('95.652173913043478200'))
    );
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore.add(ether('1')));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when remove liquidity and receive too little ETH', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidity should get 1 ETH and 95.65217391304347800 MOCK back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    expectRevert(
      ibETHRouter.removeLiquidityETH(aliceLPBalanceBefore, 0, ether('100'), alice, FOREVER, {
        from: alice,
      }),
      'IbETHRouter: receive less ETH than amountETHmin'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when remove liquidity and receive too little MOCK', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidity should get 1 ETH and 95.65217391304347800 MOCK back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    expectRevert(
      ibETHRouter.removeLiquidityETH(aliceLPBalanceBefore, ether('1000'), 0, alice, FOREVER, {
        from: alice,
      }),
      'UniswapV2Router: INSUFFICIENT_A_AMOUNT'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to remove liquidity (all MOCK) and get only MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidityAllAlpha should get slightly less than 2*95.65217391304347800 = 191.304348 MOCK (190.116529919717225111)
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    await ibETHRouter.removeLiquidityAllAlpha(aliceLPBalanceBefore, 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(
      aliceTokenBalanceBefore.add(ether('190.116529919717225111'))
    );
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore);
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when remove liquidity (all MOCK) and receive too little MOCK', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidityAllAlpha should get slightly less than 2*95.65217391304347800 = 191.304348 MOCK (190.116529919717225111)back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    expectRevert(
      ibETHRouter.removeLiquidityAllAlpha(aliceLPBalanceBefore, ether('1000'), alice, FOREVER, {
        from: alice,
      }),
      'IbETHRouter: receive less Alpha than amountAlphaMin'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to swap exact ETH for MOCK', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceBalanceBefore = await token.balanceOf(alice);
    // 1 ETH, yield 0.95652173913043478 ibETH
    // so should get slightly less than 95.6 MOCK back (94.464356006673746911)
    await ibETHRouter.swapExactETHForAlpha(0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceBalanceBefore.add(ether('94.464356006673746911')));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when swap exact ETH for MOCK and receive too little MOCK', async () => {
    expectRevert(
      ibETHRouter.swapExactETHForAlpha(ether('1000'), alice, FOREVER, {
        from: alice,
        value: ether('1'),
      }),
      'UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to swap MOCK for exact ETH', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 0.9 ETH, yield 0.860869565 ibETH
    // so should use slightly more than 86.08 MOCK (87.095775529377361165)
    await ibETHRouter.swapAlphaForExactETH(ether('0.9'), ether('100'), alice, FOREVER, {
      from: alice,
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.add(ether('0.9')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(
      aliceTokenBalanceBefore.sub(ether('87.095775529377361165'))
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when swap MOCK for exact ETH given too little MOCK', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 0.9 ETH, yield 0.860869565 ibETH
    // so should use slightly more than 86.08 MOCK (87.095775529377361063)
    expectRevert(
      ibETHRouter.swapAlphaForExactETH(ether('0.9'), ether('1'), alice, FOREVER, {
        from: alice,
      }),
      'UniswapV2Router: EXCESSIVE_INPUT_AMOUNT'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to swap exact MOCK for ETH', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 100 MOCK, yield 1 ibETH
    // so should get slightly less than 1.045 MOCK (1.032028854142382266)
    await ibETHRouter.swapExactAlphaForETH(ether('100'), 0, alice, FOREVER, {
      from: alice,
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.add(ether('1.032028854142382266')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.sub(ether('100')));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when swap exact MOCK for ETH and receive too little ETH', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 100 MOCK, yield 1 ibETH
    // so should get slightly less than 1.045 MOCK (1.032028854142382266)
    expectRevert(
      ibETHRouter.swapExactAlphaForETH(ether('100'), ether('1000'), alice, FOREVER, {
        from: alice,
      }),
      'IbETHRouter: receive less ETH than amountETHmin'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to swap ETH for exact MOCK with dust ETH back', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    // 100 MOCK need ~1 ibETH
    // Deposit 1.045454545454545454 ETH, yield 1 ibETH
    // so should get add slightly more than 1.045 ETH (1.059192269185886404 ETH)
    await ibETHRouter.swapETHForExactAlpha(ether('100'), alice, FOREVER, {
      from: alice,
      value: ether('1.1'),
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1.059192269185886404')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.add(ether('100')));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should be able to swap ETH for exact MOCK with no dust ETH back', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    // 100 MOCK need ~1 ibETH
    // Deposit 1.045454545454545454 ETH, yield 1 ibETH
    // so should get add slightly more than 1.045 ETH (1.059192269185886404 ETH)
    await ibETHRouter.swapETHForExactAlpha(ether('100'), alice, FOREVER, {
      from: alice,
      value: ether('1.059192269185886403'),
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1.059192269185886404')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.add(ether('100')));
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });

  it('should revert when swap ETH for exact MOCK given too little ETH', async () => {
    expectRevert(
      ibETHRouter.swapETHForExactAlpha(ether('100'), alice, FOREVER, {
        from: alice,
        value: ether('0.1'),
      }),
      'UniswapV2Router: EXCESSIVE_INPUT_AMOUNT'
    );
    expect(await token.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(await bank.balanceOf(ibETHRouter.address)).to.be.bignumber.equal(ether('0'));
    expect(new BN(await web3.eth.getBalance(ibETHRouter.address))).to.be.bignumber.equal(ether('0'));
  });
});
