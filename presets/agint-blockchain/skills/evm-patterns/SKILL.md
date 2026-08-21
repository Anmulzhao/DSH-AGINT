---
name: evm-patterns
description: EVM 合约模式速查库：ERC-20 / ERC-721 / ERC-1155 / ERC-4626 token 标准、Proxy（transparent / UUPS / beacon）、Access Control（Ownable / AccessControl / Roles）、Oracle 集成（Chainlink / Uniswap TWAP）、闪电贷（AAVE / dYdX / Uniswap V3）、Multicall 与批处理、签名（EIP-712 / EIP-2612 permit）、Gas 高效存储模式。Solidity 0.8+ 语法糖与最佳实践。任务涉及 ERC 标准、合约可升级性、权限设计、价格预言机集成、链下签名验证等时自动加载。
---

# EVM Patterns — 合约模式速查库

> 智进·区块链 专属 skill。任务涉及 ERC 标准、合约可升级性、权限设计、Oracle、闪电贷、签名验证时自动加载。

## 边界

- **适用**：选型合约模式、画架构、写样板、写库函数。
- **不适用**：漏洞排查（→ web3-debug）、DeFi 机制（→ defi-mechanics）、钱包/签名流程（→ wallet-security）。

## 一、Token 标准速查

### 1.1 ERC-20（同质化）

```solidity
// 用 OpenZeppelin 一行导入
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract MyToken is ERC20, ERC20Burnable, ERC20Pausable, Ownable {
    constructor() ERC20("MyToken", "MTK") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    function mint(address to, uint amount) external onlyOwner {
        _mint(to, amount);
    }
}
```

**已知坑**：
- USDT 不返回 bool（用 `SafeERC20.safeTransfer` 包装）
- USDT 有 `approve` race（必须先 `approve(0)` 再 `approve(amount)`）
- 部分 token 有 transfer fee / blacklist / hooks（Safemoon、PAXG）
- decimals 不是 18（Dai 用 18，USDC/USDT 用 6，WBTC 用 8）

### 1.2 ERC-721（NFT）

```solidity
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract MyNFT is ERC721, ERC721Enumerable, ERC721URIStorage, Ownable {
    constructor() ERC721("MyNFT", "MNFT") Ownable(msg.sender) {}

    function _baseURI() internal pure override returns (string memory) {
        return "ipfs://QmYourCID/";
    }

    function safeMint(address to, uint tokenId, string memory uri)
        external onlyOwner
    {
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    // 必须 override 全部 hooks
    function _update(address to, uint tokenId, address auth)
        internal override(ERC721, ERC721Enumerable) returns (address)
    {
        return super._update(to, tokenId, auth);
    }
    function _increaseBalance(address account, uint128 amount)
        internal override(ERC721Enumerable) returns (uint128)
    {
        return super._increaseBalance(account, amount);
    }
    function tokenURI(uint tokenId)
        public view override(ERC721, ERC721URIStorage) returns (string memory)
    {
        return super.tokenURI(tokenId);
    }
    function supportsInterface(bytes4 id)
        public view override(ERC721, ERC721Enumerable, ERC721URIStorage) returns (bool)
    {
        return super.supportsInterface(id);
    }
}
```

### 1.3 ERC-1155（多代币）

```solidity
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract My1155 is ERC1155, Ownable {
    constructor() ERC1155("ipfs://QmYourCID/{id}.json") Ownable(msg.sender) {}

    function mint(address to, uint id, uint amount, bytes memory data)
        external onlyOwner
    {
        _mint(to, id, amount, data);
    }
}
```

适用场景：游戏道具、批量 airdrop、NFT + 同质化代币混合。

### 1.4 ERC-4626（Tokenized Vault）

```solidity
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract MyVault is ERC4626, ERC20, Ownable {
    constructor(IERC20 asset_)
        ERC20("Vault Share", "vSHARE")
        ERC4626(asset_)
        Ownable(msg.sender)
    {}

    // 自定义存款逻辑（如折溢价、费率）
    function _deposit(address caller, address receiver, uint assets, uint shares)
        internal virtual override returns (uint actualShares, uint actualAssets)
    {
        // 可加存款费、滑点保护等
        actualShares = previewDeposit(assets);
        actualAssets = assets;
        super._deposit(caller, receiver, actualAssets, actualShares);
    }
}
```

