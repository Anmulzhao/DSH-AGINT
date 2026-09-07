# AGINT / dsh web 镜像（精简版）
#
# 思路：镜像层只放 Node 环境 + AGINT 源码这两样不变的原料。
# dsh 的安装、插件同步、zod 补装全部在容器首次启动时完成，
# 且**全部落到数据卷上** —— 重建镜像、换镜像、换机器都不影响。
#
#   docker build -f docker/Dockerfile -t agint-dsh-web:v0.7.1 .
#
# 构建出来的镜像依然干净到接近 `node:lts` —— 没有 npm 全局包、没有
# 启动脚本、没有 zod。启动时由 entrypoint 装到 /persist 下。

# 老板倾向用 `node:lts` 自动跟 LTS 线，但显式锁死构建很容易：
#   docker build --build-arg NODE_IMAGE=node:24 ...
ARG NODE_IMAGE=node:lts
FROM ${NODE_IMAGE}

# install.sh 的硬依赖：合并 cordis.patch.yml 用 PyYAML（自定义 !!js tag），
# rsync 加速同步。装一次就能共享层缓存，镜像增加 ~50MB，可接受。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-yaml rsync ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agint
COPY presets ./presets
COPY plugins ./plugins
COPY profile-patches ./profile-patches
COPY install ./install

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
