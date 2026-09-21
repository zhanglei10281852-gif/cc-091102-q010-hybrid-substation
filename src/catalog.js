// 资源目录：风场、光伏站与共享升压站。
// 每个资源声明容量（同一时刻允许的停电窗口数）、滚动周期配额、保护期；
// lockGroups 表示联锁组——组内任一资源停电，必须整组同时停电。

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;

const t = (iso) => Date.parse(iso);

export const catalog = {
  resources: {
    'wind-farm-1': {
      kind: 'wind',
      capacity: 1,
      rollingQuota: { windowMs: DAY_MS, maxCount: 2 },
    },
    'wind-farm-2': {
      kind: 'wind',
      capacity: 1,
      rollingQuota: { windowMs: DAY_MS, maxCount: 2 },
    },
    'solar-site-3': {
      kind: 'solar',
      capacity: 1,
      rollingQuota: { windowMs: DAY_MS, maxCount: 2 },
    },
    'solar-site-4': {
      kind: 'solar',
      capacity: 1,
      rollingQuota: { windowMs: DAY_MS, maxCount: 2 },
    },
    'substation-a': {
      kind: 'substation',
      capacity: 1,
      rollingQuota: { windowMs: DAY_MS, maxCount: 1 },
      protectedPeriods: [
        {
          start: t('2026-10-01T00:00:00+08:00'),
          end: t('2026-10-04T00:00:00+08:00'),
          reason: '国庆保电保护期',
        },
      ],
    },
  },
  // 联锁组：风场2、光伏4、升压站A 必须同时停送电。
  lockGroups: [['wind-farm-2', 'solar-site-4', 'substation-a']],
};

export function knownResourceIds() {
  return Object.keys(catalog.resources).sort();
}
