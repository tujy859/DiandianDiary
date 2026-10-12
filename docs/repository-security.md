# 仓库配置与凭据

## AppID 与本机开发

AppID 标识小程序，AppSecret 才是服务端访问凭据。按本项目约定，真实 AppID 也不再提交到仓库，避免扫描提醒和开发环境混用。

共享的 `project.config.json` 保留编译配置，`appid` 使用 `touristappid`。在已被 Git 忽略的 `project.private.config.json` 中配置真实 AppID：新环境复制 `project.private.config.json.example` 后修改；已有文件只添加或修改 `appid` 字段，保留其余设置。微信开发者工具使用私有配置覆盖共享配置；重新打开项目后，在「详情 → 基本信息」确认 AppID，再使用云开发和真机预览。如果开发者工具改写了共享配置，提交前恢复占位值。

云环境 ID 是客户端连接所需的配置，可以保留在代码中。数据库和存储的权限、云函数身份校验仍需按部署说明正确配置。

## 不提交的内容

| 内容 | 保存位置或处理方式 |
|---|---|
| 真实 AppID、开发工具个人设置 | `project.private.config.json`，已忽略 |
| 微信 AppSecret、腾讯云 SecretId/SecretKey、模型 API Key、访问令牌 | 云函数环境变量或部署平台的凭据配置；不用源码保存，也不能打进小程序客户端包 |
| 云开发自定义登录私钥、微信支付证书、CI 上传私钥 | `tcb_custom_login.json`、`*.pem`、`*.key`、`*.p12` 等均已忽略 |
| 本机环境变量、SDK/CLI 登录缓存、含令牌的 npm 配置 | `.env*`、`.cloudbase/`、`.tcb/`、`.npmrc` 已忽略；`.env.example` 只能填占位值 |
| 真实用户日记、照片、数据库导出、日志和备份 | 不进入源码目录；本地 `local-data/`、`backups/`、`*.log` 已忽略，其他路径需自行确认 |

业务源码、测试、依赖锁文件、共享编译配置和数据库权限模板继续提交。当前模型设置保存在用户设备上；面向用户分发前仍应实现经过身份校验的服务端模型代理，共享模型密钥不能放在客户端。

## 提交检查

```sh
node tools/check-repository-security.cjs --staged
```

以上检查实际暂存内容；不带参数时检查 Git 跟踪文件的工作区内容，CI 使用这一模式检查检出的提交。检查仅报告路径、行号及类别，不打印凭据值。覆盖真实微信 AppID、常见服务商令牌、长凭据字面量、私钥标记与禁止提交的文件路径，不能识别所有凭据格式、截图或用户隐私数据。GitHub secret scanning 和人工检查仍有必要。

`.gitignore` 不影响已被跟踪的文件，也不能清除旧提交。若误提交了真实 AppSecret/API Key，先在服务商处撤销或轮换，再处理代码和历史。当前 AppID 提醒可在核对后手动处理；本次清理只修改新提交，保留已有 Git 历史，不自动关闭 GitHub 告警或强制推送。

参考：[微信开发者工具项目配置](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html)、[CloudBase 私钥配置说明](https://docs.cloudbase.net/recipes/add-auth-wechat-miniprogram)、[GitHub secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns)。
