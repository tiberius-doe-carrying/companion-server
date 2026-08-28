# T100 伴随助手局域网服务

零第三方依赖，需要 Node.js 18+。

## 配置

复制 `config.example.json` 为 `config.json` 并设置两个不同的长随机值：

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "deviceToken": "Android App 使用的设备令牌",
  "adminKey": "成熟系统和网页控制台使用的管理密钥"
}
```

仓库已忽略 `config.json`。环境变量仍可覆盖同名配置，适合部署环境。

## 启动

PowerShell：

```powershell
npm start
```

默认监听 `0.0.0.0:8787`。启动日志会显示可供手机访问的局域网地址。

Android App 中填写：

- 服务器地址：`http://电脑局域网IP:8787`；debug APK 仅允许 localhost 和私有网段 HTTP，release 仍要求 HTTPS；
- 设备编号：`rc-t100-001`；
- Token：`T100_DEVICE_TOKEN` 的值。

浏览器访问 `http://127.0.0.1:8787/` 使用控制台。

OpenAPI 文档：`http://127.0.0.1:8787/openapi.json`。

> 当前队列只保存在内存中，服务重启后清空，仅用于局域网原型验证。
