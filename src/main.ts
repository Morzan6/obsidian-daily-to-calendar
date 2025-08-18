import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, moment, requestUrl, TextAreaComponent } from 'obsidian';

import { DEFAULT_SETTINGS, ScheduleGCalSettings } from 'src/settings';


export default class ScheduleGCalPlugin extends Plugin {
  settings: ScheduleGCalSettings;
  statusBar?: HTMLElement;
  private lastScheduleHashByPath: Map<string, string> = new Map();

  async onload() {
    await this.loadSettings();

    this.statusBar = this.addStatusBarItem();
    this.updateStatus('Idle');

    const ribbon = this.addRibbonIcon('calendar', "Sync today's schedule to Google Calendar", async () => {
      await this.syncToday();
    });
    ribbon.addClass('schedule-gcal-ribbon');

    const ribbonAll = this.addRibbonIcon('calendar', 'Sync ALL daily notes to Google Calendar', async () => {
      await this.syncAllDailyNotes();
    });
    ribbonAll.addClass('schedule-gcal-ribbon-all');

    this.addCommand({
      id: 'sync-today-schedule-to-google-calendar',
      name: "Sync Today's Schedule to Google Calendar",
      callback: async () => {
        await this.syncToday();
      },
    });

    this.addCommand({
      id: 'sync-all-dailies-to-google-calendar',
      name: 'Sync ALL Daily Notes to Google Calendar',
      callback: async () => {
        await this.syncAllDailyNotes();
      },
    });

    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (!this.settings.autoSyncOnModify) return;
        if (!(file instanceof TFile)) return;
        if (!this.isInDailyFolder(file.path)) return;
        const dateStr = this.dateStrFromDailyFile(file.name);
        if (!dateStr) return;
        try {
          const content = await this.app.vault.read(file);
          const scheduleNormalized = extractScheduleNormalized(content, this.settings.scheduleHeading);
          const currentHash = simpleHash(scheduleNormalized);
          const lastHash = this.lastScheduleHashByPath.get(file.path);
          if (lastHash === currentHash) {
            return;
          }
          this.lastScheduleHashByPath.set(file.path, currentHash);
          await this.syncForPath(file.path, dateStr);
        } catch (e) {
          console.error('Auto-sync modify handler failed', e);
        }
      })
    );

    if (this.settings.autoSyncOnModify) {
      const dailyFiles = this.getDailyFiles();
      for (const f of dailyFiles) {
        try {
          const content = await this.app.vault.read(f);
          const normalized = extractScheduleNormalized(content, this.settings.scheduleHeading);
          const h = simpleHash(normalized);
          this.lastScheduleHashByPath.set(f.path, h);
        } catch (e) {
          console.debug('Failed to prime schedule hash cache', f.path, e);
        }
      }
    }

    this.addSettingTab(new ScheduleGCalSettingTab(this.app, this));
  }

  onunload() { }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateStatus(text: string) {
    this.statusBar?.setText(`Schedule→GCal: ${text}`);
  }

  getTodayNotePath(): string | null {
    const fileNameBase = moment().format(this.settings.dailyFilenameFormat);
    const fileName = fileNameBase.endsWith('.md') ? fileNameBase : `${fileNameBase}.md`;
    const folder = this.settings.dailyFolder?.replace(/^\/+|\/+$/g, '');
    const path = folder ? `${folder}/${fileName}` : fileName;
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file.path : null;
  }

  async syncToday() {
    try {
      const path = this.getTodayNotePath();
      if (!path) {
        this.updateStatus('Idle');
        return;
      }

      const dateStr = moment().format('YYYY-MM-DD');
      await this.syncForPath(path, dateStr);
    } catch (e) {
      console.error(e);
      this.updateStatus('Error');
      new Notice('Sync failed — see console');
    }
  }

  private async syncForPath(path: string, dateStr: string) {
    this.updateStatus('Parsing…');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('Failed to read note: ' + path);
      return;
    }
    const content = await this.app.vault.read(file);
    try {
      const normalized = extractScheduleNormalized(content, this.settings.scheduleHeading);
      const h = simpleHash(normalized);
      this.lastScheduleHashByPath.set(path, h);
    } catch (e) {
      console.debug('Failed to compute normalized schedule hash', e);
    }
    const entries = parseSchedule(content, this.settings.scheduleHeading);
    const hadEntries = entries.length > 0;

    this.updateStatus('Preparing…');
    try {
      await getAccessTokenMobile(this.settings);
    } catch (e) {
      console.error('Auth init failed', e);
      new Notice('Google auth failed — check settings');
      this.updateStatus('Auth failed');
      return;
    }

    this.updateStatus('Indexing existing events…');

    let existingEvents: GCalEventResponse[] = [];
    try {
      existingEvents = await listEventsForDateViaRest(this.settings, this.settings.gcalCalendarId, dateStr);
    } catch (e) {
      console.error('Failed to fetch existing events', e);
    }

    const calendarEventMap = new Map<string, string>();
    for (const event of existingEvents) {
      if (event.description) {
        const keyMatch = event.description.match(/Obsidian-Event-Key:\s*(.+)/);
        if (keyMatch && event.id) {
          calendarEventMap.set(keyMatch[1].trim(), event.id);
        }
      }
    }

    this.updateStatus('Syncing…');
    const vault = this.app.vault.getName();
    const noteLink = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;

    const currentKeys = new Set<string>();
    if (hadEntries) {
      for (const e of entries) {
        const key = makeEventKey(dateStr, e.rawLine);
        currentKeys.add(key);
        
        const localEventId = this.settings.eventMap[key];
        const calendarEventId = calendarEventMap.get(key);
        const existingId = localEventId || calendarEventId;
        
        if (calendarEventId && !localEventId) {
          this.settings.eventMap[key] = calendarEventId;
        }
        
        const eventBody = buildEventBody(
          e,
          dateStr,
          this.settings.timeZone,
          noteLink,
          this.settings.defaultDurationMinutes,
          key
        );
        try {
          if (existingId) {
            const updated = await patchEventViaClient(
              this.settings,
              this.settings.gcalCalendarId,
              existingId,
              eventBody
            );
            if (updated?.id) this.settings.eventMap[key] = updated.id;
          } else {
            const created = await createEventViaClient(
              this.settings,
              this.settings.gcalCalendarId,
              eventBody
            );
            if (created?.id) this.settings.eventMap[key] = created.id;
          }
        } catch (err) {
          console.error('Event sync error', err);
          new Notice('Some events failed to sync. See console');
        }
      }
    }

    let deletedCount = 0;
    const prefix = `${dateStr}::`;
    
    const allEventsToCheck = new Map<string, string>();

    for (const [key, eventId] of Object.entries(this.settings.eventMap)) {
      if (key.startsWith(prefix)) {
        allEventsToCheck.set(key, eventId);
      }
    }

    for (const [key, eventId] of calendarEventMap) {
      if (key.startsWith(prefix) && !allEventsToCheck.has(key)) {
        allEventsToCheck.set(key, eventId);
      }
    }
    
    for (const [key, eventId] of allEventsToCheck) {
      if (currentKeys.has(key)) continue;
      try {
        await deleteEventViaClient(this.settings, this.settings.gcalCalendarId, eventId);
        delete this.settings.eventMap[key];
        deletedCount++;
      } catch (err) {
        console.error('Delete event failed', key, eventId, err);
      }
    }

    await this.saveSettings();
    this.updateStatus('Done');
    if (hadEntries) {
      new Notice(`Synced ${entries.length} schedule entr${entries.length === 1 ? 'y' : 'ies'} for ${dateStr}${deletedCount ? `, removed ${deletedCount}` : ''}`);
    } else {
      if (deletedCount) new Notice(`Removed ${deletedCount} events for ${dateStr}`);
    }
  }

  async syncAllDailyNotes() {
    try {
      const files = this.getDailyFiles();
      if (files.length === 0) {
        new Notice('No daily notes found');
        return;
      }
      let totalSynced = 0;

      for (const f of files) {
        const dateStr = this.dateStrFromDailyFile(f.name);
        if (!dateStr) continue;

        await this.syncForPath(f.path, dateStr);

        totalSynced++;
      }
      new Notice(`Processed ${totalSynced} daily note${totalSynced === 1 ? '' : 's'}`);
    } catch (e) {
      console.error(e);
      new Notice('Sync all failed — see console');
    }
  }

  private isInDailyFolder(path: string): boolean {
    const folder = (this.settings.dailyFolder || '').replace(/^\/+|\/+$/g, '');
    if (!folder) return false;
    return path.startsWith(folder + '/');
  }

  private dateStrFromDailyFile(fileName: string): string | null {
    const base = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
    const fmt = this.settings.dailyFilenameFormat || 'YYYY-MM-DD';
    const m = moment(base, fmt, true);
    if (!m.isValid()) return null;
    return m.format('YYYY-MM-DD');
  }

  private getDailyFiles(): TFile[] {
    const folderPath = (this.settings.dailyFolder || '').replace(/^\/+|\/+$/g, '');
    if (!folderPath) return [];
    const abs = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(abs instanceof TFolder)) return [];
    const out: TFile[] = [];
    const stack: (TFolder)[] = [abs];
    while (stack.length) {
      const current = stack.pop();
      if (!current) break;
      // @ts-ignore Obsidian types: children exists on TFolder
      for (const child of current.children || []) {
        if (child instanceof TFolder) stack.push(child);
        else if (child instanceof TFile && child.extension === 'md') out.push(child);
      }
    }
    return out;
  }
}

