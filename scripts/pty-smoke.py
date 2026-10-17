#!/usr/bin/env python3
"""Headless smoke test of the real interactive Claude Code CLI with the mod.

Runs `claude --plugin-dir mod` in a pseudo-terminal, gives the pane the keys,
presses Start / Remix / Demo / Stop, edits the mod to force a hot reload, and
exits. Audio goes to scripts/test-sink.sh (a file), so nothing is heard.
Prints a JSON report: engine process counts at each stage, PCM bytes written,
and the pane text seen. No model request is made unless --live is given.
"""
import json, os, pty, re, select, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH = os.environ.get('SMOKE_DIR', os.path.join(HERE, 'work', 'smoke'))
os.makedirs(SCRATCH, exist_ok=True)
SINK = os.path.join(SCRATCH, 'sink.pcm')
ENGINE = os.path.join(HERE, 'engine', 'main.mjs')
LIVE = '--live' in sys.argv
CLAUDE = os.path.expanduser('~/.local/bin/claude')

project = os.path.join(SCRATCH, 'project')
subprocess.run(['rm', '-rf', project])
subprocess.run(['cp', '-R', os.path.join(HERE, 'fixtures', 'demo-project'), project], check=True)
if os.path.exists(SINK):
    os.remove(SINK)

# A clean environment like a fresh iTerm2 tab: drop the parent Claude session's markers.
env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE')}
env.update({
    'CODE_ORCHESTRA_FFPLAY': os.path.join(HERE, 'scripts', 'test-sink.sh'),
    'CODE_ORCHESTRA_NODE': subprocess.check_output(['/bin/zsh', '-lc', 'command -v node']).decode().strip(),
    'SINK_OUT': SINK, 'TERM': 'xterm-256color', 'COLUMNS': '150', 'LINES': '48',
})

pid, fd = pty.fork()
if pid == 0:
    os.chdir(project)
    extra = ['--debug-file', os.path.join(SCRATCH, 'debug.log')] if os.environ.get('SMOKE_DEBUG') else []
    os.execve(CLAUDE, [CLAUDE, '--plugin-dir', os.path.join(HERE, 'mod')] + extra, env)

import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 150, 0, 0))
os.kill(pid, signal.SIGWINCH)

buf = bytearray()
def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            buf.extend(data)

def text():
    t = buf.decode('utf8', 'replace')
    t = re.sub(r'\x1b\][^\x07]*\x07', '', t)
    return re.sub(r'\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b[()][0-9A-B]|\x1b[=>78]', ' ', t)

def send(s, wait=1.0):
    os.write(fd, s.encode() if isinstance(s, str) else s)
    pump(wait)

def engines():
    out = subprocess.run(['pgrep', '-f', ENGINE], capture_output=True, text=True).stdout.split()
    return len(out)

def sink_bytes():
    return os.path.getsize(SINK) if os.path.exists(SINK) else 0

report = {'dialogs': []}
# Startup dialogs: trust the throwaway fixture folder; decline optional browser tools.
seen = 0
for _ in range(12):
    pump(1.5)
    t = text()[seen:]
    if 'trust' in t.lower() and ('folder' in t.lower() or 'files' in t.lower()) and 'Yes' in t:
        # Only ever the throwaway copy of fixtures/demo-project under work/smoke. The default is "No, exit".
        report['dialogs'].append('trust: yes'); seen = len(text()); send(b'\x1b[B', 0.5); send('\r', 3)
    elif 'Enter to confirm' in t and 'browser' in t.lower():
        report['dialogs'].append('chrome: esc (keep off)'); seen = len(text()); send(b'\x1b', 3)
    elif 'CODE ORCHESTRA [' in text():
        break
report['pane_title_seen'] = bool(re.search(r'CODE ORCHESTRA\s+\[LIVE\]', text()))
report['engines_at_launch'] = engines()
send('/orchestra', 0.8)       # the command opens the pane with the keys
send('\r', 2.5)
send('s', 5)                  # Start
report['engines_after_start'] = engines()
report['pcm_after_start'] = sink_bytes()
report['playing_seen'] = 'playing' in text()
send('r', 3)                  # Remix (lands next bar)
send('d', 6)                  # Demo
report['demo_seen'] = '[DEMO]' in text()
report['pcm_after_demo'] = sink_bytes()
send('s', 3)                  # Stop
report['engines_after_stop'] = engines()
report['stopped_seen'] = 'stopped' in text()
send('s', 3)                  # Start again: same engine, no second one
report['engines_after_restart'] = engines()

# Hot reload: touch the module; the old module's engine must go away.
reg = os.path.join(HERE, 'mod', 'hooks', 'register.tsx')
original = open(reg).read()
try:
    open(reg, 'w').write(original + '\n// smoke-test reload marker\n')
    pump(6)
finally:
    open(reg, 'w').write(original)
pump(12)                      # restoring the file reloads once more; let it settle
report['engines_after_hot_reload'] = engines()
send('s', 4)
report['engines_after_start_post_reload'] = engines()

if LIVE:
    before = len(text())
    send(b'\x1b', 1)          # hand the keys back to the prompt (music keeps playing)
    send('Read README.md and scale.mjs, then reply with just the word ok.', 0.5)
    send('\r', 30)
    later = text()[before:]
    report['live_events_text'] = re.findall(r'(\d+) live events', later)[-1:]
    report['live_reflected_lines'] = sorted(set(re.findall(r'(?:Read|Prompt|Turn done)[^\n]{0,4}→ [a-z +]+', later)))[:6]
    report['engines_during_live'] = engines()

send(b'\x1b', 1)
send('/exit\r', 6)
try:
    os.kill(pid, 0)
    os.kill(pid, signal.SIGTERM)
except OSError:
    pass
time.sleep(2.5)
report['engines_after_exit'] = engines()
report['sinks_after_exit'] = len(subprocess.run(['pgrep', '-f', 'test-sink.sh'], capture_output=True, text=True).stdout.split())
report['sockets_left'] = [s for s in os.listdir(os.path.expanduser('~/.code-orchestra/run')) if s.endswith('.sock')]
open(os.path.join(SCRATCH, 'screen.txt'), 'w').write(text())
print(json.dumps(report, indent=1))
