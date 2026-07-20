import os, pty, sys, fcntl, termios, struct, select, time, signal

def capture(cmd, cols, rows, out, duration=6.0, feed=None):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env['TERM'] = 'xterm-256color'
        env['COLUMNS'] = str(cols); env['LINES'] = str(rows)
        os.execvpe('/bin/sh', ['/bin/sh', '-c', cmd], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    data = bytearray()
    start = time.time()
    fed = 0
    while time.time() - start < duration:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk: break
            data += chunk
        if feed and fed < len(feed):
            el = time.time() - start
            while fed < len(feed) and feed[fed][0] <= el:
                os.write(fd, feed[fed][1]); fed += 1
    try:
        os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except Exception: pass
    os.close(fd)
    open(out, 'wb').write(bytes(data))
    print(f'{out}: {len(data)} bytes')

if __name__ == '__main__':
    import json
    spec = json.loads(sys.argv[1])
    capture(**spec)
