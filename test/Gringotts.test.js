const MockUniswapV2Factory = artifacts.require('MockUniswapV2Factory');
const MockUniswapV2Pair = artifacts.require('MockUniswapV2Pair');
const Gringotts = artifacts.require('Gringotts');
const SimpleGringottsConfig = artifacts.require('SimpleGringottsConfig');
const UniswapV2Router02 = artifacts.require('UniswapV2Router02');
const StrategyAllETHOnly = artifacts.require('StrategyAllETHOnly');
const StrategyLiquidate = artifacts.require('StrategyLiquidate');
const WETH = artifacts.require('WETH');
const MockERC20 = artifacts.require('MockERC20');

const FOREVER = '2000000000';
const { expectRevert } = require('@openzeppelin/test-helpers');

contract('Gringotts', ([deployer, alice, bob]) => {
  beforeEach(async () => {
    this.factory = await MockUniswapV2Factory.new(deployer);
    this.weth = await WETH.new();
    this.router = await UniswapV2Router02.new(this.factory.address, this.weth.address);
    this.token = await MockERC20.new('MOCK', 'MOCK');
    await this.token.mint(alice, '100000000000000000000');
    await this.token.mint(bob, '100000000000000000000');
    await this.factory.createPair(this.weth.address, this.token.address);
    this.lp = await MockUniswapV2Pair.at(await this.factory.getPair(this.token.address, this.weth.address));
    this.addStrat = await StrategyAllETHOnly.new(this.router.address);
    this.liqStrat = await StrategyLiquidate.new(this.router.address);
    // this.config = await SimpleGringottsConfig.new();
    // this.bank = await Gringotts.new(this.config.address);
  });

  it('should be easy', async () => {
    console.log('it works!');
  });
});
