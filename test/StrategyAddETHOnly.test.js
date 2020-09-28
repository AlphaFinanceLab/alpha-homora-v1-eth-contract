const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyAllETHOnly = artifacts.require('StrategyAllETHOnly');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert } = require('@openzeppelin/test-helpers');

contract('StrategyAddETHOnly', ([deployer, alice, bob]) => {
  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    await this.token.mint(alice, '1000000000000000000');
    await this.token.mint(bob, '1000000000000000000');
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.strat = await StrategyAllETHOnly.new(this.router.address);
  });

  it('should revert on bad calldata', async () => {
    // Alice adds 1e17 MOCK + 1e18 WEI
    await this.token.approve(this.router.address, '100000000000000000', { from: alice });
    await this.router.addLiquidityETH(this.token.address, '100000000000000000', '0', '0', alice, FOREVER, {
      value: web3.utils.toWei('1', 'ether'),
      from: alice,
    });
    // Bob passes some bad calldata that can't be decoded
    await expectRevert(
      this.strat.execute(bob, '0', '0x1234', {
        value: web3.utils.toWei('0.1', 'ether'),
        from: bob,
      }),
      'revert'
    );
  });

  it('should convert all ETH to LP tokens at best rate', async () => {
    // Alice adds 1e17 MOCK + 1e18 WEI
    await this.token.approve(this.router.address, '100000000000000000', { from: alice });
    await this.router.addLiquidityETH(this.token.address, '100000000000000000', '0', '0', alice, FOREVER, {
      value: web3.utils.toWei('1', 'ether'),
      from: alice,
    });
    // Bob uses AddETHOnly strategy to add 1e17 WEI
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '0']),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: bob,
      }
    );
    assert.equal('15411526978189516', await this.lp.balanceOf(bob));
    assert.equal('0', await this.lp.balanceOf(this.strat.address));
    assert.equal('0', await this.token.balanceOf(this.strat.address));
    // Bob uses AddETHOnly strategy to add another 1e17 WEI
    await this.lp.transfer(this.strat.address, '15411526978189516', { from: bob });
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '10000000000000000']),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: bob,
      }
    );
    assert.equal('30136025967736232', await this.lp.balanceOf(bob));
    assert.equal('0', await this.lp.balanceOf(this.strat.address));
    assert.equal('0', await this.token.balanceOf(this.strat.address));
    // Bob uses AddETHOnly yet again, but now with an unreasonable min LP request
    await expectRevert(
      this.strat.execute(
        bob,
        '0',
        web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, '50000000000000000']),
        {
          value: web3.utils.toWei('0.1', 'ether'),
          from: bob,
        }
      ),
      'insufficient LP tokens received'
    );
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
