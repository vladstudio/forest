import * as net from 'net';

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: 'localhost' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

export function resolvePortVars(value: string, mapping: Record<string, string>, portBase: number): string {
  return value.replace(/\$\{ports\.(\w+)\}/g, (_, name) => {
    const offset = parseInt(mapping[name]?.replace('+', '') ?? '0') || 0;
    return String(portBase + offset);
  });
}
