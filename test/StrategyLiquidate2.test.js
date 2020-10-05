const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyLiquidate2 = artifacts.require('StrategyLiquidate2');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert, BN } = require('@openzeppelin/test-helpers');

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


contract.only('StrategyLiquidate2', ([deployer, alice, bob]) => {
  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    await this.token.mint(alice, '1000000000000000000');
    await this.token.mint(bob, '1000000000000000000');
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.strat = await StrategyLiquidate2.new(this.router.address);
  });

  context("It should convert LP tokens and farming token", () => {
    beforeEach(async () => {
      // Alice adds 1e17 MOCK + 1e18 WEI
      await this.token.approve(this.router.address, '100000000000000000', { from: alice });
      await this.router.addLiquidityETH(this.token.address, '100000000000000000', '0', '0', alice, FOREVER, {
        value: web3.utils.toWei('1', 'ether'),
        from: alice,
      });
      // Bob tries to add 1e18 MOCK + 1e18 WEI (but obviously can only add 1e17 MOCK)
      await this.token.approve(this.router.address, '1000000000000000000', { from: bob });
      await this.router.addLiquidityETH(this.token.address, '1000000000000000000', '0', '0', bob, FOREVER, {
        value: web3.utils.toWei('1', 'ether'),
        from: bob,
      });
      assert.equal('900000000000000000', await this.token.balanceOf(bob));
      assert.equal('316227766016837933', await this.lp.balanceOf(bob));
      await this.lp.transfer(this.strat.address, '316227766016837933', { from: bob });
    });

    it('should revert, Bob uses liquidate strategy to turn all LPs back to ETH with an unreasonable expectation', async () => {
      // Bob uses liquidate strategy to turn all LPs back to ETH but with an unreasonable expectation
      await expectRevert(
        this.strat.execute(
          bob,
          '0',
          web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('2', 'ether')]),
          {
            from: bob,
          }
        ),
        'insufficient ETH received'
      );
    });

    it('should convert all LP tokens back to ETH and farming token (debt = received ETH)', async () => {
      const bobEthBefore = new BN(await web3.eth.getBalance(bob));
      // Bob uses liquidate strategy to turn LPs back to ETH and farming token
      await this.strat.execute(
        bob,
        '1000000000000000000', // debt 1 ETH
        web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('0', 'ether')]),
        {
          from: bob,
          gasPrice: 0,
        }
      );
      const bobEthAfter = new BN(await web3.eth.getBalance(bob));
      assert.equal('0', await this.lp.balanceOf(this.strat.address));
      assert.equal('0', await this.lp.balanceOf(bob));
      assert.equal('1000000000000000000', bobEthAfter.sub(bobEthBefore).toString());
      assert.equal('1000000000000000000', await this.token.balanceOf(bob));
    });
  })

  // it('should only allow owner to withdraw loss ERC20 tokens', async () => {
  //   await this.token.transfer(this.strat.address, '100', { from: alice });
  //   await expectRevert(
  //     this.strat.recover(this.token.address, alice, '50', { from: alice }),
  //     'Ownable: caller is not the owner'
  //   );
  //   await this.strat.recover(this.token.address, deployer, '50');
  //   assert.equal('50', await this.token.balanceOf(deployer));
  // });
});
