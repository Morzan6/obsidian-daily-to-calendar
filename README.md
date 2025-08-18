# Obsidian Daily to Calendar

 [Русская версия README](./README.ru.md)

A plugin that automatically syncs your daily notes schedule with Google Calendar, keeping your Obsidian planning in sync with your calendar events.

## Features

- **Sync Today's Schedule**: Quickly sync today's daily note schedule to Google Calendar
- **Bulk Sync**: Sync all daily notes at once to populate your calendar
- **Auto-sync on Modify**: Automatically sync when you modify daily notes (optional)
- **Smart Parsing**: Parses various time formats and schedule entries from your daily notes
- **Duplicate Prevention**: Avoids creating duplicate events by tracking synced content
- **Customizable**: Configure calendar ID, schedule heading, time zone, and more

## Installation

1. Download the latest release from the releases page
2. Extract the files to your Obsidian plugins folder: `.obsidian/plugins/obsidian-daily-to-calendar/`
3. Enable the plugin in Obsidian settings
4. Configure your Google Calendar API credentials (see Setup section)

## Setup

### Google Calendar API Setup

This plugin uses Google's Calendar API to create and manage events. You'll need to set up a Google Cloud project and service account to authenticate with Google Calendar.

1. **Create a Google Cloud Project**
   - Go to the [Google Cloud Console](https://console.cloud.google.com/)
   - Click "Select a project" → "New Project"
   - Give your project a name (e.g., "Obsidian Calendar Sync")
   - Click "Create"

2. **Enable the Google Calendar API**
   - In your project dashboard, go to "APIs & Services" → "Library"
   - Search for "Google Calendar API"
   - Click on it and press "Enable"

3. **Create a Service Account**
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "Service Account"
   - Enter a name (e.g., "obsidian-calendar-sync")
   - Click "Create and Continue"
   - Skip the optional steps and click "Done"

4. **Generate and Download the Key File**
   - Click on your newly created service account
   - Go to the "Keys" tab
   - Click "Add Key" → "Create New Key"
   - Select "JSON" format and click "Create"
   - Save the downloaded JSON file securely (contains your private key)

5. **Share Your Calendar with the Service Account**
   - Open Google Calendar in your browser
   - Find the calendar you want to sync to (or create a new one)
   - Click the three dots next to the calendar name → "Settings and sharing"
   - Under "Share with specific people", click "Add people"
   - Enter the service account email (found in the JSON file as `client_email`)
   - Set permission to "Make changes to events"
   - Click "Send"

6. **Get Your Calendar ID**
   - In the same calendar settings page, scroll down to "Calendar ID"
   - Copy this ID (usually looks like: `your-email@gmail.com` or a long string ending in `@group.calendar.google.com`)
   - You'll need this for the plugin configuration

7. **Configure the Plugin**
   - Open the downloaded JSON file in a text editor
   - Copy the entire contents
   - In Obsidian, go to plugin settings and paste it into the "Service Account Key" field

### Plugin Configuration

Open the plugin settings and configure:

- **Service Account Key**: Paste your Google service account JSON key
- **Calendar ID**: The ID of the Google Calendar to sync to
- **Schedule Heading**: The heading in your daily notes that contains schedule items (default: "Schedule")
- **Daily Notes Folder**: Path to your daily notes folder
- **Time Zone**: Your local time zone for proper event timing
- **Default Event Duration**: Duration for events without end times
- **Auto-sync on Modify**: Enable automatic syncing when daily notes are modified

## Usage

### Schedule Format

In your daily notes, create a schedule section like this:

```markdown
## Schedule

- 09:00-10:30 Team Meeting
- 11:00 Doctor Appointment
- 14:00-15:00 Project Review
- 16:30 Call with client
- All day: Conference
```

Supported time formats:
- `HH:MM-HH:MM` (time range)
- `HH:MM` (single time, uses default duration)
- `All day:` (all-day events)

### Syncing

**Manual Sync:**
- Click the calendar ribbon icon to sync today's schedule
- Use the "Sync ALL" ribbon icon to sync all daily notes
- Use command palette: "Sync Today's Schedule to Google Calendar"

**Auto Sync:**
- Enable "Auto-sync on Modify" in settings
- Plugin will automatically sync when you modify daily notes

### Status Indicator

The status bar shows the current sync status:
- **Idle**: Ready to sync
- **Syncing**: Currently syncing to calendar
- **Error**: Last sync encountered an error

## Commands

- **Sync Today's Schedule to Google Calendar**: Syncs today's daily note
- **Sync ALL Daily Notes to Google Calendar**: Syncs all daily notes in the folder

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Verify your service account JSON key is correct
   - Ensure the calendar is shared with your service account email
   - Check that the Calendar API is enabled in Google Cloud Console

2. **No Events Created**
   - Verify the schedule heading matches your daily notes
   - Check that your time format is supported
   - Ensure the daily notes folder path is correct

3. **Duplicate Events**
   - The plugin tracks synced content to prevent duplicates
   - If you see duplicates, try clearing the plugin data and re-syncing

### Debug Information

Check the developer console (Ctrl+Shift+I) for detailed error messages and sync logs.

## Development

### Building the Plugin

```bash
npm install
npm run build
```

### Development Mode

```bash
npm run dev
```

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

MIT License - see LICENSE file for details.

## Support

If you find this plugin helpful, consider supporting its development:
- Report bugs and request features via GitHub issues
- Contribute code improvements
- Share the plugin with other Obsidian users

---

**Author**: Morzan6 (n.kusmaul@yandex.ru)  
**Version**: 1.1.1