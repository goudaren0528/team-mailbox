import fs from 'node:fs';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { memberNameSchema } from './validation.js';

// net.isIP rejects abbreviated/octal IPv4; ipaddr handles address arithmetic.
export function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) {
    throw new Error('Invalid IP address (use an unscoped IPv4 or IPv6 literal)');
  }
  return ipaddr.process(value);
}

function parseCidr(value) {
  if (typeof value !== 'string' || !/\/\d+$/.test(value)) throw new Error('Invalid CIDR');
  const literal = value.slice(0, value.lastIndexOf('/'));
  normalizeIp(literal);
  let [address, prefix] = ipaddr.parseCIDR(value);
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) {
    if (prefix < 96) throw new Error('Mapped IPv6 CIDR prefix must be >= 96');
    address = address.toIPv4Address();
    prefix -= 96;
  }
  return [address, prefix];
}

const schema = z.object({
  allowedCidrs: z.array(z.string()).min(1),
  members: z.array(z.object({
    name: memberNameSchema,
    ips: z.array(z.string()).min(1),
  }).strict()).min(1),
}).strict();

export function parseAccessConfig(input) {
  const config = schema.parse(input);
  const ranges = config.allowedCidrs.map(parseCidr);
  const allowed = address => ranges.some(([network, prefix]) =>
    address.kind() === network.kind() && address.match(network, prefix));
  const byIp = new Map();
  const names = new Set();
  const members = config.members.map(({ name, ips }) => {
    if (names.has(name)) throw new Error(`Duplicate member name: ${name}`);
    names.add(name);
    const normalized = ips.map(ip => {
      const address = normalizeIp(ip);
      const key = address.toString();
      if (!allowed(address)) throw new Error(`Member IP outside allowedCidrs: ${name}`);
      if (byIp.has(key)) throw new Error(`Duplicate normalized IP binding: ${key}`);
      byIp.set(key, name);
      return key;
    });
    return Object.freeze({ name, ips: Object.freeze(normalized) });
  });
  const peers = Object.freeze(members.map(({ name }) => Object.freeze({ name, displayName: name }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze({
    members: Object.freeze(members),
    peers,
    hasMember: name => names.has(name),
    identify(remoteAddress) {
      try {
        const address = normalizeIp(remoteAddress);
        if (!allowed(address)) return null;
        const name = byIp.get(address.toString());
        return name ? { name, displayName: name } : null;
      } catch { return null; }
    },
  });
}

export function loadAccessConfig(filePath) {
  return parseAccessConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
