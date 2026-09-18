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

在运行 Node 服务的本机通过 `127.0.0.1` 或 `localhost` 打开网页控制台时，服务端会发放仅当前进程有效的 HttpOnly 管理会话，不需要再次输入 `adminKey`。从局域网其他电脑访问时仍需填写管理密钥，浏览器会将其保存在本机 `localStorage`。设备编号既可手动输入，也可从当前已上报设备的下拉建议中选择。

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

## 实时遥测与轨迹

服务端提供真实遥测的接入骨架，不会生成或推测坐标。授权 DJI SDK、司空 Sync 或其他合规遥测适配器可以向设备接口上报：

```http
POST /api/device/telemetry
Authorization: Bearer <device-token>
Content-Type: application/json

{"deviceId":"rc-t100-001","latitude":30.123456,"longitude":120.123456,"altitude":18.2,"speed":4.1,"heading":92,"isFlying":true,"source":"dji-sdk"}
```

服务端为每台设备保留最近 2000 个点。网页“设备状态”页会自动绘制轨迹、显示最近上报时间和飞行状态；管理端也可通过 `GET /api/admin/telemetry?deviceId=...` 读取。当前伴随 App 的无障碍页面控制本身不是飞控遥测来源，未接入授权遥测适配器前网页会显示“等待设备上报真实遥测”。

网页“作业准备”页可请求设备同步 Agras 作业列表和已导入处方图列表，保存“作业 → 处方图”关联，并下发 `PREPARE_AGRAS_JOB`。伴随 App 会按名称定位“作业-本地”中的指定记录并点击该行右侧进入箭头，进入地图页后精确选择指定处方图并确认，随后点击官方页面右下角“调用”和“执行”。官方自身的飞行器连接、账号权限及安全确认仍会继续生效，命令只接受设备最近同步清单中存在的名称。清单接口为 `GET /api/admin/agras-inventory`、`POST /api/device/agras-inventory`，关联接口为 `GET/POST /api/admin/job-bindings`；服务重启后当前清单与关联会清空。

网页控制台必须同时选择一个 `.tif` 和一个 `.tfw` 文件。两者扩展名前的基础名称必须完全一致（扩展名大小写不敏感）。每个文件最大 1 GiB；服务端和 Android 均流式处理：

```http
PUT /api/admin/prescriptions/prescription.tif?deviceId=rc-t100-001&pairId=upload-001
X-Admin-Key: <admin-key>
Content-Type: application/octet-stream

<TIF 文件内容>
```

再使用相同的 `deviceId` 和 `pairId` 上传 `prescription.tfw`。第一份返回 `202`，服务端收到并验证完整文件对后返回 `201`，计算两份文件各自的 SHA-256 并创建一条 `DOWNLOAD_PRESCRIPTION` 命令。遥控器插有可写 SD 卡时，伴随 App 把两份文件保存到 SD 卡根目录 `DJI/RX/`，校验完成后才允许导入；未插卡时只保存到遥控器内部 `Download/DJI-Prescriptions/`，并拒绝执行 `IMPORT_PRESCRIPTION`。文件下载不等于开始作业；任务执行仍被拦截。

在 Agras 已显示包含“导入”入口的处方图页面时，可下发：

```json
{"deviceId":"rc-t100-001","type":"IMPORT_PRESCRIPTION","payload":{"fileName":"prescription.tif","entryText":"导入","source":"dji","unit":"mu","resample":"average","timeoutMs":15000}}
```

伴随 App 会自动进入 Agras 的“处方图 → 内存卡”页面，按文件名勾选目标文件；导入设置弹窗出现后只选择“平均值”并点击“确定”，不会修改来源和面积单位。如果页面结构不匹配则立即失败，不使用坐标猜测。该命令确认的是文件导入，不会上传航线到飞行器，也不会开始任务。

> 当前队列只保存在内存中，服务重启后清空，仅用于局域网原型验证。
