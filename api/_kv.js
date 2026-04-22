// Shared Redis client + helpers.
// Uses @upstash/redis which reads UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// by default. Falls back to KV_REST_API_* if Vercel provisions those instead.

import { Redis } from '@upstash/redis';

const URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const kv = (URL && TOKEN) ? new Redis({ url: URL, token: TOKEN }) : null;

export function isConfigured() {
  return !!(URL && TOKEN);
}

// --- Family codes ---
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
