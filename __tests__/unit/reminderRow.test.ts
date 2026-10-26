import { describe, expect, it } from 'vitest';

import { reminderRowState } from '@/utils/reminderRow';

describe('reminderRowState', () => {
  it('reads "On" and offers to turn off when permission is granted and the setting is on', () => {
    expect(reminderRowState('granted', true)).toEqual({ value: 'On', action: 'turnOff' });
  });

  it('reads "Off" and offers to turn on when permission is granted and the setting is off', () => {
    expect(reminderRowState('granted', false)).toEqual({ value: 'Off', action: 'turnOn' });
  });

  it('reads "Off" and offers to request permission when it has never been asked', () => {
    expect(reminderRowState('undetermined', false)).toEqual({ value: 'Off', action: 'requestPermission' });
  });

  it('offers to request permission when undetermined even if the setting is somehow already true', () => {
    // cannot happen in practice, but permission decides the row, not the setting
    expect(reminderRowState('undetermined', true)).toEqual({ value: 'Off', action: 'requestPermission' });
  });

  it('treats the store\'s initial "unknown" status the same as undetermined', () => {
    expect(reminderRowState('unknown', false)).toEqual({ value: 'Off', action: 'requestPermission' });
    expect(reminderRowState('unknown', true)).toEqual({ value: 'Off', action: 'requestPermission' });
  });

  it('reads "Off in iOS Settings" and offers to open settings when the OS denied permission', () => {
    expect(reminderRowState('denied', false)).toEqual({ value: 'Off in iOS Settings', action: 'openSettings' });
  });

  it('stays "Off in iOS Settings" even if notificationsEnabled is stale-true from before the OS revoked it', () => {
    expect(reminderRowState('denied', true)).toEqual({ value: 'Off in iOS Settings', action: 'openSettings' });
  });
});
