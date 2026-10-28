# 自定义域名改由阿里云 ECS 承接

本分支目标：`https://shuanglu-battery.cn/` → 阿里云 ECS `123.56.252.14` → nginx HTTPS → 回环 Node 服务。GitHub 保存源码，GitHub Pages 不运行数据库、上传或管理员接口。

这是一份待实施的切换配置，不表示 DNS 或 ECS 已变更。先完成 [ECS 部署、完整数据迁移和验收](../ALIYUN_DEPLOY.md)，再调整正式域名。

## 切换记录

在当前权威 DNS 服务商的解析控制台设置：

| 类型 | 主机记录 | 目标值 | 操作 |
| --- | --- | --- | --- |
| A | @ | `123.56.252.14` | 新增或替换为 ECS 公网 IP |
| A | @ | `162.159.143.30` | 切换时移除旧 Sites 记录 |
| A | @ | `172.66.3.26` | 切换时移除旧 Sites 记录 |

不要让同名记录同时保留新旧主机地址，否则不同访客可能访问不同站点。核对同名 AAAA / CNAME 是否仍指向其他服务。保留邮箱 MX、必要 TXT 和其他业务子域名；旧 Sites 验证 TXT 不承担流量路由，确认不再需要后可另行清理。

域名不是通过 GitHub 仓库中的 `CNAME` 文件指向 ECS。GitHub Pages 设置若仍绑定此域名，可在正式转移后解除，避免页面提示与实际托管混淆。

## HTTPS 与管理员

ECS 安全组、主机防火墙开放 80/443；nginx 安装域名匹配的证书。应用的 `APP_ORIGIN=https://shuanglu-battery.cn`；Node 只监听 `127.0.0.1:3000`。管理员入口为 `/?admin=1`，使用新服务器配置的管理员密码，无需 ChatGPT 身份。

`www.shuanglu-battery.cn` 与 `admin.shuanglu-battery.cn` 不会因根域名切换而自动生效。若要承接这些入口，需要分别配置 DNS、证书、nginx 路由及来源设置；不要沿用旧的 `custom-domains.chatgpt.site` CNAME。

## 验证与回退

切换前可在本机 hosts 指向 ECS，或执行：

```bash
curl --resolve shuanglu-battery.cn:443:123.56.252.14 \
  --fail https://shuanglu-battery.cn/api/health
```

确认数据、素材、下载、登录和上传均正常后再切 DNS。生效期间不同 DNS 缓存可能保留旧记录；对比访问内容与最新解析，避免把旧站结果当作新站验收。

切换前保存旧解析记录和源站数据备份。若需要将流量暂时退回仍在运行的旧站，可恢复此前两条 Sites A 记录；这会恢复旧平台依赖，且新 ECS 写入的数据不会自动同步回旧站，需先停止相关编辑并核对差异。旧站应在新站稳定且备份验证后再下线。
