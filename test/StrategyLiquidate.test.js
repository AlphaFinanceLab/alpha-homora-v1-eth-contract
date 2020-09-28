const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyLiquidate = artifacts.require('StrategyLiquidate');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert } = require('@openzeppelin/test-helpers');

contract('StrategyLiquidate', ([deployer, alice, bob]) => {
  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    await this.token.mint(alice, '1000000000000000000');
    await this.token.mint(bob, '1000000000000000000');
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.strat = await StrategyLiquidate.new(this.router.address);
  });

  it('should convert all LP tokens back to ETH', async () => {
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
    // Bob uses liquidate strategy to turn all LPs back to ETH but with an unreasonable expectation
    await this.lp.transfer(this.strat.address, '316227766016837933', { from: bob });
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
    // Bob uses liquidate strategy to turn all LPs back to ETH with a sane minimum value
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('1', 'ether')]),
      {
        from: bob,
      }
    );
    assert.equal('0', await this.lp.balanceOf(this.strat.address));
    assert.equal('0', await this.lp.balanceOf(bob));
    assert.equal('500751126690035053', await this.weth.balanceOf(this.lp.address));
    assert.equal('200000000000000000', await this.token.balanceOf(this.lp.address));
  });

  it('should only allow owner to withdraw loss ERC20 tokens', async () => {
    await this.token.transfer(this.strat.address, '100', { from: alice });
    await expectRevert(
      this.strat.recover(this.token.address, alice, '50', { from: alice }),
      'Ownable: caller is not the owner'
    );
    await this.strat.recover(this.token.address, deployer, '50');
    assert.equal('50', await this.token.balanceOf(deployer));
  });
});
