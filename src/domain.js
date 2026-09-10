export const conflictKinds = ['calendar-overlap', 'rolling-quota', 'protected-period', 'dependency-conflict'];

export async function reserveGroup(store, command) {
  const acquired = [];
  for (const resource of command.resources) {
    if (store.isBusy(resource, command)) throw new Error(`resource-conflict:${resource}`);
    await store.hold(resource, command.commandId);
    acquired.push(resource);
  }
  await store.save({ ...command, state: 'approved' });
  return acquired;
}

export function recover(store) {
  store.clearAllHolds();
}
