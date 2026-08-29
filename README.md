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

控制台顶部显示设备连接状态、最后心跳、前台命令服务、无障碍服务和 DJI Agras 安装状态。新版伴随 App 约每 3 秒上报一次；服务端在 15 秒没有心跳后把设备标记为离线。状态只保存在内存中，Node 服务重启后等待设备下一次心跳即可恢复。

OpenAPI 文档：`http://127.0.0.1:8787/openapi.json`。

## 命令

支持 SmartFarm（`com.dji.agflow`）和 Agras（`com.dji.agrasx`）：`OPEN_DJI`、`OPEN_AGRAS`、
`OPEN_APP`、`OPEN_DEEPLINK`、`INSPECT_PAGE`、`CLICK_TEXT`、`CLICK_ID`、`CLICK_RATIO`、
`WAIT_PAGE`、`BACK`。当前遥控器默认目标是 Agras；`OPEN_DJI` 和省略 `payload.app` 的命令均操作 `com.dji.agrasx`。需要兼容 SmartFarm 时可显式指定 `payload.app: "smartfarm"`。

`CLICK_RATIO` 的 `x`、`y` 必须在 `0..1`，并提供非空 `description`。Node 服务和 Android App 都会拦截锁机、解锁、起飞、任务执行、返航、降落、喷洒、播撒等危险操作；坐标点击还会检查命中无障碍节点的元数据。

## 上传处方图

网页控制台可直接选择 `.djitile` 处方图并下发。接口使用原始二进制请求体，最大 512 MiB；服务端和 Android 均流式处理，适合 300 多 MiB 的文件：

```http
PUT /api/admin/prescriptions/prescription.djitile?deviceId=rc-t100-001
X-Admin-Key: <admin-key>
Content-Type: application/octet-stream

<文件内容>
```

服务端会计算 SHA-256 并创建 `DOWNLOAD_PRESCRIPTION` 设备命令。Android 10 及以上把通过校验的文件保存到公共目录 `Download/DJI-Prescriptions`，然后启动 DJI Agras。文件下载不等于开始作业；进入导入页面、选择文件和导入参数使用页面检查与安全导航命令完成，任务执行仍被拦截。

在 Agras 已显示包含“导入”入口的处方图页面时，可下发：

```json
{"deviceId":"rc-t100-001","type":"IMPORT_PRESCRIPTION","payload":{"fileName":"prescription.djitile","entryText":"导入","source":"dji","unit":"mu","resample":"max","timeoutMs":15000}}
```

伴随 App 只会在 Agras 或系统文件选择器中按指定文件名操作，并按资源 ID 设置导入参数。如果页面结构不匹配则立即失败，不使用坐标猜测。该命令确认的是文件导入，不会上传航线到飞行器，也不会开始任务。

> 当前队列只保存在内存中，服务重启后清空，仅用于局域网原型验证。