// ===== Parsing =====
type ScheduleEntry = {
  rawLine: string;
  title: string;
  start?: string; // HH:mm
  end?: string;   // HH:mm
  allDay?: boolean;
};

function parseSchedule(md: string, heading: string): ScheduleEntry[] {
  const lines = md.split(/\r?\n/);
  const entries: ScheduleEntry[] = [];

  const headingIdx = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+(.+)$/i.test(l) &&
    l.replace(/^\s{0,3}#{1,6}\s+/, '').trim().toLowerCase() === heading.trim().toLowerCase());
  if (headingIdx === -1) return entries;

  const startIdx = headingIdx + 1;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}#{1,6}\s+/.test(line)) break;
    const m = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!m) continue;
    const item = m[1].trim();
    const parsed = parseScheduleLine(item);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function parseScheduleLine(text: string): ScheduleEntry | null {
  // 1) HH:mm-HH:mm Title
  const normalized = text.replace(/^\s*\[(?: |x|X)\]\s+/, '');
  let m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)$/.exec(normalized);
  if (m) {
    return { rawLine: text, title: m[3].trim(), start: fixTime(m[1]), end: fixTime(m[2]) };
  }
  // 2) HH:mm Title (default duration)
  m = /^(\d{1,2}:\d{2})\s+(.+)$/.exec(normalized);
  if (m) {
    return { rawLine: text, title: m[2].trim(), start: fixTime(m[1]) };
  }
  // 3) All-day Title
  m = /^all-?day\s*[:-]?\s*(.+)$/i.exec(normalized);
  if (m) {
    return { rawLine: text, title: m[1].trim(), allDay: true };
  }
  return { rawLine: text, title: normalized };
}

