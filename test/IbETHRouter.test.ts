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
import { ecsign, bufferToHex } from 'ethereumjs-util';
import { utils, BigNumber } from 'ethers';
const { BN, ether } = require('@openzeppelin/test-helpers');

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

const PERMIT_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')
);

function getDomainSeparator(name: string, tokenAddress: string) {
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        utils.keccak256(
          utils.toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
        ),
        utils.keccak256(utils.toUtf8Bytes(name)),
        utils.keccak256(utils.toUtf8Bytes('1')),
        31337,
        tokenAddress,
      ]
    )
  );
}

async function getApprovalDigest(
  token: UniswapV2PairInstance,
  approve: {
    owner: string;
    spender: string;
    value: BigNumber;
  },
  nonce: BigNumber,
  deadline: BigNumber
): Promise<string> {
  const name = await token.name();
  const DOMAIN_SEPARATOR = getDomainSeparator(name, token.address);
  return utils.keccak256(
    utils.solidityPack(
      ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
      [
        '0x19',
        '0x01',
        DOMAIN_SEPARATOR,
        utils.keccak256(
          utils.defaultAbiCoder.encode(
            ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
            [
              PERMIT_TYPEHASH,
              approve.owner,
              approve.spender,
              approve.value.toString(),
              nonce.toString(),
              deadline.toString(),
            ]
          )
        ),
      ]
    )
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
    token = await MockERC20.new('MOCK', 'MOCK');
    await token.mint(deployer, ether('10000'));
    await token.mint(alice, ether('100'));
    config = await SimpleBankConfig.new(MIN_DEBT_SIZE, INTEREST_RATE, RESERVE_POOL_BPS, KILL_PRIZE_BPS);
    bank = await Bank.new(config.address);
    await bank.deposit({ value: ether('100') });
    await bank.deposit({ from: alice, value: ether('10') });
    expect(await web3.eth.getBalance(bank.address)).to.be.bignumber.equal(ether('110'));
    expect(await bank.balanceOf(alice)).to.be.bignumber.equal(ether('10'));
    expect(await bank.balanceOf(deployer)).to.be.bignumber.equal(ether('100'));

    ibETHRouter = await IbETHRouter.new(factory.address, bank.address);

    // Send some ETH to Bank to create interest
    // This make 1 ibETH = 1.045454545454545454 ETH
    await web3.eth.sendTransaction({ from: deployer, to: bank.address, value: ether('5') });

    // Create ibETH-MOCK pair
    await factory.createPair(bank.address, token.address);
    lp = await UniswapV2Pair.at(await factory.getPair(token.address, bank.address));

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
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
  });

  it('should be able to add liquidity with excess ETH and get dust ETH back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    const aliceBalanceBefore = new BN(await web3.eth.getBalance(alice));
    // Adding 100 MOCK requires adding 1 ibETH
    // Deposit 1.045454545454545454 ETH, yield 1 ibETH
    // Only need 1.045454545454545454 ETH, but add 10 ETH
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('10'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceBalanceBefore.sub(ether('1.045454545454545454')));
  });

  it('should be able to add liquidity with excess MOCK and has some leftover', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    const aliceBalanceBefore = await token.balanceOf(alice);
    // Add 100 MOCK requires adding 1 ibETH
    // Deposit 0.1 ETH, yield 0.095652173913043478 ibETH
    // Only need 9.565217391304347800 MOCK, but add 100 MOCK
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('0.1'),
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceBalanceBefore.sub(ether('9.5652173913043478')));
  });

  it('should be able to add liquidity to ibETH-MOCK with ibETH and MOCK', async () => {
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceIbETHBalanceBefore = await bank.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await bank.approve(ibETHRouter.address, ether('1'), { from: alice });
    // Add 100 MOCK requires adding 1 ibETH
    await ibETHRouter.addLiquidity(token.address, bank.address, ether('100'), ether('1'), 0, 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.above(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.sub(ether('100')));
    expect(await bank.balanceOf(alice)).to.be.bignumber.equal(aliceIbETHBalanceBefore.sub(ether('1')));
  });

  it('should be able to remove liquidity and get ETH and MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidity should get 1 ETH and 95.65217391304347800 MOCK back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    await ibETHRouter.removeLiquidityETH(token.address, aliceLPBalanceBefore, 0, 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    assertAlmostEqual(await token.balanceOf(alice), aliceTokenBalanceBefore.add(ether('95.65217391304347800')));
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore.add(ether('1')));
  });

  it('should be able to remove liquidity and get ibETH and MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await bank.approve(ibETHRouter.address, ether('1'), { from: alice });
    await ibETHRouter.addLiquidity(token.address, bank.address, ether('100'), ether('1'), 0, 0, alice, FOREVER, {
      from: alice,
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceIbETHBalanceBefore = await bank.balanceOf(alice);
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Add liquidity with 1 ibETH and 100 MOCK
    // So, removeLiquidity should get 1 ibETH and 100 MOCK back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    await ibETHRouter.removeLiquidity(token.address, bank.address, aliceLPBalanceBefore, 0, 0, alice, FOREVER, {
      from: alice,
    });
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.add(ether('100')));
    expect(await bank.balanceOf(alice)).to.be.bignumber.equal(aliceIbETHBalanceBefore.add(ether('1')));
  });

  it('should be able to remove liquidity with permit and get ETH and MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Sign permit
    const nonce = await lp.nonces(alice);
    const digest = await getApprovalDigest(
      lp,
      { owner: alice, spender: ibETHRouter.address, value: aliceLPBalanceBefore },
      nonce,
      new BN(FOREVER)
    );
    const msgHash = Buffer.from(digest.slice(2), 'hex');
    const { v, r, s } = ecsign(msgHash, Buffer.from(process.env.PRIVATE_KEY_2 as string, 'hex'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidity should get 1 ETH and 95.65217391304347800 MOCK back
    await ibETHRouter.removeLiquidityETHWithPermit(
      token.address,
      aliceLPBalanceBefore,
      0,
      0,
      alice,
      new BN(FOREVER),
      false,
      v,
      bufferToHex(r),
      bufferToHex(s),
      {
        from: alice,
      }
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    assertAlmostEqual(await token.balanceOf(alice), aliceTokenBalanceBefore.add(ether('95.65217391304347800')));
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore.add(ether('1')));
  });

  it('should be able to remove liquidity supporting fee on transfer and get ETH and MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidity should get 1 ETH and 95.65217391304347800 MOCK back
    await lp.approve(ibETHRouter.address, aliceLPBalanceBefore, { from: alice });
    await ibETHRouter.removeLiquidityETHSupportingFeeOnTransferTokens(
      token.address,
      aliceLPBalanceBefore,
      0,
      0,
      alice,
      FOREVER,
      {
        from: alice,
      }
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    assertAlmostEqual(await token.balanceOf(alice), aliceTokenBalanceBefore.add(ether('95.65217391304347800')));
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore.add(ether('1')));
  });

  it('should be able to remove liquidity with permit supporting fee on transfer and get ETH and MOCK back', async () => {
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    await ibETHRouter.addLiquidityETH(token.address, ether('100'), 0, 0, alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    const aliceLPBalanceBefore = await lp.balanceOf(alice);
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    expect(aliceLPBalanceBefore).to.be.bignumber.above(ether('0'));
    const nonce = await lp.nonces(alice);
    const digest = await getApprovalDigest(
      lp,
      { owner: alice, spender: ibETHRouter.address, value: aliceLPBalanceBefore },
      nonce,
      new BN(FOREVER)
    );
    const msgHash = Buffer.from(digest.slice(2), 'hex');
    const { v, r, s } = ecsign(msgHash, Buffer.from(process.env.PRIVATE_KEY_2 as string, 'hex'));
    // Deposit 1 ETH, yield 0.95652173913043478 ibETH
    // Add liquidity with 0.95652173913043478 ibETH and 95.65217391304347800 MOCK
    // So, removeLiquidity should get 1 ETH and 95.65217391304347800 MOCK back
    await ibETHRouter.removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
      token.address,
      aliceLPBalanceBefore,
      0,
      0,
      alice,
      new BN(FOREVER),
      false,
      v,
      bufferToHex(r),
      bufferToHex(s),
      {
        from: alice,
      }
    );
    expect(await lp.balanceOf(alice)).to.be.bignumber.equal(ether('0'));
    assertAlmostEqual(await token.balanceOf(alice), aliceTokenBalanceBefore.add(ether('95.65217391304347800')));
    assertAlmostEqual(new BN(await web3.eth.getBalance(alice)), aliceETHBalanceBefore.add(ether('1')));
  });

  it('should be able to swap exact ETH for MOCK', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceBalanceBefore = await token.balanceOf(alice);
    // 1 ETH, yield 0.95652173913043478 ibETH
    // so should get slightly less than 95.6 MOCK back (94.464356006673746911)
    await ibETHRouter.swapExactETHForTokens(0, [bank.address, token.address], alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceBalanceBefore.add(ether('94.464356006673746911')));
  });

  it('should be able to swap exact ETH for MOCK', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceBalanceBefore = await token.balanceOf(alice);
    // 1 ETH, yield 0.95652173913043478 ibETH
    // so should get slightly less than 95.6 MOCK back (94.464356006673746911)
    await ibETHRouter.swapExactETHForTokens(0, [bank.address, token.address], alice, FOREVER, {
      from: alice,
      value: ether('1'),
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceBalanceBefore.add(ether('94.464356006673746911')));
  });

  it('should be able to swap MOCK for exact ETH', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 0.9 ETH, yield 0.860869565 ibETH
    // so should use slightly more than 86.08 MOCK (87.095775529377361063)
    await ibETHRouter.swapTokensForExactETH(ether('0.9'), ether('100'), [token.address, bank.address], alice, FOREVER, {
      from: alice,
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.add(ether('0.9')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(
      aliceTokenBalanceBefore.sub(ether('87.095775529377361063'))
    );
  });

  it('should be able to swap exact MOCK for ETH', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 100 MOCK, yield 1 ibETH
    // so should get slightly less than 1.045 MOCK (1.032028854142382266)
    await ibETHRouter.swapExactTokensForETH(ether('100'), 0, [token.address, bank.address], alice, FOREVER, {
      from: alice,
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.add(ether('1.032028854142382266')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.sub(ether('100')));
  });

  it('should be able to swap ETH for exact MOCK', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    // 100 MOCK need ~1 ibETH
    // Deposit 1.045454545454545454 ETH, yield 1 ibETH
    // so should get add slightly more than 1.045 ETH (1.059192269185886403 ETH)
    await ibETHRouter.swapETHForExactTokens(ether('100'), [bank.address, token.address], alice, FOREVER, {
      from: alice,
      value: ether('1.1'),
    });
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1.059192269185886403')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.add(ether('100')));
  });

  it('should be able to swap exact ETH for MOCK supporting fee on transfer', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    // 1 ETH, yield 0.95652173913043478 ibETH
    // so should get slightly less than 95.6 MOCK back (94.464356006673746911 ETH)
    await ibETHRouter.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0,
      [bank.address, token.address],
      alice,
      FOREVER,
      {
        from: alice,
        value: ether('1'),
      }
    );
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.sub(ether('1')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(
      aliceTokenBalanceBefore.add(ether('94.464356006673746911'))
    );
  });

  it('should be able to swap exact MOCK for ETH supporting fee on transfer', async () => {
    const aliceETHBalanceBefore = new BN(await web3.eth.getBalance(alice));
    const aliceTokenBalanceBefore = await token.balanceOf(alice);
    await token.approve(ibETHRouter.address, ether('100'), { from: alice });
    // 100 MOCK, yield 1 ibETH
    // so should get slightly less than 1.045 MOCK (1.032028854142382266)
    await ibETHRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
      ether('100'),
      0,
      [token.address, bank.address],
      alice,
      FOREVER,
      {
        from: alice,
      }
    );
    assertAlmostEqual(await web3.eth.getBalance(alice), aliceETHBalanceBefore.add(ether('1.032028854142382266')));
    expect(await token.balanceOf(alice)).to.be.bignumber.equal(aliceTokenBalanceBefore.sub(ether('100')));
  });
});
