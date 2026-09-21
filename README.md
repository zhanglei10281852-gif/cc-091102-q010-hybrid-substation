# 风光共享升压站窗口

集控中心用本服务协调风场、光伏站与共享升压站的联锁停电计划。一次预约涉及多个资源，任何一侧冲突都应阻止整组窗口落定。`fixtures/incident.json` 保存一条三资源预约资料。

使用 Node.js 20 运行，`npm test` 校验依赖资料与一致性语义，`npm start` 提供预约与状态接口。运行锁文件、人员身份和生产连接信息不能提交。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/reservations` | 受理预约：200 落定 / 409 拒绝（响应含阻断资源）/ 400 参数非法 |
| GET | `/reservations/:commandId` | 查询预约当前结论（approved / rejected / cancelled） |
| POST | `/reservations/:commandId/cancel` | 取消已定窗口，三个资源视图同时释放；重复取消返回同一结论 |
| GET | `/resources/:resource/calendar` | 单资源视图：已落定窗口 + 在途占用 |
| GET | `/health` | 健康检查与统计 |
| POST | `/admin/recover` | 手动触发恢复收尾（清扫到期占用、补偿悬挂占用） |

预约命令格式：

```json
{"commandId":"OUTAGE-61","resources":["wind-farm-2","solar-site-4","substation-a"],"startsAt":"2026-10-08T01:00:00+08:00","endsAt":"2026-10-08T05:00:00+08:00"}
```

## 一致性约定

- **共同结论**：一次命令要么写入全部资源视图，要么全部不写；拒绝时响应一次性列出全部阻断资源与冲突类别（`calendar-overlap` / `rolling-quota` / `protected-period` / `dependency-conflict`）。
- **稳定锁序**：多资源锁按资源名字典序获取，交叉争抢只会串行排队，不会死锁。
- **写入补偿**：任一写入点（占用登记、窗口落库）中断都会释放已取得的占用，容量立即回滚，命令可安全重试。
- **超时清理**：命令处理有截止时间（`commandTimeoutMs`），占用带 TTL（`holdTtlMs`），清扫器到期回收，不会留下悬挂窗口。
- **幂等**：`commandId` 是幂等键，相同命令重试读取首次结果（含拒绝结论）；更换内容必须使用新的 `commandId`，同号不同内容返回 409。
- **容量**：容量检查与占用写入在同一把资源锁内完成，任何资源的容量在任一瞬时都不会被短暂突破。
- **故障恢复**：所有写入先落运行日志（默认 `var/journal.jsonl`，已 gitignore，可用 `JOURNAL_PATH` 覆盖）。重启后重放日志：已提交窗口原样恢复，悬挂占用被补偿并留下 `recovery` 拒绝结论，缺少结论的已提交预约自动补齐 approved 结论。

资源配置（容量、联锁依赖、保电时段、滚动配额、超时）见 `src/config.js`。
