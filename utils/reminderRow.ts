// PermissionOutcome from services/notifications.ts plus the store's initial 'unknown',
// restated because utils can't import services
export type ReminderPermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unknown';

export type ReminderRowAction = 'turnOff' | 'turnOn' | 'requestPermission' | 'openSettings';

export interface ReminderRowState {
  value: string;
  action: ReminderRowAction;
}

// denied wins over notificationsEnabled: nothing is delivered once the OS has revoked it,
// and iOS won't prompt again
export function reminderRowState(
  permissionStatus: ReminderPermissionStatus,
  notificationsEnabled: boolean,
): ReminderRowState {
  if (permissionStatus === 'denied') {
    return { value: 'Off in iOS Settings', action: 'openSettings' };
  }
  if (permissionStatus === 'granted') {
    return notificationsEnabled ? { value: 'On', action: 'turnOff' } : { value: 'Off', action: 'turnOn' };
  }
  // never asked, or not refreshed yet. either way the OS can still be asked
  return { value: 'Off', action: 'requestPermission' };
}