适用场景：收益聚合器（Yearn V3）、借贷协议存款凭证（Lido stETH）、封装资产（wBTC）。

### 1.5 速查表

| 标准 | 用途 | 关键接口 | 已知坑 |
|---|---|---|---|
| ERC-20 | 同质化代币 | transfer, approve, transferFrom | USDT 不返回 bool |
| ERC-721 | NFT | safeTransferFrom, setApprovalForAll | gas 高、需考虑 enumeration |
| ERC-1155 | 多代币 | safeBatchTransferFrom | receiver 需要 onERC1155Received |
| ERC-4626 | 收益金库 | deposit, mint, withdraw, redeem | 通胀/通缩 token 处理 |
| ERC-2612 | permit (gasless approve) | permit, nonces | 必须 EIP-712 |
| ERC-2981 | NFT 版税 | royaltyInfo | marketplaces 实现不一 |
| ERC-4907 | NFT 租借 | setUser, userOf | 业务约束强 |
| ERC-6551 | NFT 绑定的 TBA | createAccount | 较新 |

## 二、Proxy 模式

### 2.1 透明代理（Transparent Proxy）

```solidity
// 部署：proxy (delegatecall to impl) + ProxyAdmin + Implementation
// 用户交互只走 proxy，admin 通过 ProxyAdmin 升级
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract MyContractV1 { /* 业务逻辑 */ }

contract Deploy {
    function deploy() external returns (address) {
        MyContractV1 impl = new MyContractV1();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            msg.sender,  // initialAdmin (ProxyAdmin owner)
            abi.encodeWithSelector(MyContractV1.initialize.selector)
        );
        return address(proxy);
    }
}
```

特点：admin 通过 ProxyAdmin 升级；用户调用全部 delegatecall 到 impl。

### 2.2 UUPS（Universal Upgradeable Proxy Standard）

```solidity
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

contract MyContractV1 is Initializable, UUPSUpgradeable, Ownable {
    function initialize() external initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImpl) internal override onlyOwner {}

    // 业务函数
}

// 部署 proxy 时直接 delegatecall
```

特点：升级逻辑在实现合约里，proxy 更轻量；必须保留 `_authorizeUpgrade` 和 upgrade 函数。

### 2.3 Beacon

```solidity
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

contract MyBeacon is UpgradeableBeacon {
    constructor(address impl_) UpgradeableBeacon(impl_) Ownable(msg.sender) {}

    function upgrade(address newImpl) external onlyOwner {
        upgradeTo(newImpl);
    }
}

// 多个 proxy 共用一个 beacon → 一次升级全部生效
```

适用场景：克隆工厂（OpenSea Seaport、Uniswap V3 NFT positions）。

### 2.4 Diamond Standard（EIP-2535）

- 多个 facet（实现合约）通过 selector-to-facet mapping 共享 storage
- 适用超大合约（> 24k gas 上限）或模块化升级
- 比 UUPS 复杂得多，建议非必要不用

### 2.5 选型速查

| 场景 | 推荐 |
|---|---|
| 单一合约可升级 | UUPS（最省 gas + 简洁） |
| 多个相同合约批量升级 | Beacon |
| 需要 admin 与用户隔离 | Transparent |
| 超大合约 / 模块化 | Diamond（慎重） |
| 一次性合约 | 不可升级（最安全） |

### 2.6 升级安全守则

1. **storage layout 不能改**：只能在末尾追加新变量；不能改类型、不能重排、不能删除
2. **构造函数不可用**：用 `initializer` + `Initializable`
3. **`selfdestruct` 不能在 impl 里**：会破坏所有 proxy
4. **测试 storage layout**：`forge inspect <ContractName> storageLayout`
5. **升级前在测试网跑一遍完整测试 + storage slot diff**

## 三、Access Control

### 3.1 Ownable（单 owner）

```solidity
import "@openzeppelin/contracts/access/Ownable.sol";
contract C is Ownable {
    function adminOnly() external onlyOwner { /* */ }
}
```

适用：单人管理；不适合团队 / DAO。

### 3.2 AccessControl（多角色）

```solidity
import "@openzeppelin/contracts/access/AccessControl.sol";

contract C is AccessControl {
    bytes32 public constant ADMIN = keccak256("ADMIN_ROLE");
    bytes32 public constant MINTER = keccak256("MINTER_ROLE");

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);  // super admin
        _grantRole(ADMIN, msg.sender);
        _grantRole(MINTER, msg.sender);
    }

    function mint(address to, uint amount) external onlyRole(MINTER) {
        _mint(to, amount);
    }
}
```

