import fs from 'node:fs';

const waitBuffer = new SharedArrayBuffer(4);
const waitArray = new Int32Array(waitBuffer);

function sleepSync(ms: number): void {
  Atomics.wait(waitArray, 0, 0, ms);
}

function openPromptInput(): { fd: number; close: boolean } {
  const candidates = process.platform === 'win32' ? ['CONIN$'] : ['/dev/tty'];
  for (const candidate of candidates) {
    try {
      return { fd: fs.openSync(candidate, 'r'), close: true };
    } catch {
      // Fall back to stdin below.
    }
  }

  if (process.stdin.isTTY) {
    return { fd: 0, close: false };
  }

  throw new Error('Interactive prompt requires a TTY.');
}

export function promptLineSync(prompt: string, nonTtyMessage: string): string {
  if (!process.stdout.isTTY && !process.stderr.isTTY) {
    throw new Error(nonTtyMessage);
  }

  process.stdout.write(prompt);
  let input: { fd: number; close: boolean };
  try {
    input = openPromptInput();
  } catch {
    throw new Error(nonTtyMessage);
  }

  let answer = '';
  const buffer = Buffer.alloc(256);
  try {
    for (;;) {
      let bytes = 0;
      try {
        bytes = fs.readSync(input.fd, buffer, 0, buffer.length, null);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          sleepSync(25);
          continue;
        }
        throw e;
      }
      if (bytes === 0) break;
      const chunk = buffer.toString('utf-8', 0, bytes);
      const newline = chunk.search(/[\r\n]/);
      if (newline >= 0) {
        answer += chunk.slice(0, newline);
        break;
      }
      answer += chunk;
    }
  } finally {
    if (input.close) fs.closeSync(input.fd);
  }

  return answer.trim();
}
