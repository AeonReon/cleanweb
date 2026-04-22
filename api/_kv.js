// Shared KV client + helpers. Uses @vercel/kv which reads KV_REST_API_URL +
// KV_REST_API_TOKEN from env (auto-injected when you provision a KV store
// from the Vercel dashboard).

import { kv } from '@vercel/kv';

export function isConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// --- Family codes ---
// Human-friendly, unguessable. 12 chars from a reduced alphabet (no 0/O/1/I/L).
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newFamilyCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return `${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(8,12)}`;
}

export function normCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export function slug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function canonUrl(u) {
  try {
    const url = new URL(u);
    return (url.origin + url.pathname).replace(/\/$/, '').toLowerCase();
  } catch { return String(u || '').toLowerCase(); }
}

// --- Keys ---
export const K = {
  family:      code => `family:${code}`,
  members:     code => `family:${code}:members`,
  collections: code => `family:${code}:collections`,
  saves:       code => `family:${code}:saves`,
  save:       (code, id) => `family:${code}:save:${id}`,
  collection: (code, name) => `family:${code}:collection:${slug(name)}`,
  urlIndex:   code => `family:${code}:urls`,
};

export { kv };