适用：团队 / DAO / 多角色系统。

### 3.3 多签（Gnosis Safe）

```solidity
// 关键 admin 函数通过 Safe 多签调用
// Safe Contract: https://github.com/safe-global/safe-smart-account
```

适用：treasury / 合约升级 / 参数变更。强烈推荐 ≥ 5M 资产用 Safe。

### 3.4 Timelock（延迟执行）

```solidity
import "@openzeppelin/contracts/governance/TimelockController.sol";

TimelockController timelock = new TimelockController(
    2 days,           // minDelay
    proposers,        // 提案人
    executors,        // 执行人
    msg.sender        // admin
);
```

适用：所有 admin 操作强制 24-72h 延迟，给用户退出机会。

### 3.5 选型速查

| 规模 | 推荐 |
|---|---|
| 个人项目 | Ownable |
| 团队 / 多角色 | AccessControl |
| 资产 ≥ 100k USD | AccessControl + Safe 多签 |
| 资产 ≥ 1M USD | AccessControl + Safe + Timelock |
| 协议 / DAO | Governor + Timelock |

## 四、Oracle 集成

### 4.1 Chainlink Price Feed

```solidity
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract PriceConsumer {
    AggregatorV3Interface public priceFeed;

    constructor(address _feed) { priceFeed = AggregatorV3Interface(_feed); }

    function getLatestPrice() public view returns (int) {
        (, int price,, uint updatedAt,) = priceFeed.latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale price");  // 1h
        require(price > 0, "negative price");
        return price;
    }
}
```

**已知坑**：
- Chainlink 也有失效场景（LUNA 崩盘时）；组合多个源（Chainlink + Uniswap TWAP）
- 不同链的 feed 地址不同（mainnet vs Sepolia vs Arbitrum）
- `latestRoundData` 返回 5 个字段，必须全部检查（updatedAt > 0, answeredInRound > roundId）
- `decimals()` 通常是 8

### 4.2 Uniswap V3 TWAP

```solidity
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

contract TwapOracle {
    function consult(IUniswapV3Pool pool, uint secondsAgo) external view returns (int24) {
        require(secondsAgo > 0, "secondsAgo > 0");
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = uint32(secondsAgo);
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(tickCumulativesDelta / int56(uint56(secondsAgo)));
        return arithmeticMeanTick;
    }
}
```

**已知坑**：
- 必须用 ≥ 30 分钟窗口防操纵
- 需要流动性足够（TVL ≥ 1M USD 否则易操纵）
- 注意 token0/token1 顺序

### 4.3 速查

| 场景 | 推荐 |
|---|---|
| 主网资产、大流动性 | Chainlink（多源聚合） |
| 长尾资产 / DEX 集成 | Uniswap V3 TWAP + Chainlink 兜底 |
| 借贷协议（防操纵） | Chainlink 主 + Uniswap TWAP 验证 |
| 内部测试 | Mock oracle |

## 五、闪电贷（Flash Loan）

### 5.1 AAVE V3

```solidity
import "@aave/v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/v3-core/contracts/interfaces/IPoolAddressesProvider.sol";

contract MyFlashLoan is FlashLoanSimpleReceiverBase {
    constructor(IPoolAddressesProvider provider) FlashLoanSimpleReceiverBase(provider) {}

    function executeFlashLoan(address asset, uint amount) external {
        POOL.flashLoanSimple(address(this), asset, amount, "", 0);
        // 收到回调 executeOperation，必须还钱 + 0.05% fee
    }

    function executeOperation(
        address asset, uint amount, uint premium, address initiator, bytes calldata params
    ) external returns (bool) {
        // 1. 套利 / 清算 / 抵押 swap
        // 2. 还钱
        IERC20(asset).approve(address(POOL), amount + premium);
        return true;
    }
}
```

### 5.2 Uniswap V3

```solidity
import "@uniswap/v3-periphery/contracts/flashloan/UniswapV3Flashloan.sol";

// 通过 SwapRouter 走 flash(...)
// 详见 https://docs.uniswap.org/contracts/v3/guides/flash-loans
```

### 5.3 dYdX Solo Margin

- 较旧，实现复杂，新项目首选 AAVE

### 5.4 速查

