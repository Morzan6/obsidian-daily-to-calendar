export interface ScheduleGCalSettings {
  gcalCalendarId: string;
  saClientEmail: string;
  saPrivateKey: string;
  dailyFolder: string;
  dailyFilenameFormat: string;
  scheduleHeading: string;
  defaultDurationMinutes: number;
  timeZone: string;
  eventMap: Record<string, string>;
  autoSyncOnModify: boolean;
}

export const DEFAULT_SETTINGS: ScheduleGCalSettings = {
  gcalCalendarId: 'primary',
  saClientEmail: '',
  saPrivateKey: '',
  dailyFolder: 'Daily',
  dailyFilenameFormat: 'YYYY-MM-DD',
  scheduleHeading: 'Schedule',
  defaultDurationMinutes: 60,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  eventMap: {},
  autoSyncOnModify: false,
};
