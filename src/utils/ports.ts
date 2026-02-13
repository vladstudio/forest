import * as net from 'net';

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: 'localhost' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}
