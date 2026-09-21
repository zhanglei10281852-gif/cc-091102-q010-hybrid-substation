# 风光共享升压站窗口

集控中心用本服务协调风场、光伏站与共享升压站的联锁停电计划。一次预约涉及多个资源，任何一侧冲突都阻止整组窗口落定；三个资源视图对同一命令只呈现一个共同结论。`fixtures/incident.json` 保存一条三资源预约资料。

使用 Node.js 20+ 运行：`npm test` 运行 27 项测试，`npm start`（默认 8080，`PORT` 可改）提供 HTTP 服务。运行锁文件、人员身份和生产连接信息不能提交。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/resources` | 资源目录与联锁组 |
| POST | `/reservations` | 提交预约（幂等键 `commandId`） |
| GET | `/reservations/:commandId` | 查询命令结论 |
| POST | `/reservations/:commandId/cancel` | 取消（body 可带 `reason`） |
| GET | `/views` | 全部资源日历视图 + 命令结论 |
| POST | `/admin/recover` | 崩溃/超时对账：释放过期锁、按结论修复视图 |

预约 body：

```json
{
  "commandId": "OUTAGE-61",
  "resources": ["wind-farm-2", "solar-site-4", "substation-a"],
  "startsAt": "2026-10-08T01:00:00+08:00",
  "endsAt": "2026-10-08T05:00:00+08:00"
}
```

- **201** `{"decision":"approved", ...}`：三个视图同时落定；同 `commandId` 重试返回首次结论（`retried:true`），不产生第二组窗口。
- **409** `{"decision":"rejected","blockers":[...]}`：整组不受理，`blockers` 给出每个阻断资源、类别（`calendar-overlap` / `rolling-quota` / `protected-period` / `dependency-conflict`）和冲突命令。
- **503** `lock-timeout`：锁等待超时（瞬时错误，可安全重试），`blockers` 指明持锁方。
- 联锁组必须整组申请；只停组内一部分直接以 `dependency-conflict` 拒绝，并指出缺失资源。

## 一致性设计

- **稳定加锁顺序**：资源名全局排序后逐个加锁，所有事务同序获取，交叉争抢不形成等待环；另设获取超时（必须小于锁 TTL）与锁 TTL 双保险。
- **容量不突破**：冲突评估在全部锁内完成，用扫描线计算并入新窗口后的区间最大并发，超容量即拒绝；区间首尾相接不视为重叠。
- **写入补偿**：提交在任一资源写入点中断 → 删除已写窗口，不落结论；取消中断 → 凭删除前快照还原。命令结论落盘与窗口写入同成败。
- **超时无悬挂**：进程死亡留下的锁由 TTL + `/admin/recover` 释放；对账按命令结论双向修复——批准命令补齐缺失视图，取消/无结论命令清除残留窗口，且对账本身幂等。
- **幂等重放**：`commandId` 是唯一事实键，批准与取消结论永久重放；冲突拒绝不持久化（阻断可能解除，允许原命令稍后再试）。

## 模块

- `src/catalog.js`：资源容量、滚动配额、保护期、联锁组配置。
- `src/store.js`：内存存储——资源锁（TTL/重入）、窗口日历、命令记录、故障注入钩子、对账。
- `src/domain.js`：校验、冲突评估、加锁/补偿、预约/取消/查询/恢复。
- `src/server.js`：HTTP 统一入口。
- `test/`：领域并发/故障测试与 HTTP 端到端测试。
