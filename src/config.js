// 资源与调度约束的默认配置。测试可整体替换。
export const defaultConfig = {
  resources: {
    'wind-farm-2': { capacity: 1 },
    'solar-site-4': { capacity: 1 },
    'substation-a': { capacity: 1 },
  },
  // 联锁依赖：升压站检修时，经它并网的风场与光伏站必须同步出现在同一命令里
  dependencies: {
    'substation-a': ['wind-farm-2', 'solar-site-4'],
  },
  // 保电时段：窗口与时段相交即拒绝
  protectedPeriods: [
    { name: '国庆保电', startsAt: '2026-10-01T00:00:00+08:00', endsAt: '2026-10-05T00:00:00+08:00' },
  ],
  // 滚动配额：任一资源在滚动窗口内最多安排的停电窗口数（保守判定，宁拒勿放）
  rollingQuota: { windowMs: 7 * 24 * 3600_000, max: 4 },
  commandTimeoutMs: 5_000, // 单条命令从取锁到落库的最长耗时
  holdTtlMs: 30_000, // 占用（hold）的生存期，超时由清扫器回收
  sweepIntervalMs: 5_000,
  maxWindowMs: 30 * 24 * 3600_000,
};
