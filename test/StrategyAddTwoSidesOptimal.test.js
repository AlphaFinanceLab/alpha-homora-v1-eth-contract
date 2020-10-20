const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyAddTwoSidesOptimal = artifacts.require('StrategyAddTwoSidesOptimal');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');
const { BN } = require('@openzeppelin/test-helpers');

contract('StrategyAddTwoSidesOptimal', ([deployer, alice, bob, goblin]) => {
  const MAX_ROUNDING_ERROR = '4';

  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    await this.token.mint(alice, web3.utils.toWei('0.1', 'ether'));
    await this.token.mint(bob, web3.utils.toWei('0.1', 'ether'));
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.strat = await StrategyAddTwoSidesOptimal.new(this.router.address, goblin);
    // Alice adds 1e17 MOCK + 1e18 WEI
    await this.token.approve(this.router.address, web3.utils.toWei('0.1', 'ether'), {
      from: alice,
    });
    await this.router.addLiquidityETH(this.token.address, web3.utils.toWei('0.1', 'ether'), '0', '0', alice, FOREVER, {
      value: web3.utils.toWei('1', 'ether'),
      from: alice,
    });
  });

  it('should only allow goblin to call execute', async () => {
    await expectRevert(
      this.strat.execute(
        bob,
        '0',
        web3.eth.abi.encodeParameters(['address', 'uint256', 'uint256'], [this.token.address, '0', '0']),
        {
          value: web3.utils.toWei('0.1', 'ether'),
          from: bob,
        }
      ),
      'caller is not the goblin'
    );

    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(['address', 'uint256', 'uint256'], [this.token.address, '0', '0']),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: goblin,
      }
    );
  });

  it('should revert on bad calldata', async () => {
    // Bob passes some bad calldata that can't be decoded
    await expectRevert(
      this.strat.execute(bob, '0', '0x1234', {
        value: web3.utils.toWei('0.1', 'ether'),
        from: goblin,
      }),
      'revert'
    );
  });

  it('should convert all ETH to LP tokens at best rate', async () => {
    // Bob uses AddTwoSidesOptimal strategy to add 1e17 WEI
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(['address', 'uint256', 'uint256'], [this.token.address, '0', '10000000000000000']),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: goblin,
      }
    );
    const goblinBefore = await this.lp.balanceOf(goblin);
    expect(goblinBefore).to.be.bignumber.above('0');
    expect(await this.lp.balanceOf(this.strat.address)).to.be.bignumber.equal('0');
    expect(await this.token.balanceOf(this.strat.address)).to.be.bignumber.below(MAX_ROUNDING_ERROR);
    // Bob uses AddTwoSidesOptimal strategy to add another 1e17 WEI
    await this.lp.transfer(this.strat.address, goblinBefore, {
      from: goblin,
    });
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(['address', 'uint256', 'uint256'], [this.token.address, '0', '10000000000000000']),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: goblin,
      }
    );
    expect(await this.lp.balanceOf(goblin)).to.be.bignumber.above(goblinBefore);
    expect(await this.lp.balanceOf(this.strat.address)).to.be.bignumber.equal('0');
    expect(await this.token.balanceOf(this.strat.address)).to.be.bignumber.below(new BN(MAX_ROUNDING_ERROR * 2));
  });

  it('should convert all MOCK to LP tokens at best rate', async () => {
    // Bob uses AddTwoSidesOptimal strategy to add 0.5e17 MOCK
    await this.token.approve(this.strat.address, web3.utils.toWei('0.05', 'ether'), {
      from: bob,
    });
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'uint256', 'uint256'],
        [this.token.address, web3.utils.toWei('0.05', 'ether'), '10000000000000000']
      ),
      {
        from: goblin,
      }
    );
    const goblinBefore = await this.lp.balanceOf(goblin);
    expect(await this.lp.balanceOf(goblin)).to.be.bignumber.above('0');
    expect(await this.lp.balanceOf(this.strat.address)).to.be.bignumber.equal('0');
    expect(await this.token.balanceOf(this.strat.address)).to.be.bignumber.below(MAX_ROUNDING_ERROR);
    // Bob uses AddTwoSidesOptimal strategy to add another 1e17 WEI
    await this.lp.transfer(this.strat.address, await this.lp.balanceOf(bob), {
      from: bob,
    });
    await this.token.approve(this.strat.address, web3.utils.toWei('0.05', 'ether'), {
      from: bob,
    });
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'uint256', 'uint256'],
        [this.token.address, web3.utils.toWei('0.05', 'ether'), '10000000000000000']
      ),
      {
        from: goblin,
      }
    );
    expect(await this.lp.balanceOf(goblin)).to.be.bignumber.above(goblinBefore);
    expect(await this.lp.balanceOf(this.strat.address)).to.be.bignumber.equal('0');
    expect(await this.token.balanceOf(this.strat.address)).to.be.bignumber.below(new BN(MAX_ROUNDING_ERROR * 2));
  });

  it('should convert some ETH and some MOCK to LP tokens at best rate', async () => {
    // Bob uses AddTwoSidesOptimal strategy to add 1e17 WEI
    await this.token.approve(this.strat.address, web3.utils.toWei('0.05', 'ether'), {
      from: bob,
    });
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'uint256', 'uint256'],
        [this.token.address, web3.utils.toWei('0.05', 'ether'), '10000000000000000']
      ),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: goblin,
      }
    );
    const goblinBefore = await this.lp.balanceOf(goblin);
    expect(goblinBefore).to.be.bignumber.above('0');
    expect(await this.lp.balanceOf(this.strat.address)).to.be.bignumber.equal('0');
    expect(await this.token.balanceOf(this.strat.address)).to.be.bignumber.below(MAX_ROUNDING_ERROR);
    // Bob uses AddTwoSidesOptimal strategy to add another 1e17 WEI
    await this.lp.transfer(this.strat.address, await this.lp.balanceOf(bob), {
      from: bob,
    });
    await this.token.approve(this.strat.address, web3.utils.toWei('0.05', 'ether'), {
      from: bob,
    });
    await this.strat.execute(
      bob,
      '0',
      web3.eth.abi.encodeParameters(
        ['address', 'uint256', 'uint256'],
        [this.token.address, web3.utils.toWei('0.05', 'ether'), '10000000000000000']
      ),
      {
        value: web3.utils.toWei('0.1', 'ether'),
        from: goblin,
      }
    );
    expect(await this.lp.balanceOf(goblin)).to.be.bignumber.above(goblinBefore);
    expect(await this.lp.balanceOf(this.strat.address)).to.be.bignumber.equal('0');
    expect(await this.token.balanceOf(this.strat.address)).to.be.bignumber.below(new BN(MAX_ROUNDING_ERROR * 2));
  });

  it('should only allow owner to withdraw loss ERC20 tokens', async () => {
    await this.token.mint(alice, '100');
    await this.token.transfer(this.strat.address, '100', { from: alice });
    await expectRevert(
      this.strat.recover(this.token.address, alice, '50', { from: alice }),
      'Ownable: caller is not the owner'
    );
    await this.strat.recover(this.token.address, deployer, '50');
    expect(await this.token.balanceOf(deployer)).to.be.bignumber.equal('50');
  });
});
