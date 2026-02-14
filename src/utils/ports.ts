import * as net from 'net';

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: 'localhost' });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export function resolvePortVars(value: string, mapping: Record<string, string>, portBase: number): string {
  return value.replace(/\$\{ports\.(\w+)\}/g, (_, name) => {
    const offset = parseInt(mapping[name]?.replace('+', '') ?? '0') || 0;
    return String(portBase + offset);
  });
}
