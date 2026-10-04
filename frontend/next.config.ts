import type { NextConfig } from 'next';

const config: NextConfig = {
  // El agente corre en su propio proceso Bun (bun run serve): necesita
  // bun:sqlite y Bun.SQL, que no existen en el runtime de Next.
  reactStrictMode: true,
  // Hay un lockfile aqui y otro en la raiz del repo; sin esto Turbopack elige
  // la raiz como workspace y avisa en cada arranque.
  turbopack: { root: import.meta.dirname },
};

export default config;