function fixTime(t: string): string {
  const [h, m] = t.split(':').map((x) => parseInt(x, 10));
  const hh = (h % 24).toString().padStart(2, '0');
  const mm = (m % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

// ===== Google Calendar API =====
type GCalEventDate =
  | { date: string; timeZone: string }
  | { dateTime: string; timeZone: string };

type GCalEventBody = {
  summary: string;
  start: GCalEventDate;
  end: GCalEventDate;
  description?: string;
};

type GCalEventResponse = { id: string; description?: string; summary?: string };
type GCalEventsListResponse = { items?: GCalEventResponse[] };
type OAuthTokenResponse = { access_token: string; expires_in?: number };

function buildEventBody(
  entry: ScheduleEntry,
  ymd: string,
  timeZone: string,
  noteLink: string,
  defaultDurationMinutes: number,
  eventKey: string
): GCalEventBody {
  const baseDescription = `From Obsidian daily note: ${noteLink}\n\nObsidian-Event-Key: ${eventKey}`;
  
  if (entry.allDay) {
    const endDate = moment(ymd).add(1, 'day').format('YYYY-MM-DD');
    return {
      summary: entry.title,
      start: { date: ymd, timeZone },
      end: { date: endDate, timeZone },
      description: baseDescription,
    };
  }

  const start = entry.start ?? '09:00';
  const startDt = moment(`${ymd} ${start}`, 'YYYY-MM-DD HH:mm');
  const endDt = entry.end
    ? moment(`${ymd} ${entry.end}`, 'YYYY-MM-DD HH:mm')
    : startDt.clone().add(defaultDurationMinutes, 'minutes');

  const startLocal = `${ymd}T${startDt.format('HH:mm')}:00`;
  const endLocal = `${ymd}T${endDt.format('HH:mm')}:00`;
  return {
    summary: entry.title,
    start: { dateTime: startLocal, timeZone },
    end: { dateTime: endLocal, timeZone },
    description: baseDescription,
  };
}

// ===== REST auth helpers (Service Account JWT) =====
let mobileTokenCache: { key: string; accessToken: string; expEpoch: number } | null = null;

function authCacheKey(s: ScheduleGCalSettings): string {
  const scopes = 'https://www.googleapis.com/auth/calendar';
  const keyLen = (s.saPrivateKey || '').length;
  return `${s.saClientEmail}|${scopes}|${keyLen}`;
}

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeStr(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToPkcs8ArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\r|\n|\s/g, '');
  const binary = atob(cleaned);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKeyRS256(pem: string): Promise<CryptoKey> {
  const keyData = pemToPkcs8ArrayBuffer(pem);
  return await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signJwtRS256(header: Record<string, unknown>, payload: Record<string, unknown>, pem: string): Promise<string> {
  const enc = new TextEncoder();
  const headerB64 = base64UrlEncodeStr(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeStr(JSON.stringify(payload));
  const toSign = `${headerB64}.${payloadB64}`;
  const key = await importPrivateKeyRS256(pem);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    enc.encode(toSign)
  );
  const sigB64 = base64UrlEncode(signature);
  return `${toSign}.${sigB64}`;
}

async function getAccessTokenMobile(settings: ScheduleGCalSettings): Promise<string> {
  const key = authCacheKey(settings);
  const now = Math.floor(Date.now() / 1000);
  if (mobileTokenCache && mobileTokenCache.key === key && mobileTokenCache.expEpoch - 60 > now) {
    return mobileTokenCache.accessToken;
  }
  const iat = now;
  const exp = now + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: settings.saClientEmail,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  } as const;
  const assertion = await signJwtRS256(header, payload, settings.saPrivateKey);
  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', assertion);
  const resp = await requestUrl({
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: form.toString(),
  });
  if (resp.status < 200 || resp.status >= 300) {
    const txt = resp.text || '';
    throw new Error(`Token exchange failed: ${resp.status} ${txt}`);
  }
  const data = JSON.parse(resp.text) as OAuthTokenResponse;
  const accessToken = data.access_token;
  const expiresIn = data.expires_in || 3600;
  mobileTokenCache = { key, accessToken, expEpoch: now + expiresIn };
  return accessToken;
}

async function gcalFetchMobile(settings: ScheduleGCalSettings, url: string, init: RequestInit): Promise<unknown> {
  const token = await getAccessTokenMobile(settings);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (init.headers) {
    const h = init.headers as HeadersInit;
    if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k] = String(v);
    } else if (h instanceof Headers) {
      h.forEach((v, k) => {
        headers[k] = String(v);
      });
    } else {
      Object.assign(headers, h as Record<string, string>);
    }
  }
  const resp = await requestUrl({
    url,
    method: (init.method as string) || 'GET',
    headers,
    body: (init as { body?: string }).body,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const text = resp.text || '';
    throw new Error(`GCal REST error ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return undefined;
  return resp.text ? JSON.parse(resp.text) : undefined;
}

async function createEventViaRest(
  settings: ScheduleGCalSettings,
  calendarId: string,
  body: GCalEventBody,
): Promise<GCalEventResponse> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return await gcalFetchMobile(settings, url, { method: 'POST', body: JSON.stringify(body) }) as GCalEventResponse;
}

async function patchEventViaRest(
  settings: ScheduleGCalSettings,
  calendarId: string,
  eventId: string,
  body: GCalEventBody,
): Promise<GCalEventResponse> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  return await gcalFetchMobile(settings, url, { method: 'PATCH', body: JSON.stringify(body) }) as GCalEventResponse;
}

async function listEventsForDateViaRest(
  settings: ScheduleGCalSettings,
  calendarId: string,
  dateStr: string
): Promise<GCalEventResponse[]> {
  const timeMin = `${dateStr}T00:00:00Z`;
  const timeMax = moment(dateStr).add(1, 'day').format('YYYY-MM-DD') + 'T00:00:00Z';
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true`;
  
  const result = await gcalFetchMobile(settings, url, { method: 'GET' }) as GCalEventsListResponse;
  return result.items || [];
}

async function deleteEventViaRest(
  settings: ScheduleGCalSettings,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const token = await getAccessTokenMobile(settings);
  const resp = await requestUrl({
    url,
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if ((resp.status >= 200 && resp.status < 300) || resp.status === 204 || resp.status === 404 || resp.status === 410) {
    return;
  }
  const text = resp.text || '';
  throw new Error(`GCal REST error ${resp.status}: ${text}`);
}


async function createEventViaClient(
  settings: ScheduleGCalSettings,
  calendarId: string,
  body: GCalEventBody
): Promise<GCalEventResponse> {
  return await createEventViaRest(settings, calendarId, body);
}

async function patchEventViaClient(
  settings: ScheduleGCalSettings,
  calendarId: string,
  eventId: string,
  body: GCalEventBody
): Promise<GCalEventResponse> {
  return await patchEventViaRest(settings, calendarId, eventId, body);
}

async function deleteEventViaClient(
  settings: ScheduleGCalSettings,
  calendarId: string,
  eventId: string
): Promise<void> {
  await deleteEventViaRest(settings, calendarId, eventId);
}


function makeEventKey(dateStr: string, rawLine: string) {
  const withoutBox = rawLine.replace(/^\s*\[(?: |x|X)\]\s+/, '');
  return `${dateStr}::${withoutBox.trim()}`;
}

// ===== Helpers for auto-sync change detection =====
function extractScheduleNormalized(md: string, heading: string): string {
  const lines = md.split(/\r?\n/);
  const headingIndex = lines.findIndex((l) => /^(\s{0,3})(#{1,6})\s+(.+)$/.test(l) &&
    l.replace(/^\s{0,3}#{1,6}\s+/, '').trim().toLowerCase() === heading.trim().toLowerCase());
  if (headingIndex === -1) return '';
  const m = /^(\s{0,3})(#{1,6})\s+/.exec(lines[headingIndex]);
  const headingLevel = m ? m[2].length : 1;

  const collected: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^\s{0,3}#{1,6}\s+/.test(line);
    if (isHeading) {
      const lvl = (line.match(/^(\s{0,3})(#{1,6})\s+/) || [])[2]?.length || 1;
      if (lvl <= headingLevel) break;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    let item = bullet[1].trim();
    item = item.replace(/^\s*\[(?: |x|X)\]\s+/, '');
    item = item.replace(/\s+/g, ' ').trim();
    collected.push(item);
  }
  return collected.join('\n');
}

function simpleHash(input: string): string {
  let hash = 5381 >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash = (((hash << 5) + hash) ^ input.charCodeAt(i)) >>> 0; // hash * 33 ^ c
  }
  return ('00000000' + hash.toString(16)).slice(-8);
}

// ===== Settings UI =====
class ScheduleGCalSettingTab extends PluginSettingTab {
  plugin: ScheduleGCalPlugin;
  constructor(app: App, plugin: ScheduleGCalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Daily Schedule → Google Calendar' });

    const saHelp = containerEl.createEl('div');
    saHelp.setAttr('style', 'font-size: 13px; font-weight: 600; color: var(--text-accent); padding: 8px 10px; border-left: 3px solid var(--interactive-accent); border-radius: 4px; margin-top: 8px;');
    saHelp.setText('Tip: Share the target calendar with the service account email with at least "Make changes to events".');
    new Setting(containerEl)
      .setName('Service Account Client Email')
      .setDesc('From the JSON key: client_email')
      .addText((t) =>
        t.setPlaceholder('service-account@project.iam.gserviceaccount.com')
          .setValue(this.plugin.settings.saClientEmail)
          .onChange(async (v) => {
            this.plugin.settings.saClientEmail = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Service Account Private Key (PEM)')
      .setDesc('Paste the full PEM, including -----BEGIN PRIVATE KEY----- / -----END PRIVATE KEY-----')
      .addTextArea?.((ta: TextAreaComponent) => {
        ta.setPlaceholder('-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkq...\n-----END PRIVATE KEY-----')
          .setValue(this.plugin.settings.saPrivateKey)
          .onChange(async (v: string) => {
            this.plugin.settings.saPrivateKey = v.trim();
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 6;
        ta.inputEl.cols = 60;
      })
    new Setting(containerEl)
      .setName('(Fallback) SA Private Key')
      .setDesc('If no textarea shown above, paste PEM in one line with \n escapes')
      .addText((t) =>
        t.setPlaceholder('-----BEGIN PRIVATE KEY-----\\n...')
          .setValue(this.plugin.settings.saPrivateKey)
          .onChange(async (v) => {
            this.plugin.settings.saPrivateKey = v.trim();
            await this.plugin.saveSettings();
          })
      );



    new Setting(containerEl)
      .setName('Calendar ID')
      .setDesc("Target calendar (e.g., 'primary' or email)")
      .addText((t) =>
        t.setPlaceholder('primary')
          .setValue(this.plugin.settings.gcalCalendarId)
          .onChange(async (v) => {
            this.plugin.settings.gcalCalendarId = v.trim() || 'primary';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Daily notes folder')
      .setDesc('Folder containing daily notes')
      .addText((t) =>
        t.setPlaceholder('Daily')
          .setValue(this.plugin.settings.dailyFolder)
          .onChange(async (v) => {
            this.plugin.settings.dailyFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Daily filename format')
      .setDesc("moment.js format without extension, e.g., 'YYYY-MM-DD'")
      .addText((t) =>
        t.setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.dailyFilenameFormat)
          .onChange(async (v) => {
            this.plugin.settings.dailyFilenameFormat = v.trim() || 'YYYY-MM-DD';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Schedule heading')
      .setDesc('Heading under which schedule items are listed')
      .addText((t) =>
        t.setPlaceholder('Schedule')
          .setValue(this.plugin.settings.scheduleHeading)
          .onChange(async (v) => {
            this.plugin.settings.scheduleHeading = v.trim() || 'Schedule';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Default duration (minutes)')
      .setDesc('Duration for events without end times')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setPlaceholder('60')
          .setValue(String(this.plugin.settings.defaultDurationMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.defaultDurationMinutes = n;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Time zone')
      .setDesc('IANA time zone, e.g., Europe/Berlin')
      .addText((t) =>
        t.setPlaceholder(this.plugin.settings.timeZone)
          .setValue(this.plugin.settings.timeZone)
          .onChange(async (v) => {
            this.plugin.settings.timeZone = (v.trim() || this.plugin.settings.timeZone);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-sync on modify')
      .setDesc("Automatically sync when today's daily note is modified")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoSyncOnModify)
          .onChange(async (v) => {
            this.plugin.settings.autoSyncOnModify = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync today's schedule now")
      .addButton((b) =>
        b.setButtonText('Sync')
          .onClick(async () => {
            await this.plugin.syncToday();
          })
      );

    new Setting(containerEl)
      .setName('Sync ALL daily notes now')
      .setDesc('Sync schedule sections in all daily notes in the configured folder')
      .addButton((b) =>
        b.setButtonText('Sync All')
          .onClick(async () => {
            await this.plugin.syncAllDailyNotes();
          })
      );
  }
}
