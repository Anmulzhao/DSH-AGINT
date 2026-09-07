# AGINT / dsh web · Docker 部署

日常只需要管 `docker/docker-compose.yml` 一个文件 —— 其他都是它的依赖。镜像用 `node:lts`，**host 网络模式**；所有会变的状态（dsh 安装、profile、23 个插件、凭证、会话、wiki 数据）**全部落到 NAS 数据盘**。换机器只要搬这块盘。

---

## 持久化模型

整个持久层就是一个 bind mount，挂到容器内 `/persist`：

```
/persist                               ← NAS 上一个普通文件夹，挂进容器
├── dsh-install/                       ← dsh 装在这里（不是容器可写层！）
│    ├── bin/dsh
│    └── lib/node_modules/@deepseek-ai/dsh/
├── dsh-home/                          ← $DSH_HOME（profile、插件、凭证、会话）
│    ├── profiles/web/
│    │    ├── plugins/agint-*           ← AGINT 23 个插件
│    │    └── cordis.patch.yml
│    ├── .credentials.yaml              ← API key 在这（首次网页配置后落盘）
│    └── sentinel.lease
└── agint-data/                        ← $AGINT_HOME（wiki / dreams / reviews）
     ├── wiki/
     ├── dreams/
     └── reviews/
```

**换机器只要搬 `/persist`**：拷过去 → `docker compose up -d` → 浏览器打开，所有状态原样回来。

---

## 关于网络：host 模式

容器直接用宿主机网络栈。dsh web 监听 `0.0.0.0:3080` 就等同于 NAS 的 `0.0.0.0:3080`。

- 不需要端口映射（不用 `ports:`）
- 浏览器从 NAS 自己访问就 `http://localhost:3080`
- 从局域网别的机器访问就 `http://NAS_IP:3080`，但要确认 dssh 的信任围栏（详见底部）

**唯一约束**：NAS 的 3080 别被别的服务占用（被占就改 compose 里 `DSH_PORT=3080`）。

---

## 三步跑起来

**第 1 步**：在仓库根目录（`D:\DSH\project\DSH-AGINT`）建一个 `.env` 文件。**部署到绿联 NAS 时**改这一行：

```
DATA_DISK=/volume1/agint-system       ← 改：NAS 上 dsh 全家桶要住的文件夹
```

(其他都用默认值，不用写。)

> `.env` 已被 `.gitignore` 忽略，不会进 git。

**第 2 步**：构建镜像（首次几分钟，之后秒级）

```bash
docker compose -f docker/docker-compose.yml build
```

**第 3 步**：启动

```bash
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml logs -f     # 看首次启动（要装 dsh + 23 个插件）
```

浏览器打开 **http://localhost:3080**，首次进设置填 API key。

> 首次启动要 1–2 分钟（entrypoint 干四件事：装 dsh → 初始化 web profile → 同步 23 个插件 → 补 zod）。

---

## 日常用到的命令

全部以 compose 文件为入口：

```bash
# 看状态
docker compose -f docker/docker-compose.yml ps

# 看最近日志
docker compose -f docker/docker-compose.yml logs --tail 100 -f

# 进容器
docker exec -it agint-dsh-web bash

# 停掉（状态全保留，下次起来就回原样）
docker compose -f docker/docker-compose.yml down

# 卸载（容器 + 镜像都删，数据卷要单独删 DATA_DISK 那个目录）
docker compose -f docker/docker-compose.yml down --rmi all
```

---

## 升级 dsh

改 `.env` 里的 `DSH_VERSION`，重起容器即可（entrypoint 检测到版本对不上就重装到数据盘）：

```bash
sed -i 's/^DSH_VERSION=.*/DSH_VERSION=0.1.2.x/' .env   # 或者直接编辑
docker compose -f docker/docker-compose.yml up -d
```

不需要重新 build 镜像。

---

## 改了 AGINT 代码之后

```bash
docker compose -f docker/docker-compose.yml build && \
docker compose -f docker/docker-compose.yml up -d
```

`entrypoint` 会自动同步到 `/persist/dsh-home/profiles/web/`。

---

## 备查

### 镜像里到底有什么

只有三类、全部是不可变原料：

| 类别 | 内容 |
|---|---|
| 运行时 | `node:lts` 基础镜像 |
| 构建工具 | `python3` / `python3-yaml` / `rsync` |
| 数据 | AGINT 源码 |

**没有** dsh、zod、任何凭证。

### dsh 也装在数据盘

- 自动：entrypoint 启动时 `npm install -g --prefix /persist/dsh-install` 装到 `/persist`
- 手动：`docker exec -it agint-dsh-web bash` → `npm install -g --prefix /persist/dsh-install @deepseek-ai/dsh@<ver>`
- 换版本：两种都行，效果一样（装出的位置都在 `/persist/dsh-install`）

### 选 Ubuntu 26.04 作底

`docker build --build-arg DOCKERFILE=docker/Dockerfile.ubuntu ...`

### 局域网跨机访问（host 网络下的细节）

从 NAS 自身访问是 `http://localhost:3080`，这已经默认被信任。

从局域网其他 PC 访问是 `http://<NAS_IP>:3080`，host header 是 `<NAS_IP>:3080`，dsh 默认信任列表只有 `localhost` 和 `127.0.0.1`，会被静默挡掉（在 compose 之外或 `.env` 里设 `DSH_TRUSTED_HOSTS=localhost:3080,127.0.0.1:3080,<NAS_IP>:3080` 即可）。
