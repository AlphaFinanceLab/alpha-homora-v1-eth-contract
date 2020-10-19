const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyWithdrawMinimizeTrading = artifacts.require('StrategyWithdrawMinimizeTrading');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert, BN } = require('@openzeppelin/test-helpers');

contract('StrategyWithdrawMinimizeTrading', ([deployer, alice, bob]) => {
  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    await this.token.mint(alice, '1000000000000000000');
    await this.token.mint(bob, '1000000000000000000');
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.strat = await StrategyWithdrawMinimizeTrading.new(this.router.address);
  });

  context('It should convert LP tokens and farming token', () => {
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

    it('should revert, Bob uses withdraw minimize trading strategy to turn LPs back to farming with an unreasonable expectation', async () => {
      // Bob uses withdraw minimize trading strategy to turn LPs back to farming with an unreasonable expectation
      await expectRevert(
        this.strat.execute(
          bob,
          '1000000000000000000',
          web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('2', 'ether')]),
          {
            from: bob,
          }
        ),
        'insufficient farming tokens received'
      );
    });

    it('should convert all LP tokens back to ETH and farming token (debt = received ETH)', async () => {
      const bobEthBefore = new BN(await web3.eth.getBalance(bob));
      const bobTokenBefore = await this.token.balanceOf(bob);
      // Bob uses liquidate strategy to turn LPs back to ETH and farming token
      await this.strat.execute(
        bob,
        '1000000000000000000', // debt 1 ETH
        web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('0.001', 'ether')]),
        {
          from: bob,
          gasPrice: 0,
        }
      );
      const bobEthAfter = new BN(await web3.eth.getBalance(bob));
      const bobTokenAfter = await this.token.balanceOf(bob);
      assert.equal('0', await this.lp.balanceOf(this.strat.address));
      assert.equal('0', await this.lp.balanceOf(bob));
      assert.equal('1000000000000000000', bobEthAfter.sub(bobEthBefore)); // 1 ETH
      assert.equal('100000000000000000', bobTokenAfter.sub(bobTokenBefore)); // 0.1 farming token
    });

    it('should convert all LP tokens back to ETH and farming token (debt < received ETH)', async () => {
      const bobEthBefore = new BN(await web3.eth.getBalance(bob));
      const bobTokenBefore = await this.token.balanceOf(bob);
      // Bob uses liquidate strategy to turn LPs back to ETH and farming token
      await this.strat.execute(
        bob,
        '500000000000000000', // debt 0.5 ETH
        web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('0.001', 'ether')]),
        {
          from: bob,
          gasPrice: 0,
        }
      );
      const bobEthAfter = new BN(await web3.eth.getBalance(bob));
      const bobTokenAfter = await this.token.balanceOf(bob);
      assert.equal('0', await this.lp.balanceOf(this.strat.address));
      assert.equal('0', await this.lp.balanceOf(bob));
      assert.equal('1000000000000000000', bobEthAfter.sub(bobEthBefore)); // 1 ETH
      assert.equal('100000000000000000', bobTokenAfter.sub(bobTokenBefore)); // 0.1 farming token
    });

    it('should convert all LP tokens back to ETH and farming token (debt > received ETH, farming token is enough to convert to ETH)', async () => {
      const bobEthBefore = new BN(await web3.eth.getBalance(bob));
      const bobTokenBefore = await this.token.balanceOf(bob);
      // Bob uses liquidate strategy to turn LPs back to ETH and farming token
      await this.strat.execute(
        bob,
        '1200000000000000000', // debt 1.2 ETH
        web3.eth.abi.encodeParameters(['address', 'uint256'], [this.token.address, web3.utils.toWei('0.001', 'ether')]),
        {
          from: bob,
          gasPrice: 0,
        }
      );
      const bobEthAfter = new BN(await web3.eth.getBalance(bob));
      const bobTokenAfter = await this.token.balanceOf(bob);
      assert.equal('0', await this.lp.balanceOf(this.strat.address));
      assert.equal('0', await this.lp.balanceOf(bob));
      assert.equal('1200000000000000000', bobEthAfter.sub(bobEthBefore)); // 1.2 ETH
      assert.equal('74924774322968906', bobTokenAfter.sub(bobTokenBefore)); // 0.1 - 0.025 = 0.075 farming token
    });

    it('should revert (debt > received ETH, farming token is not enough to convert to ETH)', async () => {
      await expectRevert(
        this.strat.execute(
          bob,
          '2000000000000000000', // debt 2 ETH
          web3.eth.abi.encodeParameters(
            ['address', 'bytes'],
            [
              this.strat.address,
              web3.eth.abi.encodeParameters(
                ['address', 'uint256'],
                [this.token.address, web3.utils.toWei('0.001', 'ether')]
              ),
            ]
          ),
          {
            from: bob,
            gasPrice: 0,
          }
        ),
        'revert'
      );
    });
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
