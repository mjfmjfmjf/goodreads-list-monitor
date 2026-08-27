#!/usr/bin/env python3
"""
Monitor macOS sleep/wake and display on/off events.
Tracks timestamps and calculates durations for each sleep/display-off period.

Usage:
  python3 sleepMonitor.py          # show recent history then monitor live
  python3 sleepMonitor.py --live   # monitor live only (no history dump)
"""

import subprocess
import re
import sys
from datetime import datetime, timedelta


def format_duration(seconds):
    """Format seconds as human-readable duration."""
    seconds = abs(seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f'{hours}h {minutes}m {secs}s'
    elif minutes > 0:
        return f'{minutes}m {secs}s'
    else:
        return f'{secs}s'


def parse_timestamp(line):
    """Extract timestamp from a log line (log stream or pmset format)."""
    m = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})', line)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S')
    except ValueError:
        return None


def classify_event(line):
    """Classify a log line into an event type."""
    lower = line.lower()
    if 'display is turned off' in lower or 'display turned off' in lower:
        return 'display_off'
    if 'display is turned on' in lower or 'display turned on' in lower:
        return 'display_on'
    if 'entering sleep' in lower:
        return 'sleep'
    if 'entering darkwake' in lower:
        return 'darkwake'
    if any(phrase in lower for phrase in ['wake from sleep', 'wake from darkwake', 'wake from standby']):
        return 'wake'
    return None


def parse_pmset_history():
    """Parse recent power events from pmset -g log."""
    events = []
    try:
        result = subprocess.run(
            ['pmset', '-g', 'log'],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.strip().split('\n'):
            ts = parse_timestamp(line)
            evtype = classify_event(line)
            if ts and evtype:
                events.append((ts, evtype, line.strip()))
    except Exception:
        pass
    return events


def dedup_events(events, window_sec=5):
    """Remove duplicate events of the same type within a time window."""
    result = []
    for ts, evtype, raw in events:
        if result:
            last_ts, last_type, _ = result[-1]
            if evtype == last_type and (ts - last_ts).total_seconds() < window_sec:
                continue
        result.append((ts, evtype, raw))
    return result


def show_history_and_estimate():
    """Show recent history and estimate current state."""
    print(f'\n  Started monitoring at {datetime.now():%Y-%m-%d %H:%M:%S}')
    print(f'  Recent power events (from pmset -g log):')
    print(f'  {"=" * 62}')

    events = dedup_events(parse_pmset_history())

    if not events:
        print(f'  (no recent events found)')
        print(f'  {"=" * 62}\n')
        return None, None

    last_sleep = None
    last_wake = None
    last_display_off = None

    for ts, evtype, raw in events[-20:]:
        label = {
            'sleep':    'SLEEP',
            'wake':     'WAKE',
            'darkwake': 'DARKWAKE',
            'display_off': 'Display OFF',
            'display_on':  'Display ON',
        }.get(evtype, evtype.upper())

        if evtype == 'sleep':
            last_sleep = ts
        elif evtype == 'wake':
            last_wake = ts
        elif evtype == 'display_off':
            last_display_off = ts

        extra = ''
        print(f'  {ts:%Y-%m-%d %H:%M:%S}  {label}{extra}')

    print(f'  {"=" * 62}')

    # Estimate current state
    now = datetime.now()
    if last_sleep and (not last_wake or last_wake < last_sleep):
        elapsed = (now - last_sleep).total_seconds()
        print(f'  ⚠️  Mac appears to be SLEEPING since {last_sleep:%H:%M:%S} (about {format_duration(elapsed)} ago)')
    elif last_wake:
        elapsed = (now - last_wake).total_seconds()
        print(f'  Mac is awake (last woke {last_wake:%H:%M:%S}, {format_duration(elapsed)} ago)')
    else:
        print(f'  Mac state unknown from history')

    print()
    return last_sleep, last_wake


def monitor():
    """Live-monitor power events via log stream."""
    last_display_off = None
    last_sleep = None
    last_event_time = {}
    DEDUP_WINDOW = 3  # seconds

    cmd = [
        'log', 'stream', '--style', 'compact',
        '--predicate',
        'subsystem == "com.apple.powerd" '
        '|| (eventMessage CONTAINS[c] "sleep" AND eventMessage CONTAINS[c] "powerd") '
        '|| (eventMessage CONTAINS[c] "wake" AND eventMessage CONTAINS[c] "powerd") '
        '|| eventMessage CONTAINS[c] "display is turned"'
    ]

    print('  Listening for live events (Ctrl+C to stop)...\n')

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue

            ts = parse_timestamp(line)
            evtype = classify_event(line)
            if not ts or not evtype:
                continue

            # Dedup: skip same event type within DEDUP_WINDOW seconds
            key = evtype
            prev = last_event_time.get(key)
            if prev and (ts - prev).total_seconds() < DEDUP_WINDOW:
                continue
            last_event_time[key] = ts

            if evtype == 'display_off':
                last_display_off = ts
                print(f'  {ts:%Y-%m-%d %H:%M:%S}  Display OFF')

            elif evtype == 'display_on':
                if last_display_off:
                    dur = (ts - last_display_off).total_seconds()
                    print(f'  {ts:%Y-%m-%d %H:%M:%S}  Display ON    (off for {format_duration(dur)})')
                else:
                    print(f'  {ts:%Y-%m-%d %H:%M:%S}  Display ON')
                last_display_off = None

            elif evtype == 'sleep':
                if last_sleep and (ts - last_sleep).total_seconds() < 10:
                    continue  # skip rapid-fire duplicates
                last_sleep = ts
                print(f'  {ts:%Y-%m-%d %H:%M:%S}  SLEEP')

            elif evtype in ('wake', 'darkwake'):
                if last_sleep:
                    dur = (ts - last_sleep).total_seconds()
                    label = 'WAKE' if evtype == 'wake' else 'DARKWAKE'
                    print(f'  {ts:%Y-%m-%d %H:%M:%S}  {label}        (slept {format_duration(dur)})')
                    last_sleep = None
                else:
                    label = 'WAKE' if evtype == 'wake' else 'DARKWAKE'
                    print(f'  {ts:%Y-%m-%d %H:%M:%S}  {label}')

    except KeyboardInterrupt:
        print('\n  Stopped.')
        try:
            proc.terminate()
        except Exception:
            pass
    except Exception as e:
        print(f'  Error: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    if '--live' in sys.argv:
        print(f'\n  Started monitoring at {datetime.now():%Y-%m-%d %H:%M:%S}\n')
        monitor()
    else:
        show_history_and_estimate()
        monitor()