| 提供方 | 费用 | 流动性 | 实现 |
|---|---|---|---|
| AAVE V3 | 0.05% | 最大 | FlashLoanSimpleReceiverBase |
| Uniswap V3 | 0% | 中等 | SwapRouter.flash |
| Balancer V2 | 0% | 中等 | IFlashLoanRecipient |
| dYdX | 0% | 大 | Solo Margin |

## 六、Multicall（批处理）

### 6.1 Multicall3（标准）

```solidity
import "multicall3/Multicall3.sol";

Multicall3 multicall = new Multicall3();

Multicall3.Call[] memory calls = new Multicall3.Call[](2);
calls[0] = Multicall3.Call({target: tokenA, callData: abi.encodeWithSelector(IERC20.balanceOf.selector, user)});
calls[1] = Multicall3.Call({target: tokenB, callData: abi.encodeWithSelector(IERC20.balanceOf.selector, user)});

Multicall3.Result[] memory results = multicall.aggregate3(calls);
// 在用户链下聚合查询，省 gas
```

### 6.2 合约内批处理

```solidity
function batchTransfer(address[] calldata tos, uint[] calldata amounts) external {
    require(tos.length == amounts.length);
    for (uint i = 0; i < tos.length; i++) {
        _transfer(msg.sender, tos[i], amounts[i]);
    }
}
```

## 七、EIP-712 签名（链下签名 / Permit / MetaTx）

### 7.1 EIP-712 domain

```solidity
bytes32 public DOMAIN_SEPARATOR;

constructor() {
    DOMAIN_SEPARATOR = keccak256(abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256(bytes("MyProtocol")),
        keccak256(bytes("1")),
        block.chainid,
        address(this)
    ));
}
```

### 7.2 Permit（EIP-2612）

```solidity
// 链下签名：owner 签名 approve 给 spender
// 链上验证：spender 提交签名 + 调用 permit
function permit(address owner, address spender, uint value, uint deadline, uint8 v, bytes32 r, bytes32 s) external {
    require(block.timestamp <= deadline);
    bytes32 digest = keccak256(abi.encodePacked(
        "\x19\x01", DOMAIN_SEPARATOR,
        keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            owner, spender, value, nonces[owner]++, deadline
        ))
    ));
    address recovered = ecrecover(digest, v, r, s);
    require(recovered == owner);
    _approve(owner, spender, value);
}
```

### 7.3 通用 EIP-712 验证

```solidity
function verify(bytes32 structHash, bytes memory signature, address expectedSigner) internal view returns (bool) {
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    address recovered = ECDSA.recover(digest, signature);
    return recovered == expectedSigner;
}
```

## 八、Solidity 0.8+ 语法糖与最佳实践

### 8.1 custom errors（替代 require 字符串）

```solidity
// 节省 gas + 更清晰的错误类型
error InsufficientBalance(uint available, uint required);
error Unauthorized(address caller);
error Expired(uint deadline);

function withdraw(uint amount) external {
    uint bal = balances[msg.sender];
    if (bal < amount) revert InsufficientBalance(bal, amount);
    if (msg.sender != owner) revert Unauthorized(msg.sender);
    balances[msg.sender] = bal - amount;
}
```

### 8.2 NatSpec 注释

```solidity
/// @notice 提取用户的存款
/// @param amount 提取数量（wei）
/// @dev 仅 owner 可调用
function withdraw(uint amount) external onlyOwner { /* */ }
```

### 8.3 接收 ETH

```solidity
receive() external payable { /* 接受 ETH */ }
fallback() external payable { /* fallback */ }
```

### 8.4 safe math

- Solidity ≥ 0.8 默认 SafeMath，溢出自动 revert
- 仅在确定不会溢出时用 `unchecked { }` 块

### 8.5 库 / abstract / interface

```solidity
library SafeMath {
    function add(uint a, uint b) internal pure returns (uint) {
        unchecked { return a + b; }  // 已知不溢出
    }
}
abstract contract Base { function _hook() internal virtual; }
interface IERC20 { function transfer(address to, uint amount) external returns (bool); }
```

---

## 关联阅读

- [[web3-debug]] — 漏洞排查 / Gas 优化
- [[defi-mechanics]] — DeFi 协议机制
- [[wallet-security]] — EIP-712 / 4337
- [[chain-rpc-toolkit]] — ethers.js / viem 用法模式